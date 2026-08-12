import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskManager } from "./tasks.js";
import { trackManager, makeManager, fakeChild, baseTask, AMBIENT_VALUE, FAKE_SECRETS_ENV_PATH, AXI_TASKS_TEST_DIR, AXI_TASKS_CACHE_DIR, AXI_TASKS_OVERLAY_DIR, TASKS_STATE_FILE, FROM_CALLER, OCCUPYING_TASK, CAPTURED_DISPATCH, SRC1_LOG, DID_THING, SOL_MODEL, mkdtempTracked, preserveEnvVars } from "./tasks.test-helpers.js";
import { DEFAULT_SUMMARY_MODEL } from "./tasks.js";
import { TASKFERRY_PLUMBING_ENV_VARS } from "./paths.js";

describe("caller-env union: basic dispatch and TASKFERRY_TASK_ID", () => {
  test("a caller-supplied env value overlays the daemon's own ambient environment", (t) => {
    delete process.env.AXI_TEST_CALLER_VAR;
    t.after(() => delete process.env.AXI_TEST_CALLER_VAR);
    let capturedOpts = null;
    const mgr = makeManager({ spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); } });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: { AXI_TEST_CALLER_VAR: FROM_CALLER } });

    assert.equal(capturedOpts.env.AXI_TEST_CALLER_VAR, FROM_CALLER);
  });

  test("caller env cannot override the fixed excluded set of daemon-controlled vars", (t) => {
    // Build the excluded set from paths.js's shared export (plus PATH/HOME,
    // which tasks.js's CALLER_ENV_EXCLUDED also prepends) so this list cannot
    // drift from the daemon's real derivation again. preserveEnvVars restores
    // each var exactly as found in t.after.
    const excluded = ["PATH", "HOME", ...TASKFERRY_PLUMBING_ENV_VARS];
    preserveEnvVars(t, excluded);
    for (const name of excluded) process.env[name] = `real-${name}`;
    let capturedOpts = null;
    const mgr = makeManager({ spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); } });

    const maliciousEnv = Object.fromEntries(excluded.map((name) => [name, `malicious-${name}`]));
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: maliciousEnv });

    for (const name of excluded) {
      assert.equal(capturedOpts.env[name], `real-${name}`, `${name} must keep the daemon's own ambient value`);
    }
  });

  test("a denylisted name is stripped even when the caller's env explicitly sets it", (_t) => {
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); },
      envDenylistSpec: "AXI_TEST_DENIED_VAR",
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: { AXI_TEST_DENIED_VAR: "leaked-value" } });

    assert.equal("AXI_TEST_DENIED_VAR" in capturedOpts.env, false);
  });

  test("TASKFERRY_CHILD survives even when denylisted", (_t) => {
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); },
      envDenylistSpec: "TASKFERRY_CHILD",
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    assert.equal(capturedOpts.env.TASKFERRY_CHILD, "1");
  });

  test("TASKFERRY_TASK_ID is stamped with the spawned task's own id, for both dispatch and advisor roles", async () => {
    let dispatchOpts = null;
    let advisorOpts = null;
    const mgr = makeManager({
      spawnFn: (_cmd, _args, opts) => {
        if (!dispatchOpts) dispatchOpts = opts; else advisorOpts = opts;
        const child = fakeChild();
        setImmediate(() => child.emit("exit", 0, null));
        return child;
      },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });

    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.equal(dispatchOpts.env.TASKFERRY_TASK_ID, dispatched.id);

    const advised = await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: SOL_MODEL });
    assert.equal(advisorOpts.env.TASKFERRY_TASK_ID, advised.task_id);
  });

  test("TASKFERRY_TASK_ID is absent from summary spawns", async () => {
    let capturedOpts = null;
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Investigated the issue" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); },
    });

    await mgr.summarize("source", { maxWords: 150 });

    assert.equal("TASKFERRY_TASK_ID" in capturedOpts.env, false);
  });

  test("omitting env behaves as ambient-only, same as before caller-env forwarding existed", (t) => {
    process.env.AXI_TEST_AMBIENT_ONLY = AMBIENT_VALUE;
    t.after(() => delete process.env.AXI_TEST_AMBIENT_ONLY);
    let capturedOpts = null;
    const mgr = makeManager({ spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); } });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    assert.equal(capturedOpts.env.AXI_TEST_AMBIENT_ONLY, AMBIENT_VALUE);
  });
});

