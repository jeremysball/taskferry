import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { makeManager, fakeChild, preserveEnvVars, baseTask, mkdtempTracked, TASKS_STATE_FILE } from "./tasks.test-helpers.js";
import { uvDirPath } from "./tasks.js";

// A bwrap-shaped fake child with separate stdout/stderr streams and a real
// pid, distinct from fakeChild() (which only wires stdout) -- the gate reads
// both streams, so tests need both to exist as EventEmitters.
function fakeGateChild(pid = 9000) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// A gate child whose output pipes behave like real streams (readableEnded
// starts false), so settlement has to wait for 'close' to read the tail.
function pipedGateChild(pid = 9001) {
  const child = fakeGateChild(pid);
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function dispatchAndSettleWithChanges({ directory, spawns, cacheDir, sandboxEnabled = true, gateChildFactory = fakeGateChild, env, managerOptions = {}, onWorkerSpawn }) {
  const mgr = makeManager({
    spawnFn: (cmd, args, opts) => {
      const child = spawns.length === 0 ? fakeChild() : gateChildFactory();
      spawns.push({ cmd, args, opts, child });
      if (spawns.length === 1) onWorkerSpawn?.();
      return child;
    },
    // buildManagerOptions() defaults overlayEnabled to false -- without this,
    // task.overlayDirs never gets set, startCheckGate's `!task.overlayDirs`
    // guard always no-ops, and every test below would see only one spawn.
    overlayEnabled: true,
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    // Without this injection, the manager probes bwrap's overlay support at
    // startup against the host -- which fails in this CI sandbox (no real
    // bwrap), so requireOverlayCapability() throws and the dispatch never
    // gets far enough for the gate to be a thing. Injecting "supported"
    // mirrors tasks.changeset.test.js's existing convention.
    checkOverlaySupportFn: () => ({ supported: true }),
    platform: "linux",
    runOverlayCommandFn: (command, args) => {
      // Simulate a real changeset: `git diff` (or the sh -c wrapper extraction
      // uses) reports non-empty output so extraction sets changesetStatus to
      // "pending" and startCheckGate() gets a chance to run.
      if (command === "bwrap") return { status: 0, stdout: FAKE_GATE_DIFF, stderr: "" };
      // resolvePreDispatchHead() (src/changeset.js) probes `git -C <dir>
      // rev-parse HEAD` through this same fn -- without a non-empty stdout
      // preDispatchHead stays null, isGitTarget in extractChangesetForTaskRecord
      // is false, and the hasChanges branch the gate is wired into never
      // runs. The post-extraction assertNoHeadDrift() re-check fires the same
      // probe again with the same shape; one branch handles both.
      if (args?.[0] === "-C") return { status: 0, stdout: FAKE_PRE_DISPATCH_HEAD, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    cacheDir,
    sandboxEnabled,
    ...managerOptions,
  });
  const dispatched = mgr.dispatch({ model: FAKE_GATE_MODEL, executor: "opencode", prompt: "hello", directory, env });
  spawns[0].child.emit("exit", 0, null); // settles the worker; extraction + startCheckGate run synchronously off this
  return { mgr, dispatched };
}
const FAKE_PRE_DISPATCH_HEAD = "abc123\n";
const FAKE_GATE_DIFF = "diff --git a/f b/f\n+changed\n";
const FAKE_GATE_MODEL = "opencode-go/minimax-m3";
const FAKE_GATE_CONFIG = `check = "npm test"\n`;
const TASKFERRY_CONFIG_FILENAME = ".taskferry.toml";
const ROTATED_ENV_VAR = "AXI_GATE_ROTATED";
const ROTATED_ENV_BEFORE = "before-rotation";
const ROTATED_ENV_AFTER = "after-rotation";

describe("startCheckGate", () => {
  test("no .taskferry.toml: checkStatus stays 'none', no second spawn", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-none-"));
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ spawns, directory });
    assert.equal(spawns.length, 1); // only the worker spawn, no gate spawn
    assert.equal(mgr.status(dispatched.id).checkStatus, undefined); // "none" is never surfaced
  });

  test("a declared check command spawns a second bwrap invocation over the same overlay after extraction", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-spawn-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ spawns, directory });
    assert.equal(spawns.length, 2);
    assert.equal(spawns[1].cmd, "bwrap");
    assert.ok(spawns[1].args.includes("npm test"));
    assert.equal(mgr.status(dispatched.id).checkStatus, "running");
  });
});

