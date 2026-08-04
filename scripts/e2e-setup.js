import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decode } from "@toon-format/toon";
import { fileURLToPath } from "node:url";
import { runSetup } from "../src/setup.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliSource = path.join(repoRoot, "src", "cli.js");
const pluginSource = path.join(repoRoot, "src", "opencode-plugin.js");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-e2e-home-"));
const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-e2e-checkout-"));
const fixtureSrc = path.join(checkout, "src");
fs.symlinkSync(path.join(repoRoot, "src"), fixtureSrc, "dir");
fs.symlinkSync(path.join(repoRoot, "package.json"), path.join(checkout, "package.json"), "file");

let exitCode = 0;
try {
  const result = runSetup({
    checkoutDirectory: checkout,
    cliPath: cliSource,
    homeDirectory: home,
    env: { PATH: path.join(home, ".local", "bin") },
    runNpmInstall: () => {},
    runCommand: () => ({ status: null, stdout: "", stderr: "", error: { code: "ENOENT" } }),
  });

  const binLink = result.cli.path;
  const stat = fs.lstatSync(binLink);
  if (!stat.isSymbolicLink()) throw new Error(`${binLink} is not a symlink`);
  const resolved = fs.realpathSync(binLink);
  if (resolved !== cliSource) {
    throw new Error(`symlink target mismatch: got ${resolved}, expected ${cliSource}`);
  }

  const pluginLink = result.opencode.path;
  const pluginStat = fs.lstatSync(pluginLink);
  if (!pluginStat.isSymbolicLink()) throw new Error(`${pluginLink} is not a symlink`);
  const pluginResolved = fs.realpathSync(pluginLink);
  if (pluginResolved !== pluginSource) {
    throw new Error(`plugin symlink target mismatch: got ${pluginResolved}, expected ${pluginSource}`);
  }

  const stdout = execFileSync(process.execPath, [binLink, "--version"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const value = decode(stdout.trim());
  if (value.name !== "taskferry") throw new Error(`unexpected name: ${value.name}`);
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new Error(`unexpected version: ${value.version}`);
  }

  console.log(JSON.stringify({
    binLink,
    resolved,
    pluginResolved,
    pluginPath: pluginLink,
    version: value,
  }, null, 2));
  console.log("E2E PASS: setup-service-installed symlink produces real CLI output");
} catch (error) {
  console.error("E2E FAIL:", error);
  exitCode = 1;
} finally {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(checkout, { recursive: true, force: true });
}
process.exit(exitCode);