describe("caller-env union: envFileVars merge with caller/ambient", () => {
  test("envFileVars supplies a var missing from both the daemon's ambient env and the caller's env", () => {
    delete process.env.AXI_TEST_FILE_ONLY;
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); },
      envFileVars: { AXI_TEST_FILE_ONLY: "from-file" },
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    assert.equal(capturedOpts.env.AXI_TEST_FILE_ONLY, "from-file");
  });

  test("the daemon's own ambient env overrides the same key in envFileVars", (t) => {
    process.env.AXI_TEST_FILE_VS_AMBIENT = AMBIENT_VALUE;
    t.after(() => delete process.env.AXI_TEST_FILE_VS_AMBIENT);
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); },
      envFileVars: { AXI_TEST_FILE_VS_AMBIENT: "file-value" },
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    assert.equal(capturedOpts.env.AXI_TEST_FILE_VS_AMBIENT, AMBIENT_VALUE);
  });

  test("caller-supplied env overrides the same key in envFileVars", () => {
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); },
      envFileVars: { AXI_TEST_FILE_VS_CALLER: "file-value" },
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: { AXI_TEST_FILE_VS_CALLER: FROM_CALLER } });

    assert.equal(capturedOpts.env.AXI_TEST_FILE_VS_CALLER, FROM_CALLER);
  });

  test("envDenylist strips a var that came from envFileVars", () => {
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); },
      envFileVars: { AXI_TEST_DENIED_FROM_FILE: "leaked-value" },
      envDenylistSpec: "AXI_TEST_DENIED_FROM_FILE",
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    assert.equal("AXI_TEST_DENIED_FROM_FILE" in capturedOpts.env, false);
  });

  test("a var from envFileVars cannot override the daemon's real ambient PATH", (t) => {
    preserveEnvVars(t, ["PATH"]);
    process.env.PATH = "real-path";
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); },
      envFileVars: { PATH: "malicious-path-from-file" },
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    assert.equal(capturedOpts.env.PATH, "real-path");
  });

  test("envFileVars cannot smuggle a value for a plumbing var the ambient env never set (review finding: CALLER_ENV_EXCLUDED was only applied to caller env)", (t) => {
    preserveEnvVars(t, ["TASKFERRY_SOCKET_PATH"]);
    delete process.env.TASKFERRY_SOCKET_PATH;
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); },
      envFileVars: { TASKFERRY_SOCKET_PATH: "/tmp/attacker-controlled.sock" },
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    assert.equal("TASKFERRY_SOCKET_PATH" in capturedOpts.env, false);
  });

  test("envFileVars cannot smuggle a value for HOME either, when ambient HOME is unset", (t) => {
    preserveEnvVars(t, ["HOME"]);
    delete process.env.HOME;
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); },
      envFileVars: { HOME: "/tmp/attacker-controlled-home" },
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    assert.equal("HOME" in capturedOpts.env, false);
  });
});