describe("startCheckGate environment parity", () => {
  test("the gate inherits the worker's caller-forwarded PATH and tool config", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-caller-env-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), "check = \"fake-check-tool\"\n");
    const fakeBin = path.join(directory, "caller-tool-bin");
    // Only the caller's shell knows where its tool shims live (mise, uv,
    // nvm, ...). The worker must find the fake tool through that PATH, and
    // the later check gate must see the same PATH rather than falling back
    // to the daemon's ambient one.
    const callerPath = `${fakeBin}${path.delimiter}${process.env.PATH}`;
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({
      spawns,
      directory,
      env: { PATH: callerPath, AXI_GATE_TOOL_DIR: fakeBin },
    });

    assert.equal(spawns.length, 2);
    assert.equal(spawns[0].opts.env.PATH, callerPath, "worker spawn must use the caller-forwarded PATH");
    assert.equal(spawns[1].opts.env.PATH, callerPath, "check gate must use the same caller-forwarded PATH as the worker");
    assert.equal(spawns[1].opts.env.AXI_GATE_TOOL_DIR, fakeBin, "check gate must inherit the caller's tool config");
    assert.equal(mgr.status(dispatched.id).checkStatus, "running");
  });

  test("the gate applies the same env denylist as the worker", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-denylist-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    dispatchAndSettleWithChanges({
      spawns,
      directory,
      env: { AXI_GATE_DENIED: "must-not-reach-child", AXI_GATE_ALLOWED: "ok" },
      managerOptions: { envDenylistSpec: "AXI_GATE_DENIED" },
    });

    for (const spawn of spawns) {
      assert.equal("AXI_GATE_DENIED" in spawn.opts.env, false, `${spawn.cmd} spawn must not receive a denylisted var`);
      assert.equal(spawn.opts.env.AXI_GATE_ALLOWED, "ok");
    }
  });

  test("the gate strips TASKFERRY_* control vars while the worker keeps its own markers", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-control-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    const { dispatched } = dispatchAndSettleWithChanges({
      spawns,
      directory,
      env: {
        TASKFERRY_CHILD: "caller-child",
        TASKFERRY_TASK_ID: "caller-task-id",
        TASKFERRY_OUTPUT_DIR: "/tmp/caller-output",
        AXI_GATE_KEEP: "yes",
      },
    });

    assert.equal(spawns[0].opts.env.TASKFERRY_CHILD, "1");
    assert.equal(spawns[0].opts.env.TASKFERRY_TASK_ID, dispatched.id);
    assert.equal(spawns[1].opts.env.AXI_GATE_KEEP, "yes");
    assert.deepEqual(
      Object.keys(spawns[1].opts.env).filter((key) => key.startsWith("TASKFERRY_")),
      [],
      "the gate is an internal verification spawn, not a dispatched ferry: no TASKFERRY_* control marker may leak into it",
    );
  });
});

