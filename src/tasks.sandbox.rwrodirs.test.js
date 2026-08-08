import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManager, fakeChild, mkdtempTracked } from "./tasks.test-helpers.js";

// The dispatch directory and the bound dirs must NOT share an ancestor
// relationship: roDirs that are descendants of the launch directory are
// (correctly) rejected as overlapping a protected mount. Use a dedicated
// dispatch dir under its own temp subtree, and ro/rw targets under a
// sibling subtree, so they never overlap.
const launchDir = () => { const d = path.join(mkdtempTracked("axi-ro-dispatch-"), "work"); fs.mkdirSync(d, { recursive: true }); return d; };
const roTarget = () => mkdtempTracked("axi-ro-target-");
// Returns the list of [flag, src, dest] triples for the given bind flag in
// the captured argv, so tests can assert directly on the constructed argv
// (the spawn boundary is mocked, so a green run does not prove bwrap
// receives the right args -- assert on buildBwrapArgs's output instead).
const pairsFor = (args, flag) => {
  const pairs = [];
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === flag) pairs.push([args[i + 1], args[i + 2]]);
  }
  return pairs;
};
let captured;
const baseManagerOpts = {
  spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
  sandboxEnabled: true,
  checkBwrapAvailableFn: () => ({ checked: true, available: true }),
  platform: "linux",
  resolveGitCommonDirFn: () => null,
};