describe("caller-env union: envFile load at construction", () => {
  test("createTaskManager() with envFilePath but no envFileVars override loads via loadEnvFileFn once at construction", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    fs.writeFileSync(path.join(stateDir, TASKS_STATE_FILE), "[]");
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const overlayTmpRoot = mkdtempTracked(AXI_TASKS_OVERLAY_DIR);
    let loadCalls = 0;
    let capturedOpts = null;

    const mgr = trackManager(createTaskManager({
      stateDir,
      cacheDir,
      overlayTmpRoot,
      sandboxEnabled: false,
      overlayEnabled: false,
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); },
      killFn: () => {},
      envFilePath: FAKE_SECRETS_ENV_PATH,
      loadEnvFileFn: (p) => { loadCalls++; assert.equal(p, FAKE_SECRETS_ENV_PATH); return { AXI_TEST_FROM_LOADER: "loaded-once" }; },
      watchEnvFileFn: () => ({ close: () => {} }),
    }));

    assert.equal(loadCalls, 1, "loadEnvFileFn must run exactly once, at construction, not per-dispatch");
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    mgr.dispatch({ prompt: "hi again", directory: os.tmpdir() });
    assert.equal(loadCalls, 1);
    assert.equal(capturedOpts.env.AXI_TEST_FROM_LOADER, "loaded-once");
  });

  test("createTaskManager() propagates a loadEnvFileFn throw synchronously, before any dispatch is possible", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    fs.writeFileSync(path.join(stateDir, TASKS_STATE_FILE), "[]");
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const overlayTmpRoot = mkdtempTracked(AXI_TASKS_OVERLAY_DIR);

    assert.throws(
      () => trackManager(createTaskManager({
        stateDir,
        cacheDir,
        overlayTmpRoot,
        sandboxEnabled: false,
        overlayEnabled: false,
        spawnFn: () => fakeChild(),
        killFn: () => {},
        envFilePath: "/fake/missing.env",
        loadEnvFileFn: () => { throw new Error("error: env file not found: /fake/missing.env"); },
      })),
      /env file not found/
    );
  });

  test("omitting envFilePath never calls loadEnvFileFn and defaults envFileVars to {}", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    fs.writeFileSync(path.join(stateDir, TASKS_STATE_FILE), "[]");
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const overlayTmpRoot = mkdtempTracked(AXI_TASKS_OVERLAY_DIR);
    let loadCalls = 0;

    trackManager(createTaskManager({
      stateDir,
      cacheDir,
      overlayTmpRoot,
      sandboxEnabled: false,
      overlayEnabled: false,
      spawnFn: () => fakeChild(),
      killFn: () => {},
      loadEnvFileFn: () => { loadCalls++; return {}; },
    }));

    assert.equal(loadCalls, 0);
  });

  test("an explicit empty-string TASKFERRY_ENV_FILE disables loading rather than falling through to config.envFile (review finding: the old `||` check treated \"\" as unset)", (t) => {
    preserveEnvVars(t, ["TASKFERRY_ENV_FILE"]);
    process.env.TASKFERRY_ENV_FILE = "";
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    fs.writeFileSync(path.join(stateDir, TASKS_STATE_FILE), "[]");
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const overlayTmpRoot = mkdtempTracked(AXI_TASKS_OVERLAY_DIR);
    let loadCalls = 0;

    trackManager(createTaskManager({
      stateDir,
      cacheDir,
      overlayTmpRoot,
      sandboxEnabled: false,
      overlayEnabled: false,
      spawnFn: () => fakeChild(),
      killFn: () => {},
      config: { envFile: "/would/have/loaded/this.env" },
      loadEnvFileFn: () => { loadCalls++; return { SHOULD_NOT_APPEAR: "leaked" }; },
    }));

    assert.equal(loadCalls, 0, "an explicit empty TASKFERRY_ENV_FILE must disable loading, not fall through to config.envFile");
  });

  test("createTaskManager() starts a live watch via watchEnvFileFn, passed the resolved envFilePath", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    fs.writeFileSync(path.join(stateDir, TASKS_STATE_FILE), "[]");
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const overlayTmpRoot = mkdtempTracked(AXI_TASKS_OVERLAY_DIR);
    const watchCalls = [];

    trackManager(createTaskManager({
      stateDir,
      cacheDir,
      overlayTmpRoot,
      sandboxEnabled: false,
      overlayEnabled: false,
      spawnFn: () => fakeChild(),
      killFn: () => {},
      envFilePath: FAKE_SECRETS_ENV_PATH,
      loadEnvFileFn: () => ({ AXI_TEST_INITIAL: "initial" }),
      watchEnvFileFn: (p, options) => { watchCalls.push([p, options]); return { close: () => {} }; },
    }));

    assert.equal(watchCalls.length, 1, "watchEnvFileFn must run exactly once, at construction");
    assert.equal(watchCalls[0][0], FAKE_SECRETS_ENV_PATH);
    assert.equal(typeof watchCalls[0][1].onReload, "function");
    assert.equal(typeof watchCalls[0][1].onError, "function");
  });
});