describe("startCheckGate environment precedence", () => {
  test("the gate keeps envFile below daemon ambient below caller precedence", (t) => {
    preserveEnvVars(t, ["AXI_GATE_AMBIENT", "AXI_GATE_CALLER", "AXI_GATE_FILE_ONLY"]);
    process.env.AXI_GATE_AMBIENT = "ambient";
    process.env.AXI_GATE_CALLER = "ambient";
    delete process.env.AXI_GATE_FILE_ONLY;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-precedence-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    dispatchAndSettleWithChanges({
      spawns,
      directory,
      env: { AXI_GATE_CALLER: "caller" },
      managerOptions: {
        envFileVars: {
          AXI_GATE_AMBIENT: "file",
          AXI_GATE_CALLER: "file",
          AXI_GATE_FILE_ONLY: "file",
        },
      },
    });

    for (const spawn of spawns) {
      assert.equal(spawn.opts.env.AXI_GATE_AMBIENT, "ambient", `${spawn.cmd} must see daemon ambient above the env file`);
      assert.equal(spawn.opts.env.AXI_GATE_CALLER, "caller", `${spawn.cmd} must see caller above daemon ambient`);
      assert.equal(spawn.opts.env.AXI_GATE_FILE_ONLY, "file", `${spawn.cmd} must see env-file-only values`);
    }
  });

  test("the gate still overrides caller/ambient UV dirs with the per-task check dirs", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-uv-caller-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), "check = \"uv run pytest\"\n");
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-uv-caller-cache-"));
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({
      spawns,
      directory,
      cacheDir,
      env: { UV_CACHE_DIR: "/tmp/caller-uv-cache", UV_TOOL_DIR: "/tmp/caller-uv-tools" },
    });
    const uvCacheDir = uvDirPath(cacheDir, mgr.paths.STATE_DIR, dispatched.id, "uv-cache");
    const uvToolsDir = uvDirPath(cacheDir, mgr.paths.STATE_DIR, dispatched.id, "uv-tools");

    assert.equal(spawns[1].opts.env.UV_CACHE_DIR, uvCacheDir);
    assert.equal(spawns[1].opts.env.UV_TOOL_DIR, uvToolsDir);
  });

  test("the gate's caller-env snapshot is not persisted as a new task field", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-no-persist-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const secret = `s3cr3t-${Date.now()}`;
    const spawns = [];
    const { mgr } = dispatchAndSettleWithChanges({
      spawns,
      directory,
      env: { AXI_GATE_SECRET: secret },
    });
    mgr.flushPersist();
    const persisted = JSON.parse(fs.readFileSync(path.join(mgr.paths.STATE_DIR, TASKS_STATE_FILE), "utf8"));
    const record = persisted.find((task) => task.checkStatus === "running");
    assert.ok(record, "expected the dispatching task to be persisted");
    // The pre-existing resumeEnv field is the only caller-env copy tasks.json
    // has ever carried; the same-process launch snapshot must stay in memory
    // and add no second on-disk copy.
    const envFields = Object.keys(record).filter((key) => /env/i.test(key)).sort();
    assert.deepEqual(envFields, ["resumeEnv"]);
    assert.equal(record.resumeEnv.AXI_GATE_SECRET, secret);
  });

});

describe("startCheckGate launcher identity", () => {
  test("uses daemon-resolved absolute bwrap and sh even when the caller's PATH shadows both", () => {
    const directory = mkdtempTracked("axi-gate-launcher-");
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), "check = \"printf trusted\"\n");
    const trustedBin = mkdtempTracked("axi-gate-trusted-bin-");
    const callerBin = mkdtempTracked("axi-gate-caller-bin-");
    const trustedBwrap = path.join(trustedBin, "bwrap");
    const trustedSh = path.join(trustedBin, "sh");
    const callerBwrap = path.join(callerBin, "bwrap");
    const callerSh = path.join(callerBin, "sh");
    for (const file of [trustedBwrap, trustedSh, callerBwrap, callerSh]) {
      fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    const spawns = [];
    dispatchAndSettleWithChanges({
      spawns,
      directory,
      env: { PATH: `${callerBin}${path.delimiter}${process.env.PATH}` },
      managerOptions: {
        resolveSandboxLaunchersFn: () => ({
          bwrapPath: fs.realpathSync(trustedBwrap),
          shellPath: fs.realpathSync(trustedSh),
        }),
      },
    });

    assert.equal(spawns.length, 2);
    assert.equal(spawns[0].cmd, fs.realpathSync(trustedBwrap), "the worker must spawn the daemon-resolved bwrap, not a caller-PATH shim");
    assert.equal(spawns[1].cmd, fs.realpathSync(trustedBwrap), "the gate must spawn the daemon-resolved bwrap, not a caller-PATH shim");
    const separator = spawns[1].args.lastIndexOf("--");
    assert.notEqual(separator, -1, "expected the gate bwrap argv to contain the command separator");
    assert.equal(spawns[1].args[separator + 1], fs.realpathSync(trustedSh), "the gate must execute the daemon-resolved absolute sh, not a caller-PATH shim");
    assert.equal(spawns[1].args[separator + 2], "-c");
  });
});

