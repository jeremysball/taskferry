import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { detectCheckCommand, runInit } from "./init.js";

const configFilename = ".taskferry.toml";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axi-init-test-"));
}

describe("detectCheckCommand", () => {
  test("prefers an existing package.json 'check' script outright", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { check: "eslint . && tsc --noEmit", lint: "eslint ." } }));
    assert.equal(detectCheckCommand(dir), "npm run check");
  });

  test("composes lint+typecheck+test from package.json scripts when there's no 'check' script", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run" } }));
    assert.equal(detectCheckCommand(dir), "npm run lint && npm run test");
  });

  test("detects pyproject.toml", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "[project]\nname = \"x\"\n");
    assert.equal(detectCheckCommand(dir), "uv run pytest && uv run ruff check .");
  });

  test("detects go.mod", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/x\n");
    assert.equal(detectCheckCommand(dir), "go vet ./... && go test ./...");
  });

  test("detects Cargo.toml", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n");
    assert.equal(detectCheckCommand(dir), "cargo clippy -- -D warnings && cargo test");
  });

  test("nothing recognized -> null", () => {
    assert.equal(detectCheckCommand(tmpDir()), null);
  });
});

describe("runInit", () => {
  test("never overwrites an existing .taskferry.toml", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, configFilename), "check = \"already here\"\n");
    const result = await runInit(dir);
    assert.equal(result.written, false);
    assert.match(result.reason, /already exists/);
    assert.equal(fs.readFileSync(path.join(dir, configFilename), "utf8"), "check = \"already here\"\n");
  });

  test("no TTY and a detected command: writes a commented fill-in template, does not guess the value in", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "go.mod"), "module x\n");
    const stdin = new EventEmitter();
    stdin.isTTY = false;
    const stdout = { write: () => {} };
    const result = await runInit(dir, { io: { stdin, stdout } });
    assert.equal(result.written, true);
    const content = fs.readFileSync(path.join(dir, configFilename), "utf8");
    assert.match(content, /# check = "go vet/);
    assert.ok(!content.includes("\ncheck ="));
  });

  test("nothing detected: writes the commented template with no proposed value", async () => {
    const dir = tmpDir();
    const stdin = new EventEmitter();
    stdin.isTTY = false;
    const result = await runInit(dir, { io: { stdin, stdout: { write: () => {} } } });
    assert.equal(result.checkCommand, null);
    const content = fs.readFileSync(path.join(dir, configFilename), "utf8");
    assert.match(content, /fill this in/);
  });
});