describe("caller-env union: envFile watch reload/error/setup/close", () => {
  test("omitting envFilePath never calls watchEnvFileFn", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    fs.writeFileSync(path.join(stateDir, TASKS_STATE_FILE), "[]");
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const overlayTmpRoot = mkdtempTracked(AXI_TASKS_OVERLAY_DIR);
    let watchCalls = 0;

    trackManager(createTaskManager({
      stateDir,
      cacheDir,
      overlayTmpRoot,
      sandboxEnabled: false,
      overlayEnabled: false,
      spawnFn: () => fakeChild(),
      killFn: () => {},
      watchEnvFileFn: () => { watchCalls++; return { close: () => {} }; },
    }));

    assert.equal(watchCalls, 0);
  });

  test("a watchEnvFileFn onReload call updates envFileVars for every dispatch after it fires, not ones already in flight", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    fs.writeFileSync(path.join(stateDir, TASKS_STATE_FILE), "[]");
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const overlayTmpRoot = mkdtempTracked(AXI_TASKS_OVERLAY_DIR);
    let capturedOpts = null;
    let onReload;

    const mgr = trackManager(createTaskManager({
      stateDir,
      cacheDir,
      overlayTmpRoot,
      sandboxEnabled: false,
      overlayEnabled: false,
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); },
      killFn: () => {},
      envFilePath: FAKE_SECRETS_ENV_PATH,
      loadEnvFileFn: () => ({ AXI_TEST_ROTATE: "before-rotation" }),
      watchEnvFileFn: (_p, options) => { onReload = options.onReload; return { close: () => {} }; },
      // The default 3s global lowerdir stagger (taskferry#318) would
      // otherwise queue the second dispatch instead of launching it
      // immediately.
      lowerdirStaggerMs: 0,
    }));

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.equal(capturedOpts.env.AXI_TEST_ROTATE, "before-rotation");

    onReload({ AXI_TEST_ROTATE: "after-rotation" });

    mgr.dispatch({ prompt: "hi again", directory: os.tmpdir() });
    assert.equal(capturedOpts.env.AXI_TEST_ROTATE, "after-rotation", "envFileVars must reflect the reload without a daemon restart");
  });

  test("a watchEnvFileFn onError call (a failed reload) leaves envFileVars at its last-known-good value", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    fs.writeFileSync(path.join(stateDir, TASKS_STATE_FILE), "[]");
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const overlayTmpRoot = mkdtempTracked(AXI_TASKS_OVERLAY_DIR);
    let capturedOpts = null;
    let onError;
    const warnings = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => { warnings.push(chunk); return true; };

    let mgr;
    try {
      mgr = trackManager(createTaskManager({
        stateDir,
        cacheDir,
        overlayTmpRoot,
        sandboxEnabled: false,
        overlayEnabled: false,
        spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); },
        killFn: () => {},
        envFilePath: FAKE_SECRETS_ENV_PATH,
        loadEnvFileFn: () => ({ AXI_TEST_STABLE: "good-value" }),
        watchEnvFileFn: (_p, options) => { onError = options.onError; return { close: () => {} }; },
      }));

      onError(new Error("transient mid-rename read failure"));

      mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
      assert.equal(capturedOpts.env.AXI_TEST_STABLE, "good-value");
      assert.ok(warnings.some((w) => w.includes("env-file reload failed") && w.includes("transient mid-rename read failure")));
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("a watchEnvFileFn setup failure is caught and logged rather than blocking daemon startup", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    fs.writeFileSync(path.join(stateDir, TASKS_STATE_FILE), "[]");
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const overlayTmpRoot = mkdtempTracked(AXI_TASKS_OVERLAY_DIR);
    const warnings = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => { warnings.push(chunk); return true; };

    let mgr;
    try {
      assert.doesNotThrow(() => {
        mgr = trackManager(createTaskManager({
          stateDir,
          cacheDir,
          overlayTmpRoot,
          sandboxEnabled: false,
          overlayEnabled: false,
          spawnFn: () => fakeChild(),
          killFn: () => {},
          envFilePath: FAKE_SECRETS_ENV_PATH,
          loadEnvFileFn: () => ({ AXI_TEST_STILL_WORKS: "yes" }),
          watchEnvFileFn: () => { throw new Error("ENOENT: fake watch setup failure"); },
        }));
      });
      assert.ok(warnings.some((w) => w.includes("could not watch env file") && w.includes("fake watch setup failure")));
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.ok(mgr, "manager construction must still succeed with the initial envFileVars load");
  });

  test("manager.close() closes the env-file watcher returned by watchEnvFileFn", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    fs.writeFileSync(path.join(stateDir, TASKS_STATE_FILE), "[]");
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const overlayTmpRoot = mkdtempTracked(AXI_TASKS_OVERLAY_DIR);
    let closeCalls = 0;

    const mgr = trackManager(createTaskManager({
      stateDir,
      cacheDir,
      overlayTmpRoot,
      sandboxEnabled: false,
      overlayEnabled: false,
      spawnFn: () => fakeChild(),
      killFn: () => {},
      envFilePath: FAKE_SECRETS_ENV_PATH,
      loadEnvFileFn: () => ({}),
      watchEnvFileFn: () => ({ close: () => { closeCalls++; } }),
    }));

    mgr.close();
    assert.equal(closeCalls, 1);
  });
});