describe("startCheckGate launch-env lifetime", () => {
  test("a no-overlay/non-gate settle drops the launch-env snapshot on the shared settle path", () => {
    const directory = mkdtempTracked("axi-gate-no-overlay-");
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    const originalWeakMap = globalThis.WeakMap;
    const operations = [];
    class TrackingWeakMap extends originalWeakMap {
      set(key, value) {
        operations.push({ op: "set", key });
        return super.set(key, value);
      }
      delete(key) {
        operations.push({ op: "delete", key });
        return super.delete(key);
      }
    }
    globalThis.WeakMap = TrackingWeakMap;
    let mgr;
    try {
      // No sandbox/overlay: extraction returns before its own cleanup, so
      // only finishChildSettlement can drain this entry.
      mgr = makeManager({
        spawnFn: (cmd, args, opts) => {
          const child = fakeChild();
          spawns.push({ cmd, args, opts, child });
          return child;
        },
        sandboxEnabled: false,
        overlayEnabled: false,
        platform: "linux",
      });
      const dispatched = mgr.dispatch({
        model: FAKE_GATE_MODEL,
        executor: "opencode",
        prompt: "hello",
        env: { AXI_NO_CHANGE_SECRET: "must-not-linger" },
        directory,
      });
      const setKeys = operations.filter((entry) => entry.op === "set").map((entry) => entry.key);
      assert.equal(setKeys.length > 0, true, "the worker launch must record its launch env");
      spawns[0].child.emit("exit", 0, null);
      assert.equal(spawns.length, 1, "a no-overlay settle must not start a gate");
      assert.notEqual(mgr.status(dispatched.id).checkStatus, "running");
      const deleted = operations.some((entry) => entry.op === "delete" && setKeys.includes(entry.key));
      assert.equal(deleted, true, "the shared settle path must delete the launch-env entry to avoid retaining caller secrets");
    } finally {
      mgr?.close();
      globalThis.WeakMap = originalWeakMap;
    }
  });
});

describe("startCheckGate restart parity", () => {
  test("a gate re-run after daemon restart reuses the persisted caller env", () => {
    const directory = mkdtempTracked("axi-gate-restart-dir-");
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), "check = \"true\"\n");
    const overlayTmpRoot = mkdtempTracked("axi-gate-restart-overlay-");
    const overlayRoot = path.join(overlayTmpRoot, "taskferry-cow-oc_gate_restart");
    fs.mkdirSync(path.join(overlayRoot, "upper", "main"), { recursive: true });
    fs.mkdirSync(path.join(overlayRoot, "work", "main"), { recursive: true });
    const callerPath = `/caller/restart-bin${path.delimiter}${process.env.PATH}`;
    const secret = `restart-secret-${Date.now()}`;
    const spawns = [];
    const mgr = makeManager({
      tasksFixture: [{
        ...baseTask({ id: "oc_gate_restart", directory }),
        role: "dispatch",
        changesetStatus: "pending",
        preDispatchHead: "abc123",
        checkStatus: "running",
        checkCommand: "true",
        overlayDirs: {
          root: overlayRoot,
          tmpRoot: overlayTmpRoot,
          upperDir: path.join(overlayRoot, "upper", "main"),
          workDir: path.join(overlayRoot, "work", "main"),
          rwBinds: [],
        },
        resumeEnv: { PATH: callerPath, AXI_GATE_RESTART_SECRET: secret },
      }],
      spawnFn: (cmd, args, opts) => {
        const child = fakeGateChild();
        spawns.push({ cmd, args, opts, child });
        return child;
      },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });

    assert.equal(spawns.length, 1, "the interrupted gate must auto-rerun exactly once");
    assert.equal(spawns[0].opts.env.PATH, callerPath, "restart gate must use the caller PATH persisted in resumeEnv");
    assert.equal(spawns[0].opts.env.AXI_GATE_RESTART_SECRET, secret, "restart gate must use the caller secrets persisted in resumeEnv");
    assert.equal(mgr.status("oc_gate_restart").checkStatus, "running");
  });
});

