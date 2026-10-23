import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeManager, makeFakeExecutor, fakeChild, mkdtempTracked, preserveEnvVars, captureStderr } from "./tasks.test-helpers.js";

// The dispatch directory and the bound dirs must NOT share an ancestor
// relationship: roBind that are descendants of the launch directory are
// (correctly) rejected as overlapping a protected mount. Use a dedicated
// dispatch dir under its own temp subtree, and ro/rw targets under a
// sibling subtree, so they never overlap.
const launchDir = () => { const d = path.join(mkdtempTracked("axi-ro-dispatch-"), "work"); fs.mkdirSync(d, { recursive: true }); return d; };
const roTarget = () => mkdtempTracked("axi-ro-target-");
const writeProjectReadOnlyPaths = (directory, ...paths) => fs.writeFileSync(path.join(directory, ".taskferry.toml"), `read_only_paths = ${JSON.stringify(paths)}\n`);
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
// The error text a blank-but-non-empty bind list produces (see parseBindList in tasks.js).
const NAMES_NO_PATH = "names no path";
let captured;
const baseManagerOpts = {
  spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
  sandboxEnabled: true,
  checkBwrapAvailableFn: () => ({ checked: true, available: true }),
  platform: "linux",
  resolveGitCommonDirFn: () => null,
};