describe("caller-env union: summary/advisor/report env forwarding", () => {
  test("summaryEnvironment strips OPENCODE_CONFIG* even when the caller's env explicitly sets one", async (_t) => {
    let capturedEnv = null;
    const mgr = makeManager({
      tasksFixture: (logDir) => [{ ...baseTask({ id: "src1", status: "done", logPath: path.join(logDir, SRC1_LOG) }) }],
      logs: { [SRC1_LOG]: JSON.stringify({ type: "text", part: { messageID: "m1", text: DID_THING } }) + "\n" },
      spawnFn: (_cmd, _args, opts) => { capturedEnv = opts.env; return fakeChild(); },
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
    });

    await mgr.summarize("src1", { env: { OPENCODE_CONFIG: "malicious-config-path", FOO: "bar" } });

    assert.equal("OPENCODE_CONFIG" in capturedEnv, false);
    assert.equal(capturedEnv.FOO, "bar", "a non-OPENCODE_CONFIG caller var must survive the summaryEnvironment strip");
  });

  test("advisor() forwards a caller-supplied env value into the dispatched child", async (t) => {
    delete process.env.AXI_TEST_ADVISOR_CALLER_VAR;
    t.after(() => delete process.env.AXI_TEST_ADVISOR_CALLER_VAR);
    let capturedOpts = null;
    const child = fakeChild();
    const mgr = makeManager({
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return child; },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });

    const advisorPromise = mgr.advisor({
      prompt: "hi",
      directory: os.tmpdir(),
      model: SOL_MODEL,
      env: { AXI_TEST_ADVISOR_CALLER_VAR: "from-advisor-caller" },
    });
    child.emit("exit", 1, null);
    await advisorPromise;

    assert.ok(capturedOpts, "the advisor dispatch must have spawned a child");
    assert.equal(capturedOpts.env.AXI_TEST_ADVISOR_CALLER_VAR, "from-advisor-caller");
  });

  test("summarize() report mode forwards a caller-supplied env value into the spawned summary child", async (t) => {
    delete process.env.AXI_TEST_REPORT_CALLER_VAR;
    t.after(() => delete process.env.AXI_TEST_REPORT_CALLER_VAR);
    let capturedEnv = null;
    const mgr = makeManager({
      tasksFixture: (logDir) => [{ ...baseTask({ id: "src1", status: "done", logPath: path.join(logDir, SRC1_LOG) }) }],
      logs: { [SRC1_LOG]: JSON.stringify({ type: "text", part: { messageID: "m1", text: DID_THING } }) + "\n" },
      spawnFn: (_cmd, _args, opts) => { capturedEnv = opts.env; return fakeChild(); },
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
    });

    await mgr.summarize("src1", { mode: "report", env: { AXI_TEST_REPORT_CALLER_VAR: "from-report-caller" } });

    assert.ok(capturedEnv, "the summarize report call must have spawned a child");
    assert.equal(capturedEnv.AXI_TEST_REPORT_CALLER_VAR, "from-report-caller");
  });
});