describe("startCheckGate launch-time environment immutability", () => {
  test("the gate keeps the env-file values captured at worker launch even if the file reloads before extraction", () => {
    const directory = mkdtempTracked("axi-gate-envfile-frozen-");
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    let reload;
    const spawns = [];
    dispatchAndSettleWithChanges({
      spawns,
      directory,
      managerOptions: {
        envFilePath: "/nonexistent/caller-secrets.env",
        loadEnvFileFn: () => ({ [ROTATED_ENV_VAR]: ROTATED_ENV_BEFORE }),
        watchEnvFileFn: (_envFilePath, { onReload }) => {
          reload = onReload;
          return { close() {} };
        },
      },
      onWorkerSpawn: () => reload({ [ROTATED_ENV_VAR]: ROTATED_ENV_AFTER }),
    });

    assert.equal(spawns.length, 2);
    assert.equal(spawns[0].opts.env[ROTATED_ENV_VAR], ROTATED_ENV_BEFORE, "the worker must use the launch-time env-file values");
    assert.equal(spawns[1].opts.env[ROTATED_ENV_VAR], ROTATED_ENV_BEFORE, "the gate must not silently rebuild from the reloaded env file");
  });

  test("a caller mutating its env object after dispatch cannot change the gate's frozen snapshot", () => {
    const directory = mkdtempTracked("axi-gate-env-mutation-");
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const originalPath = `/original/bin${path.delimiter}${process.env.PATH}`;
    const callerEnv = { PATH: originalPath, AXI_GATE_MUTABLE_SECRET: "original" };
    const spawns = [];
    dispatchAndSettleWithChanges({
      spawns,
      directory,
      env: callerEnv,
      onWorkerSpawn: () => {
        callerEnv.PATH = "/mutated/bin";
        callerEnv.AXI_GATE_MUTABLE_SECRET = "mutated";
      },
    });

    assert.equal(spawns.length, 2);
    assert.equal(spawns[0].opts.env.PATH, originalPath);
    assert.equal(spawns[1].opts.env.PATH, originalPath, "the gate must see the queued env snapshot, not the caller's later mutation");
    assert.equal(spawns[1].opts.env.AXI_GATE_MUTABLE_SECRET, "original", "the gate must not see caller mutations made after dispatch");
  });
});

describe("startCheckGate uv dirs", () => {
  test("the gate's bwrap re-binds the worker's per-task uv cache/tool dirs and re-points the env at them (taskferry#426)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-uv-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), "check = \"uv run pytest\"\n");
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-uv-cache-"));
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ spawns, directory, cacheDir });
    const uvCacheDir = uvDirPath(cacheDir, mgr._stateDir, dispatched.id, "uv-cache");
    const uvToolsDir = uvDirPath(cacheDir, mgr._stateDir, dispatched.id, "uv-tools");
    // The worker's bwrap argv carried the same dirs (assessed on spawn[0]).
    const [worker, gate] = spawns;
    for (const dir of [uvCacheDir, uvToolsDir]) {
      const gateBind = gate.args.indexOf(dir);
      assert.notEqual(gateBind, -1, `expected gate bwrap to bind ${dir}`);
      assert.equal(gate.args[gateBind - 1], "--bind");
      const workerBind = worker.args.indexOf(dir);
      assert.notEqual(workerBind, -1, `expected worker bwrap to bind ${dir}`);
      assert.equal(worker.args[workerBind - 1], "--bind");
    }
    assert.equal(gate.opts.env.UV_CACHE_DIR, uvCacheDir);
    assert.equal(gate.opts.env.UV_TOOL_DIR, uvToolsDir);
  });

});