describe("bwrap sandboxing: --rw-bind and --ro-bind -- binding and conflict resolution", () => {
  test("a path in both rw and ro sets binds read-write and warns (read-write wins)", () => {
    const conflict = roTarget();
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const mgr = makeManager({
        ...baseManagerOpts,
        rwBind: [conflict],
        roBind: [conflict],
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
        rwBind: [conflict],
      });
      mgr.dispatch({ prompt: "hello", directory: launchDir(), roBind: [conflict] });
      const bindPairs = pairsFor(captured.args, "--bind");
      const roPairs = pairsFor(captured.args, "--ro-bind");
      assert.ok(bindPairs.some(([src]) => src === conflict));
      assert.ok(!roPairs.some(([src]) => src === conflict));
      assert.match(warned, /read-write wins/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("--rw-bind targeting a deny-listed path (e.g. ~/.ssh) still binds read-write, but warns loudly that it overrides the deny-list", () => {
    const sshDir = path.join(os.homedir(), ".ssh");
    if (!fs.existsSync(sshDir)) return; // nothing to override on a host with no ~/.ssh
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const mgr = makeManager({ ...baseManagerOpts, rwBind: [sshDir] });
      mgr.dispatch({ prompt: "hello", directory: launchDir() });
      const bindPairs = pairsFor(captured.args, "--bind");
      assert.ok(bindPairs.some(([src]) => src === sshDir), `~/.ssh not bound read-write: ${JSON.stringify(bindPairs)}`);
      assert.match(warned, /overrides the sandbox deny-list/);
      assert.match(warned, new RegExp(sshDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("--ro-bind targeting a sandboxDenylist entry still binds read-only, but warns loudly that it overrides the deny-list", () => {
    const denied = roTarget();
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const mgr = makeManager({ ...baseManagerOpts, sandboxDenylist: [denied], roBind: [denied] });
      mgr.dispatch({ prompt: "hello", directory: launchDir() });
      const roPairs = pairsFor(captured.args, "--ro-bind");
      assert.ok(roPairs.some(([src]) => src === denied), `deny-listed path not bound read-only: ${JSON.stringify(roPairs)}`);
      assert.match(warned, /overrides the sandbox deny-list/);
      assert.match(warned, /bound read-only anyway/);
      assert.match(warned, new RegExp(denied.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("a deny-listed path in both rw and ro sets binds read-write with the rw override warning, not the ro one", () => {
    const denied = roTarget();
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const mgr = makeManager({ ...baseManagerOpts, sandboxDenylist: [denied], rwBind: [denied], roBind: [denied] });
      mgr.dispatch({ prompt: "hello", directory: launchDir() });
      const bindPairs = pairsFor(captured.args, "--bind");
      const roPairs = pairsFor(captured.args, "--ro-bind");
      assert.ok(bindPairs.some(([src]) => src === denied), `rw-wins path not bound rw: ${JSON.stringify(bindPairs)}`);
      assert.ok(!roPairs.some(([src]) => src === denied), `rw-wins path must not stay ro: ${JSON.stringify(roPairs)}`);
      assert.match(warned, /read-write wins/);
      assert.match(warned, /overrides the sandbox deny-list/);
      assert.ok(!warned.match(/bound read-only anyway/), `ro override warning must be suppressed when rw wins: ${warned}`);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("a path listed read-only via both --ro-bind and a project's read_only_paths warns exactly once when it also collides with --rw-bind", () => {
    const conflict = roTarget();
    const directory = launchDir();
    writeProjectReadOnlyPaths(directory, conflict);
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const mgr = makeManager({ ...baseManagerOpts, rwBind: [conflict], roBind: [conflict] });
      mgr.dispatch({ prompt: "hello", directory });
      const bindPairs = pairsFor(captured.args, "--bind");
      const roPairs = pairsFor(captured.args, "--ro-bind");
      assert.ok(bindPairs.some(([src]) => src === conflict), `rw-wins path not bound rw: ${JSON.stringify(bindPairs)}`);
      assert.ok(!roPairs.some(([src]) => src === conflict), `rw-wins path must not stay ro: ${JSON.stringify(roPairs)}`);
      const occurrences = (warned.match(/read-write wins/g) || []).length;
      assert.equal(occurrences, 1, `expected exactly one rw-wins warning for a path duplicated across --ro-bind and read_only_paths, got ${occurrences}: ${warned}`);
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});

// The two global bind lists, `roBind` and `rwBind`, follow one contract: the
// first layer that sets a list is the whole list. The tests that pin it run
// once per list so neither can drift from the other. `argvFlag` is the bwrap
// flag the list ends up as in the captured argv.
const BIND_LISTS = [
  { flag: "--ro-bind", key: "roBind", env: "TASKFERRY_RO_BIND", argvFlag: "--ro-bind", listName: "read-only" },
  { flag: "--rw-bind", key: "rwBind", env: "TASKFERRY_RW_BIND", argvFlag: "--bind", listName: "read-write" },
];

for (const { flag, key, env, argvFlag, listName } of BIND_LISTS) {
  describe(`bwrap sandboxing: ${flag} replaces the global ${listName} list instead of adding to it`, () => {
    // A bound path appears in the argv as `[flag, path, path]`.
    const bound = () => pairsFor(captured.args, argvFlag);
    const isBound = (target) => bound().some(([src, dest]) => src === target && dest === target);
    const dump = () => JSON.stringify(bound());

    test(`${flag} binds ${listName}, the manager option winning over env and config (replace, not union)`, (t) => {
      const managerDefault = roTarget();
      const envDir = roTarget();
      const configDir = roTarget();
      preserveEnvVars(t, [env]);
      process.env[env] = envDir;
      const mgr = makeManager({ ...baseManagerOpts, [key]: [managerDefault], config: { [key]: configDir } });
      mgr.dispatch({ prompt: "hello", directory: launchDir() });
      assert.ok(isBound(managerDefault), `manager default ${key} not bound: ${dump()}`);
      assert.ok(!isBound(envDir), `${env} must be replaced by the manager option: ${dump()}`);
      assert.ok(!isBound(configDir), `config ${key} must be replaced by the manager option: ${dump()}`);
    });

    test(`${env} replaces the config ${key} list`, (t) => {
      const envDir = roTarget();
      const configDir = roTarget();
      preserveEnvVars(t, [env]);
      process.env[env] = envDir;
      const mgr = makeManager({ ...baseManagerOpts, config: { [key]: configDir } });
      mgr.dispatch({ prompt: "hello", directory: launchDir() });
      assert.ok(isBound(envDir), `${env} not bound: ${dump()}`);
      assert.ok(!isBound(configDir), `config ${key} must be replaced by the env var: ${dump()}`);
    });

    test(`an empty ${env} is an explicit empty list: it replaces the config ${key} with nothing`, (t) => {
      const configDir = roTarget();
      preserveEnvVars(t, [env]);
      process.env[env] = "";
      const mgr = makeManager({ ...baseManagerOpts, config: { [key]: configDir } });
      mgr.dispatch({ prompt: "hello", directory: launchDir() });
      assert.ok(bound().length > 0, `sandbox must still carry its own ${listName} binds, or this test proves nothing`);
      assert.ok(!isBound(configDir), `config ${key} must be replaced by the empty env var: ${dump()}`);
    });

    test(`a per-dispatch ${flag} replaces the whole global list (manager option, env, config), it does not add to it`, (t) => {
      const managerDefault = roTarget();
      const envDir = roTarget();
      const configDir = roTarget();
      const perDispatch = roTarget();
      preserveEnvVars(t, [env]);
      process.env[env] = envDir;
      const mgr = makeManager({ ...baseManagerOpts, [key]: [managerDefault], config: { [key]: configDir } });
      mgr.dispatch({ prompt: "hello", directory: launchDir(), [key]: [perDispatch] });
      assert.ok(isBound(perDispatch), `per-dispatch ${key} not bound: ${dump()}`);
      for (const replaced of [managerDefault, envDir, configDir]) {
        assert.ok(!isBound(replaced), `${replaced} must be replaced by the per-dispatch list: ${dump()}`);
      }
    });

    test(`a per-dispatch empty ${flag} list binds none of the global list`, () => {
      const managerDefault = roTarget();
      const mgr = makeManager({ ...baseManagerOpts, [key]: [managerDefault] });
      mgr.dispatch({ prompt: "hello", directory: launchDir(), [key]: [] });
      assert.ok(bound().length > 0, `sandbox must still carry its own ${listName} binds, or this test proves nothing`);
      assert.ok(!isBound(managerDefault), `global ${key} must be replaced by the empty per-dispatch list: ${dump()}`);
    });

    test(`a dispatch with no ${key} of its own keeps the whole global list`, () => {
      const managerDefault = roTarget();
      const mgr = makeManager({ ...baseManagerOpts, [key]: [managerDefault] });
      mgr.dispatch({ prompt: "hello", directory: launchDir() });
      assert.ok(isBound(managerDefault), `global ${key} not bound: ${dump()}`);
    });

    test(`a per-dispatch ${flag} affects only that dispatch: the next one sees the global list again`, () => {
      const managerDefault = roTarget();
      const perDispatch = roTarget();
      const mgr = makeManager({ ...baseManagerOpts, [key]: [managerDefault] });
      mgr.dispatch({ prompt: "one", directory: launchDir(), [key]: [perDispatch] });
      mgr.dispatch({ prompt: "two", directory: launchDir() });
      assert.ok(isBound(managerDefault), `the next dispatch must see the global list again: ${dump()}`);
      assert.ok(!isBound(perDispatch), `the first dispatch's list must not carry over: ${dump()}`);
    });

    test(`a relative ${flag} path is resolved against the dispatch's launch directory`, () => {
      const target = roTarget();
      const directory = launchDir();
      const relative = path.relative(directory, target);
      assert.ok(!path.isAbsolute(relative) && relative.startsWith(".."), `fixture must be a relative path: ${relative}`);
      assert.ok(!fs.existsSync(path.resolve(relative)), "fixture must not exist relative to the process cwd, or this test proves nothing");
      const warned = captureStderr(() => {
        const mgr = makeManager({ ...baseManagerOpts });
        mgr.dispatch({ prompt: "hello", [key]: [relative], directory });
      });
      assert.ok(isBound(target), `relative ${key} not bound at its absolute path: ${dump()}`);
      assert.doesNotMatch(warned, /not found on this host/);
    });

    test("a path listed twice in the replacing list is bound once", () => {
      const target = roTarget();
      const mgr = makeManager({ ...baseManagerOpts });
      mgr.dispatch({ prompt: "hello", directory: launchDir(), [key]: [target, target] });
      assert.equal(bound().filter(([src]) => src === target).length, 1, `expected a single bind: ${dump()}`);
    });

    test(`a non-empty ${env} that names no path throws instead of silently binding nothing`, (t) => {
      const configDir = roTarget();
      preserveEnvVars(t, [env]);
      for (const blank of [" ", ",", " , "]) {
        process.env[env] = blank;
        assert.throws(
          () => makeManager({ ...baseManagerOpts, config: { [key]: configDir } }),
          (err) => err.message.includes(env) && err.message.includes(NAMES_NO_PATH) && err.message.includes(listName),
          `blank ${JSON.stringify(blank)} must be rejected`,
        );
      }
      process.env[env] = "";
      assert.doesNotThrow(() => makeManager({ ...baseManagerOpts, config: { [key]: configDir } }), "an empty string stays the explicit bind-none value");
    });

    test(`a non-empty config ${key} string that names no path throws, naming the config key`, () => {
      assert.throws(
        () => makeManager({ ...baseManagerOpts, config: { [key]: " , " } }),
        (err) => err.message.includes(`config ${key}`) && err.message.includes(NAMES_NO_PATH),
      );
    });

    test(`a manager ${key} option that names no path throws; a blank entry next to a real path is dropped`, () => {
      const configDir = roTarget();
      const real = roTarget();
      for (const blank of [[" "], [""], ["", " "]]) {
        assert.throws(
          () => makeManager({ ...baseManagerOpts, [key]: blank, config: { [key]: configDir } }),
          (err) => err.message.includes(`${key} option`) && err.message.includes(NAMES_NO_PATH),
          `blank ${JSON.stringify(blank)} must be rejected, not shadow the config list`,
        );
      }
      const mgr = makeManager({ ...baseManagerOpts, [key]: [" ", real], config: { [key]: configDir } });
      mgr.dispatch({ prompt: "hello", directory: launchDir() });
      assert.ok(isBound(real), `the real entry must bind: ${dump()}`);
      assert.ok(!isBound(configDir), `the manager option still replaces the config list: ${dump()}`);
    });

    test(`a per-dispatch ${flag} list that names no path throws instead of dropping the global list; a blank entry next to a real path is dropped`, () => {
      const managerDefault = roTarget();
      const real = roTarget();
      const mgr = makeManager({ ...baseManagerOpts, [key]: [managerDefault] });
      assert.throws(
        () => mgr.dispatch({ prompt: "hello", directory: launchDir(), [key]: [" "] }),
        (err) => err.message.includes(key) && err.message.includes(NAMES_NO_PATH),
      );
      mgr.dispatch({ prompt: "hello", directory: launchDir(), [key]: [" ", real] });
      assert.ok(isBound(real), `the real entry must bind: ${dump()}`);
      assert.ok(!isBound(managerDefault), `the per-dispatch list still replaces the global list: ${dump()}`);
    });
  });
}

describe("bwrap sandboxing: what a per-dispatch bind list does not replace", () => {
  test("the sandbox's own rw binds survive an empty per-dispatch --rw-bind (only the global list is replaced)", () => {
    const managerDefault = roTarget();
    const directory = launchDir();
    const mgr = makeManager({ ...baseManagerOpts, rwBind: [managerDefault] });
    const dispatched = mgr.dispatch({ prompt: "hello", rwBind: [], directory });
    const bindPairs = pairsFor(captured.args, "--bind");
    assert.ok(bindPairs.some(([src]) => src === directory), `launch directory must stay bound: ${JSON.stringify(bindPairs)}`);
    assert.ok(bindPairs.some(([src]) => src.endsWith(dispatched.id)), `the task's own output directory must stay bound: ${JSON.stringify(bindPairs)}`);
    assert.ok(!bindPairs.some(([src]) => src === managerDefault));
  });

  test("a per-dispatch --ro-bind does not replace the project's .taskferry.toml read_only_paths (the project layer stays additive)", () => {
    const managerDefault = roTarget();
    const projectDir = roTarget();
    const perDispatch = roTarget();
    const directory = launchDir();
    writeProjectReadOnlyPaths(directory, projectDir);
    const mgr = makeManager({ ...baseManagerOpts, roBind: [managerDefault] });
    mgr.dispatch({ prompt: "hello", roBind: [perDispatch], directory });
    const roPairs = pairsFor(captured.args, "--ro-bind");
    assert.ok(roPairs.some(([src]) => src === perDispatch), `per-dispatch roBind not bound: ${JSON.stringify(roPairs)}`);
    assert.ok(roPairs.some(([src]) => src === projectDir), `project read_only_paths must still bind: ${JSON.stringify(roPairs)}`);
    assert.ok(!roPairs.some(([src]) => src === managerDefault), `global roBind must be replaced: ${JSON.stringify(roPairs)}`);
  });
});

describe("bwrap sandboxing: --rw-bind and --ro-bind -- validation and deprecated aliases", () => {
  test("--ro-bind skips a nonexistent path with a warning, not a crash", () => {
    const missing = path.join(os.tmpdir(), "axi-ro-dir-does-not-exist");
    const real = roTarget();
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const mgr = makeManager({ ...baseManagerOpts, roBind: [missing, real] });
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

  test("--ro-bind skips a path overlapping a protected mount with a warning", () => {
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const mgr = makeManager({ ...baseManagerOpts });
      const protectedPath = path.join(mgr.paths.STATE_DIR, "prompts");
      mgr.dispatch({ prompt: "hello", directory: launchDir(), roBind: [protectedPath] });
      const roPairs = pairsFor(captured.args, "--ro-bind");
      assert.ok(!roPairs.some(([src]) => src === protectedPath), `protected path bound ro: ${JSON.stringify(roPairs)}`);
      assert.match(warned, /overlaps a protected sandbox mount, skipped/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("--ro-bind skips stateDir/runtimeDir/launchDirectory even when they also overlap the deny-list, with no override warning", () => {
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const mgr = makeManager({ ...baseManagerOpts });
      const directory = launchDir();
      // stateDir is in the default deny-list AND the structural protected
      // set; runtimeDir (stateDir/run) is a deny-list descendant. The
      // structural check must win for all three -- dropped, never overridden.
      const runtimeDir = path.join(mgr.paths.STATE_DIR, "run");
      fs.mkdirSync(runtimeDir, { recursive: true });
      mgr.dispatch({ prompt: "hello", roBind: [mgr.paths.STATE_DIR, runtimeDir, directory], directory });
      const roPairs = pairsFor(captured.args, "--ro-bind");
      for (const protectedPath of [mgr.paths.STATE_DIR, runtimeDir, directory]) {
        assert.ok(!roPairs.some(([src]) => src === protectedPath), `protected path bound ro: ${protectedPath} in ${JSON.stringify(roPairs)}`);
      }
      assert.match(warned, /overlaps a protected sandbox mount, skipped/);
      assert.ok(!warned.match(/overrides the sandbox deny-list/), `structural paths must not get the deny-list override warning: ${warned}`);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("--allowed-dirs and --rw-bind on one dispatch union into a single per-dispatch list that replaces the global one", () => {
    const viaNew = roTarget();
    const viaOld = roTarget();
    const managerDefault = roTarget();
    const mgr = makeManager({ ...baseManagerOpts, rwBind: [managerDefault] });
    mgr.dispatch({ prompt: "hello", directory: launchDir(), rwBind: [viaNew], allowedDirs: [viaOld] });
    const bindPairs = pairsFor(captured.args, "--bind");
    assert.ok(bindPairs.some(([src]) => src === viaNew));
    assert.ok(bindPairs.some(([src]) => src === viaOld));
    assert.ok(!bindPairs.some(([src]) => src === managerDefault), `global rwBind must be replaced: ${JSON.stringify(bindPairs)}`);
  });

  test("the deprecated TASKFERRY_ALLOWED_DIRS env var feeds the global rw list and warns at manager construction", (t) => {
    const viaEnv = roTarget();
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    preserveEnvVars(t, ["TASKFERRY_ALLOWED_DIRS"]);
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
    }
  });

  test("config allowedDirs (deprecated) and config rwBind share a layer, so both feed the global rw list", () => {
    const viaConfigOld = roTarget();
    const viaConfigNew = roTarget();
    const mgr = makeManager({ ...baseManagerOpts, config: { allowedDirs: viaConfigOld, rwBind: viaConfigNew } });
    mgr.dispatch({ prompt: "hello", directory: launchDir() });
    const bindPairs = pairsFor(captured.args, "--bind");
    assert.ok(bindPairs.some(([src]) => src === viaConfigOld));
    assert.ok(bindPairs.some(([src]) => src === viaConfigNew));
  });

  test("an empty value of the deprecated name is inert at every level: it never empties the list, and the layer falls through", (t) => {
    const configDir = roTarget();
    preserveEnvVars(t, ["TASKFERRY_ALLOWED_DIRS"]);
    const boundDirs = (opts) => {
      captureStderr(() => makeManager({ ...baseManagerOpts, ...opts }).dispatch({ prompt: "hello", directory: launchDir() }));
      return pairsFor(captured.args, "--bind").map(([src]) => src);
    };
    assert.ok(boundDirs({ config: { rwBind: configDir } }).includes(configDir), "control: the config list binds when nothing shadows it");
    process.env.TASKFERRY_ALLOWED_DIRS = "";
    assert.ok(boundDirs({ config: { rwBind: configDir } }).includes(configDir), "an empty TASKFERRY_ALLOWED_DIRS must not shadow config rwBind");
    delete process.env.TASKFERRY_ALLOWED_DIRS;
    assert.ok(boundDirs({ allowedDirs: [], config: { rwBind: configDir } }).includes(configDir), "an empty allowedDirs option must not shadow config rwBind");
    assert.ok(boundDirs({ config: { allowedDirs: "", rwBind: configDir } }).includes(configDir), "an empty config allowedDirs must not empty its own layer");
    assert.ok(!boundDirs({ rwBind: [], config: { rwBind: configDir } }).includes(configDir), "the new name keeps its empty form: rwBind [] does empty the list");
  });

  test("a per-dispatch allowedDirs warns that the name is deprecated, and an empty one leaves the global list alone", () => {
    const managerDefault = roTarget();
    const viaOld = roTarget();
    const mgr = makeManager({ ...baseManagerOpts, rwBind: [managerDefault] });
    const warned = captureStderr(() => mgr.dispatch({ prompt: "hello", directory: launchDir(), allowedDirs: [viaOld] }));
    assert.ok(pairsFor(captured.args, "--bind").some(([src]) => src === viaOld), "the deprecated per-dispatch list must still bind");
    assert.match(warned, /allowedDirs \/ --allowed-dirs is deprecated/);
    captureStderr(() => mgr.dispatch({ prompt: "hello", directory: launchDir(), allowedDirs: [] }));
    assert.ok(pairsFor(captured.args, "--bind").some(([src]) => src === managerDefault), "an empty allowedDirs must not replace the global list");
  });

  test("the deprecated config allowedDirs sits in the config layer: TASKFERRY_RW_BIND (a higher layer) replaces it, and it still warns", (t) => {
    const envDir = roTarget();
    const configOld = roTarget();
    preserveEnvVars(t, ["TASKFERRY_RW_BIND"]);
    process.env.TASKFERRY_RW_BIND = envDir;
    const warned = captureStderr(() => {
      const mgr = makeManager({ ...baseManagerOpts, config: { allowedDirs: configOld } });
      mgr.dispatch({ prompt: "hello", directory: launchDir() });
    });
    const bindPairs = pairsFor(captured.args, "--bind");
    assert.ok(bindPairs.some(([src]) => src === envDir), `TASKFERRY_RW_BIND not bound: ${JSON.stringify(bindPairs)}`);
    assert.ok(!bindPairs.some(([src]) => src === configOld), `config allowedDirs must be replaced by the env var: ${JSON.stringify(bindPairs)}`);
    assert.match(warned, /allowedDirs \/ --allowed-dirs is deprecated/, "a shadowed deprecated name must still warn");
  });
});

describe("bwrap sandboxing: an explicit --ro-bind instructions file is mapped to the executor's instructionsDest", () => {
  const instructionsExecutor = (instructionsDest) => makeFakeExecutor({
    id: "opencode",
    taskIdPrefix: "oc",
    errorBucketPrefix: "opencode",
    binaryName: "opencode",
    buildSpawnArgs: () => [],
    sandboxAuthFile: () => ({
      extraRoBinds: [],
      sandboxedDataHome: mkdtempTracked("axi-ro-datahome-"),
      sandboxEnv: {},
      ...(instructionsDest ? { instructionsDest } : {}),
    }),
  });
  // A directory holding one instructions file; returns the file's path.
  const instructionsFile = (name) => {
    const dir = roTarget();
    const file = path.join(dir, name);
    fs.writeFileSync(file, "be concise\n");
    return file;
  };
  const dest = "/sandbox/config/opencode/AGENTS.md";

  test("--ro-bind <dir>/AGENTS.md binds the file at its own path AND at the executor's instructionsDest", () => {
    const file = instructionsFile("AGENTS.md");
    const mgr = makeManager({ ...baseManagerOpts, defaultExecutor: instructionsExecutor(dest) });
    mgr.dispatch({ prompt: "hello", directory: launchDir(), roBind: [file] });
    const roPairs = pairsFor(captured.args, "--ro-bind");
    assert.ok(roPairs.some(([src, d]) => src === file && d === file), `own-path bind missing: ${JSON.stringify(roPairs)}`);
    assert.ok(roPairs.some(([src, d]) => src === file && d === dest), `instructionsDest mapping missing: ${JSON.stringify(roPairs)}`);
  });

  test("a file named CLAUDE.md is mapped to the same AGENTS.md destination", () => {
    const file = instructionsFile("CLAUDE.md");
    const mgr = makeManager({ ...baseManagerOpts, defaultExecutor: instructionsExecutor(dest) });
    mgr.dispatch({ prompt: "hello", directory: launchDir(), roBind: [file] });
    const roPairs = pairsFor(captured.args, "--ro-bind");
    assert.ok(roPairs.some(([src, d]) => src === file && d === dest), `CLAUDE.md not mapped: ${JSON.stringify(roPairs)}`);
  });

  test("the mapping also applies when the instructions file comes from the global list (TASKFERRY_RO_BIND)", (t) => {
    const file = instructionsFile("AGENTS.md");
    preserveEnvVars(t, ["TASKFERRY_RO_BIND"]);
    process.env.TASKFERRY_RO_BIND = file;
    const mgr = makeManager({ ...baseManagerOpts, defaultExecutor: instructionsExecutor(dest) });
    mgr.dispatch({ prompt: "hello", directory: launchDir() });
    const roPairs = pairsFor(captured.args, "--ro-bind");
    assert.ok(roPairs.some(([src, d]) => src === file && d === dest), `env-listed AGENTS.md not mapped: ${JSON.stringify(roPairs)}`);
  });

  test("AGENTS.md wins over CLAUDE.md when both are listed, and the loser is reported, not mapped", () => {
    const agents = instructionsFile("AGENTS.md");
    const claude = instructionsFile("CLAUDE.md");
    const warned = captureStderr(() => {
      const mgr = makeManager({ ...baseManagerOpts, defaultExecutor: instructionsExecutor(dest) });
      mgr.dispatch({ prompt: "hello", directory: launchDir(), roBind: [claude, agents] });
    });
    const roPairs = pairsFor(captured.args, "--ro-bind");
    assert.ok(roPairs.some(([src, d]) => src === agents && d === dest), `AGENTS.md not mapped: ${JSON.stringify(roPairs)}`);
    assert.ok(!roPairs.some(([src, d]) => src === claude && d === dest), `CLAUDE.md must not also be mapped: ${JSON.stringify(roPairs)}`);
    assert.ok(roPairs.some(([src, d]) => src === claude && d === claude), "the loser still binds at its own path");
    assert.match(warned, new RegExp(claude.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(warned, /only one instructions file/);
  });

  test("other file names and a directory named AGENTS.md are not mapped", () => {
    const notes = instructionsFile("NOTES.md");
    const dirNamedAgents = path.join(roTarget(), "AGENTS.md");
    fs.mkdirSync(dirNamedAgents);
    const mgr = makeManager({ ...baseManagerOpts, defaultExecutor: instructionsExecutor(dest) });
    mgr.dispatch({ prompt: "hello", directory: launchDir(), roBind: [notes, dirNamedAgents] });
    const roPairs = pairsFor(captured.args, "--ro-bind");
    assert.ok(roPairs.some(([src, d]) => src === notes && d === notes), `NOTES.md not bound at its own path: ${JSON.stringify(roPairs)}`);
    assert.ok(roPairs.some(([src, d]) => src === dirNamedAgents && d === dirNamedAgents), `AGENTS.md directory not bound at its own path: ${JSON.stringify(roPairs)}`);
    assert.ok(!roPairs.some(([, d]) => d === dest), `nothing should be mapped to instructionsDest: ${JSON.stringify(roPairs)}`);
  });

  test("two different files with the same name: the first listed is mapped, the other is reported and left at its own path", () => {
    const first = instructionsFile("AGENTS.md");
    const second = instructionsFile("AGENTS.md");
    const warned = captureStderr(() => {
      const mgr = makeManager({ ...baseManagerOpts, defaultExecutor: instructionsExecutor(dest) });
      mgr.dispatch({ prompt: "hello", directory: launchDir(), roBind: [first, second] });
    });
    const roPairs = pairsFor(captured.args, "--ro-bind");
    assert.ok(roPairs.some(([src, d]) => src === first && d === dest), `first-listed AGENTS.md not mapped: ${JSON.stringify(roPairs)}`);
    assert.ok(!roPairs.some(([src, d]) => src === second && d === dest), `second AGENTS.md must not be mapped: ${JSON.stringify(roPairs)}`);
    assert.ok(roPairs.some(([src, d]) => src === second && d === second), "the second still binds at its own path");
    assert.ok(warned.includes(`not mapping ${second}`), `warning must name the unmapped file: ${warned}`);
  });

  test("an instructions file named only in the project's .taskferry.toml binds at its own path and is not mapped", () => {
    const file = instructionsFile("AGENTS.md");
    const directory = launchDir();
    writeProjectReadOnlyPaths(directory, file);
    const mgr = makeManager({ ...baseManagerOpts, defaultExecutor: instructionsExecutor(dest) });
    mgr.dispatch({ prompt: "hello", directory });
    const roPairs = pairsFor(captured.args, "--ro-bind");
    assert.ok(roPairs.some(([src, d]) => src === file && d === file), `project-layer file must still bind at its own path: ${JSON.stringify(roPairs)}`);
    assert.ok(!roPairs.some(([, d]) => d === dest), `project-layer file must not be mapped to instructionsDest: ${JSON.stringify(roPairs)}`);
  });

  test("the same instructions file listed twice is one file: mapped once, no rival warning", () => {
    const file = instructionsFile("AGENTS.md");
    const warned = captureStderr(() => {
      const mgr = makeManager({ ...baseManagerOpts, defaultExecutor: instructionsExecutor(dest) });
      mgr.dispatch({ prompt: "hello", directory: launchDir(), roBind: [file, file] });
    });
    const roPairs = pairsFor(captured.args, "--ro-bind");
    assert.equal(roPairs.filter(([src, d]) => src === file && d === dest).length, 1, `expected exactly one mapping: ${JSON.stringify(roPairs)}`);
    assert.equal(roPairs.filter(([src, d]) => src === file && d === file).length, 1, `expected exactly one own-path bind: ${JSON.stringify(roPairs)}`);
    assert.doesNotMatch(warned, /only one instructions file/);
  });

  test("a FIFO named AGENTS.md is not mapped: the harness would block opening it", () => {
    const fifo = path.join(roTarget(), "AGENTS.md");
    execFileSync("mkfifo", [fifo]);
    assert.ok(fs.statSync(fifo).isFIFO(), "fixture must be a real FIFO, or this test proves nothing");
    const mgr = makeManager({ ...baseManagerOpts, defaultExecutor: instructionsExecutor(dest) });
    mgr.dispatch({ prompt: "hello", directory: launchDir(), roBind: [fifo] });
    const roPairs = pairsFor(captured.args, "--ro-bind");
    assert.ok(roPairs.some(([src, d]) => src === fifo && d === fifo), `FIFO still binds at its own path: ${JSON.stringify(roPairs)}`);
    assert.ok(!roPairs.some(([, d]) => d === dest), `a FIFO must not be mapped to instructionsDest: ${JSON.stringify(roPairs)}`);
  });

  test("an instructions file that is also --rw-bind'ed is promoted: read-write wins, and the mapped destination becomes writable too", () => {
    const file = instructionsFile("AGENTS.md");
    const warned = captureStderr(() => {
      const mgr = makeManager({ ...baseManagerOpts, defaultExecutor: instructionsExecutor(dest) });
      mgr.dispatch({ prompt: "hello", directory: launchDir(), roBind: [file], rwBind: [file] });
    });
    assert.match(warned, /read-write wins/);
    const bindPairs = pairsFor(captured.args, "--bind");
    const roPairs = pairsFor(captured.args, "--ro-bind");
    assert.ok(bindPairs.some(([src, d]) => src === file && d === dest), `mapped destination must be writable: ${JSON.stringify(bindPairs)}`);
    assert.ok(!roPairs.some(([src]) => src === file), `no read-only bind of the file may remain: ${JSON.stringify(roPairs)}`);
  });

  test("an executor with no instructionsDest (pi) gets the file at its own path only", () => {
    const file = instructionsFile("AGENTS.md");
    const mgr = makeManager({ ...baseManagerOpts, defaultExecutor: instructionsExecutor(null) });
    mgr.dispatch({ prompt: "hello", directory: launchDir(), roBind: [file] });
    const roPairs = pairsFor(captured.args, "--ro-bind");
    assert.ok(roPairs.some(([src, d]) => src === file && d === file), `own-path bind missing: ${JSON.stringify(roPairs)}`);
    assert.equal(roPairs.filter(([src]) => src === file).length, 1, `only the own-path bind expected: ${JSON.stringify(roPairs)}`);
  });
});