describe("bwrap sandboxing: --rw-dirs and --ro-dirs -- binding and conflict resolution", () => {
  test("--rw-dirs binds read-write (--bind), unioning the manager default, env, and config layers", () => {
    const managerDefault = roTarget();
    const envDir = roTarget();
    const configDir = roTarget();
    const oldEnv = process.env.TASKFERRY_RW_DIRS;
    process.env.TASKFERRY_RW_DIRS = envDir;
    try {
      const mgr = makeManager({
        ...baseManagerOpts,
        allowedDirs: [],
        rwDirs: [managerDefault],
        config: { rwDirs: configDir },
      });
      mgr.dispatch({ prompt: "hello", directory: launchDir(), rwDirs: [roTarget()] });
      const bindPairs = pairsFor(captured.args, "--bind");
      assert.ok(bindPairs.some(([src]) => src === managerDefault), `manager default rwDirs not bound: ${JSON.stringify(bindPairs)}`);
      assert.ok(bindPairs.some(([src]) => src === envDir), `TASKFERRY_RW_DIRS not bound: ${JSON.stringify(bindPairs)}`);
      assert.ok(bindPairs.some(([src]) => src === configDir), `config rwDirs not bound: ${JSON.stringify(bindPairs)}`);
    } finally {
      if (oldEnv === undefined) delete process.env.TASKFERRY_RW_DIRS;
      else process.env.TASKFERRY_RW_DIRS = oldEnv;
    }
  });

  test("--ro-dirs binds read-only (--ro-bind), unioning the manager default, env, and config layers", () => {
    const managerDefault = roTarget();
    const envDir = roTarget();
    const configDir = roTarget();
    const oldEnv = process.env.TASKFERRY_RO_DIRS;
    process.env.TASKFERRY_RO_DIRS = envDir;
    try {
      const mgr = makeManager({
        ...baseManagerOpts,
        roDirs: [managerDefault],
        config: { roDirs: configDir },
      });
      mgr.dispatch({ prompt: "hello", directory: launchDir(), roDirs: [roTarget()] });
      const roPairs = pairsFor(captured.args, "--ro-bind");
      assert.ok(roPairs.some(([src, dest]) => src === managerDefault && dest === managerDefault), `manager default roDirs not bound: ${JSON.stringify(roPairs)}`);
      assert.ok(roPairs.some(([src, dest]) => src === envDir && dest === envDir), `TASKFERRY_RO_DIRS not bound: ${JSON.stringify(roPairs)}`);
      assert.ok(roPairs.some(([src, dest]) => src === configDir && dest === configDir), `config roDirs not bound: ${JSON.stringify(roPairs)}`);
    } finally {
      if (oldEnv === undefined) delete process.env.TASKFERRY_RO_DIRS;
      else process.env.TASKFERRY_RO_DIRS = oldEnv;
    }
  });

  test("a path in both rw and ro sets binds read-write and warns (read-write wins)", () => {
    const conflict = roTarget();
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const mgr = makeManager({
        ...baseManagerOpts,
        rwDirs: [conflict],
        roDirs: [conflict],
      });
      mgr.dispatch({ prompt: "hello", directory: launchDir() });
      const bindPairs = pairsFor(captured.args, "--bind");
      const roPairs = pairsFor(captured.args, "--ro-bind");
      assert.ok(bindPairs.some(([src]) => src === conflict), `rw-wins path not bound rw: ${JSON.stringify(bindPairs)}`);
      assert.ok(!roPairs.some(([src]) => src === conflict), `rw-wins path must not stay ro: ${JSON.stringify(roPairs)}`);
      assert.match(warned, new RegExp(conflict.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(warned, /read-write wins/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("a path in both the per-dispatch ro set and the manager rw set binds read-write and warns", () => {
    const conflict = roTarget();
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const mgr = makeManager({
        ...baseManagerOpts,
        rwDirs: [conflict],
      });
      mgr.dispatch({ prompt: "hello", directory: launchDir(), roDirs: [conflict] });
      const bindPairs = pairsFor(captured.args, "--bind");
      const roPairs = pairsFor(captured.args, "--ro-bind");
      assert.ok(bindPairs.some(([src]) => src === conflict));
      assert.ok(!roPairs.some(([src]) => src === conflict));
      assert.match(warned, /read-write wins/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("--rw-dirs targeting a deny-listed path (e.g. ~/.ssh) still binds read-write, but warns loudly that it overrides the deny-list", () => {
    const sshDir = path.join(os.homedir(), ".ssh");
    if (!fs.existsSync(sshDir)) return; // nothing to override on a host with no ~/.ssh
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const mgr = makeManager({ ...baseManagerOpts, rwDirs: [sshDir] });
      mgr.dispatch({ prompt: "hello", directory: launchDir() });
      const bindPairs = pairsFor(captured.args, "--bind");
      assert.ok(bindPairs.some(([src]) => src === sshDir), `~/.ssh not bound read-write: ${JSON.stringify(bindPairs)}`);
      assert.match(warned, /overrides the sandbox deny-list/);
      assert.match(warned, new RegExp(sshDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("a path listed read-only via both --ro-dirs and a project's read_only_paths warns exactly once when it also collides with --rw-dirs", () => {
    const conflict = roTarget();
    const directory = launchDir();
    fs.writeFileSync(path.join(directory, ".taskferry.toml"), `read_only_paths = [${JSON.stringify(conflict)}]\n`);
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const mgr = makeManager({ ...baseManagerOpts, rwDirs: [conflict], roDirs: [conflict] });
      mgr.dispatch({ prompt: "hello", directory });
      const bindPairs = pairsFor(captured.args, "--bind");
      const roPairs = pairsFor(captured.args, "--ro-bind");
      assert.ok(bindPairs.some(([src]) => src === conflict), `rw-wins path not bound rw: ${JSON.stringify(bindPairs)}`);
      assert.ok(!roPairs.some(([src]) => src === conflict), `rw-wins path must not stay ro: ${JSON.stringify(roPairs)}`);
      const occurrences = (warned.match(/read-write wins/g) || []).length;
      assert.equal(occurrences, 1, `expected exactly one rw-wins warning for a path duplicated across --ro-dirs and read_only_paths, got ${occurrences}: ${warned}`);
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});

describe("bwrap sandboxing: --rw-dirs and --ro-dirs -- validation and deprecated aliases", () => {
  test("--ro-dirs skips a nonexistent path with a warning, not a crash", () => {
    const missing = path.join(os.tmpdir(), "axi-ro-dir-does-not-exist");
    const real = roTarget();
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const mgr = makeManager({ ...baseManagerOpts, roDirs: [missing, real] });
      mgr.dispatch({ prompt: "hello", directory: launchDir() });
      const roPairs = pairsFor(captured.args, "--ro-bind");
      assert.ok(!roPairs.some(([src]) => src === missing), `missing path bound: ${JSON.stringify(roPairs)}`);
      assert.ok(roPairs.some(([src]) => src === real), `real path not bound: ${JSON.stringify(roPairs)}`);
      assert.match(warned, /not found on this host, skipped/);
      assert.match(warned, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("--ro-dirs skips a path overlapping a protected mount with a warning", () => {
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const mgr = makeManager({ ...baseManagerOpts, roDirs: [os.homedir()] });
      mgr.dispatch({ prompt: "hello", directory: launchDir() });
      const roPairs = pairsFor(captured.args, "--ro-bind");
      assert.ok(!roPairs.some(([src]) => src === os.homedir()), `protected path bound ro: ${JSON.stringify(roPairs)}`);
      assert.match(warned, /overlaps a protected sandbox mount, skipped/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("--allowed-dirs feeds the same rw union as --rw-dirs", () => {
    const viaNew = roTarget();
    const viaOld = roTarget();
    const mgr = makeManager({ ...baseManagerOpts });
    mgr.dispatch({ prompt: "hello", directory: launchDir(), rwDirs: [viaNew], allowedDirs: [viaOld] });
    const bindPairs = pairsFor(captured.args, "--bind");
    assert.ok(bindPairs.some(([src]) => src === viaNew));
    assert.ok(bindPairs.some(([src]) => src === viaOld));
  });

  test("the deprecated TASKFERRY_ALLOWED_DIRS env var feeds the rw union and warns at manager construction", () => {
    const viaEnv = roTarget();
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    const oldEnv = process.env.TASKFERRY_ALLOWED_DIRS;
    process.env.TASKFERRY_ALLOWED_DIRS = viaEnv;
    try {
      const mgr = makeManager({ ...baseManagerOpts });
      mgr.dispatch({ prompt: "hello", directory: launchDir() });
      const bindPairs = pairsFor(captured.args, "--bind");
      assert.ok(bindPairs.some(([src]) => src === viaEnv), `TASKFERRY_ALLOWED_DIRS not bound: ${JSON.stringify(bindPairs)}`);
      assert.match(warned, /TASKFERRY_ALLOWED_DIRS \/ allowedDirs \/ --allowed-dirs is deprecated/);
      assert.match(warned, /next major release/);
    } finally {
      process.stderr.write = originalWrite;
      if (oldEnv === undefined) delete process.env.TASKFERRY_ALLOWED_DIRS;
      else process.env.TASKFERRY_ALLOWED_DIRS = oldEnv;
    }
  });

  test("config allowedDirs (deprecated) and config rwDirs both feed the rw union", () => {
    const viaConfigOld = roTarget();
    const viaConfigNew = roTarget();
    const mgr = makeManager({ ...baseManagerOpts, config: { allowedDirs: viaConfigOld, rwDirs: viaConfigNew } });
    mgr.dispatch({ prompt: "hello", directory: launchDir() });
    const bindPairs = pairsFor(captured.args, "--bind");
    assert.ok(bindPairs.some(([src]) => src === viaConfigOld));
    assert.ok(bindPairs.some(([src]) => src === viaConfigNew));
  });
});