describe("startCheckGate settlement", () => {
  test("exit 0 settles checkStatus 'passed' with exit code recorded", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-pass-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ spawns, directory });
    spawns[1].child.stdout.emit("data", Buffer.from("all good\n"));
    spawns[1].child.emit("exit", 0, null);
    const status = mgr.status(dispatched.id);
    assert.equal(status.checkStatus, "passed");
    assert.equal(status.checkExitCode, 0);
  });

  test("nonzero exit settles checkStatus 'failed' and captures the last 40 lines of combined output", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-fail-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ spawns, directory });
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    spawns[1].child.stdout.emit("data", Buffer.from(lines));
    spawns[1].child.emit("exit", 1, null);
    const status = mgr.status(dispatched.id);
    assert.equal(status.checkStatus, "failed");
    assert.equal(status.checkExitCode, 1);
    const detail = mgr.result(dispatched.id, { fields: ["checkOutputTail"] });
    assert.equal(detail.checkOutputTail.split("\n").length, 40);
    assert.ok(detail.checkOutputTail.startsWith("line 10"));
  });

  test("a timed-out gate is killed and settles checkStatus 'timeout'", { concurrency: false }, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-timeout-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), `check = "npm test"\ncheck_timeout_seconds = 5\n`);
    const spawns = [];
    const signals = [];
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { const child = spawns.length === 0 ? fakeChild() : fakeGateChild(); spawns.push({ cmd, args, opts, child }); return child; },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      // buildManagerOptions() only forwards `killFn` to createTaskManager,
      // not a `sendSignal` option -- the internal `sendSignal` binding wraps
      // sendSignalToProcess(pid, signal, { killFn: ctx.opts.killFn }), so the
      // fake must be injected at that seam or it's silently ignored and the
      // real default killFn (which throws) fires instead.
      killFn: (pid, signal) => signals.push({ pid, signal }),
      runOverlayCommandFn: (command, args) => {
        if (command === "bwrap") return { status: 0, stdout: FAKE_GATE_DIFF, stderr: "" };
        if (args?.[0] === "-C") return { status: 0, stdout: FAKE_PRE_DISPATCH_HEAD, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
const dispatched = mgr.dispatch({ model: FAKE_GATE_MODEL, executor: "opencode", prompt: "hello", directory });
    spawns[0].child.emit("exit", 0, null);
    t.mock.timers.tick(5000);
    assert.ok(signals.some((s) => s.signal === "SIGTERM"));
    // sendSignalToProcess tries the process-group form first (negative pid) --
    // this only reaches the sandboxed workload at all because the gate is
    // spawned `detached: true` (Step 3). A positive-pid-only signal here
    // would mean the fix regressed back to killing just the bwrap monitor.
    assert.ok(signals.some((s) => s.signal === "SIGTERM" && s.pid < 0), `expected a process-group SIGTERM (negative pid), got ${JSON.stringify(signals)}`);
    assert.ok(spawns[1].opts.detached === true, "gate child must be spawned detached so group-kill can reach it");
    spawns[1].child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).checkStatus, "timeout");
  });

});