describe("caller-env union: queue-time env freezing and ambient-read-fresh", () => {
  test("a queued dispatch's stored env is the one captured at dispatch() time, not re-read later", async (t) => {
    delete process.env.AXI_TEST_LATE_AMBIENT;
    t.after(() => delete process.env.AXI_TEST_LATE_AMBIENT);
    const occupyingChild = fakeChild(9001);
    /** @type {any} */
    let secondCapturedOpts = null;
    let spawnCount = 0;
    const mgr = makeManager({
      maxConcurrentTasks: 1,
      spawnFn: (_cmd, _args, opts) => {
        spawnCount++;
        if (spawnCount === 1) return occupyingChild;
        secondCapturedOpts = opts;
        return fakeChild(9002);
      },
    });

    // Occupy the only concurrency slot.
    mgr.dispatch({ prompt: OCCUPYING_TASK, directory: os.tmpdir() });
    // This one queues behind the slot, with its own env captured now.
    mgr.dispatch({ prompt: "queued task", directory: os.tmpdir(), env: { AXI_TEST_MARKER: CAPTURED_DISPATCH } });

    // Simulate ambient env changing while the second dispatch sits queued.
    process.env.AXI_TEST_LATE_AMBIENT = "set-after-queuing";

    // Release the first task so the queued one actually spawns.
    occupyingChild.emit("exit", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(secondCapturedOpts, "the queued task should have spawned");
    assert.equal(secondCapturedOpts.env.AXI_TEST_MARKER, CAPTURED_DISPATCH, "caller env is frozen at dispatch() time");
    assert.equal(secondCapturedOpts.env.AXI_TEST_LATE_AMBIENT, "set-after-queuing", "the daemon's own ambient env is still read fresh at spawn time");
  });

  test("dispatch()'s queued env is frozen against later caller mutations of the original env object (verification gate for the capturedEnv clone in tasks.js)", async (t) => {
    // Verification gate for Fix 3 (removing the capturedEnv clone added by
    // b45de81): the dispatch path must not be vulnerable to the caller
    // mutating the original env object reference they handed to dispatch().
    // Reassign an existing key's value AND add a new key on the same object
    // between queue time and the queued launch's actual spawn. The spawned
    // child must see the dispatch-time value, not the mutated one, and must
    // not see the post-queue addition. The b45de81 clone makes this test
    // pass; if that clone is ever removed, this test will fail and the
    // removal must be reverted -- see the BLOCKED note in the PR description.
    delete process.env.AXI_TEST_QUEUE_REASSIGN;
    delete process.env.AXI_TEST_QUEUE_ADDED;
    t.after(() => {
      delete process.env.AXI_TEST_QUEUE_REASSIGN;
      delete process.env.AXI_TEST_QUEUE_ADDED;
    });
    const occupyingChild = fakeChild(9001);
    /** @type {any} */
    let secondCapturedOpts = null;
    let spawnCount = 0;
    const mgr = makeManager({
      maxConcurrentTasks: 1,
      spawnFn: (_cmd, _args, opts) => {
        spawnCount++;
        if (spawnCount === 1) return occupyingChild;
        secondCapturedOpts = opts;
        return fakeChild(9002);
      },
    });

    mgr.dispatch({ prompt: OCCUPYING_TASK, directory: os.tmpdir() });
    // Hold a reference to the caller's original env object after dispatch()
    // returns -- the queued launch must NOT observe these mutations.
    const callerEnv = { AXI_TEST_QUEUE_REASSIGN: CAPTURED_DISPATCH };
    mgr.dispatch({ prompt: "queued task", directory: os.tmpdir(), env: callerEnv });

    callerEnv.AXI_TEST_QUEUE_REASSIGN = "mutated-after-queue";
    callerEnv.AXI_TEST_QUEUE_ADDED = "added-after-queue";

    occupyingChild.emit("exit", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(secondCapturedOpts, "the queued task should have spawned");
    assert.equal(secondCapturedOpts.env.AXI_TEST_QUEUE_REASSIGN, CAPTURED_DISPATCH, "the dispatch-time value must reach the spawned child, not the post-queue mutated value");
    assert.equal("AXI_TEST_QUEUE_ADDED" in secondCapturedOpts.env, false, "a var added after queue must not reach the spawned child");
  });

  test("summary's spawned env reads the daemon's ambient at spawn time, not request time (matches dispatch's deferred-env behavior)", async (t) => {
    // Fix 2: dispatch() already defers dispatchEnvironment() to spawn time so
    // the spawned child sees the daemon's current process.env. Before this
    // fix, the summary path called summaryEnvironment(env) at request time
    // and carried the frozen result until the child spawned -- anything
    // changing in the daemon's ambient env between request and spawn (e.g.
    // a sibling setting a key) would not reach the spawned summary child.
    // The summary path now mirrors dispatch()'s pattern: caller env is
    // snapshot at request time (cloned, like dispatch), and the merged env
    // is computed in startTask() at spawn time.
    delete process.env.AXI_TEST_SUMMARY_LATE_AMBIENT;
    t.after(() => delete process.env.AXI_TEST_SUMMARY_LATE_AMBIENT);
    const occupyingChild = fakeChild(9001);
    /** @type {any} */
    let summaryCapturedOpts = null;
    let spawnCount = 0;
    const mgr = makeManager({
      maxConcurrentTasks: 1,
      tasksFixture: (logDir) => [{ ...baseTask({ id: "src1", status: "done", logPath: path.join(logDir, SRC1_LOG) }) }],
      logs: { [SRC1_LOG]: JSON.stringify({ type: "text", part: { messageID: "m1", text: DID_THING } }) + "\n" },
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
      spawnFn: (_cmd, _args, opts) => {
        spawnCount++;
        if (spawnCount === 1) return occupyingChild;
        summaryCapturedOpts = opts;
        return fakeChild(9002);
      },
    });

    // Occupy the only concurrency slot.
    mgr.dispatch({ prompt: OCCUPYING_TASK, directory: os.tmpdir() });

    // Request the summary -- this queues it (concurrency slot is full).
    // The env snapshot is captured here, but summaryEnvironment(env) is NOT
    // yet applied.
    await mgr.summarize("src1", { env: {} });

    // Simulate the daemon's ambient env changing between request and spawn.
    process.env.AXI_TEST_SUMMARY_LATE_AMBIENT = "set-after-summary-request";

    // Release the occupying task; the queued summary now actually spawns.
    occupyingChild.emit("exit", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(summaryCapturedOpts, "the queued summary should have spawned");
    assert.equal(summaryCapturedOpts.env.AXI_TEST_SUMMARY_LATE_AMBIENT, "set-after-summary-request", "summary env reads the daemon's ambient at spawn time, not at request time");
  });
});

describe("caller-env union: single-pass merge and key validation", () => {
  test("excluded names, denylist names, and caller-wins are all applied in a single merge pass (review fix: caller-wins/denylist-last/denylist-strips-ambient semantics)", (t) => {
    preserveEnvVars(t, ["TASKFERRY_STATE_DIR", "AXI_TEST_DENY_AMBIENT"]);
    process.env.TASKFERRY_STATE_DIR = "real-state";
    process.env.AXI_TEST_DENY_AMBIENT = "ambient-leak";
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); },
      envDenylistSpec: "AXI_TEST_DENY_AMBIENT,AXI_TEST_DENY_CALLER",
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: {
      TASKFERRY_STATE_DIR: "malicious-state",
      AXI_TEST_DENY_AMBIENT: "caller-overrides-ambient",
      AXI_TEST_DENY_CALLER: "caller-only",
      AXI_TEST_KEEP: FROM_CALLER,
    } });

    assert.equal(capturedOpts.env.TASKFERRY_STATE_DIR, "real-state", "excluded name keeps the daemon's ambient value even when the caller sets it");
    assert.equal("AXI_TEST_DENY_AMBIENT" in capturedOpts.env, false, "denylist strips a name that came in from the daemon's own ambient env");
    assert.equal("AXI_TEST_DENY_CALLER" in capturedOpts.env, false, "denylist strips a name the caller set on the env param");
    assert.equal(capturedOpts.env.AXI_TEST_KEEP, FROM_CALLER, "non-excluded, non-denylist caller names overlay the ambient env");
  });

  test("the exclusion set is sourced from paths.js's plumbing export -- any new TASKFERRY_* plumbing var added there lands here automatically", (t) => {
    // Single-source review fix: the excluded list used to be hardcoded
    // literally in tasks.js (["PATH", "HOME", "TASKFERRY_STATE_DIR", ...]).
    // If a future plumbing var was added to paths.js without also editing
    // tasks.js, a caller could override it from their forwarded env and
    // misroute a nested taskferry call (e.g. via TASKFERRY_SOCKET_PATH). The
    // set is now built from paths.js's TASKFERRY_PLUMBING_ENV_VARS export
    // plus PATH and HOME; this test exercises every name in that export to
    // pin the derivation. preserveEnvVars restores each var exactly as found.
    preserveEnvVars(t, TASKFERRY_PLUMBING_ENV_VARS);
    for (const name of TASKFERRY_PLUMBING_ENV_VARS) {
      process.env[name] = `real-${name}`;
    }
    let capturedOpts = null;
    const mgr = makeManager({ spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return fakeChild(); } });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: {
      TASKFERRY_STATE_DIR: "malicious-state",
      TASKFERRY_RUNTIME_DIR: "malicious-runtime",
      TASKFERRY_CACHE_DIR: "malicious-cache",
      TASKFERRY_SOCKET_PATH: "malicious-socket",
      TASKFERRY_OVERLAY_TMP_DIR: "malicious-overlay",
    } });

    assert.equal(capturedOpts.env.TASKFERRY_STATE_DIR, "real-TASKFERRY_STATE_DIR");
    assert.equal(capturedOpts.env.TASKFERRY_RUNTIME_DIR, "real-TASKFERRY_RUNTIME_DIR");
    assert.equal(capturedOpts.env.TASKFERRY_CACHE_DIR, "real-TASKFERRY_CACHE_DIR");
    assert.equal(capturedOpts.env.TASKFERRY_SOCKET_PATH, "real-TASKFERRY_SOCKET_PATH");
    assert.equal(capturedOpts.env.TASKFERRY_OVERLAY_TMP_DIR, "real-TASKFERRY_OVERLAY_TMP_DIR");
  });

  test("a caller-supplied env key containing '=' is rejected synchronously and the task settles as crashed with a matching spawnError", () => {
    // Mirrors isEnvironment() in src/protocol.js so a programmatic caller
    // that bypasses the socket (e.g. internal code invoking dispatch()
    // directly) can't smuggle a malformed key past the spawn boundary. The
    // RPC layer already rejects this; sanitizedEnvironment() is the second
    // gate. The throw lands inside startTask()'s try/catch, which marks the
    // task crashed with spawnError -- fail fast, no silent drop, no spawn.
    let spawnCalled = false;
    const mgr = makeManager({ spawnFn: () => { spawnCalled = true; return fakeChild(); } });

    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: { "BAD=KEY": "value" } });

    assert.equal(mgr.status(dispatched.id).status, "crashed");
    assert.match(mgr.status(dispatched.id).spawnError, /invalid env key in caller-supplied env.*BAD=KEY/);
    assert.equal(spawnCalled, false, "the spawn must never happen when env validation fails");
  });

  test("a caller-supplied env key that is an empty string is rejected synchronously and the task settles as crashed", () => {
    let spawnCalled = false;
    const mgr = makeManager({ spawnFn: () => { spawnCalled = true; return fakeChild(); } });

    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: { "": "value" } });

    assert.equal(mgr.status(dispatched.id).status, "crashed");
    assert.match(mgr.status(dispatched.id).spawnError, /invalid env key in caller-supplied env/);
    assert.equal(spawnCalled, false);
  });

  test("a caller-supplied env value that is not a string is rejected synchronously and the task settles as crashed", () => {
    let spawnCalled = false;
    const mgr = makeManager({ spawnFn: () => { spawnCalled = true; return fakeChild(); } });

    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: { AXI_TEST_BAD_VALUE: 42 } });

    assert.equal(mgr.status(dispatched.id).status, "crashed");
    assert.match(mgr.status(dispatched.id).spawnError, /env value for "AXI_TEST_BAD_VALUE" must be a string, got number/);
    assert.equal(spawnCalled, false);
  });

  test("a caller-supplied env value that is undefined is rejected synchronously (null/undefined values would silently lose type info at the spawn boundary)", () => {
    let spawnCalled = false;
    const mgr = makeManager({ spawnFn: () => { spawnCalled = true; return fakeChild(); } });

    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: { AXI_TEST_UNDEFINED: void 0 } });

    assert.equal(mgr.status(dispatched.id).status, "crashed");
    assert.match(mgr.status(dispatched.id).spawnError, /env value for "AXI_TEST_UNDEFINED" must be a string, got undefined/);
    assert.equal(spawnCalled, false);
  });
});
