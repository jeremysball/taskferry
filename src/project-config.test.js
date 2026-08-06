import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectConfigPath, loadProjectConfig, verificationPromptBlock, _resetProjectConfigCache } from "./project-config.js";

function tmpProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axi-project-config-test-"));
}

function writeConfig(dir, content) {
  fs.writeFileSync(resolveProjectConfigPath(dir), content);
}

describe("loadProjectConfig", () => {
  beforeEach(() => {
    _resetProjectConfigCache();
  });

  test("no .taskferry.toml -> no gate, no read-only paths, no error", () => {
    const dir = tmpProjectDir();
    const config = loadProjectConfig(dir);
    assert.deepEqual(config, { check: null, checkTimeoutSeconds: 900, readOnlyPaths: [], parseError: null });
  });

  test("parses check, check_timeout_seconds, and read_only_paths", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "bun x check"\ncheck_timeout_seconds = 120\nread_only_paths = ["/a", "/b"]\n`);
    const config = loadProjectConfig(dir);
    assert.deepEqual(config, { check: "bun x check", checkTimeoutSeconds: 120, readOnlyPaths: ["/a", "/b"], parseError: null });
  });

  test("check_timeout_seconds defaults to 900 when absent", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm run check"\n`);
    assert.equal(loadProjectConfig(dir).checkTimeoutSeconds, 900);
  });

  test("invalid TOML syntax never throws: returns EMPTY_CONFIG-shaped result with parseError set", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = \n`);
    const config = loadProjectConfig(dir);
    assert.equal(config.check, null);
    assert.equal(config.readOnlyPaths.length, 0);
    assert.match(config.parseError, /taskferry\.toml/);
  });

  test("unrecognized key is a validation error, not a silent pass-through", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\nnotarealfield = 1\n`);
    const config = loadProjectConfig(dir);
    assert.equal(config.check, null);
    assert.match(config.parseError, /notarealfield/);
  });

  test("check_timeout_seconds must be a positive integer", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\ncheck_timeout_seconds = -1\n`);
    assert.match(loadProjectConfig(dir).parseError, /check_timeout_seconds/);
  });

  test("read_only_paths must be an array of strings", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\nread_only_paths = [1, 2]\n`);
    assert.match(loadProjectConfig(dir).parseError, /read_only_paths/);
  });

  test("caches by mtime: a second call without a file change does not re-read", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\n`);
    let reads = 0;
    const deps = { readFileFn: (p) => { reads++; return fs.readFileSync(p, "utf8"); } };
    loadProjectConfig(dir, deps);
    loadProjectConfig(dir, deps);
    assert.equal(reads, 1);
  });

  test("cache invalidates when mtime changes", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\n`);
    assert.equal(loadProjectConfig(dir).check, "npm test");
    // Force a distinct mtime -- same-millisecond rewrites can land on an
    // unchanged mtimeMs on fast filesystems.
    fs.utimesSync(resolveProjectConfigPath(dir), new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    writeConfig(dir, `check = "npm run check"\n`);
    assert.equal(loadProjectConfig(dir).check, "npm run check");
  });
});

describe("verificationPromptBlock", () => {
  beforeEach(() => {
    _resetProjectConfigCache();
  });

  test("renders the required-verification block with the check command embedded", () => {
    const block = verificationPromptBlock("bun x check");
    assert.match(block, /## Verification \(required\)/);
    assert.match(block, /bun x check/);
    assert.match(block, /Run it before declaring the task done/);
  });
});