describe("startCheckGate output capture", () => {
  test("the tail is snapshotted after stdout closes, not at exit, so the last failure line survives", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-drain-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    const gate = pipedGateChild();
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ spawns, directory, gateChildFactory: () => gate });
    gate.emit("exit", 1, null);
    gate.stdout.emit("data", Buffer.from("error before exit\n"));
    gate.stdout.emit("data", Buffer.from("error after exit\n"));
    gate.emit("close", 1, null);
    const detail = mgr.result(dispatched.id, { fields: ["checkStatus", "checkOutputTail"] });
    assert.equal(detail.checkStatus, "failed");
    assert.match(detail.checkOutputTail, /error after exit/);
  });

  test("a failed gate with a trailing newline captures the last 40 real lines, not 39 lines plus a trailing blank", () => {
    // Regression: lastLines(text) used to `text.split("\n").slice(-n)`, which
    // counts the final empty string after a trailing "\n" as a line -- so 45
    // real lines + "\n" returned 39 lines + a trailing "" instead of all 40
    // of lines 5..44. Real child-process output always ends with "\n", so
    // the bug dropped one real line off every failing gate's tail.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-trailing-newline-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ spawns, directory });
    const lines = Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n") + "\n";
    spawns[1].child.stdout.emit("data", Buffer.from(lines));
    spawns[1].child.emit("exit", 1, null);
    const detail = mgr.result(dispatched.id, { fields: ["checkOutputTail"] });
    assert.equal(detail.checkOutputTail.split("\n").length, 40);
    assert.ok(detail.checkOutputTail.startsWith("line 5"), `expected the 40-line tail to start at "line 5", got: ${JSON.stringify(detail.checkOutputTail.slice(0, 40))}`);
    assert.ok(detail.checkOutputTail.endsWith("line 44"), `expected the tail to include the last real line "line 44", got: ${JSON.stringify(detail.checkOutputTail.slice(-40))}`);
    assert.ok(!detail.checkOutputTail.endsWith("\n"), `expected no trailing blank line, got a tail ending with newline`);
  });

  test("a chatty gate emitting 4-byte UTF-8 output is capped by real byte count, not UTF-16 code units", () => {
    // Regression: appendBoundedOutput measured by String.length (UTF-16 code
    // units). A 4-byte UTF-8 char like 🎉 is 2 UTF-16 units, so a check
    // command spamming emoji could grow to ~2x the intended 256 KiB byte
    // budget before the cap engaged. Verify the byte count of the resulting
    // checkOutputTail stays under CHECK_GATE_OUTPUT_CAP_BYTES, and that the
    // string is still valid (the byte-level cut may land mid-codepoint; the
    // tolerant UTF-8 decoder must not throw).
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-utf8-cap-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ spawns, directory });
    // Each 🎉 is 4 UTF-8 bytes / 2 UTF-16 code units. 70000 * 4 = 280000
    // bytes, comfortably over the 256 KiB cap. Emit in chunks to exercise
    // the append path too, not just the trim path.
    const emoji = "🎉";
    const chunk = emoji.repeat(1000);
    for (let i = 0; i < 70; i++) spawns[1].child.stdout.emit("data", Buffer.from(chunk, "utf8"));
    spawns[1].child.emit("exit", 1, null);
    const detail = mgr.result(dispatched.id, { fields: ["checkOutputTail"] });
    const bytes = Buffer.byteLength(detail.checkOutputTail, "utf8");
    // Cap is enforced on real UTF-8 bytes, not on String.length (which
    // would let the tail grow to ~512 KiB before tripping).
    assert.ok(bytes <= 256 * 1024, `expected at most 256 KiB of UTF-8 bytes, got ${bytes}`);
    // The byte-level cut can land mid-codepoint; Buffer.toString("utf8") on
    // a Buffer.from(..., "utf8") with a multi-byte cut uses the tolerant
    // replacement decoder by default -- a non-throwing result here proves
    // the round-trip is well-formed as a JS string.
    assert.equal(typeof detail.checkOutputTail, "string");
    // The cap trimmed the front, so the tail must still be entirely emoji
    // (or the Unicode replacement char at a mid-codepoint byte-cut). Use
    // the `u` flag so `🎉` (a 2-code-unit surrogate pair) is matched as one
    // codepoint and `$` anchors correctly at the string's last codepoint.
    assert.match(detail.checkOutputTail, /^[🎉\uFFFD]*$/u);
  });
});