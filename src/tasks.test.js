import { test, describe, mock, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskManager, isOutsideDirectory, DEFAULT_SUMMARY_MODEL, bucketFor, parseEnvDenylist, parseSandboxDenylist } from "./tasks.js";
import { defaultRunCommand as changesetDefaultRunCommand } from "./changeset.js";

// Builds an isolated task manager backed by a temp state dir and, unless
// overridden, fake spawnFn/killFn so no test ever touches a real `opencode`
// process or a real OS signal. `tasksFixture`/`logs` seed tasks.json and
// logs/ *before* the manager loads them (createTaskManager's loadPersisted()
// runs synchronously in the constructor, same as the old module-level code
// did at import time). `tasksFixture` may be an array or `(logDir) => array`
// for fixtures whose logPath needs to point inside the real log dir.
function makeManager({ tasksFixture = [], logs = {}, spawnFn, killFn, listModelsFn, defaultExecutor, maxDispatchesPerWindow, dispatchWindowMs, advisorSessionTtlMs, maxConcurrentTasks, noOutputTimeoutMs, postOutputNoOutputTimeoutMs, watchdogPollMs, maxWaitMs, envDenylistSpec, sandboxDenylist, sandboxEnabled = false, checkBwrapAvailableFn, existsFn, statFn, readdirFn, runtimeDir, cacheDir, platform, onEvent, allowedDirs, resolveGitCommonDirFn, resolveGitDirFn, overlayEnabled = false, checkOverlaySupportFn, overlayTmpRoot, runOverlayCommandFn, rmOverlayTreeFn } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-test-"));
  const logDir = path.join(stateDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  // Sandboxing always mkdir's the resolved sandboxedDataHome (real disk, not
  // tmpfs -- see resolveCacheDir), so give every test an isolated temp
  // cacheDir by default instead of falling through to the real ~/.cache.
  const defaultCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-cache-"));
  // createTaskManager() runs sweepOrphanedOverlays() synchronously at
  // construction, scanning overlayTmpRoot for real "taskferry-cow-*" dirs --
  // its default is the real os.tmpdir(). Without an isolated default here,
  // any test that doesn't explicitly pass its own overlayTmpRoot ends up
  // scanning (and acting on) whatever a real, concurrently-running daemon
  // has actually left in /tmp on this host.
  const defaultOverlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-overlay-"));

  const fixtureTasks = typeof tasksFixture === "function" ? tasksFixture(logDir) : tasksFixture;
  fs.writeFileSync(path.join(stateDir, "tasks.json"), JSON.stringify(fixtureTasks, null, 2));
  for (const [name, content] of Object.entries(logs)) {
    fs.writeFileSync(path.join(logDir, name), content);
  }

  return createTaskManager({
    stateDir,
    spawnFn: spawnFn ?? (() => { throw new Error("spawnFn was not injected for this test"); }),
    killFn: killFn ?? (() => { throw new Error("killFn was not injected for this test"); }),
    listModelsFn: listModelsFn ?? (() => `${DEFAULT_SUMMARY_MODEL}\n`),
    sandboxEnabled,
    ...(defaultExecutor != null ? { defaultExecutor } : {}),
    ...(checkBwrapAvailableFn != null ? { checkBwrapAvailableFn } : {}),
    ...(existsFn != null ? { existsFn } : {}),
    ...(statFn != null ? { statFn } : {}),
    ...(readdirFn != null ? { readdirFn } : {}),
    ...(runtimeDir != null ? { runtimeDir } : {}),
    cacheDir: cacheDir ?? defaultCacheDir,
    ...(platform != null ? { platform } : {}),
    ...(onEvent != null ? { onEvent } : {}),
    ...(maxDispatchesPerWindow != null ? { maxDispatchesPerWindow } : {}),
    ...(dispatchWindowMs != null ? { dispatchWindowMs } : {}),
    ...(advisorSessionTtlMs != null ? { advisorSessionTtlMs } : {}),
    ...(maxConcurrentTasks != null ? { maxConcurrentTasks } : {}),
    ...(noOutputTimeoutMs != null ? { noOutputTimeoutMs } : {}),
    ...(postOutputNoOutputTimeoutMs != null ? { postOutputNoOutputTimeoutMs } : {}),
    ...(watchdogPollMs != null ? { watchdogPollMs } : {}),
    ...(maxWaitMs != null ? { maxWaitMs } : {}),
    ...(envDenylistSpec != null ? { envDenylist: parseEnvDenylist(envDenylistSpec) } : {}),
    ...(sandboxDenylist != null ? { sandboxDenylist } : {}),
    ...(allowedDirs != null ? { allowedDirs } : {}),
    ...(resolveGitCommonDirFn != null ? { resolveGitCommonDirFn } : {}),
    ...(resolveGitDirFn != null ? { resolveGitDirFn } : {}),
    overlayEnabled,
    ...(checkOverlaySupportFn != null ? { checkOverlaySupportFn } : {}),
    overlayTmpRoot: overlayTmpRoot ?? defaultOverlayTmpRoot,
    ...(runOverlayCommandFn != null ? { runOverlayCommandFn } : {}),
    ...(rmOverlayTreeFn != null ? { rmOverlayTreeFn } : {}),
  });
}

// A fake ChildProcess: an EventEmitter with the pid/unref surface dispatch()
// touches. Tests drive completion by calling fakeChild.emit("exit", ...) or
// .emit("error", ...) themselves -- nothing here runs asynchronously on its
// own, so tests don't need to wait on a real subprocess.
function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  child.stdout = new EventEmitter();
  return child;
}

function baseTask(overrides = {}) {
  return {
    id: "t_base",
    status: "done",
    directory: "/tmp/somewhere",
    model: "openai/gpt-5.6-luna",
    variant: "high",
    sessionId: "ses_base",
    pid: 12345,
    startedAt: "2026-07-13T10:00:00.000Z",
    endedAt: "2026-07-13T10:01:00.000Z",
    exitCode: 0,
    signal: null,
    logPath: null,
    promptPreview: "do the thing",
    spawnError: null,
    cancelRequested: false,
    ...overrides,
  };
}

describe("parseEnvDenylist()", () => {
  test("returns an empty array for an empty or undefined spec", () => {
    assert.deepEqual(parseEnvDenylist(undefined), []);
    assert.deepEqual(parseEnvDenylist(""), []);
  });

  test("splits, trims, and drops empty entries", () => {
    assert.deepEqual(parseEnvDenylist("FOO, BAR ,, BAZ"), ["FOO", "BAR", "BAZ"]);
  });
});

describe("parseSandboxDenylist()", () => {
  test("returns an empty array for an empty or undefined spec", () => {
    assert.deepEqual(parseSandboxDenylist(undefined), []);
    assert.deepEqual(parseSandboxDenylist(""), []);
  });

  test("splits, trims, and drops empty entries", () => {
    assert.deepEqual(parseSandboxDenylist("/home/user/.docker, /home/user/.kube ,, /opt/shared"), [
      "/home/user/.docker",
      "/home/user/.kube",
      "/opt/shared",
    ]);
  });
});

describe("persistTask() durability across concurrent manager instances", () => {
  test("two manager instances writing concurrently both keep their own task record", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-test-"));
    const mgrA = createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => fakeChild(1001),
      killFn: () => { throw new Error("not used"); },
    });
    const mgrB = createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => fakeChild(1002),
      killFn: () => { throw new Error("not used"); },
    });
    const a = mgrA.dispatch({ prompt: "from A", directory: os.tmpdir() });
    const b = mgrB.dispatch({ prompt: "from B", directory: os.tmpdir() });

    const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, "tasks.json"), "utf8"));
    const ids = onDisk.map((t) => t.id);
    assert.ok(ids.includes(a.id), "manager A's task must survive manager B's write");
    assert.ok(ids.includes(b.id), "manager B's task must survive manager A's write");
  });

  test("malformed tasks.json surfaces as a structured error instead of throwing at construction", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-test-"));
    fs.writeFileSync(path.join(stateDir, "tasks.json"), "{ not valid json");
    const mgr = createTaskManager({ stateDir, sandboxEnabled: false, spawnFn: () => fakeChild(), killFn: () => {} });
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir() }),
      /error: could not read persisted task state/
    );
  });
});

describe("dispatch() input validation (throws before spawning anything)", () => {
  test("rejects a missing prompt", () => {
    const mgr = makeManager();
    assert.throws(() => mgr.dispatch({ directory: "/tmp" }), /error: prompt is required/);
  });

  test("rejects an unknown executor name, before prompt/directory validation runs (Task 7 review fix)", () => {
    const mgr = makeManager();
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: "/tmp", executor: "bogus" }),
      /unknown executor: bogus/
    );
  });

  test("rejects a non-string prompt", () => {
    const mgr = makeManager();
    assert.throws(() => mgr.dispatch({ prompt: 42, directory: "/tmp" }), /error: prompt is required/);
  });

  test("rejects a relative directory", () => {
    const mgr = makeManager();
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: "relative/path" }),
      /error: directory must be an absolute path \(got "relative\/path"\)/
    );
  });

  test("rejects a directory that doesn't exist", () => {
    const mgr = makeManager();
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: "/no/such/dir/really" }),
      /error: directory does not exist: \/no\/such\/dir\/really/
    );
  });
});

describe("dispatch() lifecycle, driven through an injected spawnFn (no real opencode process)", () => {
  test("passes the right argv and spawn options through to spawnFn", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => {
        captured = { cmd, args, opts };
        return fakeChild();
      },
    });
    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), model: "opencode-go/minimax-m3", variant: "max", executor: "opencode" });
    assert.equal(captured.cmd, "opencode");
    assert.deepEqual(captured.args, [
      "run", "--dir", os.tmpdir(), "--auto", "--format", "json",
      "-m", "opencode-go/minimax-m3", "--variant", "max", "--", "hello",
    ]);
    assert.equal(captured.opts.cwd, os.tmpdir());
    assert.equal(captured.opts.detached, true);
  });

  test("defaults to openai/gpt-5.6-luna --variant high when no model is given", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    assert.deepEqual(captured.slice(6, 10), ["-m", "openai/gpt-5.6-luna", "--variant", "high"]);
  });

  /** @param {string[]} args @param {string} model */
  function assertDispatchedModel(args, model) {
    assert.equal(args[args.indexOf("-m") + 1], model);
  }

  test("resuming with --session-id and no --model inherits the model of the task that owned that session (issue #47)", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: "opencode-go/minimax-m3", sessionId: "ses_abc", executor: "opencode" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_abc", executor: "opencode" });
    assertDispatchedModel(captured, "opencode-go/minimax-m3");
  });

  test("resuming with --session-id and an explicit --model still uses the explicit model", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: "opencode-go/minimax-m3", sessionId: "ses_abc", executor: "opencode" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), model: "opencode/other-model", sessionId: "ses_abc", executor: "opencode" });
    assertDispatchedModel(captured, "opencode/other-model");
  });

  test("an unrecognized --session-id with no --model still falls back to the hardcoded default", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_never_seen", executor: "opencode" });
    assertDispatchedModel(captured, "openai/gpt-5.6-luna");
  });

  test("resuming with --session-id and no --executor inherits the executor of the task that owned that session", () => {
    let capturedCmd = null;
    const mgr = makeManager({ spawnFn: (cmd) => { capturedCmd = cmd; return fakeChild(); } });
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), sessionId: "ses_exec", executor: "pi" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_exec" });
    assert.equal(capturedCmd, "pi");
  });

  test("resuming with --session-id and an explicit --executor still uses the explicit executor", () => {
    let capturedCmd = null;
    const mgr = makeManager({ spawnFn: (cmd) => { capturedCmd = cmd; return fakeChild(); } });
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), sessionId: "ses_exec2", executor: "pi" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_exec2", executor: "opencode" });
    assert.equal(capturedCmd, "opencode");
  });

  test("a session-inheriting resume that matches defaultExecutor reuses that exact instance instead of building a fresh one", () => {
    // Uses a custom fake as defaultExecutor (not the real piExecutor()) so a
    // regression back to unconditionally calling resolveExecutor(executorId)
    // is observable: that path ignores this injected instance entirely and
    // would spawn with the real pi executor's own buildSpawnArgs instead.
    let captured = null;
    const fakePi = {
      id: "pi",
      taskIdPrefix: "pi",
      errorBucketPrefix: "pi",
      defaultModel: "fake-pi/marker-model",
      defaultSummaryModel: "fake-pi/marker-model",
      binaryName: "pi",
      listModelsFn: async () => "",
      buildSpawnArgs: () => ["--fake-pi-marker"],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: () => ({ extraRoBinds: [], extraRwPairBinds: [], sandboxedDataHome: "/tmp/unused", sandboxEnv: {} }),
    };
    const mgr = makeManager({ spawnFn: (cmd, args) => { captured = args; return fakeChild(); }, defaultExecutor: fakePi });
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), sessionId: "ses_reuse", executor: "pi" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_reuse" });
    assert.deepEqual(captured, ["--fake-pi-marker"]);
  });

  test("an unrecognized --session-id with no --executor still falls back to the manager's default executor", () => {
    let capturedCmd = null;
    const mgr = makeManager({ spawnFn: (cmd) => { capturedCmd = cmd; return fakeChild(); } });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_exec_never_seen" });
    assert.equal(capturedCmd, "pi");
  });

  test("a sessionId that collides across executors does not leak the other executor's model when --executor is given explicitly", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args) => { captured = args; return fakeChild(); } });
    // Same literal sessionId string, but the earlier task belongs to a
    // different executor -- resolving executor: "pi" here must not inherit
    // the opencode task's model just because the sessionId string matches.
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: "opencode-go/minimax-m3", sessionId: "ses_collide", executor: "opencode" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_collide", executor: "pi" });
    // pi's buildSpawnArgs splits a slashed model into --provider/--model,
    // unlike opencode's single -m flag -- assert pi's own default model
    // ("minimax/MiniMax-M2.7"), not the opencode task's "opencode-go/minimax-m3".
    assert.equal(captured[captured.indexOf("--provider") + 1], "minimax");
    assert.equal(captured[captured.indexOf("--model") + 1], "MiniMax-M2.7");
  });

  test("a short prompt is returned verbatim in promptPreview, with no promptTotalChars hint", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.equal(dispatched.promptPreview, "hi");
    assert.equal("promptTotalChars" in dispatched, false);
  });

  test("a long prompt is truncated in promptPreview, with a promptTotalChars hint (AXI content-truncation)", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const longPrompt = "x".repeat(500);
    const dispatched = mgr.dispatch({ prompt: longPrompt, directory: os.tmpdir() });
    assert.equal(dispatched.promptPreview, "x".repeat(200) + "…");
    assert.equal(dispatched.promptTotalChars, 500);
    // The hint must survive every lookup path, not just the dispatch() return.
    assert.equal(mgr.status(dispatched.id).promptTotalChars, 500);
  });

  test("normalizes the task directory before persistence and event emission", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-directory-"));
    const realDirectory = path.join(root, "real");
    const linkedDirectory = path.join(root, "linked");
    fs.mkdirSync(realDirectory);
    fs.symlinkSync(realDirectory, linkedDirectory, "dir");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const events = [];
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child, onEvent: (event) => events.push(event) });

    const dispatched = mgr.dispatch({ prompt: "hi", directory: linkedDirectory });
    child.emit("exit", 0, null);

    assert.equal(dispatched.directory, realDirectory);
    assert.ok(events.every((event) => event.directory === realDirectory));
    const onDisk = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    assert.equal(onDisk.find((task) => task.id === dispatched.id).directory, realDirectory);
  });

  test("a clean exit(0) settles the task to 'done'", () => {
    const child = fakeChild(555);
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.equal(dispatched.status, "running");
    assert.equal(dispatched.pid, 555);
    assert.match(dispatched.next, /taskferry wait or taskferry status/);

    child.emit("exit", 0, null);

    const settled = mgr.status(dispatched.id);
    assert.equal(settled.status, "done");
    assert.equal(settled.exitCode, 0);
    assert.ok(settled.endedAt);
  });

  test("a non-zero exit settles the task to 'crashed'", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    child.emit("exit", 1, null);

    assert.equal(mgr.status(dispatched.id).status, "crashed");
    assert.equal(mgr.status(dispatched.id).exitCode, 1);
  });

  test("a signal-only exit (e.g. SIGKILL with no code) is also 'crashed', unless cancelRequested", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    child.emit("exit", null, "SIGKILL");

    assert.equal(mgr.status(dispatched.id).status, "crashed");
  });

  test("exiting after cancel() settles to 'cancelled', not 'crashed'", () => {
    const child = fakeChild();
    const killCalls = [];
    const mgr = makeManager({ spawnFn: () => child, killFn: (pid, signal) => killCalls.push({ pid, signal }) });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    mgr.cancel(dispatched.id);
    assert.deepEqual(killCalls, [{ pid: -child.pid, signal: "SIGTERM" }]);

    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).status, "cancelled");
  });

  test("child.on('error') (e.g. ENOENT if `opencode` isn't on PATH) settles to 'crashed' with spawnError set", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    child.emit("error", new Error("spawn opencode ENOENT"));

    const settled = mgr.status(dispatched.id);
    assert.equal(settled.status, "crashed");
    const full = mgr.result(dispatched.id);
    assert.equal(full.spawnError, "spawn opencode ENOENT");
  });

  test("child.on('error') still runs changeset extraction/cleanup so a spawn-failed task doesn't strand its overlay", () => {
    // The overlay is created during the sandbox block, BEFORE the spawn
    // attempt. If the spawn errors (ENOENT), the overlay would otherwise sit
    // on disk with changesetStatus still "pending" and no extraction ever
    // booked against it -- the spawn-error path must run the same
    // extractChangesetForTask() the exit path does.
    let extractCalls = 0;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-spawn-error-extract-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-spawn-error-extract-tmp-"));
    const child = fakeChild();
    const mgr = makeManager({
      spawnFn: () => child,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
      runOverlayCommandFn: () => { extractCalls++; return { status: 0, stdout: "", stderr: "", error: undefined }; },
    });

    const dispatched = mgr.dispatch({ prompt: "hi", directory });
    const preErrorCalls = extractCalls;

    child.emit("error", new Error("spawn opencode ENOENT"));

    const status = mgr.status(dispatched.id);
    assert.equal(status.status, "crashed");
    // Empty overlay (no worker ever ran) -> 0-byte diff -> "accepted" (same
    // shape the exit path's zero-change case produces), overlayDirs cleared.
    assert.equal(status.changesetStatus, "accepted");
    assert.equal("overlayDirs" in status, false);
    assert.ok(extractCalls > preErrorCalls, "extractChangesetForTask should run on the spawn-error path");
  });

  test("advisor: child.on('error') still auto-rejects and cleans up the overlay so it's not stranded", async () => {
    // Advisor's settlement already auto-rejects+cleans; if the spawn errors
    // out, the same auto-reject must run for the spawn-error path too (the
    // bootstrap can otherwise leave the overlay under tmp until the startup
    // sweep next runs).
    let cleanedRoot = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-spawn-error-advisor-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-spawn-error-advisor-tmp-"));
    const child = fakeChild();
    const mgr = makeManager({
      spawnFn: () => child,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "", error: undefined }),
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });

    const advisePromise = mgr.advisor({ prompt: "hi", directory, model: "openai/gpt-5.6-sol" });
    child.emit("error", new Error("spawn opencode ENOENT"));
    const advised = await advisePromise;

    const status = mgr.status(advised.task_id);
    assert.equal(status.status, "crashed");
    assert.equal(status.changesetStatus, "rejected");
    assert.equal("overlayDirs" in status, false);
    assert.ok(cleanedRoot, "advisor's overlay must be cleaned up on the spawn-error path");
  });

  test("dispatch() synchronous throw from spawnFn still runs changeset extraction/cleanup so a sync-spawn-failed task doesn't strand its overlay", () => {
    // Companion to the child.on('error') test above: child.emit("error")
    // exercises the async spawn-failure path inside the dispatch() body,
    // but spawnFn can also throw synchronously (e.g. an unforeseen bug in
    // options handling, a misconfigured bwrap probe that throws during
    // dispatch) -- that lands in the startTask() try/catch which was
    // missing the same extractChangesetForTask() the async path runs.
    // Without the fix, overlayDirs is set + changesetStatus === "pending"
    // and the orphan sweep (sweepOrphanedOverlays, whose skip condition is
    // `ownsThisOverlay && changesetStatus === "pending"`) deliberately
    // leaves it alone -- the overlay sits on the tmpfs until a manual
    // reject or a reboot.
    let extractCalls = 0;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-spawn-throw-extract-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-spawn-throw-extract-tmp-"));
    const mgr = makeManager({
      spawnFn: () => { throw new Error("spawn failed synchronously"); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
      runOverlayCommandFn: () => { extractCalls++; return { status: 0, stdout: "", stderr: "", error: undefined }; },
    });

    const preDispatchCalls = extractCalls;
    const dispatched = mgr.dispatch({ prompt: "hi", directory });

    const status = mgr.status(dispatched.id);
    assert.equal(status.status, "crashed");
    assert.equal(status.spawnError, "spawn failed synchronously");
    // Empty overlay (no worker ever ran) -> 0-byte diff -> "accepted" (same
    // shape the async spawn-error path produces), overlayDirs cleared.
    assert.equal(status.changesetStatus, "accepted");
    assert.equal("overlayDirs" in status, false);
    assert.ok(extractCalls > preDispatchCalls, "extractChangesetForTask should run on the sync-throw spawn-failure path");
  });
});

describe("isOutsideDirectory()", () => {
  test("is true for a genuinely outside sibling path", () => {
    assert.equal(isOutsideDirectory("/workspace/repo", "/workspace/other"), true);
  });

  test("is false for a path nested inside the directory", () => {
    assert.equal(isOutsideDirectory("/workspace/repo", "/workspace/repo/.git"), false);
  });

  test("does not misclassify a nested directory whose name happens to start with '..' as outside", () => {
    assert.equal(isOutsideDirectory("/workspace/repo", "/workspace/repo/..foo"), false);
  });

  test("is true for the parent directory itself", () => {
    assert.equal(isOutsideDirectory("/workspace/repo/sub", "/workspace/repo"), true);
  });
});

describe("bwrap sandboxing", () => {
  test("wraps the spawn command in bwrap when sandboxing is enabled and available", () => {
    let captured = null;
    const runtimeDir = path.join(os.tmpdir(), "axi-tasks-runtime");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      runtimeDir,
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), model: "opencode-go/minimax-m3", variant: "max", executor: "opencode" });

    assert.equal(captured.cmd, "bwrap");
    assert.deepEqual(captured.args.slice(0, 3), ["--ro-bind", "/", "/"]);
    assert.deepEqual(captured.args.slice(3, 9), ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]);
    assert.ok(captured.args.includes(mgr.paths.STATE_DIR));
    const bindIndex = captured.args.indexOf("--bind");
    assert.equal(captured.args[bindIndex + 1], os.tmpdir());
    assert.ok(captured.args.includes(runtimeDir));
    assert.deepEqual(captured.args.slice(-14), [
      "--", "opencode", "run", "--dir", os.tmpdir(), "--auto", "--format", "json",
      "-m", "opencode-go/minimax-m3", "--variant", "max", "--", "hello",
    ]);
    assert.equal(captured.opts.cwd, os.tmpdir());
  });

  test("binds a git worktree's real gitdir read-write, since it lives outside the dispatch directory itself (issue #103's underlying blocker)", () => {
    let captured = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-worktree-dir-"));
    const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-git-common-dir-"));
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
    });

    mgr.dispatch({ prompt: "hello", directory });

    const bindIndex = captured.args.indexOf(gitCommonDir);
    assert.notEqual(bindIndex, -1);
    assert.equal(captured.args[bindIndex - 1], "--bind");
  });

  test("does not add a redundant bind when the resolved git-common-dir is already inside the dispatch directory", () => {
    let captured = null;
    const directory = os.tmpdir();
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => path.join(directory, ".git"),
      // Independent of whatever real ~/.pi files happen to exist on the
      // machine running this test -- a real sessions/ dir there would
      // otherwise add a 4th --bind (the rw sessions pair-bind) and make
      // this count flaky across environments.
      existsFn: () => false,
    });

    mgr.dispatch({ prompt: "hello", directory });

    const bindCount = captured.args.filter((arg) => arg === "--bind").length;
    // directory + runtimeDir + the sandboxed opencode data home -- the
    // git-common-dir sits inside `directory`, already covered by that one bind.
    assert.equal(bindCount, 3);
  });

  test("falls back to binding the whole common dir for a submodule layout, where gitDir resolves to the same path as gitCommonDir", () => {
    let captured = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-submodule-dir-"));
    const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-git-common-dir-"));
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => gitCommonDir,
    });

    mgr.dispatch({ prompt: "hello", directory });

    const bindIndex = captured.args.indexOf(gitCommonDir);
    assert.notEqual(bindIndex, -1);
    assert.equal(captured.args[bindIndex - 1], "--bind");
  });

  test("falls back to binding the whole common dir when gitDir resolution fails outright", () => {
    let captured = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-resolve-fail-dir-"));
    const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-git-common-dir-"));
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => null,
    });

    mgr.dispatch({ prompt: "hello", directory });

    const bindIndex = captured.args.indexOf(gitCommonDir);
    assert.notEqual(bindIndex, -1);
    assert.equal(captured.args[bindIndex - 1], "--bind");
  });

  test("scopes the bind (never the whole common dir) even when gitDir resolves to a non-standard layout outside gitCommonDir's own tree", () => {
    let captured = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-separate-gitdir-dir-"));
    const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-git-common-dir-"));
    // A gitDir that lives entirely outside gitCommonDir's own tree (e.g. a
    // manually re-pointed `gitdir:`/`commondir` file) -- the earlier version
    // of this fix fell through to binding the whole common dir for this
    // case, re-admitting taskferry#224's exposure. It must not do that.
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-elsewhere-gitdir-"));
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => gitDir,
    });

    mgr.dispatch({ prompt: "hello", directory });

    const boundPaths = [];
    for (let i = 0; i < captured.args.length - 1; i++) {
      if (captured.args[i] === "--bind") boundPaths.push(captured.args[i + 1]);
    }
    assert.ok(boundPaths.includes(gitDir), "should bind the resolved private gitdir");
    assert.equal(boundPaths.includes(gitCommonDir), false, "must never bind the whole common dir once a distinct gitDir was resolved");
  });

  test("scopes the git-common-dir bind to the worktree's own admin dir + shared objects/refs, never the main checkout's private HEAD/index/config (regression for taskferry#224)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "axi-git-repo-"));
    const mainCheckout = path.join(root, "main");
    fs.mkdirSync(mainCheckout);
    const git = (args) => execFileSync("git", args, { cwd: mainCheckout, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "a@b.com"]);
    git(["config", "user.name", "test"]);
    fs.writeFileSync(path.join(mainCheckout, "f.txt"), "hi\n");
    git(["add", "f.txt"]);
    git(["commit", "-q", "-m", "init"]);
    git(["branch", "feature"]);
    const worktreeDir = path.join(root, "wt");
    git(["worktree", "add", "-q", worktreeDir, "feature"]);

    let captured = null;
    // No resolveGitCommonDirFn/resolveGitDirFn override -- exercises the
    // real `git rev-parse` calls against the worktree above, not a mock.
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
    });

    mgr.dispatch({ prompt: "hello", directory: worktreeDir });

    const boundPaths = [];
    for (let i = 0; i < captured.args.length - 1; i++) {
      if (captured.args[i] === "--bind") boundPaths.push(captured.args[i + 1]);
    }
    const mainGitDir = path.join(mainCheckout, ".git");
    const worktreeGitDir = path.join(mainGitDir, "worktrees", "wt");

    assert.ok(boundPaths.includes(worktreeGitDir), "should bind the worktree's own private gitdir");
    assert.ok(boundPaths.includes(path.join(mainGitDir, "objects")), "should bind shared objects");
    assert.ok(boundPaths.includes(path.join(mainGitDir, "refs")), "should bind shared refs");

    // The main checkout's own private admin files must never be writable
    // from a dispatch that never named that checkout at all.
    assert.equal(boundPaths.includes(mainGitDir), false, "must not bind the whole common dir");
    assert.equal(boundPaths.includes(path.join(mainGitDir, "HEAD")), false);
    assert.equal(boundPaths.includes(path.join(mainGitDir, "index")), false);
    assert.equal(boundPaths.includes(path.join(mainGitDir, "config")), false);
  });

  test("binds the manager-level allowedDirs config default read-write", () => {
    let captured = null;
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), "axi-allowed-dir-"));
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => null,
      allowedDirs: [allowed],
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    const bindIndex = captured.args.indexOf(allowed);
    assert.notEqual(bindIndex, -1);
    assert.equal(captured.args[bindIndex - 1], "--bind");
  });

  test("binds a per-dispatch --allowed-dirs entry read-write, in addition to the manager-level default", () => {
    let captured = null;
    const managerDefault = fs.mkdtempSync(path.join(os.tmpdir(), "axi-allowed-dir-"));
    const perDispatch = fs.mkdtempSync(path.join(os.tmpdir(), "axi-allowed-dir-"));
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => null,
      allowedDirs: [managerDefault],
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), allowedDirs: [perDispatch] });

    const managerBindIndex = captured.args.indexOf(managerDefault);
    assert.notEqual(managerBindIndex, -1);
    assert.equal(captured.args[managerBindIndex - 1], "--bind");

    const perDispatchBindIndex = captured.args.indexOf(perDispatch);
    assert.notEqual(perDispatchBindIndex, -1);
    assert.equal(captured.args[perDispatchBindIndex - 1], "--bind");
  });

  test("silently skips an allowedDirs entry that doesn't exist on disk", () => {
    let captured = null;
    const missing = path.join(os.tmpdir(), "axi-allowed-dir-does-not-exist");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => null,
      allowedDirs: [missing],
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    assert.equal(captured.args.includes(missing), false);
  });

  test("drops deny-list paths that don't exist on disk, since bwrap's --tmpfs fails on a missing mount point", () => {
    let captured = null;
    const missing = path.join(os.homedir(), ".aws");
    const present = path.join(os.homedir(), ".ssh");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      existsFn: (p) => p !== missing,
      platform: "linux",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    assert.equal(captured.args.includes(missing), false);
    assert.equal(captured.args.includes(present), true);
  });

  test("tmpfs-masks a configured sandboxDenylist entry in addition to the fixed default deny-list", () => {
    let captured = null;
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), "axi-sandbox-denylist-"));
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      // Fixed-default entries (~/.ssh, ~/.claude) are asserted below as
      // present alongside the configured extra -- stub existsFn so that
      // assertion doesn't depend on this host's actual home directory
      // contents (a clean CI runner has neither), same pattern as the
      // sibling "drops deny-list paths that don't exist on disk" test above.
      existsFn: () => true,
      platform: "linux",
      sandboxDenylist: [extra],
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    const extraIndex = captured.args.indexOf(extra);
    assert.notEqual(extraIndex, -1, "expected the configured extra path to be tmpfs-denied");
    assert.equal(captured.args[extraIndex - 1], "--tmpfs");
    // The fixed defaults are still applied alongside the configured extra.
    assert.ok(captured.args.includes(path.join(os.homedir(), ".ssh")));
    assert.ok(captured.args.includes(path.join(os.homedir(), ".claude")));
  });

  test("points XDG_DATA_HOME at a writable spot under cacheDir when sandboxing, so opencode's own log/session db isn't blocked by the read-only root", () => {
    let captured = null;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-cache-"));
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      cacheDir,
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), executor: "opencode" });

    assert.equal(captured.opts.env.XDG_DATA_HOME, path.join(cacheDir, "opencode-data"));
  });

  test("ro-binds the real opencode auth.json into the sandboxed XDG_DATA_HOME when it exists, so credentialed providers still resolve", () => {
    let captured = null;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-cache-"));
    const realAuthFile = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      existsFn: (p) => p === realAuthFile,
      platform: "linux",
      cacheDir,
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), executor: "opencode" });

    const srcIndex = captured.args.indexOf(realAuthFile);
    assert.notEqual(srcIndex, -1);
    assert.equal(captured.args[srcIndex - 1], "--ro-bind");
    assert.equal(captured.args[srcIndex + 1], path.join(cacheDir, "opencode-data", "opencode", "auth.json"));
  });

  test("omits the auth.json ro-bind when the real file doesn't exist on disk", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      existsFn: () => false,
      platform: "linux",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    // "--ro-bind" still appears once, for the base "/" root bind — the extra
    // auth.json ro-bind (destination ".../opencode-data/opencode/auth.json")
    // is absent, even though the data home itself is still read-write bound.
    assert.equal(captured.args.some((arg) => typeof arg === "string" && arg.includes(path.join("opencode-data", "opencode", "auth.json"))), false);
  });

  test("leaves XDG_DATA_HOME untouched when sandboxing is disabled", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: false,
      platform: "linux",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    assert.equal(captured.opts.env.XDG_DATA_HOME, undefined);
  });

  test("falls through to the unwrapped opencode command when --no-sandbox is set on a dispatch", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => { throw new Error("checkBwrapAvailableFn should not be called when --no-sandbox is set"); },
      platform: "linux",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), noSandbox: true, executor: "opencode" });

    assert.equal(captured.cmd, "opencode");
  });

  test("falls through to the unwrapped opencode command when sandboxEnabled is false", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: false,
      checkBwrapAvailableFn: () => { throw new Error("checkBwrapAvailableFn should not be called when sandboxEnabled is false"); },
      platform: "linux",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), executor: "opencode" });

    assert.equal(captured.cmd, "opencode");
  });

  test("falls through to the unwrapped opencode command on a non-Linux platform without probing bwrap", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => { throw new Error("checkBwrapAvailableFn should not be called on a non-Linux platform"); },
      platform: "darwin",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), executor: "opencode" });

    assert.equal(captured.cmd, "opencode");
  });

  test("crashes the task with a matching spawnError when bwrap is required but unavailable", () => {
    const mgr = makeManager({
      spawnFn: () => { throw new Error("spawnFn should not be called when bwrap is unavailable"); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: false, reason: "bwrap not found" }),
      platform: "linux",
    });

    const dispatched = mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });
    const status = mgr.status(dispatched.id);

    assert.equal(status.status, "crashed");
    assert.match(status.spawnError, /bwrap is required for sandboxing but was not found/);
  });

  test("checks bwrap availability only once across multiple dispatches", () => {
    let calls = 0;
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => { calls++; return { checked: true, available: true }; },
      platform: "linux",
    });

    mgr.dispatch({ prompt: "one", directory: os.tmpdir() });
    mgr.dispatch({ prompt: "two", directory: os.tmpdir() });

    assert.equal(calls, 1);
  });

  test("ro-binds PROMPT_DIR when an oversized prompt is attached inside the sandbox", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
    });
    const prompt = "x".repeat(96 * 1024 + 1);

    mgr.dispatch({ prompt, directory: os.tmpdir(), executor: "opencode" });

    assert.equal(captured.cmd, "bwrap");
    const attachment = captured.args[captured.args.indexOf("-f") + 1];
    const promptDir = path.join(mgr.paths.STATE_DIR, "prompts");
    assert.equal(path.dirname(attachment), promptDir);
    const promptBindIndex = captured.args.findIndex(
      (arg, index) => arg === "--ro-bind"
        && captured.args[index + 1] === promptDir
        && captured.args[index + 2] === promptDir
    );
    assert.notEqual(promptBindIndex, -1, "expected PROMPT_DIR to be restored read-only after stateDir is masked");
  });

  test("wraps a summary launch's spawn in bwrap too, binding SUMMARY_DIR", async () => {
    let captured;
    const child = fakeChild();
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Investigated the issue" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      spawnFn: (command, args, options) => { captured = { command, args, options }; return child; },
    });

    await mgr.summarize("source", { maxWords: 150 });

    assert.equal(captured.command, "bwrap");
    assert.equal(captured.options.cwd, mgr.paths.SUMMARY_DIR);
    const bindIndex = captured.args.indexOf("--bind");
    assert.equal(captured.args[bindIndex + 1], mgr.paths.SUMMARY_DIR);
    assert.equal(captured.args.includes("--agent"), false);

    child.emit("exit", 0, null);
  });

  test("mounts an overlay on the target directory when overlayEnabled and the host supports it", () => {
    let captured = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-overlay-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-overlay-tmp-"));
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });

    assert.ok(captured.args.includes("--overlay-src"));
    const overlayIndex = captured.args.indexOf("--overlay-src");
    assert.equal(captured.args[overlayIndex + 1], directory);
    const status = mgr.status(result.id);
    assert.equal(status.changesetStatus, "pending");
    assert.ok(status.overlayDirs.upperDir.startsWith(overlayTmpRoot));
    assert.equal(status.overlayDirs.tmpRoot, overlayTmpRoot);
  });

  test("resolvePreDispatchHead is invoked through the injected runOverlayCommandFn delegate, not via a direct subprocess", () => {
    // The pre-dispatch HEAD probe used to be a direct call into the
    // changeset.js default runner, side-stepping the runOverlayCommandFn
    // delegate every other git/command invocation in this module goes
    // through. Fake it out and assert the probe is observably routed through
    // the injected delegate (and the captured HEAD lands on the task).
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-pre-dispatch-head-tmp-"));
    const preDispatchCalls = [];
    const FAKE_HEAD = "0123456789abcdef0123456789abcdef01234567";
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
      runOverlayCommandFn: (command, args) => {
        preDispatchCalls.push({ command, args });
        // Only the pre-dispatch HEAD probe runs here (the child never
        // exits, so there's no extraction bwrap call). Return a fake HEAD
        // for the first probe + a git-dir for the fallback to land on the
        // git target path.
        if (command === "git" && args.includes("rev-parse") && args.includes("HEAD")) {
          return { status: 0, stdout: `${FAKE_HEAD}\n`, stderr: "", error: undefined };
        }
        if (command === "git" && args.includes("--git-dir")) {
          return { status: 0, stdout: ".git\n", stderr: "", error: undefined };
        }
        return { status: 0, stdout: "", stderr: "", error: undefined };
      },
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    // The probe must be observable through the injected delegate, not a
    // real subprocess. The directory argument has to be threaded through too,
    // so the bwrap/git probe targets the dispatch's launch directory.
    const headProbe = preDispatchCalls.find((c) => c.command === "git" && c.args.includes("HEAD"));
    assert.ok(headProbe, "resolvePreDispatchHead must go through runOverlayCommandFn");
    assert.equal(headProbe.args[0], "-C");
    assert.equal(headProbe.args[1], os.tmpdir());
    // The probe went through the delegate: the dispatch landed on a git
    // target rather than a non-git one (otherwise the --git-dir fallback
    // probe would have returned the empty-tree sentinel and the task would
    // have been a git target via a different code path -- the existence of
    // the HEAD probe alone is what we're checking here).
    assert.ok(preDispatchCalls.some((c) => c.command === "git" && c.args.includes("HEAD")));
  });

  test("falls back to a plain bind with a warning when overlayEnabled is explicitly false", () => {
    let captured = null;
    let warned = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-no-overlay-dir-"));
      const mgr = makeManager({
        spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
        sandboxEnabled: true,
        checkBwrapAvailableFn: () => ({ checked: true, available: true }),
        overlayEnabled: false,
        platform: "linux",
      });
      const result = mgr.dispatch({ prompt: "hello", directory });
      assert.equal(captured.args.includes("--overlay-src"), false);
      assert.equal("changesetStatus" in mgr.status(result.id), false);
      assert.match(warned, /overlay disabled/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("crashes the task with a spawnError instead of dispatching unguarded when overlay is required but unsupported", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-unsupported-dir-"));
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: false, reason: "bwrap 0.6.0 < 0.8 required for --overlay" }),
      platform: "linux",
    });
    const result = mgr.dispatch({ prompt: "hello", directory });
    const status = mgr.status(result.id);
    assert.equal(status.status, "crashed");
    assert.match(status.spawnError, /bwrap 0.6.0 < 0.8/);
  });

  test("requireOverlaySupport() re-probes a negative result after the TTL so a transient failure can self-heal", () => {
    // Trigger: a time-based TTL on a negative probe cache. A positive probe
    // is cached forever (no point re-probing); a transient negative probe
    // (PATH temporarily missing bwrap, bwrap version low mid-upgrade, ...) is
    // re-evaluated after 60s so the daemon self-heals without a restart.
    let calls = 0;
    let now = 1_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    const restore = () => { Date.now = realNow; };
    try {
      const mgr = makeManager({
        spawnFn: () => fakeChild(),
        sandboxEnabled: true,
        checkBwrapAvailableFn: () => ({ checked: true, available: true }),
        overlayEnabled: true,
        checkOverlaySupportFn: () => { calls++; return { supported: false, reason: "bwrap 0.6.0 < 0.8" }; },
        platform: "linux",
      });

      // First dispatch: probe runs, cached as negative.
      mgr.dispatch({ prompt: "one", directory: os.tmpdir() });
      assert.equal(calls, 1);

      // Second dispatch immediately: cache is negative and recent, no re-probe.
      mgr.dispatch({ prompt: "two", directory: os.tmpdir() });
      assert.equal(calls, 1);

      // Just under the TTL: still cached.
      now += 59_999;
      mgr.dispatch({ prompt: "three", directory: os.tmpdir() });
      assert.equal(calls, 1);

      // At/past the TTL: re-probe.
      now += 1;
      mgr.dispatch({ prompt: "four", directory: os.tmpdir() });
      assert.equal(calls, 2);
    } finally {
      restore();
    }
  });

  test("requireOverlaySupport() caches a positive result forever (no re-probe)", () => {
    // Companion to the negative-TTL test: once supported, the host stays
    // supported (bwrap doesn't get uninstalled through a transient issue).
    // A TTL here would be wasted work on every dispatch.
    let calls = 0;
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => { calls++; return { supported: true }; },
      platform: "linux",
    });

    mgr.dispatch({ prompt: "one", directory: os.tmpdir() });
    mgr.dispatch({ prompt: "two", directory: os.tmpdir() });
    mgr.dispatch({ prompt: "three", directory: os.tmpdir() });

    assert.equal(calls, 1);
  });

  test("converts the git-common-dir binds into per-path overlays instead of plain writable binds when overlay is active", () => {
    let captured = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-worktree-overlay-dir-"));
    const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-git-common-overlay-"));
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
    });

    mgr.dispatch({ prompt: "hello", directory });

    // The whole-common-dir fallback path (no resolveGitDirFn override -> gitDir
    // resolves to the same as gitCommonDir via the real `git` binary failing in
    // this temp dir, matching the existing "falls back to binding the whole
    // common dir" test's setup) must appear as an overlay, not a plain --bind.
    const overlaySrcIndex = captured.args.indexOf("--overlay-src", captured.args.indexOf("--overlay-src") + 1);
    assert.notEqual(overlaySrcIndex, -1, "expected a second --overlay-src for the git-common-dir slice");
    assert.equal(captured.args[overlaySrcIndex + 1], gitCommonDir);
  });

  test("shareNet stays true (--share-net) for both a plain dispatch and an advisor role", async () => {
    // Regression: an advisor role previously passed shareNet: false
    // (--unshare-net), which blocks ALL outbound network in the sandbox --
    // not just the daemon socket -- so the worker CLI could never reach its
    // model provider's API at all. It failed instantly (connection refused)
    // or hung until the no-output watchdog killed it, depending on the
    // executor. The daemon socket is protected by runtimeDirWritable: false
    // instead (see the read-only-runtimeDir test below), which doesn't touch
    // network access.
    let dispatchArgs = null;
    let advisorArgs = null;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { if (!dispatchArgs) dispatchArgs = args; else advisorArgs = args; const child = fakeChild(); setImmediate(() => child.emit("exit", 0, null)); return child; },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });
    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });
    assert.ok(dispatchArgs.includes("--share-net"));
    assert.ok(!dispatchArgs.includes("--unshare-net"));

    await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
    assert.ok(advisorArgs.includes("--share-net"));
    assert.ok(!advisorArgs.includes("--unshare-net"));
  });

  test("persists the git-common-dir sub-overlays onto the task record for extraction", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-rwbinds-persist-dir-"));
    const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-rwbinds-common-"));
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });

    // Review finding #1: extraction (Task 10) re-mounts the exact sub-overlays
    // the worker ran with; they must be persisted here, not re-derived later.
    const status = mgr.status(result.id);
    assert.ok(Array.isArray(status.overlayDirs.rwBinds));
    assert.ok(status.overlayDirs.rwBinds.length > 0, "the whole-common-dir fallback must be persisted as a sub-overlay");
    assert.ok(status.overlayDirs.rwBinds.every((b) => b.path && b.upperDir && b.workDir));
  });

  test("binds a git-common-dir FILE (packed-refs) as a scratch-copy rw bind instead of a directory sub-overlay", () => {
    // Regression: overlayfs mounts are directory-only. A worktree dispatch
    // whose common dir has a packed-refs file used to pass that file through
    // the same sub-overlay machinery as objects/refs, and bwrap died at
    // spawn with "Can't mkdir <...>/packed-refs: Not a directory".
    let captured = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-filebind-dir-"));
    const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-filebind-common-"));
    const gitDir = path.join(gitCommonDir, "worktrees", "wt");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(gitCommonDir, "objects"));
    fs.mkdirSync(path.join(gitCommonDir, "refs"));
    fs.mkdirSync(path.join(gitCommonDir, "logs", "refs"), { recursive: true });
    const packedRefs = path.join(gitCommonDir, "packed-refs");
    fs.writeFileSync(packedRefs, "# packfile refs\naaaa1111 refs/heads/main\n");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => gitDir,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });

    // No directory overlay may target the packed-refs file...
    for (let i = captured.args.indexOf("--overlay-src"); i !== -1 && i < captured.args.length; i = captured.args.indexOf("--overlay-src", i + 1)) {
      assert.notEqual(captured.args[i + 1], packedRefs, "packed-refs must not be mounted as a directory overlay");
    }
    // ...instead it is bound rw from a scratch copy onto its host path.
    const scratchIdx = captured.args.findIndex((a, idx) => a === "--bind" && captured.args[idx + 2] === packedRefs);
    assert.notEqual(scratchIdx, -1, "expected an rw bind whose destination is the host packed-refs");
    const scratchPath = captured.args[scratchIdx + 1];
    assert.notEqual(scratchPath, packedRefs, "the bind source must be a scratch copy, not the host file itself");
    assert.equal(fs.readFileSync(scratchPath, "utf8"), "# packfile refs\naaaa1111 refs/heads/main\n");

    const status = mgr.status(result.id);
    // Directory slices stay sub-overlays (gitDir, objects, refs, logs/refs)...
    assert.equal(status.overlayDirs.rwBinds.length, 4);
    // ...and the file bind is persisted separately for extraction to re-mount.
    assert.deepEqual(status.overlayDirs.rwFileBinds, [{ path: packedRefs, bindSrc: scratchPath }]);
  });

  test("a git-common-dir with no packed-refs file (unborn/fresh repo) gets no file bind", () => {
    // Companion to the packed-refs regression test above -- a fresh worktree
    // with no packed refs yet must not synthesize a scratch-copy bind for a
    // file that doesn't exist (existsFn(packedRefs) guards this).
    let captured = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-nofilebind-dir-"));
    const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-nofilebind-common-"));
    const gitDir = path.join(gitCommonDir, "worktrees", "wt");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(gitCommonDir, "objects"));
    fs.mkdirSync(path.join(gitCommonDir, "refs"));
    fs.mkdirSync(path.join(gitCommonDir, "logs", "refs"), { recursive: true });
    // Deliberately no packed-refs file written.
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => gitDir,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });

    const packedRefs = path.join(gitCommonDir, "packed-refs");
    const scratchIdx = captured.args.findIndex((a, idx) => a === "--bind" && captured.args[idx + 2] === packedRefs);
    assert.equal(scratchIdx, -1, "no rw bind should target a packed-refs file that doesn't exist");

    const status = mgr.status(result.id);
    assert.deepEqual(status.overlayDirs.rwFileBinds, [], "rwFileBinds must be empty when there is no writable file to bind");
    assert.equal(status.overlayDirs.rwBinds.length, 4, "the directory slices are unaffected");
  });

  test("binds runtimeDir read-only for advisor spawns so the daemon socket is unreachable", async () => {
    // --unshare-net alone does not block Unix-domain-socket access to a
    // writable bind-mounted path, and runtimeDir holds daemon.sock (review
    // finding #6); a read-only bind makes connect() fail instead.
    let dispatchArgs = null;
    let advisorArgs = null;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { if (!dispatchArgs) dispatchArgs = args; else advisorArgs = args; const child = fakeChild(); setImmediate(() => child.emit("exit", 0, null)); return child; },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });
    const runtimeDir = path.join(mgr.paths.STATE_DIR, "run");

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });
    const flagPairs = (args) => {
      const pairs = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--bind" || args[i] === "--ro-bind") pairs.push([args[i], args[i + 1]]);
      }
      return pairs;
    };
    assert.ok(flagPairs(dispatchArgs).some(([flag, p]) => flag === "--bind" && p === runtimeDir), "dispatch keeps today's writable runtimeDir bind");

    await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
    assert.ok(flagPairs(advisorArgs).some(([flag, p]) => flag === "--ro-bind" && p === runtimeDir), "advisor must get a read-only runtimeDir bind");
    assert.ok(!flagPairs(advisorArgs).some(([flag, p]) => flag === "--bind" && p === runtimeDir), "advisor must not get a writable runtimeDir bind");
  });

  test("crashes an advisor dispatch instead of running it unguarded when overlay is globally disabled", async () => {
    // Review finding #5: an advisor without an overlay gets a plain writable
    // bind -- a path to persist writes, contradicting ADR 0001. Fail closed.
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: false,
      platform: "linux",
    });
    const advised = await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
    const status = mgr.status(advised.task_id);
    assert.equal(status.status, "crashed");
    assert.match(status.spawnError, /advisor dispatch requires overlay-gated writes/);
  });

  test("crashes an advisor dispatch instead of running it unguarded when sandboxing is force-disabled", async () => {
    // Review finding #5 (dispatch-launch side): the overlay fail-closed check
    // lives inside the sandbox block, so a globally-disabled sandbox would
    // otherwise let an advisor launch with a plain writable bind -- a path to
    // persist writes, contradicting ADR 0001. Fail closed at dispatch-launch.
    let spawned = false;
    const mgr = makeManager({
      spawnFn: () => { spawned = true; return fakeChild(); },
      sandboxEnabled: false,
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });
    const advised = await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
    const status = mgr.status(advised.task_id);
    assert.equal(status.status, "crashed");
    assert.match(status.spawnError, /advisor dispatch requires overlay-gated writes/);
    assert.match(status.spawnError, /sandbox is unavailable/);
    assert.equal(spawned, false, "advisor must not spawn an unsandboxed child");
  });

  test("crashes an advisor dispatch instead of running it unguarded when the platform cannot sandbox", async () => {
    // Same guarantee on a platform with no sandbox support (e.g. non-Linux):
    // overlay-gating cannot be established, so an advisor must fail closed
    // rather than silently writing through to the target directory.
    let spawned = false;
    const mgr = makeManager({
      spawnFn: () => { spawned = true; return fakeChild(); },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "darwin",
    });
    const advised = await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
    const status = mgr.status(advised.task_id);
    assert.equal(status.status, "crashed");
    assert.match(status.spawnError, /advisor dispatch requires overlay-gated writes/);
    assert.equal(spawned, false, "advisor must not spawn an unsandboxed child");
  });
});

describe("changeset extraction at settlement", () => {
  test("extracts a diff and leaves changesetStatus pending for a settled dispatch with an active overlay", () => {
    let extractCommand = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-tmp-"));
    let child;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
      runOverlayCommandFn: (command, args) => { extractCommand = { command, args }; return { status: 0, stdout: "diff --git a/x b/x\n", stderr: "", error: undefined }; },
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const status = mgr.status(result.id);
    assert.equal(status.changesetStatus, "pending");
    assert.equal(mgr.result(result.id, { fields: ["diff"] }).diff, "diff --git a/x b/x\n");
    assert.equal(extractCommand.command, "bwrap");
  });

  test("auto-rejects and cleans up an advisor's changeset at settlement", async () => {
    let cleanedRoot = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-advisor-extract-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-advisor-extract-tmp-"));
    let child;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "", error: undefined }),
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });

    const advisePromise = mgr.advisor({ prompt: "hello", directory, model: "openai/gpt-5.6-sol" });
    setImmediate(() => child.emit("exit", 0, null));
    const advised = await advisePromise;

    const status = mgr.status(advised.task_id);
    assert.equal(status.changesetStatus, "rejected");
    assert.ok(cleanedRoot);
  });

  test("re-mounts persisted git-common-dir sub-overlays during extraction", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-git-dir-"));
    execFileSync("git", ["init", "-q", directory]);
    fs.writeFileSync(path.join(directory, "f.txt"), "base\n");
    execFileSync("git", ["-C", directory, "add", "-A"]);
    execFileSync("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-common-"));
    const gitWorktreeAdminDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-gitdir-"));
    let extractArgs = null;
    let child;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => gitWorktreeAdminDir,
      runOverlayCommandFn: (command, args) => { extractArgs = args; return { status: 0, stdout: "diff --git a/f.txt b/f.txt\n", stderr: "", error: undefined }; },
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const overlaySrcCount = extractArgs.filter((a) => a === "--overlay-src").length;
    assert.ok(overlaySrcCount >= 2);
    assert.ok(extractArgs.includes(gitWorktreeAdminDir));
    assert.equal(mgr.status(result.id).changesetStatus, "pending");
  });

  test("auto-resolves a zero-change extraction to accepted and cleans up immediately", () => {
    let cleanedRoot = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-empty-extract-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-empty-extract-tmp-"));
    let child;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "", error: undefined }),
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const status = mgr.status(result.id);
    assert.equal(status.changesetStatus, "accepted");
    assert.ok(cleanedRoot);
    assert.equal("overlayDirs" in status, false);
  });

  test("extracts a changeset for a cancelled task too", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-cancel-extract-dir-"));
    let child;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { child = fakeChild(); return child; },
      killFn: () => {},
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: () => ({ status: 0, stdout: "diff --git a/x b/x\n", stderr: "", error: undefined }),
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    mgr.cancel(result.id);
    child.emit("exit", null, "SIGTERM");

    const status = mgr.status(result.id);
    assert.equal(status.status, "cancelled");
    assert.equal(status.changesetStatus, "pending");
    assert.equal(mgr.result(result.id, { fields: ["diff"] }).diff, "diff --git a/x b/x\n");
  });

  test("records extraction errors and keeps the overlay for recovery", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-failed-extract-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-failed-extract-tmp-"));
    let cleanedAny = false;
    let child;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
      runOverlayCommandFn: () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn bwrap ETIMEDOUT"), { code: "ETIMEDOUT" }) }),
      rmOverlayTreeFn: () => { cleanedAny = true; },
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const status = mgr.status(result.id);
    assert.equal(status.changesetStatus, "pending");
    assert.match(status.changesetError, /ETIMEDOUT/);
    assert.equal(mgr.result(result.id, { fields: ["diff"] }).diff, null);
    assert.ok(status.overlayDirs);
    assert.equal(cleanedAny, false);
  });
});

describe("dispatch() role/changeset fields", () => {
  test("a plain dispatch without an overlay omits role and changesetStatus from its summary", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild(), sandboxEnabled: false });
    const result = mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });
    const status = mgr.status(result.id);
    assert.equal("role" in status, false);
    assert.equal("changesetStatus" in status, false);
  });

  test("advisor() dispatches internally with role 'advisor'", async () => {
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { const child = fakeChild(); setImmediate(() => child.emit("exit", 0, null)); return child; },
      sandboxEnabled: false,
    });
    const advised = await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
    const status = mgr.status(advised.task_id);
    assert.equal(status.role, "advisor");
  });
});

describe("dispatch() with a prompt over the argv-safe size (issue #78: spawn E2BIG)", () => {
  test("a prompt at or under the argv-safe threshold is still passed inline, no -f attachment", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args, opts) => { captured = { args, opts }; return fakeChild(); } });
    const prompt = "x".repeat(96 * 1024);

    mgr.dispatch({ prompt, directory: os.tmpdir() });

    assert.equal(captured.args.includes("-f"), false);
    assert.equal(captured.args[captured.args.length - 1], prompt);
  });

  test("a prompt over the argv-safe threshold is written to a scratch file and attached via -f, never appearing in argv", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args, opts) => { captured = { args, opts }; return fakeChild(); } });
    const prompt = "x".repeat(96 * 1024 + 1);

    mgr.dispatch({ prompt, directory: os.tmpdir(), executor: "opencode" });

    assert.ok(captured.args.includes("-f"), "expected -f attachment flag in argv");
    const attachment = captured.args[captured.args.indexOf("-f") + 1];
    assert.equal(fs.readFileSync(attachment, "utf8"), prompt);
    assert.equal(fs.statSync(attachment).mode & 0o777, 0o600);
    assert.ok(!captured.args.includes(prompt), "the raw oversized prompt must never be passed as a single argv element");
    // A short instruction still follows "--" so opencode has a message, per its own CLI contract.
    assert.equal(captured.args[captured.args.length - 2], "--");
    assert.match(captured.args[captured.args.length - 1], /attached/i);
  });

  test("the scratch prompt file is deleted once the task settles", () => {
    const child = fakeChild();
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args, opts) => { captured = { args, opts }; return child; } });
    const prompt = "x".repeat(96 * 1024 + 1);

    mgr.dispatch({ prompt, directory: os.tmpdir(), executor: "opencode" });
    const attachment = captured.args[captured.args.indexOf("-f") + 1];
    assert.ok(fs.existsSync(attachment));

    child.emit("exit", 0, null);

    assert.equal(fs.existsSync(attachment), false);
  });

  test("the scratch prompt file is deleted even when the spawned child errors before exiting", () => {
    const child = fakeChild();
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args, opts) => { captured = { args, opts }; return child; } });
    const prompt = "x".repeat(96 * 1024 + 1);

    mgr.dispatch({ prompt, directory: os.tmpdir() });
    const attachment = captured.args[captured.args.indexOf("-f") + 1];

    child.emit("error", new Error("spawn opencode ENOENT"));

    assert.equal(fs.existsSync(attachment), false);
  });
});

describe("boot-time sweep of orphaned prompt scratch files in PROMPT_DIR", () => {
  function seedPromptDir(stateDir, entries) {
    const promptDir = path.join(stateDir, "prompts");
    fs.mkdirSync(promptDir, { recursive: true, mode: 0o700 });
    for (const name of entries) fs.writeFileSync(path.join(promptDir, name), "leftover prompt contents");
  }

  test("removes prompt files whose task id is not in the loaded task set", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-orphan-"));
    seedPromptDir(stateDir, [
      "oc_orphan_aaaaaaaa.prompt.txt",
      "oc_orphan_bbbbbbbb.prompt.txt",
    ]);

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts"));
    assert.deepEqual(remaining, []);
  });

  test("removes prompt files that belong to a tracked terminal task", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-orphan-"));
    const tracked = "oc_keepme_cccccccc";
    seedPromptDir(stateDir, [`${tracked}.prompt.txt`, "oc_orphan_dddddddd.prompt.txt"]);
    fs.writeFileSync(
      path.join(stateDir, "tasks.json"),
      JSON.stringify([baseTask({ id: tracked, status: "done" })], null, 2)
    );

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts"));
    assert.deepEqual(remaining, []);
  });

  test("removes prompt files for persisted tasks already marked 'unknown' after a crash", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-orphan-"));
    const crashed = "oc_running_eeeeeeee";
    seedPromptDir(stateDir, [`${crashed}.prompt.txt`]);
    fs.writeFileSync(
      path.join(stateDir, "tasks.json"),
      JSON.stringify([baseTask({ id: crashed, status: "unknown" })], null, 2)
    );

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts"));
    assert.deepEqual(remaining, []);
  });

  test("ignores unrelated files in PROMPT_DIR that don't match the prompt-file naming pattern", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-orphan-"));
    seedPromptDir(stateDir, ["unrelated.txt", ".DS_Store", "README"]);

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts")).sort();
    assert.deepEqual(remaining, [".DS_Store", "README", "unrelated.txt"]);
  });

  test("removes prompt files for both orphaned and tracked terminal tasks", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-orphan-"));
    const tracked = "oc_trackedfffffff";
    seedPromptDir(stateDir, [
      `${tracked}.prompt.txt`,
      "oc_orphan_11111111.prompt.txt",
      "oc_orphan_22222222.prompt.txt",
    ]);
    fs.writeFileSync(
      path.join(stateDir, "tasks.json"),
      JSON.stringify([baseTask({ id: tracked, status: "done" })], null, 2)
    );

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts"));
    assert.deepEqual(remaining, []);
  });

  test("boot-time sweep is a no-op when PROMPT_DIR is empty", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-orphan-"));
    seedPromptDir(stateDir, []);

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts"));
    assert.deepEqual(remaining, []);
  });

  test("removes prompt files for every persisted status after running and queued reload as unknown", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-orphan-"));
    const ids = {
      done: "oc_done_00000001",
      crashed: "oc_crash_00000002",
      cancelled: "oc_cancel_00000003",
      queued: "oc_queue_00000004",
      running: "oc_runnin_00000005",
    };
    seedPromptDir(stateDir, Object.values(ids).map((id) => `${id}.prompt.txt`));
    fs.writeFileSync(
      path.join(stateDir, "tasks.json"),
      JSON.stringify([
        baseTask({ id: ids.done, status: "done" }),
        baseTask({ id: ids.crashed, status: "crashed", exitCode: 1 }),
        baseTask({ id: ids.cancelled, status: "cancelled", signal: "SIGTERM" }),
        baseTask({ id: ids.queued, status: "queued", pid: null }),
        baseTask({ id: ids.running, status: "running" }),
      ], null, 2)
    );

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts")).sort();
    assert.deepEqual(remaining, []);
  });

  test("boot-time sweep creates PROMPT_DIR when it doesn't exist (first daemon boot ever)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-orphan-"));
    // Deliberately don't create PROMPT_DIR; the manager's mkdir loop at
    // line 512 creates it, and the sweep then has nothing to do.
    assert.equal(fs.existsSync(path.join(stateDir, "prompts")), false);

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    assert.equal(fs.existsSync(path.join(stateDir, "prompts")), true);
    assert.deepEqual(fs.readdirSync(path.join(stateDir, "prompts")), []);
  });

  test("removes every scratch prompt from a mixed orphaned and tracked terminal directory", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-orphan-"));
    const tracked = ["oc_track11111111", "oc_track22222222"];
    const orphans = ["oc_orphan_aaaaaaa1", "oc_orphan_aaaaaaa2", "oc_orphan_aaaaaaa3", "oc_orphan_aaaaaaa4"];
    seedPromptDir(stateDir, [
      ...tracked.map((id) => `${id}.prompt.txt`),
      ...orphans.map((id) => `${id}.prompt.txt`),
    ]);
    fs.writeFileSync(
      path.join(stateDir, "tasks.json"),
      JSON.stringify([
        baseTask({ id: tracked[0], status: "done" }),
        baseTask({ id: tracked[1], status: "crashed", exitCode: 1 }),
      ], null, 2)
    );

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts")).sort();
    assert.deepEqual(remaining, []);
  });
});

describe("sweepOrphanedOverlays()", () => {
  test("removes an overlay directory whose task id is unknown to this manager (crash before extraction ever ran)", () => {
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-tmp-"));
    fs.mkdirSync(path.join(overlayTmpRoot, "taskferry-cow-oc_gone", "upper", "main"), { recursive: true });
    let cleanedRoot = null;
    makeManager({
      overlayTmpRoot,
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });
    assert.equal(cleanedRoot, path.join(overlayTmpRoot, "taskferry-cow-oc_gone"));
  });

  test("does not sweep an overlay directory whose task still has a pending changeset", () => {
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-tmp-"));
    const overlayRoot = path.join(overlayTmpRoot, "taskferry-cow-t_pending");
    fs.mkdirSync(path.join(overlayRoot, "upper", "main"), { recursive: true });
    let cleanedAny = false;
    makeManager({
      overlayTmpRoot,
      tasksFixture: [{
        ...baseTask({ id: "t_pending" }),
        role: "dispatch",
        changesetStatus: "pending",
        overlayDirs: { root: overlayRoot, tmpRoot: overlayTmpRoot, upperDir: path.join(overlayRoot, "upper", "main"), workDir: path.join(overlayRoot, "work", "main") },
      }],
      rmOverlayTreeFn: () => { cleanedAny = true; },
    });
    assert.equal(cleanedAny, false);
  });

  test("does nothing when overlayTmpRoot doesn't exist or is empty", () => {
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-empty-"));
    assert.doesNotThrow(() => makeManager({ overlayTmpRoot }));
  });

  test("sweeps a resolved task overlay under its recorded non-live tmpRoot and persists clearing overlayDirs", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-resolved-state-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-resolved-overlay-"));
    const liveOverlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-live-overlay-"));
    const overlayRoot = path.join(overlayTmpRoot, "taskferry-cow-t_resolved");
    fs.mkdirSync(path.join(overlayRoot, "upper", "main"), { recursive: true });
    const task = {
      ...baseTask({ id: "t_resolved", directory: os.tmpdir() }),
      role: "dispatch",
      changesetStatus: "accepted",
      overlayDirs: {
        root: overlayRoot,
        tmpRoot: overlayTmpRoot,
        upperDir: path.join(overlayRoot, "upper", "main"),
        workDir: path.join(overlayRoot, "work", "main"),
      },
    };
    const tasksFile = path.join(stateDir, "tasks.json");
    fs.writeFileSync(tasksFile, JSON.stringify([task], null, 2));
    const mgr = createTaskManager({
      stateDir,
      overlayTmpRoot: liveOverlayTmpRoot,
      sandboxEnabled: false,
      cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-resolved-cache-")),
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => {},
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
    });

    assert.equal(fs.existsSync(overlayRoot), false);
    assert.equal("overlayDirs" in mgr.status(task.id), false);
    const persisted = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    assert.equal(persisted[0].overlayDirs, null);
  });

  test("two managers with distinct runtimeDirs and no explicit overlayTmpRoot never collide on the same overlay namespace (taskferry#286)", () => {
    // Regression for the shared-/tmp sweep collision: before scoping
    // overlayTmpRoot under runtimeDir, every manager's real default was the
    // same plain os.tmpdir(), so a second (e.g. restarting) daemon's startup
    // sweep could delete a first daemon's in-flight overlay out from under
    // it even though the two had fully isolated stateDir/runtimeDir.
    const runtimeDirA = fs.mkdtempSync(path.join(os.tmpdir(), "axi-runtime-a-"));
    const runtimeDirB = fs.mkdtempSync(path.join(os.tmpdir(), "axi-runtime-b-"));
    const stateDirA = fs.mkdtempSync(path.join(os.tmpdir(), "axi-state-a-"));
    const stateDirB = fs.mkdtempSync(path.join(os.tmpdir(), "axi-state-b-"));
    const mgrA = createTaskManager({
      stateDir: stateDirA,
      runtimeDir: runtimeDirA,
      sandboxEnabled: false,
      cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "axi-cache-a-")),
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => {},
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
    });
    const mgrB = createTaskManager({
      stateDir: stateDirB,
      runtimeDir: runtimeDirB,
      sandboxEnabled: false,
      cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "axi-cache-b-")),
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => {},
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
    });
    assert.notEqual(mgrA.paths.OVERLAY_TMP_ROOT, mgrB.paths.OVERLAY_TMP_ROOT);
    assert.ok(mgrA.paths.OVERLAY_TMP_ROOT.startsWith(runtimeDirA));
    assert.ok(mgrB.paths.OVERLAY_TMP_ROOT.startsWith(runtimeDirB));
  });
});

describe("output-completeness check at settlement time (issue #35)", () => {
  function writeLog(logPath, lines) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, lines.map((line) => JSON.stringify(line)).join("\n"));
  }

  test("task.activity events carry the dispatching task's originSessionId", async () => {
    const events = [];
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child, onEvent: (event) => events.push(event) });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), originSessionId: "sess-xyz" });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "working" } },
    ]);
    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    const activityEvent = events.find((event) => event.type === "task.activity");
    assert.equal(activityEvent?.originSessionId, "sess-xyz");
  });

  test("scheduleActivity emits an explicit failure marker instead of local narration when the summary model call fails", async () => {
    const events = [];
    const child = fakeChild();
    const mgr = makeManager({
      tasksFixture: [],
      spawnFn: () => child,
      listModelsFn: () => "openai/gpt-5.6-luna\n",
      onEvent: (event) => events.push(event),
    });
    mgr.setActivitySummarySubscriptions(1);

    mgr.dispatch({ prompt: "do the thing", directory: os.tmpdir() });
    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    const activityEvents = events.filter((event) => event.type === "task.activity");
    assert.ok(activityEvents.length >= 1, "expected at least one task.activity event");
    const failed = activityEvents.find((event) => event.activityVariants?.true?.summaryFailed === true);
    assert.ok(failed, "expected a task.activity event with summaryFailed: true in activityVariants");
    assert.equal(failed.activityVariants.true.activity, undefined);
    assert.match(failed.activityVariants.true.summaryError, /summary model is unavailable/);
  });

  test("a clean done task with a final message is not flagged incomplete", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "Final answer" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    const settled = mgr.status(dispatched.id);
    assert.equal(settled.status, "done");
    assert.equal("incomplete" in settled, false);
    assert.equal("finalMarker" in settled, false);
    assert.equal(mgr.result(dispatched.id).message, "Final answer");
  });

  test("a clean done task with an empty final message is flagged incomplete", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    const settled = mgr.status(dispatched.id);
    assert.equal(settled.status, "done");
    assert.equal(settled.incomplete, true);
    const r = mgr.result(dispatched.id);
    assert.equal(r.incomplete, true);
    assert.match(r.next, /no usable final output/);
  });

  test("a clean done task with only whitespace in the final message is flagged incomplete", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "   \n\t  " } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    assert.equal(mgr.status(dispatched.id).incomplete, true);
  });

  test("--require-final-marker with a matching message leaves the task as a normal done", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({
      prompt: "hi",
      directory: os.tmpdir(),
      finalMarker: "^Status: DONE$",
    });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "Status: DONE" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    const settled = mgr.status(dispatched.id);
    assert.equal(settled.status, "done");
    assert.equal("incomplete" in settled, false);
    assert.equal(settled.finalMarker, "^Status: DONE$");
    const r = mgr.result(dispatched.id, { fields: ["message", "incomplete", "finalMarker"] });
    assert.equal(r.incomplete, null);
    assert.equal(r.finalMarker, "^Status: DONE$");
    assert.equal(r.message, "Status: DONE");
  });

  test("--require-final-marker with a non-matching message flags the task incomplete", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({
      prompt: "hi",
      directory: os.tmpdir(),
      finalMarker: "^Status: DONE$",
    });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "I forgot to follow the contract" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    const settled = mgr.status(dispatched.id);
    assert.equal(settled.status, "done");
    assert.equal(settled.incomplete, true);
    assert.equal(settled.finalMarker, "^Status: DONE$");
    const r = mgr.result(dispatched.id);
    assert.equal(r.incomplete, true);
    assert.match(r.next, /--require-final-marker "\^Status: DONE\$" did not match/);
  });

  test("--require-final-marker combined with an empty message is flagged for both reasons", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({
      prompt: "hi",
      directory: os.tmpdir(),
      finalMarker: "^Status: DONE$",
    });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    assert.equal(mgr.status(dispatched.id).incomplete, true);
  });

  test("crashed and cancelled tasks are not relabeled as incomplete", () => {
    const crashChild = fakeChild();
    const crashMgr = makeManager({ spawnFn: () => crashChild });
    const crashTask = crashMgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    writeLog(crashTask.logPath, [
      { type: "text", part: { messageID: "m1", text: "" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    crashChild.emit("exit", 1, null);
    assert.equal(crashMgr.status(crashTask.id).status, "crashed");
    assert.equal("incomplete" in crashMgr.status(crashTask.id), false);

    const cancelChild = fakeChild();
    const cancelMgr = makeManager({ spawnFn: () => cancelChild, killFn: () => {} });
    const cancelTask = cancelMgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    cancelMgr.cancel(cancelTask.id);
    writeLog(cancelTask.logPath, [
      { type: "text", part: { messageID: "m1", text: "" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    cancelChild.emit("exit", null, "SIGTERM");
    assert.equal(cancelMgr.status(cancelTask.id).status, "cancelled");
    assert.equal("incomplete" in cancelMgr.status(cancelTask.id), false);
  });

  test("dispatch rejects an invalid regex source up front (before queueing)", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), finalMarker: "(unclosed" }),
      (error) => {
        assert.match(error.message, /--require-final-marker is not a valid RegExp/);
        return true;
      }
    );
  });

  test("dispatch stores originSessionId on the task and its summary", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), originSessionId: "sess-abc" });
    assert.equal(dispatched.originSessionId, "sess-abc");
    assert.equal(mgr.status(dispatched.id).originSessionId, "sess-abc");
  });

  test("dispatch without originSessionId stores null", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.equal(dispatched.originSessionId, null);
  });

  test("incomplete and finalMarker survive a daemon restart via tasks.json", () => {
    const child = fakeChild();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-restart-"));
    const logDir = path.join(stateDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });

    const mgr1 = createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => child,
      killFn: () => {},
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
    });
    const dispatched = mgr1.dispatch({
      prompt: "hi",
      directory: os.tmpdir(),
      finalMarker: "^Status: DONE$",
    });
    const logPath = dispatched.logPath;
    writeLog(logPath, [
      { type: "text", part: { messageID: "m1", text: "no marker here" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    assert.equal(mgr1.status(dispatched.id).incomplete, true);

    const mgr2 = createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => {},
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
    });
    const reloaded = mgr2.status(dispatched.id);
    assert.equal(reloaded.status, "done");
    assert.equal(reloaded.incomplete, true);
    assert.equal(reloaded.finalMarker, "^Status: DONE$");
  });
});

describe("dispatch queue", () => {
  test("launches at most two tasks per window and starts queued tasks FIFO", async () => {
    const children = [];
    const mgr = makeManager({
      maxDispatchesPerWindow: 2,
      dispatchWindowMs: 20,
      spawnFn: () => {
        const child = fakeChild(1000 + children.length);
        children.push(child);
        return child;
      },
    });

    const first = mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
    const second = mgr.dispatch({ prompt: "second", directory: os.tmpdir() });
    const third = mgr.dispatch({ prompt: "third", directory: os.tmpdir() });

    assert.equal(first.status, "running");
    assert.equal(second.status, "running");
    assert.equal(third.status, "queued");
    assert.equal(children.length, 2);

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(mgr.status(third.id).status, "running");
    assert.equal(children.length, 3);
  });

  test("cancels a queued task without spawning or signaling it", () => {
    const killCalls = [];
    const mgr = makeManager({
      maxDispatchesPerWindow: 1,
      dispatchWindowMs: 60000,
      spawnFn: () => fakeChild(),
      killFn: (pid, signal) => killCalls.push({ pid, signal }),
    });

    mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
    const queued = mgr.dispatch({ prompt: "second", directory: os.tmpdir() });
    const cancelled = mgr.cancel(queued.id);

    assert.equal(cancelled.status, "cancelled");
    assert.match(cancelled.note, /cancelled before launch/);
    assert.deepEqual(killCalls, []);
  });

  test("waits for a queued task to settle instead of returning immediately", async () => {
    const mgr = makeManager({
      maxDispatchesPerWindow: 1,
      dispatchWindowMs: 60000,
      spawnFn: () => fakeChild(),
    });

    mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
    const queued = mgr.dispatch({ prompt: "second", directory: os.tmpdir() });
    const waiting = mgr.poll(queued.id, { timeoutMs: 100 });
    mgr.cancel(queued.id);

    assert.equal((await waiting).status, "cancelled");
  });
});

describe("active-task concurrency cap (independent of the launch-rate window)", () => {
  test("starts at most maxConcurrentTasks children; a 5th stays queued until one finishes", () => {
    const children = [];
    const mgr = makeManager({
      spawnFn: () => {
        const c = fakeChild(9000 + children.length);
        children.push(c);
        return c;
      },
      maxConcurrentTasks: 4,
      maxDispatchesPerWindow: 10, // wide open, so only the concurrency cap is under test
      dispatchWindowMs: 60000,
    });
    const dispatched = Array.from({ length: 5 }, (_, i) => mgr.dispatch({ prompt: `p${i}`, directory: os.tmpdir() }));
    const statuses = () => dispatched.map((d) => mgr.status(d.id).status);
    assert.deepEqual(statuses(), ["running", "running", "running", "running", "queued"]);

    children[0].emit("exit", 0, null);
    assert.deepEqual(statuses(), ["done", "running", "running", "running", "running"]);
  });
});

describe("active-task concurrency cap (regressions)", () => {
  test("a child that fires both 'error' and 'exit' only decrements runningCount once (no over-promotion of the queue)", () => {
    // Dispatch concurrencyLimit + 2 so 2 tasks are initially queued. If the
    // exit/error handlers double-settle (no `settled` guard), runningCount
    // drops by 2 and launchQueuedTasks() runs twice in a row, promoting
    // BOTH queued tasks. With the guard, only the first promotion happens
    // and one task remains queued.
    const children = [];
    const mgr = makeManager({
      spawnFn: () => {
        const c = fakeChild(9100 + children.length);
        children.push(c);
        return c;
      },
      maxConcurrentTasks: 4,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
    });
    const dispatched = Array.from({ length: 6 }, (_, i) => mgr.dispatch({ prompt: `p${i}`, directory: os.tmpdir() }));
    const statusOf = (id) => mgr.status(id).status;
    assert.equal(dispatched.filter((d) => statusOf(d.id) === "queued").length, 2);

    // Double-settle children[0] synchronously: emit error first, then exit.
    children[0].emit("error", new Error("spawn opencode ENOENT"));
    children[0].emit("exit", 1, null);

    // children[0] settled to "crashed" once (the error wins), and exactly ONE
    // queued task was promoted to "running". The other still sits in
    // "queued" -- the duplicate exit event did not free a second slot.
    assert.equal(statusOf(dispatched[0].id), "crashed");
    assert.equal(dispatched.filter((d) => statusOf(d.id) === "running").length, 4);
    assert.equal(dispatched.filter((d) => statusOf(d.id) === "queued").length, 1);

    // Drain the queue so the test process can exit: finishing any other
    // running child promotes the last queued task and clears the retry
    // timer that launchQueuedTasks scheduled to wait for a slot to free.
    children[1].emit("exit", 0, null);
  });

  test("a persistence failure after spawn kills the child and releases its concurrency slot when it exits", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-test-"));
    const lockPath = path.join(stateDir, "tasks.lock");
    const children = [];
    const killCalls = [];
    const mgr = createTaskManager({
      stateDir,
      sandboxEnabled: false,
      maxConcurrentTasks: 1,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
      spawnFn: () => {
        const child = fakeChild(9200 + children.length);
        children.push(child);
        if (children.length === 1) {
          fs.mkdirSync(lockPath);
          const oldMs = Date.now() / 1000 - 3600;
          fs.utimesSync(lockPath, oldMs, oldMs);
        }
        return child;
      },
      killFn: (pid, signal) => killCalls.push({ pid, signal }),
    });

    assert.throws(
      () => mgr.dispatch({ prompt: "first", directory: os.tmpdir() }),
      /EISDIR|illegal operation on a directory/
    );
    assert.deepEqual(killCalls, [{ pid: -9200, signal: "SIGKILL" }]);

    children[0].emit("exit", null, "SIGKILL");
    fs.rmdirSync(lockPath);

    const second = mgr.dispatch({ prompt: "second", directory: os.tmpdir() });
    assert.equal(second.status, "running");
    assert.equal(children.length, 2);
  });
});

describe("config file precedence (maxConcurrentTasks)", () => {
  function managerWithLimit(t, { env, config }) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-cfg-precedence-"));
    const children = [];
    const originalEnv = process.env.TASKFERRY_MAX_CONCURRENT_TASKS;
    if (env === undefined) delete process.env.TASKFERRY_MAX_CONCURRENT_TASKS;
    else process.env.TASKFERRY_MAX_CONCURRENT_TASKS = env;
    t.after(() => {
      if (originalEnv === undefined) delete process.env.TASKFERRY_MAX_CONCURRENT_TASKS;
      else process.env.TASKFERRY_MAX_CONCURRENT_TASKS = originalEnv;
    });
    const manager = createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => {
        const child = fakeChild();
        children.push(child);
        return child;
      },
      killFn: () => {},
      config,
    });
    t.after(() => {
      for (const child of children) child.emit("exit", null, "SIGTERM");
    });
    return manager;
  }

  test("env var wins over config when both are set", (t) => {
    const mgr = managerWithLimit(t, { env: "1", config: { maxConcurrentTasks: 5 } });
    mgr.dispatch({ prompt: "a", directory: process.cwd(), model: "m" });
    const second = mgr.dispatch({ prompt: "b", directory: process.cwd(), model: "m" });
    assert.equal(mgr.status(second.id).status, "queued");
  });

  test("config value used when env var is unset", (t) => {
    const mgr = managerWithLimit(t, { env: undefined, config: { maxConcurrentTasks: 1 } });
    mgr.dispatch({ prompt: "a", directory: process.cwd(), model: "m" });
    const second = mgr.dispatch({ prompt: "b", directory: process.cwd(), model: "m" });
    assert.equal(mgr.status(second.id).status, "queued");
  });

  test("built-in default used when both env and config are unset", (t) => {
    const mgr = managerWithLimit(t, { env: undefined, config: {} });
    for (let i = 0; i < 4; i++) mgr.dispatch({ prompt: `p${i}`, directory: process.cwd(), model: "m" });
    const fifth = mgr.dispatch({ prompt: "p5", directory: process.cwd(), model: "m" });
    assert.equal(mgr.status(fifth.id).status, "queued");
  });
});

describe("no-output watchdog", () => {
  test("a running child with no parseable log event past the deadline is stopped and marked crashed with failureReason", async () => {
    const child = fakeChild(7001);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    await new Promise((r) => setTimeout(r, 60));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"), "watchdog must SIGTERM the stuck child's process group");
    assert.equal(JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"))[0].failureReason, "no_output_timeout");

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id);
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, "no_output_timeout");
    assert.deepEqual(mgr.result(dispatched.id, { fields: ["failureReason"] }), {
      taskId: dispatched.id,
      status: "crashed",
      failureReason: "no_output_timeout",
    });
  });

  test("result --fields failureDetail returns the field", async () => {
    const child = fakeChild(7201);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {}, noOutputTimeoutMs: 60000, watchdogPollMs: 5 });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, JSON.stringify({ type: "error", message: "insufficient_quota: out of credits" }) + "\n");
    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", 1, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail"] });
    assert.equal(r.failureReason, "payment_required");
    assert.equal(r.failureDetail, "insufficient_quota: out of credits");
  });

  test("a structured error event that matches none of the three named buckets still gets a failureReason instead of null (opencode's own UnknownError class)", async () => {
    const child = fakeChild(7203);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {}, noOutputTimeoutMs: 60000, watchdogPollMs: 5 });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", error: { name: "UnknownError", data: { message: "Streaming response failed" } } }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", 1, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail"] });
    assert.equal(r.failureReason, "opencode_unknownerror");
    assert.equal(r.failureDetail, "Streaming response failed");
  });

  test("the --fields validation error message includes failureDetail", () => {
    const child = fakeChild(7202);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    child.emit("exit", 0, null);
    assert.throws(
      () => mgr.result(dispatched.id, { fields: ["not_a_real_field"] }),
      /failureDetail/
    );
  });

  test("a running child that keeps writing parseable log events before each deadline is left alone", async () => {
    const child = fakeChild(7002);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 30,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const logPath = mgr.status(dispatched.id).logPath;
    const interval = setInterval(() => {
      fs.appendFileSync(logPath, JSON.stringify({ type: "text", part: { messageID: "m1", text: "still working..." } }) + "\n");
    }, 10);

    await new Promise((r) => setTimeout(r, 60));
    clearInterval(interval);
    assert.deepEqual(killed, []);
    assert.equal(mgr.status(dispatched.id).status, "running");

    child.emit("exit", 0, null);
    assert.equal(mgr.status(dispatched.id).failureReason, null);
  });

  test("repeated non-JSON output does not reset the no-output watchdog", async () => {
    const child = fakeChild(7004);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 30,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const logPath = mgr.status(dispatched.id).logPath;
    const interval = setInterval(() => fs.appendFileSync(logPath, "stderr noise\n"), 10);

    await new Promise((r) => setTimeout(r, 70));
    clearInterval(interval);
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
  });

  test("a running child that goes silent again after early output is eventually stopped (GLM-5.2 review finding)", async () => {
    const child = fakeChild(7003);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      postOutputNoOutputTimeoutMs: 20,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, JSON.stringify({ type: "text", part: { messageID: "m1", text: "working..." } }) + "\n");

    await new Promise((r) => setTimeout(r, 70));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"), "watchdog must eventually fire after the last activity, not just the start");

    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "no_output_timeout");
  });

  test("one log event then silence: the task survives well past noOutputTimeoutMs because the budget escalated", async () => {
    // The regression this whole change exists for: a task does real work,
    // then goes quiet to compose one long final answer. opencode writes
    // step-level events, not token deltas, so the log goes silent for
    // minutes and the pre-output budget would SIGTERM the task mid-write.
    //
    // Pre-change this test FAILS: postOutputNoOutputTimeoutMs is ignored,
    // the budget stays at 20 ms, and the SIGTERM lands ~25 ms in.
    const child = fakeChild(7005);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      postOutputNoOutputTimeoutMs: 10000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const logPath = mgr.status(dispatched.id).logPath;

    // One parseable line lands before the pre-output deadline, flipping the
    // latch. Everything from here to the assert is silence.
    fs.appendFileSync(logPath, JSON.stringify({ type: "text", part: { messageID: "m1", text: "working..." } }) + "\n");

    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(killed, [], "after one parseable log event, the escalated budget must keep the task alive past noOutputTimeoutMs");
    assert.equal(mgr.status(dispatched.id).status, "running");

    child.emit("exit", 0, null);
    assert.equal(mgr.status(dispatched.id).failureReason, null);
  });

  test("the escalated budget is still a deadline: silence past postOutputNoOutputTimeoutMs kills, and never before it", async () => {
    // Escalation must not mean "no watchdog at all" -- a genuinely hung task
    // that produced some output early still has to die, just on the longer
    // budget. The timing assertion is what makes this test discriminating:
    // pre-change the kill lands at the 20 ms pre-output budget, so asserting
    // the kill happened no earlier than 40 ms fails. Post-change it lands at
    // ~60 ms. Only a lower bound is asserted, since load can delay a timer
    // but never fire it early.
    const child = fakeChild(7006);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal, at: Date.now() }),
      noOutputTimeoutMs: 20,
      postOutputNoOutputTimeoutMs: 60,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const logPath = mgr.status(dispatched.id).logPath;

    const seededAt = Date.now();
    fs.appendFileSync(logPath, JSON.stringify({ type: "text", part: { messageID: "m1", text: "first event" } }) + "\n");

    await new Promise((r) => setTimeout(r, 200));
    const sigterm = killed.find((k) => k.signal === "SIGTERM");
    assert.ok(sigterm, "the post-output watchdog must still fire on continued silence past postOutputNoOutputTimeoutMs");
    assert.ok(
      sigterm.at - seededAt >= 40,
      `the kill must respect the escalated budget, not the 20 ms pre-output one (fired ${sigterm.at - seededAt} ms after the log event)`
    );

    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "no_output_timeout");
  });

  test("the watcher's first tick sees pre-existing JSON in the log: latch flips and post-output budget applies from the start", async () => {
    // Edge case in the escalation latch itself: the very first tick (not a
    // later one) is what observes the JSON line, so the latch must flip on
    // the first tick rather than only on a tick that follows a previous
    // empty tick. Pre-seeding the log file before the first tick fires is
    // the cleanest way to force that path through the code.
    //
    // The test reproduces this without touching internal manager state:
    // dispatch() opens the log file in append mode (fs.openSync(..., "a",
    // 0o600) at src/tasks.js:977), which preserves pre-existing content
    // instead of truncating it. The watcher's first tick then reads the
    // pre-seeded JSON from offset 0, so the outputSeen flag flips and
    // currentNoOutputTimeout jumps to postOutputNoOutputTimeout on the same
    // tick that would otherwise have hit the noOutputTimeout deadline.
    //
    // All code between dispatch() returning and fs.writeFileSync() returning
    // runs synchronously in the test thread, so the watcher's first interval
    // tick (scheduled via setInterval for `watchdogPollMs` ms later) cannot
    // fire before the seed is on disk.
    //
    // Note: this is not a "daemon-restart re-adoption" scenario in this
    // codebase -- loadPersisted() relabels any task that was `running` at
    // shutdown to `unknown` on restart, and startRunningWatcher() is only
    // ever invoked from a fresh dispatch() call, never re-armed for a
    // restored task. The edge case worth pinning down is purely the
    // first-tick-sees-existing-content timing of the latch.
    const child = fakeChild(7007);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      postOutputNoOutputTimeoutMs: 60,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const logPath = mgr.status(dispatched.id).logPath;
    fs.writeFileSync(logPath, JSON.stringify({ type: "text", part: { messageID: "m1", text: "from before" } }) + "\n");

    // Wait past noOutputTimeoutMs (20 ms) plus a comfortable buffer. With
    // the latch broken, the SIGTERM lands here because the budget stays at
    // 20 ms even though the log already contains parseable JSON. With the
    // latch working, the very first tick reads the pre-seeded JSON, the
    // outputSeen flag flips, and the deadline jumps to 60 ms.
    await new Promise((r) => setTimeout(r, 35));
    assert.deepEqual(killed, [], "watchdog must NOT fire at noOutputTimeoutMs when the log already contains parseable JSON");

    // Wait past postOutputNoOutputTimeoutMs (60 ms). The latch means the
    // deadline stays escalated at 60 ms, so continued silence must trigger
    // the SIGTERM at exactly the post-output budget, not at noOutputTimeoutMs
    // (broken latch) and not at the 300 s default (broken escalation).
    await new Promise((r) => setTimeout(r, 100));
    const sigterm = killed.find((k) => k.signal === "SIGTERM");
    assert.ok(sigterm, "after the latch from pre-existing JSON, the post-output watchdog must still fire on continued silence");

    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "no_output_timeout");
  });
});

describe("provider-failure classification", () => {
  test("a rate-limit diagnostic in the log stops the child early with failureReason rate_limited and captures failureDetail", async () => {
    const child = fakeChild(7101);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000, // long enough that only exhaustion detection could trigger this
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "rate_limit_exceeded: please retry after 60s" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited");
    assert.equal(s.failureDetail, "rate_limit_exceeded: please retry after 60s");
  });

  test("an unterminated rate-limit diagnostic stops the child early", async () => {
    const child = fakeChild(7104);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "rate limit exceeded");

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited");
    assert.equal(s.failureDetail, "rate limit exceeded");
  });

  test("a matched log line longer than 500 chars is truncated to exactly the 500-char cap", async () => {
    const child = fakeChild(7199);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    const longLine = "rate limit exceeded " + "x".repeat(1000);
    fs.writeFileSync(mgr.status(dispatched.id).logPath, longLine);

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited");
    assert.equal(s.failureDetail.length, 500);
    assert.ok(s.failureDetail.endsWith("…"));
  });

  test("status still lands on crashed when the SIGTERM'd child exits 0 (traps the signal) instead of dying by signal", async () => {
    const child = fakeChild(7105);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "rate_limit_exceeded: please retry after 60s" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    // A well-behaved CLI can trap SIGTERM and shut down cleanly (exit 0, no
    // signal) instead of dying by the signal itself. That must not read as
    // "done" and bury the failureReason behind a healthy-looking status.
    child.emit("exit", 0, null);
    const s = mgr.status(dispatched.id);
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, "rate_limited");
  });

  test("ordinary crash text is not misclassified as a provider failure (it surfaces as boot_failure instead)", () => {
    const child = fakeChild(7102);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "TypeError: cannot read property 'x' of undefined\n");
    child.emit("exit", 1, null);
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "crashed");
    // The false-positive protection this test was written for stands: no
    // provider bucket. But an eventless non-zero exit no longer settles
    // silent -- the raw line is now surfaced under the boot_failure bucket.
    assert.equal(s.failureReason, "pi_boot_failure");
    assert.equal(s.failureDetail, "TypeError: cannot read property 'x' of undefined");
  });

  test("a type:\"text\" narration event that legitimately mentions rate limits, quotas, or 429 is not misclassified as a provider failure (GLM-5.2 review finding)", async () => {
    const child = fakeChild(7103);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      [
        JSON.stringify({ type: "text", part: { messageID: "m1", text: "I hit a 429 while testing the client, so I added quota and rate-limit backoff handling per the usage-limit spec." } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }),
      ].join("\n") + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(killed.length, 0);
    assert.equal(mgr.status(dispatched.id).failureReason, null);
  });

  test("insufficient_quota lands on payment_required, not rate_limited", async () => {
    const child = fakeChild(7106);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "insufficient_quota: your account has run out of credits" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "payment_required");
    assert.equal(s.failureDetail, "insufficient_quota: your account has run out of credits");
  });

  test("a line combining insufficient_quota and rate-limit language resolves to payment_required (checked first)", async () => {
    const child = fakeChild(7107);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "rate limit exceeded: insufficient_quota on this key" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "payment_required");
  });

  test("a line mentioning quota alongside rate-limit language, without insufficient_quota, resolves to rate_limited (bare quota's fallback bucket)", async () => {
    const child = fakeChild(7108);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "Rate limit exceeded, check your quota" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "rate_limited");
  });

  test("unauthorized/invalid api key diagnostics land on authentication_failed", async () => {
    const child = fakeChild(7109);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "Unauthorized: invalid API key provided" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "authentication_failed");
    assert.equal(s.failureDetail, "Unauthorized: invalid API key provided");
  });

  test("a raw non-JSON line with an unrelated 3-digit number is not misclassified as authentication_failed", () => {
    const child = fakeChild(7110);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "401 tests passed, 0 failed\n");
    child.emit("exit", 1, null);
    // Not authentication_failed (the false-positive this test guards); an
    // eventless non-zero exit now surfaces as boot_failure with the raw
    // line as detail rather than leaving failureReason null.
    const s = mgr.status(dispatched.id);
    assert.equal(s.failureReason, "pi_boot_failure");
    assert.equal(s.failureDetail, "401 tests passed, 0 failed");
  });

  test("pi's plain-text 'No API key found for openai.' stderr line lands on authentication_failed (issue #94)", async () => {
    // pi's auth-failure stderr text reads "No API key found for <provider>."
    // -- plain English, not the `unauthorized`/`invalid api key`/`status 401`
    // surface the existing regex set covers. Without an additional pattern,
    // it leaks through as the unclassified `crashed` fallback. Today the
    // dispatch is opencode-backed (Task 6/7 will let a pi dispatch route
    // its raw line through the same classifier with `pi_` prefix); the
    // executor-prefixed end-to-end check lives with that task.
    const child = fakeChild(7115);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      "No API key found for openai.\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "authentication_failed");
    assert.equal(s.failureDetail, "No API key found for openai.");
  });

  test("a structured status_code: 401 diagnostic without the word 'unauthorized' still lands on authentication_failed", async () => {
    const child = fakeChild(7111);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "request failed with status_code: 401" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "authentication_failed");
  });

  test("no_output_timeout captures which timeout fired and the pre/post-output latch state in failureDetail", async () => {
    const child = fakeChild(7112);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "no_output_timeout");
    assert.equal(s.failureDetail, "no output for 20ms (pre-output timeout)");
  });

  test("failureReason and failureDetail are set once; a second watchdog tick does not overwrite either", async () => {
    const child = fakeChild(7113);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "rate_limit_exceeded: please retry after 60s" }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 20));

    // Append a second, different diagnostic after the first tick has almost
    // certainly already classified and started killing the task.
    fs.appendFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "Unauthorized: invalid API key provided" }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 20));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited", "the first classification wins");
    assert.equal(s.failureDetail, "rate_limit_exceeded: please retry after 60s");
  });
});

describe("trailing provider-error events that land after the last watcher poll (issue #81)", () => {
  test("a provider-error event written just before exit -- with no watcher tick in between -- is still classified instead of lost", () => {
    const child = fakeChild(7201);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      // Long enough that the watchdog interval never ticks during this test.
      watchdogPollMs: 60000,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "usage_limit_exceeded: monthly quota reached" }) + "\n"
    );

    // The provider process exits immediately after logging the error --
    // no interval tick ever gets a chance to read it.
    child.emit("exit", 1, null);

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, "rate_limited");
    assert.equal(s.failureDetail, "usage_limit_exceeded: monthly quota reached");
  });

  test("a trailing provider-error event is classified even when the child traps the signal-less exit and exits 0", () => {
    const child = fakeChild(7202);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 60000,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "Unauthorized: invalid API key provided" }) + "\n"
    );

    child.emit("exit", 0, null);

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, "authentication_failed");
  });

  test("does not override a failureReason the watcher already classified while the task was still running", async () => {
    const child = fakeChild(7203);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "rate_limit_exceeded: please retry after 60s" }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    // A second, different diagnostic lands right at exit -- the earlier,
    // watcher-classified reason must still win.
    fs.appendFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "Unauthorized: invalid API key provided" }) + "\n"
    );
    child.emit("exit", null, "SIGTERM");

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited");
    assert.equal(s.failureDetail, "rate_limit_exceeded: please retry after 60s");
  });

  test("a clean exit reuses the watcher's incremental offset and does not reclassify bytes the watcher already scanned", async () => {
    const child = fakeChild(7204);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    // A non-error line plus a newline-terminated final line so the watcher
    // can scan it without a trailing carry on its next tick.
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "all good" } }) + "\n"
      + JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }) + "\n"
    );
    // Wait for at least one watcher tick so bytesRead catches up to the
    // file size and the carry is empty.
    await new Promise((r) => setTimeout(r, 30));
    child.emit("exit", 0, null);

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "done");
    assert.equal(s.failureReason, null);
    assert.equal(s.failureDetail, null);
  });

  test("settlement reads only the trailing delta after the watcher's accumulated offset", async (t) => {
    const child = fakeChild(7209);
    const readCalls = [];
    const originalReadSync = fs.readSync;
    t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
      readCalls.push({ length, position });
      return originalReadSync(fd, buffer, offset, length, position);
    });
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    const logPath = mgr.status(dispatched.id).logPath;
    const prefix = JSON.stringify({ type: "text", part: { messageID: "m1", text: "x".repeat(4096) } }) + "\n";
    fs.writeFileSync(logPath, prefix);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const prefixBytes = Buffer.byteLength(prefix);
    assert.ok(readCalls.some((call) => call.position === 0 && call.length === prefixBytes));
    readCalls.length = 0;

    const trailing = JSON.stringify({ type: "error", message: "usage_limit_exceeded: monthly quota reached" }) + "\n";
    fs.appendFileSync(logPath, trailing);
    child.emit("exit", 1, null);

    // classifyTrailingLogFailure() reads only the trailing delta; the
    // remaining two calls are readSessionIdFromLog() scanning the log from
    // the start for a sessionID (one chunk covers the whole small file here,
    // plus a terminal zero-byte read that detects EOF).
    assert.deepEqual(readCalls, [
      { length: Buffer.byteLength(trailing), position: prefixBytes },
      { length: 64 * 1024, position: null },
      { length: 64 * 1024, position: null },
    ]);
    assert.equal(mgr.status(dispatched.id).failureReason, "rate_limited");
  });

  test("a clean exit with an opencode error in the watched-but-not-yet-classified bytes does not invent a failureReason", async () => {
    const child = fakeChild(7205);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 60000,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    // A `type:"text"` event that just happens to mention "rate limit" --
    // legitimate narration, not a provider failure (issue #81 guard).
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "the server returned 429 due to rate limit, so I retried with backoff" } }) + "\n"
    );
    child.emit("exit", 0, null);

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "done");
    assert.equal(s.failureReason, null);
  });

  test("a provider error split across the watcher's carry and the new bytes at exit is still classified", async () => {
    const child = fakeChild(7206);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    const fullLine = JSON.stringify({ type: "error", message: "rate_limit_exceeded: please retry after 60s" }) + "\n";
    // Write a partial line so the watcher's first tick stores it as carry,
    // then write the rest of the line plus a terminating \n. The exit
    // happens immediately after, before another watcher tick can finalize
    // the carry. classifyTrailingLogFailure must concatenate the carry
    // (the stale partial) with the new bytes (the rest of the line) and
    // still classify the merged line.
    const split = Math.floor(fullLine.length / 2);
    fs.writeFileSync(mgr.status(dispatched.id).logPath, fullLine.slice(0, split));
    await new Promise((r) => setTimeout(r, 30));
    fs.appendFileSync(mgr.status(dispatched.id).logPath, fullLine.slice(split));
    child.emit("exit", 1, null);

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited");
  });

  test("a trailing provider-error is still classified when the log file no longer exists at exit", () => {
    // Defensive: if the log was rotated/deleted between the watcher's last
    // tick and the exit handler, statSync throws ENOENT and the function
    // returns without crashing or inventing a reason.
    const child = fakeChild(7207);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 60000,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const logPath = mgr.status(dispatched.id).logPath;
    fs.writeFileSync(logPath, JSON.stringify({ type: "error", message: "rate_limit_exceeded: too many requests" }) + "\n");
    fs.unlinkSync(logPath);
    child.emit("exit", 1, null);

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, null);
    assert.equal(s.failureDetail, null);
  });

  test("a trailing provider-error is still classified when the log shrank past the watcher's offset between ticks", async () => {
    // Same shape as the file-shrank branch the watcher already handles: if
    // the log got rotated/replaced between the watcher's last tick and
    // exit, classifyTrailingLogFailure must reclassify the replacement
    // contents from offset 0, not from the stale watcher offset.
    const child = fakeChild(7208);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 60000,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const logPath = mgr.status(dispatched.id).logPath;
    fs.writeFileSync(logPath, "x".repeat(4096));
    child.emit("exit", 1, null);
    // Overwrite the (now-closed-by-the-exit-handler) log with a small file
    // containing a provider error.
    fs.writeFileSync(logPath, JSON.stringify({ type: "error", message: "Unauthorized: invalid API key" }) + "\n");
    // The exit handler has already classified (and found nothing); the
    // shrink branch in classifyTrailingLogFailure would re-rescan from
    // offset 0 in a real run. This test pins down that we don't crash
    // when the file changes between read and write.
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "crashed");
  });
});

describe("cancel()", () => {
  test("sends SIGTERM to the negative pid (process group), then escalates to SIGKILL after graceMs if still running", async () => {
    const child = fakeChild(777);
    const killCalls = [];
    const mgr = makeManager({ spawnFn: () => child, killFn: (pid, signal) => killCalls.push({ pid, signal }) });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    mgr.cancel(dispatched.id, { graceMs: 15 });
    assert.deepEqual(killCalls, [{ pid: -777, signal: "SIGTERM" }]);

    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(killCalls, [{ pid: -777, signal: "SIGTERM" }, { pid: -777, signal: "SIGKILL" }]);
  });

  test("does not escalate to SIGKILL if the task already exited within the grace period", async () => {
    const child = fakeChild(888);
    const killCalls = [];
    const mgr = makeManager({ spawnFn: () => child, killFn: (pid, signal) => killCalls.push({ pid, signal }) });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    mgr.cancel(dispatched.id, { graceMs: 15 });
    child.emit("exit", null, "SIGTERM"); // settles before the escalation timer fires

    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(killCalls, [{ pid: -888, signal: "SIGTERM" }]); // no SIGKILL follow-up
  });

  test("stops the watchdog so cancellation cannot add a failureReason before the child exits", async () => {
    const child = fakeChild(889);
    const killCalls = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killCalls.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    mgr.cancel(dispatched.id, { graceMs: 1000 });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(mgr.status(dispatched.id).failureReason, null);
    assert.deepEqual(killCalls, [{ pid: -889, signal: "SIGTERM" }]);
    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).status, "cancelled");
  });

  test("replaces an existing cancellation escalation timer", async () => {
    const child = fakeChild(890);
    const killCalls = [];
    const mgr = makeManager({ spawnFn: () => child, killFn: (pid, signal) => killCalls.push({ pid, signal }) });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    mgr.cancel(dispatched.id, { graceMs: 15 });
    mgr.cancel(dispatched.id, { graceMs: 100 });
    await new Promise((r) => setTimeout(r, 30));

    assert.deepEqual(killCalls, [
      { pid: -890, signal: "SIGTERM" },
      { pid: -890, signal: "SIGTERM" },
    ]);
    child.emit("exit", null, "SIGTERM");
  });

  test("signals and disables the watchdog even when cancellation persistence fails", async () => {
    const child = fakeChild(891);
    const killCalls = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killCalls.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const lockPath = path.join(path.dirname(mgr.paths.TASKS_FILE), "tasks.lock");
    fs.mkdirSync(lockPath);
    const oldMs = Date.now() / 1000 - 3600;
    fs.utimesSync(lockPath, oldMs, oldMs);

    assert.throws(() => mgr.cancel(dispatched.id, { graceMs: 1000 }), /EISDIR|illegal operation on a directory/);
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(killCalls, [{ pid: -891, signal: "SIGTERM" }]);
    assert.equal(mgr.status(dispatched.id).failureReason, null);
    fs.rmdirSync(lockPath);
    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).status, "cancelled");
  });

  test("falls back to the plain pid if group signaling (-pid) raises ESRCH", () => {
    const child = fakeChild(999);
    const killCalls = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (pid < 0) {
          const err = new Error("No such process");
          err.code = "ESRCH";
          throw err;
        }
      },
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    mgr.cancel(dispatched.id);
    assert.deepEqual(killCalls, [{ pid: -999, signal: "SIGTERM" }, { pid: 999, signal: "SIGTERM" }]);
  });

  test("returns a no-op note instead of throwing or signaling when the task isn't running", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1", status: "done" })] });
    const result = mgr.cancel("t1");
    assert.equal(result.status, "done");
    assert.match(result.note, /task is already done; nothing to cancel/);
  });

  test("a persisted 'running' task reloads as 'unknown' and is also treated as settled", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1", status: "running" })] });
    assert.equal(mgr.status("t1").status, "unknown");
    const result = mgr.cancel("t1");
    assert.match(result.note, /task is already unknown; nothing to cancel/);
  });

  test("a persisted queued task reloads as 'unknown' and is never launched", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1", status: "queued", pid: null })] });
    assert.equal(mgr.status("t1").status, "unknown");
  });
});

describe("accept()/reject()", () => {
  // The fixture's overlay root lives under this host's actual tmpdir (not a
  // hardcoded "/tmp", which would fail on hosts where os.tmpdir() resolves
  // elsewhere) so cleanupOverlay's containment check (Task 7, review finding
  // #12) accepts it. It's a dedicated mkdtemp'd subdirectory, not the bare
  // os.tmpdir() itself -- the manager's startup sweepOrphanedOverlays() scans
  // every task's overlayDirs.tmpRoot, and a fixture pointing straight at real
  // os.tmpdir() made every test in this block scan (and act on) whatever a
  // real, concurrently-running daemon actually has in /tmp (issue #253).
  const fixtureTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-accept-reject-tmp-"));
  const fixtureRoot = path.join(fixtureTmpRoot, "taskferry-cow-t_pending");
  // Each pendingTaskFixture() call writes a real .patch file to the host
  // tmpdir; track them here and remove them once the whole suite finishes
  // instead of leaking one per invocation (issue #253).
  const createdDiffPaths = [];
  after(() => {
    for (const p of createdDiffPaths) {
      try {
        fs.unlinkSync(p);
      } catch {
        // already gone or never created -- nothing to clean up
      }
    }
  });
  function pendingTaskFixture(overrides = {}) {
    // accept() now refuses to hand a missing diff file to git apply (Task 4
    // review finding #1), so the fixture must record a diffPath whose file
    // actually exists on disk. The content is irrelevant -- runCommand is
    // mocked -- only the file's existence matters. A unique tmp path per
    // fixture call keeps parallel tests from clobbering each other.
    const diffPath = path.join(os.tmpdir(), `taskferry-accept-diff-${process.pid}-${Math.random().toString(36).slice(2)}.patch`);
    fs.writeFileSync(diffPath, "diff --git a/x b/x\n");
    createdDiffPaths.push(diffPath);
    return {
      ...baseTask({ id: "t_pending", status: "done" }),
      role: "dispatch",
      changesetStatus: "pending",
      diffPath,
      overlayDirs: { root: fixtureRoot, tmpRoot: fixtureTmpRoot, upperDir: path.join(fixtureRoot, "upper", "main"), workDir: path.join(fixtureRoot, "work", "main"), rwBinds: [] },
      preDispatchHead: "abc123",
      ...overrides,
    };
  }

  test("accept() applies the diff, marks the changeset accepted, and cleans up", () => {
    let applyCalled = false;
    let cleanedRoot = null;
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: (command, args) => {
        if (command === "git" && args[2] === "apply") applyCalled = true;
        return { status: 0, stdout: "", stderr: "", error: undefined };
      },
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });
    const result = mgr.accept("t_pending");
    assert.equal(result.changesetStatus, "accepted");
    assert.equal(result.applied, true);
    assert.equal(applyCalled, true);
    assert.equal(cleanedRoot, fixtureRoot);
    assert.equal(mgr.status("t_pending").changesetStatus, "accepted");
  });

  test("accept() leaves changesetStatus pending and does not clean up when apply fails", () => {
    let cleanedRoot = null;
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: (command) => {
        if (command === "git") return { status: 1, stdout: "", stderr: "error: patch does not apply\n", error: undefined };
        return { status: 0, stdout: "", stderr: "", error: undefined };
      },
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });
    const result = mgr.accept("t_pending");
    assert.equal(result.applied, false);
    assert.match(result.reason, /patch does not apply/);
    assert.equal(mgr.status("t_pending").changesetStatus, "pending");
    assert.equal(cleanedRoot, null);
  });

  test("reject() discards the changeset without applying and cleans up", () => {
    let applyCalled = false;
    let cleanedRoot = null;
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: (command, args) => {
        if (command === "git" && args[2] === "apply") applyCalled = true;
        return { status: 0, stdout: "", stderr: "", error: undefined };
      },
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });
    const result = mgr.reject("t_pending");
    assert.equal(result.changesetStatus, "rejected");
    assert.equal(applyCalled, false);
    assert.equal(cleanedRoot, fixtureRoot);
    assert.equal(mgr.status("t_pending").changesetStatus, "rejected");
  });

  test("reject() cleans an overlay using its recorded tmpRoot after the live tmpRoot changes", () => {
    const recordedTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-recorded-overlay-"));
    const liveTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-live-overlay-"));
    const root = path.join(recordedTmpRoot, "taskferry-cow-t_pending");
    fs.mkdirSync(path.join(root, "upper", "main"), { recursive: true });
    fs.mkdirSync(path.join(root, "work", "main"), { recursive: true });
    const mgr = makeManager({
      overlayTmpRoot: liveTmpRoot,
      tasksFixture: [pendingTaskFixture({
        overlayDirs: {
          root,
          tmpRoot: recordedTmpRoot,
          upperDir: path.join(root, "upper", "main"),
          workDir: path.join(root, "work", "main"),
          rwBinds: [],
        },
      })],
    });

    const result = mgr.reject("t_pending");
    assert.equal(result.changesetStatus, "rejected");
    assert.equal(result.cleanupFailed, undefined);
    assert.equal(fs.existsSync(root), false);
  });

  test("accept() on an advisor task throws a clear, non-applying error", () => {
    const mgr = makeManager({ tasksFixture: [pendingTaskFixture({ id: "t_advisor", role: "advisor", changesetStatus: "rejected" })] });
    assert.throws(() => mgr.accept("t_advisor"), /role "advisor" and cannot be accepted/);
  });

  test("accept() on a task with no pending changeset throws", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t_none" })] });
    assert.throws(() => mgr.accept("t_none"), /no pending changeset/);
  });

  test("accept() on a task whose extraction failed errors usefully and keeps the overlay (regression: review finding #2)", () => {
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture({ diffPath: null, changesetError: "spawn bwrap ETIMEDOUT" })],
    });
    assert.throws(() => mgr.accept("t_pending"), /changeset was never extracted.*ETIMEDOUT/s);
    assert.ok(mgr.status("t_pending").overlayDirs, "the preserved overlay is the user's only copy of the changes");
  });

  test("accept() errors usefully when the recorded diff file is no longer on disk (regression: review finding #1)", () => {
    // The diffPath is recorded in tasks.json but the file itself is gone
    // (partial stateDir cleanup, a tampered tasks.json, etc.). Without this
    // check, git apply would surface its own "can't open patch" message
    // against a path the user has no reason to suspect -- fail with a
    // clear, actionable error before that happens.
    const missingDiffPath = path.join(os.tmpdir(), `taskferry-does-not-exist-${process.pid}-${Math.random().toString(36).slice(2)}.patch`);
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture({ diffPath: missingDiffPath })],
    });
    assert.throws(() => mgr.accept("t_pending"), /diff file at \/tmp\/taskferry-does-not-exist-/);
    assert.throws(() => mgr.accept("t_pending"), /cannot be applied without its diff/);
  });

  test("accept() on a non-git target whose overlay vanished errors instead of applying nothing (regression: review finding #7)", () => {
    // A reboot clears the tmpfs overlay; the pending changeset can never be
    // re-applied. Fail loudly rather than rsyncing a missing tree.
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture({
        preDispatchHead: null, // non-git target
        overlayDirs: { root: fixtureRoot, tmpRoot: fixtureTmpRoot, upperDir: path.join(fixtureRoot, "upper", "main"), workDir: path.join(fixtureRoot, "work", "main"), rwBinds: [] }, // never created on disk
      })],
    });
    assert.throws(() => mgr.accept("t_pending"), /overlay is gone/);
  });

  test("accept() surfaces a failed cleanup via cleanupFailed and leaves overlayDirs for the sweep (regression: review finding #11)", () => {
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "", error: undefined }),
      rmOverlayTreeFn: () => { throw new Error("EBUSY: resource busy or locked"); },
    });
    const result = mgr.accept("t_pending");
    assert.equal(result.applied, true);
    assert.equal(result.changesetStatus, "accepted");
    assert.equal(result.cleanupFailed, true, "a failed cleanup must not be swallowed");
    assert.ok(mgr.status("t_pending").overlayDirs, "overlayDirs must stay set so the daemon-startup sweep retries");
  });

  test("reject() surfaces a failed cleanup and leaves overlayDirs for the sweep", () => {
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      rmOverlayTreeFn: () => { throw new Error("EBUSY: resource busy or locked"); },
    });
    const result = mgr.reject("t_pending");
    assert.equal(result.changesetStatus, "rejected");
    assert.equal(result.cleanupFailed, true);
    assert.ok(mgr.status("t_pending").overlayDirs);
  });

  // Persist-before-cleanup must be followed by a second persist after the
  // cleanup actually clears overlayDirs, so the durable task record
  // doesn't keep claiming an overlay exists for an overlay that was
  // just removed. Otherwise: after a restart, the task record on disk
  // has overlayDirs populated even though the overlay is gone -- the
  // startup sweep would still clean it up (rm -rf on a missing path is
  // idempotent), but the record lies until the sweep runs.
  function readPersistedTask(mgr, taskId) {
    const tasks = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    return tasks.find((t) => t.id === taskId);
  }

  test("accept() persists the cleared overlay metadata after successful cleanup (regression: review followup #1)", () => {
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "", error: undefined }),
      rmOverlayTreeFn: () => {},
    });
    const result = mgr.accept("t_pending");
    assert.equal(result.changesetStatus, "accepted");
    assert.equal(result.applied, true);
    assert.equal(result.cleanupFailed, undefined);
    const onDisk = readPersistedTask(mgr, "t_pending");
    assert.equal(onDisk.changesetStatus, "accepted", "status must be durable");
    assert.equal(onDisk.overlayDirs, null, "cleared overlay metadata must be durable, not claim an overlay still exists");
  });

  test("reject() persists the cleared overlay metadata after successful cleanup (regression: review followup #1)", () => {
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      rmOverlayTreeFn: () => {},
    });
    const result = mgr.reject("t_pending");
    assert.equal(result.changesetStatus, "rejected");
    assert.equal(result.cleanupFailed, undefined);
    const onDisk = readPersistedTask(mgr, "t_pending");
    assert.equal(onDisk.changesetStatus, "rejected", "status must be durable");
    assert.equal(onDisk.overlayDirs, null, "cleared overlay metadata must be durable, not claim an overlay still exists");
  });

  test("accept() leaves overlayDirs durable on cleanup failure so the startup sweep can retry (regression: review followup #1)", () => {
    // Symmetric to the success cases: when cleanup fails, both the
    // status and overlayDirs must be durable on disk so the
    // daemon-startup sweep can pick up the orphan and retry the removal.
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "", error: undefined }),
      rmOverlayTreeFn: () => { throw new Error("EBUSY: resource busy or locked"); },
    });
    const result = mgr.accept("t_pending");
    assert.equal(result.cleanupFailed, true);
    const onDisk = readPersistedTask(mgr, "t_pending");
    assert.equal(onDisk.changesetStatus, "accepted");
    assert.ok(onDisk.overlayDirs, "overlayDirs must persist on cleanup failure so the startup sweep retries");
    assert.equal(onDisk.overlayDirs.root, fixtureRoot);
  });
});

describe("summarize() changeset exposure", () => {
  test("exposes changeset fields only when they are meaningful", () => {
    const overlayDirs = {
      root: path.join(os.tmpdir(), "taskferry-cow-t_pending"),
      tmpRoot: os.tmpdir(),
      upperDir: path.join(os.tmpdir(), "taskferry-cow-t_pending", "upper", "main"),
      workDir: path.join(os.tmpdir(), "taskferry-cow-t_pending", "work", "main"),
      rwBinds: [],
    };
    const mgr = makeManager({
      tasksFixture: [
        baseTask({ id: "t_plain", role: "dispatch", changesetStatus: "none", overlayDirs: null, changesetError: null }),
        baseTask({ id: "t_advisor", role: "advisor", changesetStatus: "none" }),
        baseTask({ id: "t_pending", role: "dispatch", changesetStatus: "pending", overlayDirs, changesetError: "spawn bwrap ETIMEDOUT" }),
      ],
    });

    const plain = mgr.status("t_plain");
    assert.equal("role" in plain, false);
    assert.equal("changesetStatus" in plain, false);
    assert.equal("overlayDirs" in plain, false);
    assert.equal("changesetError" in plain, false);

    const advisor = mgr.status("t_advisor");
    assert.equal(advisor.role, "advisor");
    assert.equal(advisor.changesetStatus, "none");

    const pending = mgr.status("t_pending");
    assert.equal(pending.role, "dispatch");
    assert.equal(pending.changesetStatus, "pending");
    assert.deepEqual(pending.overlayDirs, overlayDirs);
    assert.equal(pending.changesetError, "spawn bwrap ETIMEDOUT");
  });
});

describe("executorId on persisted tasks (Task 5: legacy records default to opencode at load)", () => {
  test("a persisted task with no executorId defaults to \"opencode\" on load", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        id: "oc_legacy", status: "done", directory: "/tmp", model: "openai/gpt-5.6-luna", variant: "high",
        sessionId: null, originSessionId: null, pid: null, startedAt: "2026-07-13T10:00:00.000Z",
        endedAt: "2026-07-13T10:01:00.000Z", exitCode: 0, signal: null, logPath: path.join(logDir, "oc_legacy.ndjson"),
        promptPreview: "legacy task", promptTotalChars: null, spawnError: null, cancelRequested: false, internal: false,
      }],
    });
    assert.equal(mgr.status("oc_legacy").executorId, "opencode");
  });

  test("a persisted task that already has executorId \"pi\" is preserved on load", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "pi_persisted", logPath: path.join(logDir, "pi_persisted.ndjson"), executorId: "pi" })],
    });
    assert.equal(mgr.status("pi_persisted").executorId, "pi");
  });
});

describe("dispatch() executor selection (Task 6: optional executor name resolves and stamps task.executorId)", () => {
  test("dispatch() with executor: \"pi\" resolves piExecutor and stamps task.executorId", () => {
    const mgr = makeManager({ spawnFn: () => { throw new Error("not reached in this test"); } });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: process.cwd(), executor: "pi" });
    const status = mgr.status(dispatched.id);
    assert.equal(status.executorId, "pi");
  });

  test("dispatch() with no executor defaults to pi", () => {
    const mgr = makeManager({ spawnFn: () => { throw new Error("not reached in this test"); } });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: process.cwd() });
    const status = mgr.status(dispatched.id);
    assert.equal(status.executorId, "pi");
  });

  test("dispatch() with an unknown executor name throws", () => {
    const mgr = makeManager({ spawnFn: () => { throw new Error("not reached in this test"); } });
    assert.throws(() => mgr.dispatch({ prompt: "hi", directory: process.cwd(), executor: "bogus" }), /unknown executor: bogus/);
  });
});

describe("unknown task id (status/cancel/wait/result share one error path)", () => {
  test("status() throws with an actionable help line", () => {
    const mgr = makeManager();
    assert.throws(
      () => mgr.status("nope"),
      /error: unknown task id: nope\nhelp: run taskferry list to see valid task ids/
    );
  });

  test("cancel() throws the same formatted error", () => {
    const mgr = makeManager();
    assert.throws(() => mgr.cancel("nope"), /error: unknown task id: nope/);
  });

  test("result() throws the same formatted error", () => {
    const mgr = makeManager();
    assert.throws(() => mgr.result("nope"), /error: unknown task id: nope/);
  });

  test("poll() throws synchronously (not a rejected promise) for an unknown id", () => {
    const mgr = makeManager();
    assert.throws(() => mgr.poll("nope"), /error: unknown task id: nope/);
  });
});

describe("taskDirectory() (issue #59: lets event.subscribe resolve a directory server-side from a taskId)", () => {
  test("returns the task's directory", () => {
    const mgr = makeManager({
      tasksFixture: () => [baseTask({ id: "t1", status: "done", directory: os.tmpdir() })],
    });
    assert.equal(mgr.taskDirectory("t1"), os.tmpdir());
  });

  test("throws the standard unknown-task error for a taskId that doesn't exist", () => {
    const mgr = makeManager({ tasksFixture: () => [] });
    assert.throws(() => mgr.taskDirectory("nope"), /unknown task id/);
  });
});

describe("status() log activity (tells a stuck-before-first-event task apart from an active one)", () => {
  test("reports zero bytes and no event when the log file doesn't exist yet (e.g. still queued)", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "running", logPath: path.join(logDir, "missing.ndjson") })],
    });
    const s = mgr.status("t1");
    assert.equal(s.logBytesWritten, 0);
    assert.equal(s.logLastWriteAt, null);
    assert.equal(s.logHasEvent, false);
  });

  test("reports zero bytes but a real mtime when the log file exists but is empty", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "running", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": "" },
    });
    const s = mgr.status("t1");
    assert.equal(s.logBytesWritten, 0);
    assert.ok(s.logLastWriteAt);
    assert.equal(s.logHasEvent, false);
  });

  test("reports nonzero bytes but no event when the log has been created but holds no parseable JSON line", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "running", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": "not json\n" },
    });
    const s = mgr.status("t1");
    assert.ok(s.logBytesWritten > 0);
    assert.ok(s.logLastWriteAt);
    assert.equal(s.logHasEvent, false);
  });

  test("reports logHasEvent: true once at least one line parses as JSON", () => {
    const log = JSON.stringify({ type: "session", sessionID: "ses_1" });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "running", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    const s = mgr.status("t1");
    assert.ok(s.logBytesWritten > 0);
    assert.equal(s.logHasEvent, true);
  });

  test("skips leading non-JSON lines (e.g. stderr noise) and still finds a later JSON line", () => {
    const log = ["not json", "also not json", JSON.stringify({ type: "session", sessionID: "ses_1" })].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "running", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    assert.equal(mgr.status("t1").logHasEvent, true);
  });
});

describe("poll()", () => {
  test("resolves immediately for a non-running task", async () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1", status: "crashed", exitCode: 1 })] });
    const settled = await mgr.poll("t1", { timeoutMs: 50 });
    assert.equal(settled.status, "crashed");
    assert.equal(settled.exitCode, 1);
  });

  test("resolves once the real exit event fires, before its timeout elapses", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    const waitPromise = mgr.poll(dispatched.id, { timeoutMs: 5000 });
    child.emit("exit", 0, null);
    const settled = await waitPromise;
    assert.equal(settled.status, "done");
  });

  test("with no timeoutMs, blocks until settlement instead of returning early", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    let resolved = false;
    const waitPromise = mgr.poll(dispatched.id).then((settled) => {
      resolved = true;
      return settled;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(resolved, false, "poll() must not resolve on its own without an explicit timeoutMs");

    child.emit("exit", 0, null);
    const settled = await waitPromise;
    assert.equal(settled.status, "done");
  });

  test("returns 'running' once its timeout elapses without an exit event", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    const settled = await mgr.poll(dispatched.id, { timeoutMs: 20 });
    assert.equal(settled.status, "running");
    assert.equal("outputTail" in settled, false);
  });

  test("returns the requested narration tail when its timeout elapses", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const output = "first chunk\nsecond chunk";
    fs.writeFileSync(
      dispatched.logPath,
      JSON.stringify({ type: "text", part: { messageID: "m1", text: output } })
    );

    const settled = await mgr.poll(dispatched.id, { timeoutMs: 20, tailChars: 6 });
    assert.equal(settled.status, "running");
    assert.equal(settled.outputTail, " chunk");
    assert.equal(settled.outputTailTotalChars, output.length);
    assert.equal(settled.outputTailTruncated, true);
  });

  test("with no options, resolves only once the task settles (no default 45s timer)", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    try {
      mock.timers.enable({ apis: ["setTimeout"] });
      const waitPromise = mgr.poll(dispatched.id);
      let settledYet = false;
      void waitPromise.then(() => { settledYet = true; });

      // Advance beyond the old default instead of waiting a short real-time interval.
      mock.timers.tick(45001);
      await Promise.resolve();
      assert.equal(settledYet, false, "poll() with no options must not resolve before the task settles");

      child.emit("exit", 0, null);
      const settled = await waitPromise;
      assert.equal(settled.status, "done");
    } finally {
      mock.timers.reset();
    }
  });

  test("with { timeoutMs: N }, still returns 'running' after Nms when the task hasn't settled (explicit override path)", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    try {
      mock.timers.enable({ apis: ["setTimeout"] });
      const waitPromise = mgr.poll(dispatched.id, { timeoutMs: 50000 });
      let settledYet = false;
      void waitPromise.then(() => { settledYet = true; });

      // The old implementation clamped this value to 45000ms.
      mock.timers.tick(45001);
      await Promise.resolve();
      assert.equal(settledYet, false, "timeoutMs above the old cap must not settle at 45000ms");

      mock.timers.tick(4999);
      const settled = await waitPromise;
      assert.equal(settled.status, "running");
      assert.equal("outputTail" in settled, false);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("advisor()", () => {
  test("requires a model", async () => {
    const mgr = makeManager();
    await assert.rejects(
      () => mgr.advisor({ prompt: "hi", directory: os.tmpdir() }),
      /error: model is required/
    );
  });

  test("dispatches with the given model/variant and resolves inline once the task finishes", async () => {
    const child = fakeChild();
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, _opts) => {
        captured = args;
        return child;
      },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });

    const advisorPromise = mgr.advisor({
      prompt: "how should I shard this counter?",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
      variant: "max",
      timeoutMs: 5000,
      executor: "opencode",
    });

    // Advisor dispatches are overlay-gated under bwrap (ADR 0001), so the
    // captured args are the bwrap invocation; the executor command follows "--".
    assert.deepEqual(captured.slice(captured.indexOf("--") + 1), [
      "opencode",
      "run", "--dir", os.tmpdir(), "--auto", "--format", "json",
      "-m", "openai/gpt-5.6-sol", "--variant", "max", "--", "how should I shard this counter?",
    ]);

    // Simulate opencode writing its result log, then exiting.
    const row1 = mgr.list().tasks[0];
    const dispatched = { id: row1.id, logPath: path.join(mgr.paths.LOG_DIR, `${row1.id}.ndjson`) };
    fs.writeFileSync(
      dispatched.logPath,
      [
        JSON.stringify({ type: "text", part: { messageID: "m1", text: "Shard by key, sum on read." } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop", tokens: { total: 50 }, cost: 0.002 } }),
        JSON.stringify({ sessionID: "ses_new" }),
      ].join("\n")
    );
    child.emit("exit", 0, null);

    const advised = await advisorPromise;
    assert.equal(advised.status, "done");
    assert.equal(advised.message, "Shard by key, sum on read.");
    assert.deepEqual(advised.tokens, { total: 50 });
    assert.equal(advised.cost, 0.002);
    assert.equal(advised.session_id, "ses_new");
    assert.equal(advised.session_reset, false);
    assert.equal("previous_session_id" in advised, false);
  });

  test("--executor pi reaches an actual pi-spawned child, end to end (Task 7 review fix)", async () => {
    const child = fakeChild();
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, _opts) => {
        captured = { cmd, args };
        return child;
      },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });

    const advisorPromise = mgr.advisor({
      prompt: "how should I shard this counter?",
      directory: os.tmpdir(),
      model: "minimax/MiniMax-M2.7",
      executor: "pi",
      timeoutMs: 5000,
    });

    // Advisor dispatches are overlay-gated under bwrap (ADR 0001); the pi
    // command is the bwrap payload following "--".
    assert.equal(captured.cmd, "bwrap");
    const piArgs = captured.args.slice(captured.args.indexOf("--") + 1);
    assert.equal(piArgs[0], "pi");
    assert.ok(piArgs.includes("--provider"));
    assert.ok(piArgs.includes("minimax"));

    // Raw pi --mode json events on stdout; startTask's stdout handler must
    // run them through the real piExecutor().normalizeLogEvent before they
    // land in the task log, same as a genuine pi child would produce.
    child.stdout.emit(
      "data",
      Buffer.from(
        [
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Shard by key, sum on read." }, message: { responseId: "m1" } }),
          JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", responseId: "m1", usage: { total: 50, cost: { total: 0.002 } } }] }),
        ].join("\n") + "\n"
      )
    );
    child.emit("exit", 0, null);

    const advised = await advisorPromise;
    assert.equal(advised.status, "done");
    assert.equal(advised.message, "Shard by key, sum on read.");
  });

  test("returns status: running with a task_id and session_id when the timeout elapses first", async () => {
    const child = fakeChild();
    const mgr = makeManager({
      spawnFn: () => child,
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });

    const advisorPromise = mgr.advisor({
      prompt: "long question",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
      timeoutMs: 20,
    });
    const row2 = mgr.list().tasks[0];
    const dispatched = { id: row2.id, logPath: path.join(mgr.paths.LOG_DIR, `${row2.id}.ndjson`) };
    fs.writeFileSync(dispatched.logPath, JSON.stringify({ sessionID: "ses_midrun" }));

    const advised = await advisorPromise;
    assert.equal(advised.status, "running");
    assert.equal(advised.task_id, dispatched.id);
    assert.equal(advised.session_id, "ses_midrun");
    assert.match(advised.note, /taskferry wait or taskferry advisor again with session_id/);
  });

  test("reports status: queued (not running) when the timeout elapses while the task is still waiting for a concurrency slot", async () => {
    const occupyingChild = fakeChild();
    const children = [occupyingChild];
    const mgr = makeManager({
      maxConcurrentTasks: 1,
      spawnFn: () => {
        const child = children.length === 1 ? occupyingChild : fakeChild();
        if (children.length > 1) children.push(child);
        return child;
      },
    });

    // Occupy the only concurrency slot so the advisor dispatch below queues
    // instead of running.
    mgr.dispatch({ prompt: "occupying task", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });

    const advisorPromise = mgr.advisor({
      prompt: "long question",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
      timeoutMs: 20,
    });

    const advised = await advisorPromise;
    assert.equal(advised.status, "queued");
    assert.match(advised.note, /still queued/);

    // Drain the queue so the test process can exit.
    occupyingChild.emit("exit", 0, null);
  });

  test("when the timeout elapses before opencode has written a session id, the note points at taskferry wait with task id instead of fabricating a session_id", async () => {
    const child = fakeChild();
    const mgr = makeManager({
      spawnFn: () => child,
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });

    const advisorPromise = mgr.advisor({
      prompt: "long question",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
      timeoutMs: 20,
    });
    // No log file written at all -- opencode hasn't emitted a session id yet.

    const advised = await advisorPromise;
    assert.equal(advised.status, "running");
    assert.equal(advised.session_id, null);
    assert.match(advised.note, /taskferry wait with task id/);
    assert.equal(advised.note.includes('session_id ""'), false);
  });

  test("a dispatch validation error is reported under taskferry advisor, not taskferry dispatch", async () => {
    const mgr = makeManager();
    await assert.rejects(
      () => mgr.advisor({ prompt: "", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" }),
      (err) => {
        assert.match(err.message, /taskferry advisor requires a non-empty prompt string/);
        assert.equal(err.message.includes("taskferry dispatch"), false);
        return true;
      }
    );
  });

  test("a fresh session_id within the TTL is passed through to dispatch (--continue --session)", async () => {
    const child = fakeChild();
    let captured = null;
    const mgr = makeManager({
      advisorSessionTtlMs: 60000,
      spawnFn: (cmd, args) => {
        captured = args;
        return child;
      },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });

    // First call establishes ses_live in the registry via its own result.
    const firstPromise = mgr.advisor({ prompt: "q1", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
    const firstRow = mgr.list().tasks[0];
    const firstTask = { id: firstRow.id, logPath: path.join(mgr.paths.LOG_DIR, `${firstRow.id}.ndjson`) };
    fs.writeFileSync(
      firstTask.logPath,
      [
        JSON.stringify({ type: "text", part: { messageID: "m1", text: "answer one" } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }),
        JSON.stringify({ sessionID: "ses_live" }),
      ].join("\n")
    );
    child.emit("exit", 0, null);
    const first = await firstPromise;
    assert.equal(first.session_id, "ses_live");

    // Second call resumes ses_live -- still fresh, no reset.
    const secondPromise = mgr.advisor({
      prompt: "q2 follow-up",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
      sessionId: "ses_live",
    });
    assert.equal(captured.includes("--continue"), true);
    assert.equal(captured[captured.indexOf("--session") + 1], "ses_live");

    const secondTask = mgr.list().tasks[0];
    const secondTaskLog = path.join(mgr.paths.LOG_DIR, `${secondTask.id}.ndjson`);
    fs.writeFileSync(
      secondTaskLog,
      [
        JSON.stringify({ type: "text", part: { messageID: "m2", text: "answer two" } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m2", reason: "stop" } }),
        JSON.stringify({ sessionID: "ses_live" }),
      ].join("\n")
    );
    child.emit("exit", 0, null);
    const second = await secondPromise;
    assert.equal(second.session_reset, false);
    assert.equal(second.session_id, "ses_live");
  });

  test("an expired session_id starts fresh and reports session_reset", async () => {
    const child = fakeChild();
    let captured = null;
    const mgr = makeManager({
      advisorSessionTtlMs: 10,
      spawnFn: (cmd, args) => {
        captured = args;
        return child;
      },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });

    const advisorPromise = mgr.advisor({
      prompt: "resuming after a nap",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
      sessionId: "ses_long_gone",
    });

    assert.equal(captured.includes("--continue"), false);

    const row4 = mgr.list().tasks[0];
    const dispatched = { id: row4.id, logPath: path.join(mgr.paths.LOG_DIR, `${row4.id}.ndjson`) };
    fs.writeFileSync(
      dispatched.logPath,
      [
        JSON.stringify({ type: "text", part: { messageID: "m1", text: "starting fresh" } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }),
        JSON.stringify({ sessionID: "ses_brand_new" }),
      ].join("\n")
    );
    child.emit("exit", 0, null);

    const advised = await advisorPromise;
    assert.equal(advised.session_reset, true);
    assert.equal(advised.previous_session_id, "ses_long_gone");
    assert.equal(advised.session_id, "ses_brand_new");
  });

  test("a crashed advisor task surfaces exitCode/spawnError, not a thrown error", async () => {
    const child = fakeChild();
    const mgr = makeManager({
      spawnFn: () => child,
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });

    const advisorPromise = mgr.advisor({ prompt: "hi", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
    child.emit("exit", 1, null);

    const advised = await advisorPromise;
    assert.equal(advised.status, "crashed");
    assert.equal(advised.exitCode, 1);
  });

  test("with no timeout_ms, against an injected small maxWaitMs, still returns the bounded 'still running' + resumable session_id shape", async () => {
    const child = fakeChild();
    const mgr = makeManager({
      spawnFn: () => child,
      maxWaitMs: 30,
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });

    const advisorPromise = mgr.advisor({
      prompt: "long question",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
    });
    const row = mgr.list().tasks[0];
    const dispatched = { id: row.id, logPath: path.join(mgr.paths.LOG_DIR, `${row.id}.ndjson`) };
    fs.writeFileSync(dispatched.logPath, JSON.stringify({ sessionID: "ses_midrun" }));

    const advised = await advisorPromise;
    assert.equal(advised.status, "running");
    assert.equal(advised.task_id, dispatched.id);
    assert.equal(advised.session_id, "ses_midrun");
    assert.match(advised.note, /taskferry wait or taskferry advisor again with session_id/);
  });
});

describe("list()", () => {
  test("empty state is explicit, not an empty array", () => {
    const mgr = makeManager();
    const l = mgr.list();
    assert.deepEqual(l.counts, { queued: 0, running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0 });
    assert.equal(l.tasks, "none found (this server process's lifetime)");
  });

  test("tallies counts across mixed statuses, including a rehydrated 'unknown'", () => {
    const mgr = makeManager({
      tasksFixture: [
        baseTask({ id: "t1", status: "done" }),
        baseTask({ id: "t2", status: "crashed" }),
        baseTask({ id: "t3", status: "cancelled" }),
        baseTask({ id: "t4", status: "running" }), // becomes "unknown" on load
      ],
    });
    assert.deepEqual(mgr.list().counts, { queued: 0, running: 0, done: 1, crashed: 1, cancelled: 1, unknown: 1 });
  });

  test("rows use the minimal schema plus failureReason, not the full detail object", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1" })] });
    const row = mgr.list().tasks[0];
    assert.deepEqual(Object.keys(row).sort(), ["failureReason", "id", "model", "startedAt", "status"]);
  });

  test("sorts newest first by startedAt", () => {
    const mgr = makeManager({
      tasksFixture: [
        baseTask({ id: "older", startedAt: "2026-07-13T09:00:00.000Z" }),
        baseTask({ id: "newer", startedAt: "2026-07-13T11:00:00.000Z" }),
      ],
    });
    assert.deepEqual(mgr.list().tasks.map((t) => t.id), ["newer", "older"]);
  });
});

describe("result()", () => {
  test("joins only the final step's text as `message`, keeps everything as `narration`", () => {
    const log = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "I'm about to run ls" } }),
      JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "tool-calls" } }),
      JSON.stringify({ type: "text", part: { messageID: "m2", text: "Final answer text" } }),
      JSON.stringify({
        type: "step_finish",
        part: { messageID: "m2", reason: "stop", tokens: { total: 100 }, cost: 0.001 },
      }),
      JSON.stringify({ sessionID: "ses_from_log" }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    const r = mgr.result("t1");
    assert.equal(r.message, "Final answer text");
    assert.equal(r.narration, "I'm about to run ls\n\nFinal answer text");
    assert.deepEqual(r.tokens, { total: 100 });
    assert.equal(r.cost, 0.001);
    assert.equal(r.sessionId, "ses_from_log");
    assert.equal(r.narrationTruncated, false);
    assert.equal(r.narrationTotalChars, r.narration.length);
    assert.equal("next" in r, false);
  });

  test("sums tokens and cost across every step_finish instead of keeping only the last (issue #201)", () => {
    const log = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "step one" } }),
      JSON.stringify({
        type: "step_finish",
        part: {
          messageID: "m1",
          reason: "tool-calls",
          tokens: { total: 100, input: 10, output: 20, reasoning: 5, cache: { write: 1, read: 2 } },
          cost: 0.001,
        },
      }),
      JSON.stringify({ type: "text", part: { messageID: "m2", text: "step two" } }),
      JSON.stringify({
        type: "step_finish",
        part: {
          messageID: "m2",
          reason: "stop",
          tokens: { total: 200, input: 15, output: 25, reasoning: 10, cache: { write: 3, read: 4 } },
          cost: 0.002,
        },
      }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    const r = mgr.result("t1");
    assert.deepEqual(r.tokens, { total: 300, input: 25, output: 45, reasoning: 15, cache: { write: 4, read: 6 } });
    assert.equal(r.cost, 0.003);
  });

  test("falls back to the last message seen when no step_finish reason 'stop' exists", () => {
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "partial output before a crash" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "crashed", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    assert.equal(mgr.result("t1").message, "partial output before a crash");
  });

  test("truncates narration past 2000 chars by default, with a `next` hint to escape it", () => {
    const filler = "x".repeat(3000);
    const log = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: filler } }),
      JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "tool-calls" } }),
      JSON.stringify({ type: "text", part: { messageID: "m2", text: "final" } }),
      JSON.stringify({ type: "step_finish", part: { messageID: "m2", reason: "stop" } }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    const r = mgr.result("t1");
    const expectedFull = filler + "\n\nfinal";
    assert.equal(r.narrationTruncated, true);
    assert.equal(r.narrationTotalChars, expectedFull.length);
    assert.equal(r.narration, expectedFull.slice(0, 2000) + "…");
    assert.match(r.next, /full: true.*t1/);
    assert.equal(r.message, "final"); // message itself is never truncated
  });

  test("full: true returns the untruncated narration", () => {
    const filler = "x".repeat(3000);
    const log = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: filler } }),
      JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    const r = mgr.result("t1", { full: true });
    assert.equal(r.narrationTruncated, false);
    assert.equal(r.narration, filler);
    assert.equal("next" in r, false);
  });

  test("a task with no matching log file still returns cleanly (empty message/narration)", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "crashed", logPath: path.join(logDir, "missing.ndjson") })],
    });
    const r = mgr.result("t1");
    assert.equal(r.message, "");
    assert.equal(r.narration, "");
  });

  test("returns a polite 'still running' message without reading the log, for a running task", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const r = mgr.result(dispatched.id);
    assert.equal(r.status, "running");
    assert.match(r.message, /still running/);
  });

  test("projects only requested fields while retaining the task envelope", () => {
    const log = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "Final answer" } }),
      JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    assert.deepEqual(mgr.result("t1", { fields: ["message"] }), {
      taskId: "t1",
      status: "done",
      message: "Final answer",
    });
  });

  test("rejects a full narration request that omits narration from fields", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1" })] });
    assert.throws(() => mgr.result("t1", { full: true, fields: ["message"] }), /full requires narration/);
  });

  test("returns null for selected fields unavailable on a running task", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const task = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.deepEqual(mgr.result(task.id, { fields: ["tokens"] }), {
      taskId: task.id,
      status: "running",
      tokens: null,
    });
  });

  test("does not expose partial output from an unknown summary task", () => {
    const mgr = makeManager({
      tasksFixture: [baseTask({ id: "t1", status: "running", summaryOf: { sourceTaskId: "source" } })],
    });
    const r = mgr.result("t1", { fields: ["message"] });
    assert.equal(r.status, "unknown");
    assert.match(r.message, /partial output is unavailable/);
  });
});

describe("result() diffStat field", () => {
  // The diffStat path now shells out to `git apply --numstat <diffPath>` via
  // the runOverlayCommandFn delegate (review finding #13, root-cause fix).
  // The fake here mirrors the real git format: one `<adds>\t<dels>\t<path>`
  // line per file; the test never touches a real git binary.
  test("shells out to git apply --numstat and sums the tab-separated counts (regression: review finding #13)", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_stat", logPath: path.join(logDir, "t_stat.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_stat.patch"),
      }],
      logs: { "t_stat.ndjson": "" },
      runOverlayCommandFn: (command, args) => {
        if (command === "git" && args[0] === "apply" && args[1] === "--numstat") {
          return { status: 0, stdout: "2\t1\tone.txt\n0\t1\ttwo.txt\n", stderr: "", error: undefined };
        }
        return { status: 0, stdout: "", stderr: "", error: undefined };
      },
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_stat.patch"), "diff --git a/one.txt b/one.txt\n");
    const result = mgr.result("t_stat", { fields: ["diffStat"] });
    assert.deepEqual(result.diffStat, { files: 2, additions: 2, deletions: 2 });
    assert.deepEqual(mgr.result("t_stat").diffStat, { files: 2, additions: 2, deletions: 2 });
  });

  test("reports a non-zero file count for a non-git-style diff (regression: review finding #13, non-git)", () => {
    // The pre-fix hand-rolled scan counted only `diff --git` headers, so
    // every non-git changeset reported files:0 regardless of how many files
    // actually changed. The new path routes both kinds through git apply
    // --numstat, which parses both `diff --git` and plain `diff -ruN`
    // headers. This delegate unit test mocks the run command with the same
    // output git would emit for a two-file non-git extraction; the patch
    // content matches what the mock claims to produce so the test exercises
    // the parser contract rather than skipping the patch entirely.
    const patch = [
      "diff -ruN a/existing.txt b/existing.txt",
      "--- a/existing.txt\t2026-01-01 00:00:00.000000000 -0500",
      "+++ b/existing.txt\t2026-01-01 00:00:00.000000000 -0500",
      "@@ -1 +1,2 @@",
      "-original",
      "+modified",
      "+added",
      "diff -ruN a/newfile.txt b/newfile.txt",
      "--- a/newfile.txt\t1969-12-31 19:00:00.000000000 -0500",
      "+++ b/newfile.txt\t2026-01-01 00:00:00.000000000 -0500",
      "@@ -0,0 +1 @@",
      "+new content",
      "",
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_nongit", logPath: path.join(logDir, "t_nongit.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_nongit.patch"),
      }],
      logs: { "t_nongit.ndjson": "" },
      runOverlayCommandFn: (command, args) => {
        if (command === "git" && args[0] === "apply" && args[1] === "--numstat") {
          return { status: 0, stdout: "2\t1\tmerged/existing.txt\n1\t0\tmerged/newfile.txt\n", stderr: "", error: undefined };
        }
        return { status: 0, stdout: "", stderr: "", error: undefined };
      },
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_nongit.patch"), patch);
    const result = mgr.result("t_nongit", { fields: ["diffStat"] });
    assert.notEqual(result.diffStat.files, 0, "non-git diffs must not silently report 0 files");
    assert.deepEqual(result.diffStat, { files: 2, additions: 3, deletions: 1 });
  });

  test("parses a real diff -ruN patch via the real git apply --numstat parser (regression followup: central compatibility claim)", () => {
    // The delegate unit test above mocks git's output. This test verifies
    // the central compatibility claim the brief called out: that git apply
    // --numstat actually parses the diff -ruN format extractNonGitDiff
    // produces, and the parser sums the columns git emits. Inject
    // changeset.js's real defaultRunCommand so the test exercises the real
    // Git binary rather than a synthetic mock.
    const patch = [
      "diff -ruN a/existing.txt b/existing.txt",
      "--- a/existing.txt\t2026-01-01 00:00:00.000000000 -0500",
      "+++ b/existing.txt\t2026-01-01 00:00:00.000000000 -0500",
      "@@ -1 +1,2 @@",
      "-original",
      "+modified",
      "+added",
      "diff -ruN a/newfile.txt b/newfile.txt",
      "--- a/newfile.txt\t1969-12-31 19:00:00.000000000 -0500",
      "+++ b/newfile.txt\t2026-01-01 00:00:00.000000000 -0500",
      "@@ -0,0 +1 @@",
      "+new content",
      "",
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_real_nongit", logPath: path.join(logDir, "t_real_nongit.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_real_nongit.patch"),
      }],
      logs: { "t_real_nongit.ndjson": "" },
      runOverlayCommandFn: changesetDefaultRunCommand,
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_real_nongit.patch"), patch);
    const result = mgr.result("t_real_nongit", { fields: ["diffStat"] });
    // Real git apply --numstat must report non-zero counts for this
    // representative diff -ruN patch; previously the hand-rolled scan
    // reported files:0 for every non-git changeset.
    assert.notEqual(result.diffStat.files, 0, "git apply --numstat must parse real diff -ruN output");
    // The patch has 2 additions + 1 deletion in existing.txt and 1
    // addition in newfile.txt.
    assert.equal(result.diffStat.files, 2);
    assert.equal(result.diffStat.additions, 3);
    assert.equal(result.diffStat.deletions, 1);
  });

  test("falls back to a zero stat when git apply --numstat fails to parse the diff", () => {
    // Failure mode: a plain `diff -ru` (without `-N`) extraction whose
    // "Only in ..." lines confuse git apply. The diff text is still
    // readable via `result --diff`, only the human-readable summary is
    // uncomputable; returning a zero stat is the documented fallback.
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_unparsable", logPath: path.join(logDir, "t_unparsable.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_unparsable.patch"),
      }],
      logs: { "t_unparsable.ndjson": "" },
      runOverlayCommandFn: (command, args) => {
        if (command === "git" && args[0] === "apply" && args[1] === "--numstat") {
          return { status: 128, stdout: "", stderr: "error: No valid patches in input\n", error: undefined };
        }
        return { status: 0, stdout: "", stderr: "", error: undefined };
      },
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_unparsable.patch"), "Only in b: newfile.txt\n");
    const result = mgr.result("t_unparsable", { fields: ["diffStat"] });
    assert.deepEqual(result.diffStat, { files: 0, additions: 0, deletions: 0 });
  });

  test("treats a non-zero git apply --numstat exit as parse failure even when stdout is non-empty (regression followup)", () => {
    // git apply --numstat exits 0 on success and a non-zero status on any
    // failure (corrupt patch, parse error, etc.). A non-zero status with
    // partial stdout should NOT be parsed -- a failed invocation can
    // produce partial output that would, if read, give a misleading
    // non-zero count. The fallback is the zero stat.
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_status1", logPath: path.join(logDir, "t_status1.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_status1.patch"),
      }],
      logs: { "t_status1.ndjson": "" },
      runOverlayCommandFn: (command, args) => {
        if (command === "git" && args[0] === "apply" && args[1] === "--numstat") {
          return { status: 1, stdout: "5\t3\tmerged/leftover.txt\n", stderr: "error: corrupt patch\n", error: undefined };
        }
        return { status: 0, stdout: "", stderr: "", error: undefined };
      },
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_status1.patch"), "garbage\n");
    const result = mgr.result("t_status1", { fields: ["diffStat"] });
    assert.deepEqual(result.diffStat, { files: 0, additions: 0, deletions: 0 }, "non-zero status must zero the stat, not parse partial stdout");
  });
});

describe("result() diff field", () => {
  test("returns the cached patch text for fields: ['diff']", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_diff", logPath: path.join(logDir, "t_diff.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_diff.patch"),
      }],
      logs: { "t_diff.ndjson": "" },
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_diff.patch"), "diff --git a/x b/x\n");
    const result = mgr.result("t_diff", { fields: ["diff"] });
    assert.equal(result.diff, "diff --git a/x b/x\n");
  });

  test("returns null for a task with no diffPath", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t_no_diff" })] });
    const result = mgr.result("t_no_diff", { fields: ["diff"] });
    assert.equal(result.diff, null);
  });
});

describe("tail()", () => {
  test("returns a Unicode-safe suffix of the latest text event", () => {
    const log = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "older" } }),
      JSON.stringify({ type: "text", part: { messageID: "m2", text: "alpha😀beta" } }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    assert.deepEqual(mgr.tail("t1", { chars: 5 }), {
      taskId: "t1",
      status: "done",
      text: "😀beta",
      textTotalChars: 10,
      truncated: true,
    });
  });

  test("returns a definitive no-text response", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1" })] });
    const r = mgr.tail("t1");
    assert.equal(r.text, "none observed yet");
    assert.equal(r.textTotalChars, 0);
    assert.equal(r.truncated, false);
  });

  test("validates the requested suffix length", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1" })] });
    assert.throws(() => mgr.tail("t1", { chars: 0 }), /chars must be a positive integer/);
  });

  test("accepts a request up to the 131072 ceiling and rejects above it", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1" })] });
    assert.doesNotThrow(() => mgr.tail("t1", { chars: 131072 }));
    assert.throws(() => mgr.tail("t1", { chars: 131073 }), /chars must be a positive integer no greater than 131072/);
  });

  test("falls back to raw captured output for a crashed task that never emitted an event", () => {
    const raw = 'Error: Extension "/x/y.js" error: Provider y: "baseUrl" is required when defining models.';
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "crashed", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": raw + "\n" },
    });
    const r = mgr.tail("t1");
    assert.equal(r.text, raw);
    assert.equal(r.textTotalChars, raw.length);
    assert.equal(r.truncated, false);
  });

  test("keeps the none-observed response once any parseable event exists, even with no narration", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "crashed", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": JSON.stringify({ type: "step_start", part: {} }) + "\nError: mid-run stderr noise\n" },
    });
    assert.equal(mgr.tail("t1").text, "none observed yet");
  });

  test("raw-capture fallback respects the chars suffix and reports truncation", () => {
    const raw = "Error: " + "x".repeat(1500);
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "crashed", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": raw + "\n" },
    });
    const r = mgr.tail("t1");
    assert.equal(Array.from(r.text).length, 1000);
    assert.equal(r.textTotalChars, raw.length);
    assert.equal(r.truncated, true);
  });

  test("an eventless crashed task with an empty log keeps the none-observed response", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "crashed", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": "" },
    });
    assert.equal(mgr.tail("t1").text, "none observed yet");
  });

  test("a watchdog-killed eventless task shows its raw capture (failureReason does not gate tail)", () => {
    const raw = "Error: Extension \"/x/y.js\" blew up at load";
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "crashed", failureReason: "no_output_timeout", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": raw + "\n" },
    });
    assert.equal(mgr.tail("t1").text, raw);
  });
});

describe("summarize()", () => {
  test("uses --pure and a private attachment", async () => {
    let captured;
    const child = fakeChild();
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Investigated the issue" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      spawnFn: (command, args, options) => {
        captured = { command, args, options };
        return child;
      },
    });

    const summary = await mgr.summarize("source", { maxWords: 150 });
    assert.equal(captured.command, "opencode");
    assert.ok(captured.args.includes("--pure"));
    assert.equal(captured.args.includes("--auto"), false);
    assert.equal(captured.args.includes("--agent"), false);
    const attachment = captured.args[captured.args.indexOf("-f") + 1];
    assert.equal(fs.statSync(attachment).mode & 0o777, 0o600);
    assert.equal(captured.options.cwd, mgr.paths.SUMMARY_DIR);
    assert.equal(summary.summaryTask.status, "running");

    child.emit("exit", 0, null);
    assert.equal(fs.existsSync(attachment), false);
  });

  test("writes a previous_summary field into the snapshot attachment when previousActivity is given", async () => {
    let capturedSnapshot;
    const child = fakeChild();
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Investigated the issue" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      spawnFn: (command, args) => {
        const attachment = args[args.indexOf("-f") + 1];
        capturedSnapshot = JSON.parse(fs.readFileSync(attachment, "utf8"));
        return child;
      },
    });

    await mgr.summarize("source", { maxWords: 150, previousActivity: "Read the config file." });

    assert.equal(capturedSnapshot.previous_summary, "Read the config file.");
    child.emit("exit", 0, null);
  });

  test("omits previous_summary from the snapshot attachment when there is no prior activity", async () => {
    let capturedSnapshot;
    const child = fakeChild();
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Investigated the issue" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      spawnFn: (command, args) => {
        const attachment = args[args.indexOf("-f") + 1];
        capturedSnapshot = JSON.parse(fs.readFileSync(attachment, "utf8"));
        return child;
      },
    });

    await mgr.summarize("source", { maxWords: 150 });

    assert.equal("previous_summary" in capturedSnapshot, false);
    child.emit("exit", 0, null);
  });

  test("includes truncated tool call input/output alongside text in the narration snapshot", async () => {
    let capturedSnapshot;
    const child = fakeChild();
    const log = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "Checking repo state" } }),
      JSON.stringify({
        type: "tool_use",
        part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "git status" }, output: "x".repeat(600) } },
      }),
      JSON.stringify({ type: "text", part: { messageID: "m2", text: "Now editing the file" } }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      spawnFn: (command, args) => {
        const attachment = args[args.indexOf("-f") + 1];
        capturedSnapshot = JSON.parse(fs.readFileSync(attachment, "utf8"));
        return child;
      },
    });

    await mgr.summarize("source", { maxWords: 150 });

    assert.match(capturedSnapshot.narration, /Checking repo state/);
    assert.match(capturedSnapshot.narration, /\[tool:bash] \{"command":"git status"} -> x+…\[truncated]/);
    assert.match(capturedSnapshot.narration, /Now editing the file/);
    child.emit("exit", 0, null);
  });

  test("does not spend a model call when no text has been observed", async () => {
    let spawned = false;
    const mgr = makeManager({
      tasksFixture: [baseTask({ id: "source" })],
      spawnFn: () => { spawned = true; return fakeChild(); },
    });
    const result = await mgr.summarize("source");
    assert.equal(result.summary, "no model text observed yet");
    assert.equal(spawned, false);
  });

  test("rejects an unavailable configured summary model before creating a task", async () => {
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "progress" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      listModelsFn: () => "openai/gpt-5.6-luna\n",
    });
    await assert.rejects(mgr.summarize("source"), /summary model is unavailable/);
    assert.equal(mgr.list().tasks.length, 1);
  });

  test("checkSummaryModelReady rejects when the configured summary model is unavailable", async () => {
    const mgr = makeManager({ listModelsFn: () => "openai/gpt-5.6-luna\n" });
    await assert.rejects(mgr.checkSummaryModelReady(), /summary model is unavailable/);
  });

  test("createTaskManager()'s real default listModelsFn validates against opencode's list, not the dispatch-default executor's (a default pi install must still find the default summary model)", async () => {
    // Bypasses makeManager deliberately -- it always injects its own
    // listModelsFn fallback, which would mask a regression back to either
    // the round-2 (defaultExecutor.listModelsFn) or round-3 pre-fix
    // (hardcoded `opencode models`) defaults. We want to prove the new
    // default is opencodeExecutor().listModelsFn regardless of the
    // configured dispatch-default executor.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-test-"));
    let piListModelsCalled = false;
    const fakePi = {
      id: "pi",
      taskIdPrefix: "pi",
      errorBucketPrefix: "pi",
      defaultModel: "minimax/MiniMax-M2.7",
      defaultSummaryModel: "minimax/MiniMax-M2.7",
      binaryName: "pi",
      listModelsFn: async () => {
        piListModelsCalled = true;
        // Whatever pi returns here is irrelevant: summaries always run
        // through opencode, so this list must NOT be used for the check.
        return "minimax/MiniMax-M2.7\n";
      },
      buildSpawnArgs: () => [],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: () => ({ extraRoBinds: [], extraRwPairBinds: [], sandboxedDataHome: "/tmp/unused", sandboxEnv: {} }),
    };
    const mgr = createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => fakeChild(),
      killFn: () => {},
      defaultExecutor: fakePi,
      // listModelsFn intentionally omitted -- exercising the real default.
    });
    // On a host with opencode installed, the check will succeed (real
    // `opencode models` output includes the default summary model). On
    // a host without opencode, the check will fail with a "verify that
    // opencode is installed" error -- which is itself proof that the
    // check hit opencode, not pi. Either outcome is fine; what matters
    // is that pi's listModelsFn was never consulted.
    try {
      await mgr.checkSummaryModelReady();
    } catch (err) {
      // If opencode isn't installed, the error message must still point
      // at opencode -- that's what proves we routed through opencode.
      assert.match(/** @type {Error} */ (err).message, /verify that opencode is installed/, "the summary availability check must consult opencode's listModelsFn, not pi's");
    }
    assert.equal(piListModelsCalled, false, "fakePi.listModelsFn must not be used for the summary availability check (it would reject opencode-only summary models)");
  });

  test("an injected listModelsFn takes precedence over the opencode default (preserves the round-2 test seam)", async () => {
    // The round-2 fix made createTaskManager's `listModelsFn` option
    // defer to defaultExecutor's listModelsFn, and several tests rely
    // on being able to inject a custom listModelsFn. Verify that
    // explicit injection still works -- just that the new *default* (used
    // when no override is given) is opencode's, not pi's.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-test-"));
    let injectedCalled = false;
    const fakePi = {
      id: "pi",
      taskIdPrefix: "pi",
      errorBucketPrefix: "pi",
      defaultModel: "minimax/MiniMax-M2.7",
      defaultSummaryModel: "minimax/MiniMax-M2.7",
      binaryName: "pi",
      listModelsFn: async () => "minimax/MiniMax-M2.7\n",
      buildSpawnArgs: () => [],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: () => ({ extraRoBinds: [], extraRwPairBinds: [], sandboxedDataHome: "/tmp/unused", sandboxEnv: {} }),
    };
    const mgr = createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => fakeChild(),
      killFn: () => {},
      defaultExecutor: fakePi,
      listModelsFn: async () => {
        injectedCalled = true;
        return `${DEFAULT_SUMMARY_MODEL}\n`;
      },
    });
    await mgr.checkSummaryModelReady();
    assert.equal(injectedCalled, true, "explicit listModelsFn injection must take precedence over the opencode default");
  });

  test("summary cache keeps separate entries for caller envs with different provider keys (no cross-caller pollution)", async () => {
    // Fix 1: the old single-entry cache meant caller A's listModelsFn output
    // (the model list opencode exposed under A's API keys) would satisfy
    // caller B's availability check, even though B has different credentials
    // and a different visible model list. Two summarize() calls with
    // different provider keys must populate and read separate cache entries,
    // each rooted in its own env.
    /** @type {Array<EventEmitter>} */
    const spawned = [];
    let listModelsCalls = 0;
    const mgr = makeManager({
      tasksFixture: (logDir) => [
        baseTask({ id: "srcA", status: "done", logPath: path.join(logDir, "srcA.ndjson") }),
        baseTask({ id: "srcB", status: "done", logPath: path.join(logDir, "srcB.ndjson") }),
      ],
      logs: {
        "srcA.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the A thing" } }) + "\n",
        "srcB.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the B thing" } }) + "\n",
      },
      listModelsFn: async (env) => {
        listModelsCalls++;
        // Env A sees model-A; env B does NOT (and vice versa). If the cache
        // ever cross-polluted, the second summarize would read the first
        // call's cached output and the wrong model list would reach the
        // availability check for the other caller.
        if (env.OPENAI_API_KEY === "AAA") return `${DEFAULT_SUMMARY_MODEL}\nopenai/gpt-A-only\n`;
        if (env.OPENAI_API_KEY === "BBB") return `${DEFAULT_SUMMARY_MODEL}\nopenai/gpt-B-only\n`;
        return `${DEFAULT_SUMMARY_MODEL}\n`;
      },
      spawnFn: () => {
        const child = fakeChild();
        spawned.push(child);
        return child;
      },
    });

    await mgr.summarize("srcA", { env: { OPENAI_API_KEY: "AAA" } });
    assert.equal(listModelsCalls, 1, "first caller populates its own cache entry");

    await mgr.summarize("srcB", { env: { OPENAI_API_KEY: "BBB" } });
    assert.equal(listModelsCalls, 2, "second caller (different provider key) must populate a separate cache entry, not read the first caller's");

    for (const child of spawned) child.emit("exit", 0, null);
  });

  test("summary cache shares an entry for identical caller envs (one listModelsFn call within the TTL)", async () => {
    // Fix 1: opposite of the cross-pollution case. Two callers with the
    // same provider-relevant env must share the cache entry -- otherwise
    // every dispatch would re-shell-out to `opencode models`, defeating
    // the original 5-minute memoization purpose.
    /** @type {Array<EventEmitter>} */
    const spawned = [];
    let listModelsCalls = 0;
    const mgr = makeManager({
      tasksFixture: (logDir) => [
        baseTask({ id: "srcA", status: "done", logPath: path.join(logDir, "srcA.ndjson") }),
        baseTask({ id: "srcB", status: "done", logPath: path.join(logDir, "srcB.ndjson") }),
      ],
      logs: {
        "srcA.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the A thing" } }) + "\n",
        "srcB.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the B thing" } }) + "\n",
      },
      listModelsFn: async () => {
        listModelsCalls++;
        return `${DEFAULT_SUMMARY_MODEL}\n`;
      },
      spawnFn: () => {
        const child = fakeChild();
        spawned.push(child);
        return child;
      },
    });

    await mgr.summarize("srcA", { env: { OPENAI_API_KEY: "same", ANTHROPIC_API_KEY: "same" } });
    await mgr.summarize("srcB", { env: { OPENAI_API_KEY: "same", ANTHROPIC_API_KEY: "same" } });

    assert.equal(listModelsCalls, 1, "identical caller envs must share one cache entry");

    for (const child of spawned) child.emit("exit", 0, null);
  });

  test("summary cache ignores cosmetic env differences that don't change which models a provider exposes (no per-call fragmentation)", async () => {
    // Fix 1: the fingerprint deliberately excludes high-churn unrelated
    // caller vars (PATH, LANG, USER, ...) so a caller changing cosmetic
    // vars doesn't trigger a fresh listModelsFn shell-out within the TTL.
    /** @type {Array<EventEmitter>} */
    const spawned = [];
    let listModelsCalls = 0;
    const mgr = makeManager({
      tasksFixture: (logDir) => [
        baseTask({ id: "srcA", status: "done", logPath: path.join(logDir, "srcA.ndjson") }),
        baseTask({ id: "srcB", status: "done", logPath: path.join(logDir, "srcB.ndjson") }),
      ],
      logs: {
        "srcA.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the A thing" } }) + "\n",
        "srcB.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the B thing" } }) + "\n",
      },
      listModelsFn: async () => {
        listModelsCalls++;
        return `${DEFAULT_SUMMARY_MODEL}\n`;
      },
      spawnFn: () => {
        const child = fakeChild();
        spawned.push(child);
        return child;
      },
    });

    await mgr.summarize("srcA", { env: { OPENAI_API_KEY: "same", LANG: "en_US.UTF-8", USER: "alice" } });
    await mgr.summarize("srcB", { env: { OPENAI_API_KEY: "same", LANG: "C.UTF-8", USER: "bob" } });

    assert.equal(listModelsCalls, 1, "LANG/USER are not in the fingerprint -- cosmetic differences must not fragment the cache");

    for (const child of spawned) child.emit("exit", 0, null);
  });

  test("summary cache separates entries across opencode catalog/auth overrides and provider base-URL overrides", async () => {
    // Review follow-up to fix 1: the original fingerprint covered
    // *_API_KEY / OPENCODE_CONFIG* / PI_CODING_AGENT_DIR only. But
    // OPENCODE_MODELS_URL / OPENCODE_MODELS_PATH point opencode at a
    // different model catalog, OPENCODE_AUTH_CONTENT carries inline auth
    // (the sibling of the already-covered OPENCODE_CONFIG_CONTENT), and
    // *_BASE_URL endpoint overrides change which catalog a provider
    // exposes (corporate proxies, self-hosted endpoints). Two callers
    // differing only in one of these must not share a cache entry.
    /** @type {Array<EventEmitter>} */
    const spawned = [];
    let listModelsCalls = 0;
    const mgr = makeManager({
      tasksFixture: (logDir) => [
        baseTask({ id: "srcA", status: "done", logPath: path.join(logDir, "srcA.ndjson") }),
        baseTask({ id: "srcB", status: "done", logPath: path.join(logDir, "srcB.ndjson") }),
      ],
      logs: {
        "srcA.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the A thing" } }) + "\n",
        "srcB.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the B thing" } }) + "\n",
      },
      listModelsFn: async () => {
        listModelsCalls++;
        return `${DEFAULT_SUMMARY_MODEL}\n`;
      },
      spawnFn: () => {
        const child = fakeChild();
        spawned.push(child);
        return child;
      },
    });

    await mgr.summarize("srcA", { env: { OPENAI_API_KEY: "same", OPENCODE_MODELS_URL: "https://catalog-1" } });
    assert.equal(listModelsCalls, 1, "first caller populates");

    await mgr.summarize("srcB", { env: { OPENAI_API_KEY: "same", OPENCODE_MODELS_URL: "https://catalog-2" } });
    assert.equal(listModelsCalls, 2, "different OPENCODE_MODELS_URL must not share a cache entry");

    await mgr.summarize("srcA", { env: { OPENAI_API_KEY: "same", OPENCODE_MODELS_PATH: "/models-1.json" } });
    assert.equal(listModelsCalls, 3, "OPENCODE_MODELS_PATH is in the fingerprint");

    await mgr.summarize("srcB", { env: { OPENAI_API_KEY: "same", OPENCODE_AUTH_CONTENT: '{"auth":"a"}' } });
    await mgr.summarize("srcA", { env: { OPENAI_API_KEY: "same", OPENCODE_AUTH_CONTENT: '{"auth":"b"}' } });
    assert.equal(listModelsCalls, 5, "different OPENCODE_AUTH_CONTENT must not share a cache entry");

    await mgr.summarize("srcB", { env: { OPENAI_API_KEY: "same", OPENAI_BASE_URL: "https://proxy.internal" } });
    assert.equal(listModelsCalls, 6, "a *_BASE_URL endpoint override is in the fingerprint");

    for (const child of spawned) child.emit("exit", 0, null);
  });

  test("summary cache TTL still expires per-key after 5 minutes (a stale entry must not be served indefinitely)", async (t) => {
    // Fix 1: re-keying on env does not break the existing 5-minute TTL.
    // After the TTL window elapses, the next call must re-shell-out for
    // the same env's model list (provider availability can change within
    // a TTL window -- e.g. an opencode auth.json swap or a new provider
    // registration). Mock Date.now to control TTL timing without
    // sleeping.
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    /** @type {() => void} */
    const restore = () => { Date.now = realNow; };
    t.after(restore);

    /** @type {Array<EventEmitter>} */
    const spawned = [];
    let listModelsCalls = 0;
    const mgr = makeManager({
      tasksFixture: (logDir) => [
        baseTask({ id: "srcA", status: "done", logPath: path.join(logDir, "srcA.ndjson") }),
        baseTask({ id: "srcB", status: "done", logPath: path.join(logDir, "srcB.ndjson") }),
      ],
      logs: {
        "srcA.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the A thing" } }) + "\n",
        "srcB.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the B thing" } }) + "\n",
      },
      listModelsFn: async () => {
        listModelsCalls++;
        return `${DEFAULT_SUMMARY_MODEL}\n`;
      },
      spawnFn: () => {
        const child = fakeChild();
        spawned.push(child);
        return child;
      },
    });

    await mgr.summarize("srcA", { env: { OPENAI_API_KEY: "same" } });
    assert.equal(listModelsCalls, 1, "first call populates the cache");

    now += 5 * 60 * 1000 + 1; // past the 5-minute TTL window

    await mgr.summarize("srcB", { env: { OPENAI_API_KEY: "same" } });
    assert.equal(listModelsCalls, 2, "after TTL expiry, the same env's cache must repopulate");

    for (const child of spawned) child.emit("exit", 0, null);
  });

  test("concurrent summary availability checks for the same caller env coalesce into a single listModelsFn call (no interleaved writes)", async () => {
    // Fix 1: the old single-entry cache had a write race -- two concurrent
    // `modelsCache = ...` assignments could interleave (one wins the
    // expiresAt, the other the output), leaving an entry whose output
    // doesn't match its expiresAt. The new Map<key, entry> + inFlight
    // pattern serializes populates per-key: the second caller awaits the
    // first's populate promise and reads the same entry.
    /** @type {() => void} */
    let releaseListModels;
    const listModelsBlocking = new Promise((resolve) => { releaseListModels = () => resolve(undefined); });
    let listModelsCalls = 0;
    const mgr = makeManager({
      listModelsFn: async () => {
        listModelsCalls++;
        await listModelsBlocking;
        return `${DEFAULT_SUMMARY_MODEL}\n`;
      },
    });

    // Fire two concurrent checks for the same caller env (no env, so both
    // share the empty fingerprint). Before fix 1, both would race through
    // the `if (Date.now() >= modelsCache.expiresAt)` gate before either
    // populated the entry, leading to two concurrent shell-outs.
    const call1 = mgr.checkSummaryModelReady();
    const call2 = mgr.checkSummaryModelReady();
    releaseListModels();
    await Promise.all([call1, call2]);

    assert.equal(listModelsCalls, 1, "concurrent populate calls for the same fingerprint must coalesce, not race");
  });

  test("summary --mode activity rejects when the summary model is unavailable, instead of masking the failure with local narration", async () => {
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "progress" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      listModelsFn: () => "openai/gpt-5.6-luna\n",
    });
    await assert.rejects(mgr.summarize("source", { mode: "activity", maxWords: 150 }), /summary model is unavailable/);
  });

  test("preserves head and tail narration around an oversized log omission marker", async () => {
    const child = fakeChild();
    let attachment;
    const events = [
      JSON.stringify({ type: "text", part: { messageID: "head", text: "HEAD_MARKER" } }),
      ...Array.from({ length: 160 }, (_, index) => JSON.stringify({
        type: "text",
        part: { messageID: `middle-${index}`, text: "x".repeat(700) },
      })),
      JSON.stringify({ type: "text", part: { messageID: "tail", text: "TAIL_MARKER" } }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": events },
      spawnFn: (_command, args) => {
        attachment = args[args.indexOf("-f") + 1];
        return child;
      },
    });
    await mgr.summarize("source");
    const snapshot = JSON.parse(fs.readFileSync(attachment, "utf8"));
    assert.match(snapshot.narration, /HEAD_MARKER/);
    assert.match(snapshot.narration, /TAIL_MARKER/);
    assert.match(snapshot.narration, /bytes omitted from source log/);
    child.emit("exit", 0, null);
  });

  // Drives a single spawned summary child through its lifecycle (write a
  // sessionID into its log so readSessionIdFromLog returns it, then fire the
  // exit event). The default fakeChild never logs anything, so without this
  // step the cache wouldn't get a session id to persist for the next call.
  // Returns the summary task id (looked up by summaryOf.sourceTaskId) and the
  // fakeChild handle so the caller can keep emitting further exits.
  async function settleSummaryChildWithSessionId(mgr, summaryTaskId, sessionId, finalText = "current state") {
    const persisted = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    const summary = persisted.find((task) => task.id === summaryTaskId);
    if (!summary) throw new Error(`no summary task ${summaryTaskId} persisted`);
    fs.writeFileSync(
      summary.logPath,
      [
        JSON.stringify({ sessionID: sessionId, type: "step_start" }),
        JSON.stringify({ type: "text", part: { messageID: "answer", text: finalText } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "answer", reason: "stop" } }),
      ].join("\n")
    );
  }

  test("first summarize call spawns with no --continue/--session flags and writes the full bounded excerpt", async () => {
    let firstArgs;
    let firstSnapshot;
    const child = fakeChild();
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Inspect the daemon" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      spawnFn: (_command, args) => {
        firstArgs = args;
        firstSnapshot = JSON.parse(fs.readFileSync(args[args.indexOf("-f") + 1], "utf8"));
        return child;
      },
    });

    const started = await mgr.summarize("source", { maxWords: 150 });
    assert.ok(started.summaryTask);

    assert.equal(firstArgs.includes("--continue"), false);
    assert.equal(firstArgs.includes("--session"), false);
    assert.match(firstSnapshot.narration, /Inspect the daemon/);
    assert.equal(firstSnapshot.narration_is_delta, undefined);

    await settleSummaryChildWithSessionId(mgr, started.summaryTask.id, "ses_first");
    child.emit("exit", 0, null);
  });

  test("second summarize call continues the prior session and sends only the narration delta (not the full bounded excerpt)", async () => {
    const children = [];
    const captures = [];
    const initialLog = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Reading the config" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": initialLog },
      spawnFn: (_command, args) => {
        const child = fakeChild(5000 + children.length);
        children.push(child);
        captures.push({ args, attachment: args[args.indexOf("-f") + 1] });
        return child;
      },
    });

    // First call: no continuation flags, snapshot uses the full bounded excerpt.
    const firstStarted = await mgr.summarize("source", { maxWords: 150 });
    const firstSnapshot = JSON.parse(fs.readFileSync(captures[0].attachment, "utf8"));
    assert.equal(captures[0].args.includes("--continue"), false);
    assert.equal(captures[0].args.includes("--session"), false);
    assert.match(firstSnapshot.narration, /Reading the config/);

    // Simulate the first summary task settling and handing its session id
    // back via the cache's setSummarySessionId path (startTask's exit handler
    // does this in production).
    await settleSummaryChildWithSessionId(mgr, firstStarted.summaryTask.id, "ses_first");
    children[0].emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    // Grow the source log; the second turn must see only the appended bytes.
    fs.appendFileSync(firstStarted.sourceTaskId && path.join(mgr.paths.LOG_DIR, `${firstStarted.sourceTaskId}.ndjson`), "");

    // Read the source task's persisted logPath and append new content so the
    // next summarize call sees a real delta.
    const persistedTasks = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    const source = persistedTasks.find((t) => t.id === "source");
    fs.appendFileSync(source.logPath, JSON.stringify({ type: "text", part: { messageID: "m2", text: "New step completed" } }) + "\n");

    // Second call: must continue the prior session, send only the delta, and
    // include the previous summary so the model can stitch them together.
    const secondStarted = await mgr.summarize("source", { maxWords: 150, previousActivity: "Read the config." });
    const secondArgs = captures[1].args;
    const secondSnapshot = JSON.parse(fs.readFileSync(captures[1].attachment, "utf8"));

    assert.ok(secondStarted.summaryTask);
    assert.equal(secondArgs.includes("--continue"), true);
    assert.ok(secondArgs.includes("--session"));
    const sessionIdx = secondArgs.indexOf("--session");
    assert.equal(secondArgs[sessionIdx + 1], "ses_first");
    // Delta-only: includes the newly appended narration, omits the old prefix.
    assert.match(secondSnapshot.narration, /New step completed/);
    assert.equal(secondSnapshot.narration.includes("Reading the config"), false);
    assert.equal(secondSnapshot.narration_is_delta, true);
    assert.equal(secondSnapshot.previous_summary, "Read the config.");

    // Clean up the spawned summary children.
    await settleSummaryChildWithSessionId(mgr, secondStarted.summaryTask.id, "ses_second", "delta-only result");
    children[1].emit("exit", 0, null);
  });

  test("continue-fails-so-fresh: summarizeActivity detects a session-id mismatch and retries fresh, leaving the cache clear of the stale id", async () => {
    const captures = [];
    const children = [];
    const initialLog = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Reading the config" } }) + "\n";
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": initialLog },
      spawnFn: (_command, args) => {
        captures.push({ args, attachment: args[args.indexOf("-f") + 1] });
        const child = fakeChild(7000 + captures.length);
        children.push(child);
        return child;
      },
    });

    // Seed the cache the same way startTask's exit handler would after a
    // prior successful summarize call: it stores the spawn's opencode
    // session id and the source-log watermark at summarize time. The watermark
    // is the byte size of the source log right now, so summarizeTask's
    // rotation check (`watermark > currentSize`) won't kick in and discard it.
    const sourceLogPath = path.join(fs.realpathSync(mgr.paths.LOG_DIR), "source.ndjson");
    const initialSize = fs.statSync(sourceLogPath).size;
    mgr.activityCache.setSummarySessionId("source", "ses_cached");
    mgr.activityCache.setLastSummarizedWatermark("source", initialSize);

    // Grow the source log so a delta exists for the next turn.
    const sourceTaskPersisted = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8")).find((t) => t.id === "source");
    const appendedLine = JSON.stringify({ type: "text", part: { messageID: "m2", text: "More work done" } }) + "\n";
    fs.appendFileSync(sourceTaskPersisted.logPath, appendedLine);

    // Kick off the activity path: summarizeActivity will spawn #1 with
    // --continue --session ses_cached, poll #1, see that the spawned child's
    // log carries no matching session id, and spawn #2 fresh.
    const refreshP = mgr.activityCache.refresh(
      { id: "source", status: "running", logPath: sourceTaskPersisted.logPath },
      { force: true, includeSummary: true }
    );

    // Wait for spawn #1 to land (synchronous inside summarizeTask).
    while (captures.length < 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(captures[0].args.includes("--continue"));
    assert.ok(captures[0].args.includes("--session"));
    assert.equal(captures[0].args[captures[0].args.indexOf("--session") + 1], "ses_cached");
    // Spawn #1's snapshot is a delta (we have a prior watermark and growth).
    const firstSnapshot = JSON.parse(fs.readFileSync(captures[0].attachment, "utf8"));
    assert.equal(firstSnapshot.narration_is_delta, true);

    // Drive spawn #1's exit. The fakeChild's log is empty so its derived
    // session id is null -- which doesn't match ses_cached, triggering the
    // fallback path.
    children[0].emit("exit", 0, null);
    while (captures.length < 2) await new Promise((resolve) => setImmediate(resolve));

    // Spawn #2 is the fresh retry: no --continue, no --session, full bounded excerpt.
    const retryArgs = captures[1].args;
    assert.equal(retryArgs.includes("--continue"), false);
    assert.equal(retryArgs.includes("--session"), false);
    const retrySnapshot = JSON.parse(fs.readFileSync(captures[1].attachment, "utf8"));
    assert.equal(retrySnapshot.narration_is_delta, undefined);
    assert.match(retrySnapshot.narration, /Reading the config/);
    assert.match(retrySnapshot.narration, /More work done/);

    // Drop a usable final message + sessionID into the retry's log so the
    // retry's session id survives into the cache for the next call.
    const persisted = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    const retries = persisted.filter((t) => t.summaryOf && t.summaryOf.sourceTaskId === "source");
    assert.equal(retries.length, 2, "expected two summary tasks to have been queued");
    fs.writeFileSync(
      retries[1].logPath,
      JSON.stringify({ sessionID: "ses_fresh_retry", type: "text", part: { messageID: "answer", text: "fresh retry output" } }) + "\n"
        + JSON.stringify({ type: "step_finish", part: { messageID: "answer", reason: "stop" } }) + "\n"
    );
    children[1].emit("exit", 0, null);

    const result = await refreshP;
    assert.equal(result.activity, "fresh retry output");
    // Cache ended up with the retry's session id (recorded by the exit
    // handler), not the stale ses_cached or the mismatched first attempt.
    assert.equal(mgr.activityCache.getSummarySessionId("source"), "ses_fresh_retry");
    assert.notEqual(mgr.activityCache.getLastSummarizedWatermark("source"), initialSize);
  });

  test("summarizeTask's exit handler persists the opencode session id and the source-log watermark to the activity cache for the next turn", async () => {
    const child = fakeChild();
    const initialLog = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Investigating issue" } }) + "\n";
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": initialLog },
      spawnFn: () => child,
    });

    const started = await mgr.summarize("source", { maxWords: 150 });
    // Pre-settlement: cache has nothing for this task.
    assert.equal(mgr.list().tasks.length, 2);

    await settleSummaryChildWithSessionId(mgr, started.summaryTask.id, "ses_real");
    child.emit("exit", 0, null);
    // Allow the exit handler's microtasks (persist, activity update, etc.) to drain.
    await new Promise((resolve) => setImmediate(resolve));

    // Exit handler should have stamped the summary task with the spawned
    // opencode session id read from its log, and persisted status=done to
    // tasks.json. The activity-cache side effects (next-turn --session lookup)
    // are exercised end-to-end by the second-call test above.
    const persisted = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    const summary = persisted.find((task) => task.id === started.summaryTask.id);
    assert.equal(summary.status, "done");
    assert.equal(summary.sessionId, "ses_real");
  });

  test("activity-refresh summary reserve retries briefly instead of dropping a second task's summary outright (regression for #134 review finding)", async () => {
    const children = [];
    const log1 = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Task one progress" } }) + "\n";
    const log2 = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Task two progress" } }) + "\n";
    const mgr = makeManager({
      maxConcurrentTasks: 2,
      tasksFixture: (logDir) => [
        baseTask({ id: "source1", logPath: path.join(logDir, "source1.ndjson") }),
        baseTask({ id: "source2", logPath: path.join(logDir, "source2.ndjson") }),
      ],
      logs: { "source1.ndjson": log1, "source2.ndjson": log2 },
      spawnFn: () => {
        const child = fakeChild(9000 + children.length);
        children.push(child);
        return child;
      },
    });
    const fixtures = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    const source1 = fixtures.find((t) => t.id === "source1");
    const source2 = fixtures.find((t) => t.id === "source2");

    try {
      mock.timers.enable({ apis: ["setTimeout"] });

      // source1's forced activity refresh occupies the only summary reserve
      // slot (summaryConcurrencyLimit = 1 at maxConcurrentTasks = 2).
      const refresh1P = mgr.activityCache.refresh(source1, { force: true, includeSummary: true });
      while (children.length < 1) await new Promise((resolve) => setImmediate(resolve));
      const summary1Id = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"))
        .find((t) => t.summaryOf && t.summaryOf.sourceTaskId === "source1").id;

      // source2's refresh starts while the reserve is full. Before this fix,
      // the reserve check returned the "skipped" response immediately here.
      const refresh2P = mgr.activityCache.refresh(source2, { force: true, includeSummary: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(children.length, 1, "source2 must not spawn yet while the reserve is full");

      // Free the slot before the retry loop exhausts its attempts.
      await settleSummaryChildWithSessionId(mgr, summary1Id, "ses_source1", "source one summary");
      children[0].emit("exit", 0, null);
      assert.equal((await refresh1P).activity, "source one summary");

      // Advance past the retry delay so source2's loop re-checks and proceeds
      // now that the slot is free, instead of giving up.
      mock.timers.tick(500);
      while (children.length < 2) await new Promise((resolve) => setImmediate(resolve));

      const summary2Id = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"))
        .find((t) => t.summaryOf && t.summaryOf.sourceTaskId === "source2").id;
      await settleSummaryChildWithSessionId(mgr, summary2Id, "ses_source2", "source two summary");
      children[1].emit("exit", 0, null);

      const result2 = await refresh2P;
      assert.equal(result2.activity, "source two summary", "source2 must get a real summary, not the reserve-skip text");
    } finally {
      mock.timers.reset();
    }
  });
});

describe("caller-env union (sanitizedEnvironment)", () => {
  test("a caller-supplied env value overlays the daemon's own ambient environment", (t) => {
    delete process.env.AXI_TEST_CALLER_VAR;
    t.after(() => delete process.env.AXI_TEST_CALLER_VAR);
    let capturedOpts = null;
    const mgr = makeManager({ spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); } });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: { AXI_TEST_CALLER_VAR: "from-caller" } });

    assert.equal(capturedOpts.env.AXI_TEST_CALLER_VAR, "from-caller");
  });

  test("caller env cannot override the fixed excluded set of daemon-controlled vars", (t) => {
    const excluded = ["PATH", "HOME", "TASKFERRY_STATE_DIR", "TASKFERRY_RUNTIME_DIR", "TASKFERRY_CACHE_DIR", "TASKFERRY_SOCKET_PATH"];
    for (const name of excluded) process.env[name] = `real-${name}`;
    t.after(() => { for (const name of excluded) delete process.env[name]; });
    let capturedOpts = null;
    const mgr = makeManager({ spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); } });

    const maliciousEnv = Object.fromEntries(excluded.map((name) => [name, `malicious-${name}`]));
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: maliciousEnv });

    for (const name of excluded) {
      assert.equal(capturedOpts.env[name], `real-${name}`, `${name} must keep the daemon's own ambient value`);
    }
  });

  test("a denylisted name is stripped even when the caller's env explicitly sets it", (t) => {
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); },
      envDenylistSpec: "AXI_TEST_DENIED_VAR",
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: { AXI_TEST_DENIED_VAR: "leaked-value" } });

    assert.equal("AXI_TEST_DENIED_VAR" in capturedOpts.env, false);
  });

  test("TASKFERRY_CHILD survives even when denylisted", (t) => {
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); },
      envDenylistSpec: "TASKFERRY_CHILD",
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    assert.equal(capturedOpts.env.TASKFERRY_CHILD, "1");
  });

  test("TASKFERRY_TASK_ID is stamped with the spawned task's own id, for both dispatch and advisor roles", async () => {
    let dispatchOpts = null;
    let advisorOpts = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => {
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

    const advised = await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
    assert.equal(advisorOpts.env.TASKFERRY_TASK_ID, advised.task_id);
  });

  test("TASKFERRY_TASK_ID is absent from summary spawns", async () => {
    let capturedOpts = null;
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Investigated the issue" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); },
    });

    await mgr.summarize("source", { maxWords: 150 });

    assert.equal("TASKFERRY_TASK_ID" in capturedOpts.env, false);
  });

  test("omitting env behaves as ambient-only, same as before caller-env forwarding existed", (t) => {
    process.env.AXI_TEST_AMBIENT_ONLY = "ambient-value";
    t.after(() => delete process.env.AXI_TEST_AMBIENT_ONLY);
    let capturedOpts = null;
    const mgr = makeManager({ spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); } });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    assert.equal(capturedOpts.env.AXI_TEST_AMBIENT_ONLY, "ambient-value");
  });

  test("summaryEnvironment strips OPENCODE_CONFIG* even when the caller's env explicitly sets one", async (t) => {
    let capturedEnv = null;
    const mgr = makeManager({
      tasksFixture: (logDir) => [{ ...baseTask({ id: "src1", status: "done", logPath: path.join(logDir, "src1.ndjson") }) }],
      logs: { "src1.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the thing" } }) + "\n" },
      spawnFn: (cmd, args, opts) => { capturedEnv = opts.env; return fakeChild(); },
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
      spawnFn: (cmd, args, opts) => { capturedOpts = opts; return child; },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });

    const advisorPromise = mgr.advisor({
      prompt: "hi",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
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
      tasksFixture: (logDir) => [{ ...baseTask({ id: "src1", status: "done", logPath: path.join(logDir, "src1.ndjson") }) }],
      logs: { "src1.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the thing" } }) + "\n" },
      spawnFn: (cmd, args, opts) => { capturedEnv = opts.env; return fakeChild(); },
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
    });

    await mgr.summarize("src1", { mode: "report", env: { AXI_TEST_REPORT_CALLER_VAR: "from-report-caller" } });

    assert.ok(capturedEnv, "the summarize report call must have spawned a child");
    assert.equal(capturedEnv.AXI_TEST_REPORT_CALLER_VAR, "from-report-caller");
  });

  test("a queued dispatch's stored env is the one captured at dispatch() time, not re-read later", async (t) => {
    delete process.env.AXI_TEST_LATE_AMBIENT;
    t.after(() => delete process.env.AXI_TEST_LATE_AMBIENT);
    const occupyingChild = fakeChild(9001);
    /** @type {any} */
    let secondCapturedOpts = null;
    let spawnCount = 0;
    const mgr = makeManager({
      maxConcurrentTasks: 1,
      spawnFn: (cmd, args, opts) => {
        spawnCount++;
        if (spawnCount === 1) return occupyingChild;
        secondCapturedOpts = opts;
        return fakeChild(9002);
      },
    });

    // Occupy the only concurrency slot.
    mgr.dispatch({ prompt: "occupying task", directory: os.tmpdir() });
    // This one queues behind the slot, with its own env captured now.
    mgr.dispatch({ prompt: "queued task", directory: os.tmpdir(), env: { AXI_TEST_MARKER: "captured-at-dispatch-time" } });

    // Simulate ambient env changing while the second dispatch sits queued.
    process.env.AXI_TEST_LATE_AMBIENT = "set-after-queuing";

    // Release the first task so the queued one actually spawns.
    occupyingChild.emit("exit", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(secondCapturedOpts, "the queued task should have spawned");
    assert.equal(secondCapturedOpts.env.AXI_TEST_MARKER, "captured-at-dispatch-time", "caller env is frozen at dispatch() time");
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
      spawnFn: (cmd, args, opts) => {
        spawnCount++;
        if (spawnCount === 1) return occupyingChild;
        secondCapturedOpts = opts;
        return fakeChild(9002);
      },
    });

    mgr.dispatch({ prompt: "occupying task", directory: os.tmpdir() });
    // Hold a reference to the caller's original env object after dispatch()
    // returns -- the queued launch must NOT observe these mutations.
    const callerEnv = { AXI_TEST_QUEUE_REASSIGN: "captured-at-dispatch-time" };
    mgr.dispatch({ prompt: "queued task", directory: os.tmpdir(), env: callerEnv });

    callerEnv.AXI_TEST_QUEUE_REASSIGN = "mutated-after-queue";
    callerEnv.AXI_TEST_QUEUE_ADDED = "added-after-queue";

    occupyingChild.emit("exit", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(secondCapturedOpts, "the queued task should have spawned");
    assert.equal(secondCapturedOpts.env.AXI_TEST_QUEUE_REASSIGN, "captured-at-dispatch-time", "the dispatch-time value must reach the spawned child, not the post-queue mutated value");
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
      tasksFixture: (logDir) => [{ ...baseTask({ id: "src1", status: "done", logPath: path.join(logDir, "src1.ndjson") }) }],
      logs: { "src1.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the thing" } }) + "\n" },
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
      spawnFn: (cmd, args, opts) => {
        spawnCount++;
        if (spawnCount === 1) return occupyingChild;
        summaryCapturedOpts = opts;
        return fakeChild(9002);
      },
    });

    // Occupy the only concurrency slot.
    mgr.dispatch({ prompt: "occupying task", directory: os.tmpdir() });

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

  test("excluded names, denylist names, and caller-wins are all applied in a single merge pass (review fix: caller-wins/denylist-last/denylist-strips-ambient semantics)", (t) => {
    process.env.TASKFERRY_STATE_DIR = "real-state";
    process.env.AXI_TEST_DENY_AMBIENT = "ambient-leak";
    t.after(() => {
      delete process.env.TASKFERRY_STATE_DIR;
      delete process.env.AXI_TEST_DENY_AMBIENT;
    });
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); },
      envDenylistSpec: "AXI_TEST_DENY_AMBIENT,AXI_TEST_DENY_CALLER",
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: {
      TASKFERRY_STATE_DIR: "malicious-state",
      AXI_TEST_DENY_AMBIENT: "caller-overrides-ambient",
      AXI_TEST_DENY_CALLER: "caller-only",
      AXI_TEST_KEEP: "from-caller",
    } });

    assert.equal(capturedOpts.env.TASKFERRY_STATE_DIR, "real-state", "excluded name keeps the daemon's ambient value even when the caller sets it");
    assert.equal("AXI_TEST_DENY_AMBIENT" in capturedOpts.env, false, "denylist strips a name that came in from the daemon's own ambient env");
    assert.equal("AXI_TEST_DENY_CALLER" in capturedOpts.env, false, "denylist strips a name the caller set on the env param");
    assert.equal(capturedOpts.env.AXI_TEST_KEEP, "from-caller", "non-excluded, non-denylist caller names overlay the ambient env");
  });

  test("the exclusion set is sourced from paths.js's plumbing export -- any new TASKFERRY_* plumbing var added there lands here automatically", (t) => {
    // Single-source review fix: the excluded list used to be hardcoded
    // literally in tasks.js (["PATH", "HOME", "TASKFERRY_STATE_DIR", ...]).
    // If a future plumbing var was added to paths.js without also editing
    // tasks.js, a caller could override it from their forwarded env and
    // misroute a nested taskferry call (e.g. via TASKFERRY_SOCKET_PATH). The
    // set is now built from paths.js's TASKFERRY_PLUMBING_ENV_VARS export
    // plus PATH and HOME; this test exercises every name in that export to
    // pin the derivation.
    for (const name of ["TASKFERRY_STATE_DIR", "TASKFERRY_RUNTIME_DIR", "TASKFERRY_CACHE_DIR", "TASKFERRY_SOCKET_PATH", "TASKFERRY_OVERLAY_TMP_DIR"]) {
      process.env[name] = `real-${name}`;
    }
    t.after(() => {
      for (const name of ["TASKFERRY_STATE_DIR", "TASKFERRY_RUNTIME_DIR", "TASKFERRY_CACHE_DIR", "TASKFERRY_SOCKET_PATH", "TASKFERRY_OVERLAY_TMP_DIR"]) {
        delete process.env[name];
      }
    });
    let capturedOpts = null;
    const mgr = makeManager({ spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); } });

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

    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: { AXI_TEST_UNDEFINED: undefined } });

    assert.equal(mgr.status(dispatched.id).status, "crashed");
    assert.match(mgr.status(dispatched.id).spawnError, /env value for "AXI_TEST_UNDEFINED" must be a string, got undefined/);
    assert.equal(spawnCalled, false);
  });
});

describe("startTask() writes stdout through executor.normalizeLogEvent (Task 7: write-time normalization)", () => {
  test("JSON events flagged null by normalizeLogEvent are dropped; kept events are written canonicalized", () => {
    const child = fakeChild();
    const spawnFn = mock.fn(() => child);
    const fakeExecutor = {
      id: "opencode",
      taskIdPrefix: "oc",
      errorBucketPrefix: "opencode",
      defaultModel: "openai/gpt-5.6-luna",
      defaultSummaryModel: "opencode/mimo-v2.5-free",
      binaryName: "opencode",
      listModelsFn: async () => "",
      buildSpawnArgs: () => ["run", "--dir", process.cwd(), "--auto", "--format", "json", "-m", "x", "--", "hi"],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (evt) => (evt.type === "drop-me" ? null : { ...evt, normalized: true }),
      sandboxAuthFile: () => ({ extraRoBinds: [], sandboxedDataHome: "/tmp/unused", sandboxEnv: {} }),
    };
    const mgr = makeManager({ spawnFn, defaultExecutor: fakeExecutor });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: process.cwd() });
    const logPath = mgr.status(dispatched.id).logPath;
    child.stdout.emit("data", Buffer.from('{"type":"drop-me"}\n{"type":"keep-me"}\n'));
    child.emit("exit", 0, null);
    const contents = fs.readFileSync(logPath, "utf8");
    assert.ok(!contents.includes("drop-me"), "events normalizeLogEvent returned null for must not be written to the log");
    assert.ok(contents.includes('"keep-me"'));
    assert.ok(contents.includes('"normalized":true'));
  });

  test("non-JSON stdout lines (e.g. pi's plain-text auth failure) are preserved verbatim for classifyProviderFailure", () => {
    // Real pi auth-failure output is plain text on stdout (not stderr) and
    // exits 0 -- the only way classifyProviderFailure can see it is if
    // it's written to the canonical log file. startTask must therefore
    // forward every line that isn't parseable JSON verbatim, not drop it.
    const child = fakeChild();
    const spawnFn = mock.fn(() => child);
    const fakeExecutor = {
      id: "opencode",
      taskIdPrefix: "oc",
      errorBucketPrefix: "opencode",
      defaultModel: "openai/gpt-5.6-luna",
      defaultSummaryModel: "opencode/mimo-v2.5-free",
      binaryName: "opencode",
      listModelsFn: async () => "",
      buildSpawnArgs: () => ["run", "--dir", process.cwd(), "--auto", "--format", "json", "-m", "x", "--", "hi"],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed, // identity, so dropped means JSON.parse failed
      sandboxAuthFile: () => ({ extraRoBinds: [], sandboxedDataHome: "/tmp/unused", sandboxEnv: {} }),
    };
    const mgr = makeManager({ spawnFn, defaultExecutor: fakeExecutor });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: process.cwd() });
    const logPath = mgr.status(dispatched.id).logPath;
    child.stdout.emit("data", Buffer.from('No API key found for openai.\n'));
    child.emit("exit", 0, null);
    const contents = fs.readFileSync(logPath, "utf8");
    assert.ok(contents.includes("No API key found for openai."));
  });

  test("a non-empty trailing partial line at process end is preserved verbatim (no terminating newline required)", () => {
    const child = fakeChild();
    const spawnFn = mock.fn(() => child);
    const fakeExecutor = {
      id: "opencode",
      taskIdPrefix: "oc",
      errorBucketPrefix: "opencode",
      defaultModel: "openai/gpt-5.6-luna",
      defaultSummaryModel: "opencode/mimo-v2.5-free",
      binaryName: "opencode",
      listModelsFn: async () => "",
      buildSpawnArgs: () => ["run", "--dir", process.cwd(), "--auto", "--format", "json", "-m", "x", "--", "hi"],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: () => ({ extraRoBinds: [], sandboxedDataHome: "/tmp/unused", sandboxEnv: {} }),
    };
    const mgr = makeManager({ spawnFn, defaultExecutor: fakeExecutor });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: process.cwd() });
    const logPath = mgr.status(dispatched.id).logPath;
    child.stdout.emit("data", Buffer.from("trailing non-json fragment with no newline"));
    child.stdout.emit("end");
    child.emit("exit", 0, null);
    const contents = fs.readFileSync(logPath, "utf8");
    assert.ok(contents.includes("trailing non-json fragment with no newline"));
  });
});

describe("startTask() spawns the executor's CLI binary, not a hardcoded command (Task 7: executor-driven binary)", () => {
  test("a pi dispatch spawns the `pi` binary, with args from executor.buildSpawnArgs", () => {
    let captured = null;
    const fakePi = {
      id: "pi",
      taskIdPrefix: "pi",
      errorBucketPrefix: "pi",
      defaultModel: "minimax/MiniMax-M2.7",
      defaultSummaryModel: "minimax/MiniMax-M2.7",
      binaryName: "pi",
      listModelsFn: async () => "",
      buildSpawnArgs: (ctx) => ["--model", ctx.model, "--mode", "json", "-p", ctx.prompt],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: () => ({ extraRoBinds: [], sandboxedDataHome: "/tmp/unused", sandboxEnv: {} }),
    };
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      defaultExecutor: fakePi,
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.equal(captured.cmd, "pi");
    assert.deepEqual(captured.args, ["--model", "minimax/MiniMax-M2.7", "--mode", "json", "-p", "hi"]);
  });

  test("a default (pi) dispatch still spawns `pi`", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.equal(captured.cmd, "pi");
  });
});

describe("startTask() merges executor.sandboxAuthFile().sandboxEnv into spawnEnv (Task 7: per-executor env overrides)", () => {
  test("opencode's sandboxEnv rewrites XDG_DATA_HOME to the sandboxed cache data home", () => {
    let captured = null;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-cache-oc-"));
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      cacheDir,
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    assert.equal(captured.opts.env.XDG_DATA_HOME, path.join(cacheDir, "opencode-data"));
  });

  test("pi's sandboxEnv rewrites PI_CODING_AGENT_DIR, not XDG_DATA_HOME, and the auth bind destination matches", () => {
    let captured = null;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-cache-pi-"));
    const realAuthFile = path.join(os.tmpdir(), "fake-pi-home", "auth.json");
    const fakePi = {
      id: "pi",
      taskIdPrefix: "pi",
      errorBucketPrefix: "pi",
      defaultModel: "minimax/MiniMax-M2.7",
      defaultSummaryModel: "minimax/MiniMax-M2.7",
      binaryName: "pi",
      listModelsFn: async () => "",
      buildSpawnArgs: (ctx) => ["--model", ctx.model, "--mode", "json", "-p", ctx.prompt],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: ({ dataDir, existsFn }) => {
        const sandboxedDataHome = path.join(dataDir, "pi-data");
        return {
          extraRoBinds: existsFn(realAuthFile) ? [/** @type {[string, string]} */ ([realAuthFile, path.join(sandboxedDataHome, "auth.json")])] : [],
          sandboxedDataHome,
          sandboxEnv: { PI_CODING_AGENT_DIR: sandboxedDataHome },
        };
      },
    };
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      defaultExecutor: fakePi,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      cacheDir,
      existsFn: (p) => p === realAuthFile,
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    // The pi binary was launched inside bwrap
    assert.equal(captured.cmd, "bwrap");
    // The args tail is `-- <binaryName> <buildSpawnArgs...>`. Find the
    // separator and the binary right after it.
    const separatorIdx = captured.args.lastIndexOf("--");
    assert.equal(captured.args[separatorIdx + 1], "pi");
    // PI_CODING_AGENT_DIR was overridden to the sandboxed data home.
    assert.equal(captured.opts.env.PI_CODING_AGENT_DIR, path.join(cacheDir, "pi-data"));
    // XDG_DATA_HOME was NOT rewritten for pi -- the opencode dispatcher
    // rewrites it; pi's executor returns a sandboxEnv that only sets
    // PI_CODING_AGENT_DIR. (Any pre-existing XDG_DATA_HOME from process.env
    // is preserved verbatim; we don't care whether the host had one.)
    assert.notEqual(captured.opts.env.XDG_DATA_HOME, path.join(cacheDir, "pi-data"));
    // The auth.json bind destination matches the override (pi-data/auth.json)
    const piDataAuth = path.join(cacheDir, "pi-data", "auth.json");
    const destIdx = captured.args.indexOf(piDataAuth);
    assert.notEqual(destIdx, -1, "expected the auth.json destination to match PI_CODING_AGENT_DIR");
    // The bwrap pattern is `--ro-bind <src> <dest>`, so --ro-bind sits two
    // positions before the destination (src is the one position before dest).
    assert.equal(captured.args[destIdx - 2], "--ro-bind");
    assert.equal(captured.args[destIdx - 1], realAuthFile);
  });

  test("a pi dispatch's sandboxAuthFile call is invoked with the dispatch's sessionId + launchDirectory, so the bind can scope to a single session file", () => {
    let capturedArgs = null;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-cache-pi-"));
    const realAuthFile = path.join(os.tmpdir(), "fake-pi-home", "auth.json");
    const fakePi = {
      id: "pi",
      taskIdPrefix: "pi",
      errorBucketPrefix: "pi",
      defaultModel: "minimax/MiniMax-M2.7",
      defaultSummaryModel: "minimax/MiniMax-M2.7",
      binaryName: "pi",
      listModelsFn: async () => "",
      buildSpawnArgs: (ctx) => ["--model", ctx.model, "--mode", "json", "-p", ctx.prompt],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: (args) => {
        capturedArgs = args;
        const sandboxedDataHome = path.join(args.dataDir, "pi-data");
        return {
          extraRoBinds: [],
          extraRwPairBinds: [],
          sandboxedDataHome,
          sandboxEnv: { PI_CODING_AGENT_DIR: sandboxedDataHome },
        };
      },
    };
    const directory = os.tmpdir();
    const sessionId = "019f90ea-1234-70e0-98dc-6847db316eb4";
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      defaultExecutor: fakePi,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      cacheDir,
      existsFn: (p) => p === realAuthFile,
    });
    mgr.dispatch({ prompt: "resume me", directory, sessionId });
    assert.notEqual(capturedArgs, null, "sandboxAuthFile must be invoked for a sandboxed dispatch");
    assert.equal(capturedArgs.sessionId, sessionId, "sandboxAuthFile must receive the dispatch's sessionId so the bind can scope to that single file");
    assert.equal(capturedArgs.launchDirectory, directory, "sandboxAuthFile must receive the dispatch's launchDirectory so it can compute pi's per-cwd sessions subdirectory");
    assert.equal(typeof capturedArgs.statFn, "function", "sandboxAuthFile must receive a statFn (for the isDirectory guard)");
    assert.equal(typeof capturedArgs.readdirFn, "function", "sandboxAuthFile must receive a readdirFn (for the session file lookup)");
  });

  test("a fresh (non-resume) pi dispatch does not pass a sessionId to sandboxAuthFile, so no sessions bind is added", () => {
    let capturedArgs = null;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-cache-pi-"));
    const fakePi = {
      id: "pi",
      taskIdPrefix: "pi",
      errorBucketPrefix: "pi",
      defaultModel: "minimax/MiniMax-M2.7",
      defaultSummaryModel: "minimax/MiniMax-M2.7",
      binaryName: "pi",
      listModelsFn: async () => "",
      buildSpawnArgs: (ctx) => ["--model", ctx.model, "--mode", "json", "-p", ctx.prompt],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: (args) => {
        capturedArgs = args;
        return {
          extraRoBinds: [],
          extraRwPairBinds: [],
          sandboxedDataHome: path.join(args.dataDir, "pi-data"),
          sandboxEnv: { PI_CODING_AGENT_DIR: path.join(args.dataDir, "pi-data") },
        };
      },
    };
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      defaultExecutor: fakePi,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      cacheDir,
      existsFn: () => false,
    });
    mgr.dispatch({ prompt: "fresh", directory: os.tmpdir() });
    assert.notEqual(capturedArgs, null);
    assert.equal(capturedArgs.sessionId, null, "no sessionId must be threaded for a fresh (non-resume) dispatch");
    // launchDirectory is still passed -- it's needed for the per-cwd encoding
    // even when there's no sessionId, in case the executor wants to use it
    // for diagnostics. The bind itself stays empty because there's no
    // sessionId to resolve a file for.
    assert.equal(typeof capturedArgs.launchDirectory, "string");
  });

  test("the pi sandboxAuthFile call does not add the whole sessions/ pair-bind on the dispatch path -- only the resumed file's bind (regression: scope regression vs. shadowed sandboxed-only sessions)", () => {
    // Earlier round-2 review surfaced a security scope regression: pi's
    // sandboxAuthFile was binding the ENTIRE real sessions/ directory
    // read-write, which let a prompt-injectable sandboxed worker
    // write/delete any session in the user's pi history. After this fix,
    // only the resumed session's specific file is bound. Verify that
    // the bwrap invocation no longer contains a pair-bind of the whole
    // realSessionsDir, even when pi's own sandboxAuthFile decides to
    // bind a single file.
    let captured = null;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-cache-pi-"));
    const realSessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
    const realSessionFile = path.join(realSessionsDir, "--tmp--", "2026-07-23T21-42-41-761Z_019f90ea-1234-70e0-98dc-6847db316eb4.jsonl");
    const realAuthFile = path.join(os.homedir(), ".pi", "agent", "auth.json");
    const fakePi = {
      id: "pi",
      taskIdPrefix: "pi",
      errorBucketPrefix: "pi",
      defaultModel: "minimax/MiniMax-M2.7",
      defaultSummaryModel: "minimax/MiniMax-M2.7",
      binaryName: "pi",
      listModelsFn: async () => "",
      buildSpawnArgs: (ctx) => ["--model", ctx.model, "--mode", "json", "-p", ctx.prompt],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: ({ dataDir, existsFn, statFn, readdirFn, sessionId, launchDirectory }) => {
        const sandboxedDataHome = path.join(dataDir, "pi-data");
        const sandboxedSessionsHome = path.join(sandboxedDataHome, "sessions");
        const extraRwPairBinds = [];
        if (sessionId && launchDirectory && existsFn(realSessionsDir) && statFn(realSessionsDir)?.isDirectory()) {
          const safePath = `--${launchDirectory.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
          const subdir = path.join(realSessionsDir, safePath);
          const entries = readdirFn(subdir);
          for (const entry of entries) {
            if (!entry.endsWith(".jsonl")) continue;
            const underscoreIdx = entry.lastIndexOf("_");
            if (underscoreIdx === -1) continue;
            const fileSessionId = entry.slice(underscoreIdx + 1, -".jsonl".length);
            if (fileSessionId.startsWith(sessionId)) {
              extraRwPairBinds.push([path.join(subdir, entry), path.join(sandboxedSessionsHome, safePath, entry)]);
              break;
            }
          }
        }
        return {
          extraRoBinds: existsFn(realAuthFile) ? [[realAuthFile, path.join(sandboxedDataHome, "auth.json")]] : [],
          extraRwPairBinds,
          sandboxedDataHome,
          sandboxEnv: { PI_CODING_AGENT_DIR: sandboxedDataHome },
        };
      },
    };
    const directory = os.tmpdir();
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      defaultExecutor: fakePi,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      cacheDir,
      // Pretend the host has both a sessions/ dir and the specific file.
      existsFn: (p) => p === realSessionsDir || p === realAuthFile,
      statFn: (p) => (p === realSessionsDir ? { isDirectory: () => true } : null),
      readdirFn: (p) => (p === path.join(realSessionsDir, "--tmp--") ? [path.basename(realSessionFile)] : []),
    });
    mgr.dispatch({ prompt: "resume", directory, sessionId: "019f90ea-1234-70e0-98dc-6847db316eb4" });
    assert.equal(captured.cmd, "bwrap");
    // Look for a --bind whose src is the whole realSessionsDir (not the
    // single file). Pre-fix this would appear; post-fix it must not.
    const pairBindSrcs = [];
    for (let i = 0; i < captured.args.length; i++) {
      if (captured.args[i] === "--bind" && captured.args[i + 1] && captured.args[i + 2]) {
        pairBindSrcs.push(captured.args[i + 1]);
      }
    }
    assert.ok(!pairBindSrcs.includes(realSessionsDir), `the whole sessions directory must not be pair-bound (would re-introduce the scope regression). Saw: ${pairBindSrcs.join(", ")}`);
    // The specific session file IS bound, mapped onto the matching path
    // under the sandboxed sessions tree.
    const fileBindSrcs = pairBindSrcs.filter((p) => p === realSessionFile);
    assert.equal(fileBindSrcs.length, 1, `expected exactly one --bind of the single session file, got ${fileBindSrcs.length} (all pair-bind srcs: ${pairBindSrcs.join(", ")})`);
  });
});

describe("provider-failure classification is task-aware via task.executorId (Task 7: end-to-end pi bucket)", () => {
  test("a pi executor task receiving plain 'No API key found for openai.' settles with failureReason: 'pi_authentication_failed'", async () => {
    const fakePi = {
      id: "pi",
      taskIdPrefix: "pi",
      errorBucketPrefix: "pi",
      defaultModel: "minimax/MiniMax-M2.7",
      defaultSummaryModel: "minimax/MiniMax-M2.7",
      binaryName: "pi",
      listModelsFn: async () => "",
      buildSpawnArgs: () => ["--model", "minimax/MiniMax-M2.7", "--mode", "json", "-p", "hi"],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: () => ({ extraRoBinds: [], sandboxedDataHome: "/tmp/unused", sandboxEnv: {} }),
    };
    const child = fakeChild(9119);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      defaultExecutor: fakePi,
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    // pi exits 0 after printing the plain-text auth failure on stdout;
    // startTask's stdout handler must preserve that line so the watcher
    // can classify it.
    child.stdout.emit("data", Buffer.from("No API key found for openai.\n"));
    child.emit("exit", 0, null);
    // Watcher is async -- give one tick so classifyProviderFailure runs.
    await new Promise((r) => setTimeout(r, 20));
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "pi_authentication_failed");
    assert.equal(s.failureDetail, "No API key found for openai.");
  });
});

describe("bucketFor() (Task 7 review fix: isolate the prefix rule from the classify e2e path)", () => {
  test("opencode's bucket names stay unprefixed", () => {
    assert.equal(bucketFor("opencode", "rate_limited"), "rate_limited");
    assert.equal(bucketFor("opencode", "authentication_failed"), "authentication_failed");
  });

  test("every other prefix gets an underscore-joined prefix", () => {
    assert.equal(bucketFor("pi", "rate_limited"), "pi_rate_limited");
    assert.equal(bucketFor("pi", "executornormalizationerror"), "pi_executornormalizationerror");
  });
});

describe("classifyProviderFailure() honors the binding compatibility contract (Task 7)", () => {
  test("opencode's named buckets stay unprefixed (shipped behavior preserved)", async () => {
    // Each line below is what opencode would emit today; the bucket must
    // come back as the historical string every doc, watcher, and CLI
    // output is keyed off (no `opencode_` prefix).
    const cases = [
      { line: JSON.stringify({ type: "error", message: "rate_limit_exceeded: please retry after 60s" }), bucket: "rate_limited" },
      { line: JSON.stringify({ type: "error", message: "insufficient_quota: out of credits" }), bucket: "payment_required" },
      { line: JSON.stringify({ type: "error", message: "Unauthorized: invalid API key" }), bucket: "authentication_failed" },
      // Raw non-JSON line that matches a known bucket (e.g. a future pi
      // shape leaking into an opencode task -- the prefix-stripping rule
      // must apply on this branch too).
      { line: "No API key found for openai.", bucket: "authentication_failed" },
    ];
    for (const { line, bucket } of cases) {
      const child = fakeChild(9300 + cases.indexOf({ line, bucket }));
      const mgr = makeManager({
        spawnFn: () => child,
        killFn: () => {},
        noOutputTimeoutMs: 60000,
        watchdogPollMs: 5,
      });
      const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
      fs.writeFileSync(mgr.status(dispatched.id).logPath, `${line}\n`);
      await new Promise((r) => setTimeout(r, 40));
      child.emit("exit", null, "SIGTERM");
      assert.equal(
        mgr.status(dispatched.id).failureReason,
        bucket,
        `opencode task with line ${JSON.stringify(line)} must land on bare ${bucket}`
      );
    }
  });

  test("pi's named buckets receive the pi_ prefix so executor-specific failures stay distinguishable", async () => {
    const fakePi = {
      id: "pi",
      taskIdPrefix: "pi",
      errorBucketPrefix: "pi",
      defaultModel: "minimax/MiniMax-M2.7",
      defaultSummaryModel: "minimax/MiniMax-M2.7",
      binaryName: "pi",
      listModelsFn: async () => "",
      buildSpawnArgs: () => ["--model", "minimax/MiniMax-M2.7", "--mode", "json", "-p", "hi"],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: () => ({ extraRoBinds: [], sandboxedDataHome: "/tmp/unused", sandboxEnv: {} }),
    };
    // Each line is the equivalent pi shape for the opencode buckets above;
    // the same regex set must classify it, but with the pi_ prefix added.
    const cases = [
      { line: JSON.stringify({ type: "error", message: "rate_limit_exceeded: please retry after 60s" }), bucket: "pi_rate_limited" },
      { line: JSON.stringify({ type: "error", message: "insufficient_quota: out of credits" }), bucket: "pi_payment_required" },
      { line: JSON.stringify({ type: "error", message: "Unauthorized: invalid API key" }), bucket: "pi_authentication_failed" },
      { line: "No API key found for openai.", bucket: "pi_authentication_failed" },
    ];
    for (let i = 0; i < cases.length; i++) {
      const { line, bucket } = cases[i];
      const child = fakeChild(9400 + i);
      const mgr = makeManager({
        spawnFn: () => child,
        killFn: () => {},
        defaultExecutor: fakePi,
        noOutputTimeoutMs: 60000,
        watchdogPollMs: 5,
      });
      const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
      fs.writeFileSync(mgr.status(dispatched.id).logPath, `${line}\n`);
      await new Promise((r) => setTimeout(r, 40));
      child.emit("exit", null, "SIGTERM");
      assert.equal(
        mgr.status(dispatched.id).failureReason,
        bucket,
        `pi task with line ${JSON.stringify(line)} must land on ${bucket}`
      );
    }
  });

  test("unknown structured error events keep the executor prefix for both opencode and pi", async () => {
    // The third-class-name bucket (constructed from evt.error.name) is
    // a *new* string that has never been shipped unprefixed -- so
    // callers don't depend on a bare name, and the prefix rule stays
    // unconditional on this branch.
    const opencodeEvent = JSON.stringify({
      type: "error",
      error: { name: "SomeNewOpencodeClass", data: { message: "Streaming failed" } },
    });
    const piEvent = JSON.stringify({
      type: "error",
      error: { name: "SomeNewPiClass", data: { message: "Streaming failed" } },
    });
    // opencode (default executor)
    const childOc = fakeChild(9500);
    const mgrOc = makeManager({
      spawnFn: () => childOc,
      killFn: () => {},
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatchedOc = mgrOc.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgrOc.status(dispatchedOc.id).logPath, `${opencodeEvent}\n`);
    await new Promise((r) => setTimeout(r, 40));
    childOc.emit("exit", null, "SIGTERM");
    assert.equal(
      mgrOc.status(dispatchedOc.id).failureReason,
      "opencode_somenewopencodeclass"
    );

    // pi
    const fakePi = {
      id: "pi",
      taskIdPrefix: "pi",
      errorBucketPrefix: "pi",
      defaultModel: "minimax/MiniMax-M2.7",
      defaultSummaryModel: "minimax/MiniMax-M2.7",
      binaryName: "pi",
      listModelsFn: async () => "",
      buildSpawnArgs: () => ["--model", "minimax/MiniMax-M2.7", "--mode", "json", "-p", "hi"],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: () => ({ extraRoBinds: [], sandboxedDataHome: "/tmp/unused", sandboxEnv: {} }),
    };
    const childPi = fakeChild(9501);
    const mgrPi = makeManager({
      spawnFn: () => childPi,
      killFn: () => {},
      defaultExecutor: fakePi,
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatchedPi = mgrPi.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgrPi.status(dispatchedPi.id).logPath, `${piEvent}\n`);
    await new Promise((r) => setTimeout(r, 40));
    childPi.emit("exit", null, "SIGTERM");
    assert.equal(
      mgrPi.status(dispatchedPi.id).failureReason,
      "pi_somenewpiclass"
    );
  });
});

describe("startTask() never lets normalizeLogEvent() throws escape the stdout handler (Task 7 review fix)", () => {
  // The narrow helper used for both the inline and trailing-fragment paths
  // must catch any throw from executor.normalizeLogEvent(parsed), write a
  // canonical structured error event to the log file, and return -- the
  // EventEmitter callback must never propagate the throw up to Node, which
  // would otherwise unhandle it, crash the daemon, and orphan the child.
  // The daemon must not silently continue as if the malformed event had
  // been normalized successfully: a structured error event is observable
  // through classifyProviderFailure so the task settles with a real
  // failureReason, not an unclassified "crashed".
  test("a throwing normalizeLogEvent on the inline path does not crash out of the stdout handler", () => {
    const child = fakeChild();
    const spawnFn = mock.fn(() => child);
    const fakeExecutor = {
      id: "opencode",
      taskIdPrefix: "oc",
      errorBucketPrefix: "opencode",
      defaultModel: "openai/gpt-5.6-luna",
      defaultSummaryModel: "opencode/mimo-v2.5-free",
      binaryName: "opencode",
      listModelsFn: async () => "",
      buildSpawnArgs: () => ["run", "--dir", process.cwd(), "--auto", "--format", "json", "-m", "x", "--", "hi"],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: () => { throw new Error("boom from inside normalizeLogEvent"); },
      sandboxAuthFile: () => ({ extraRoBinds: [], sandboxedDataHome: "/tmp/unused", sandboxEnv: {} }),
    };
    const mgr = makeManager({ spawnFn, defaultExecutor: fakeExecutor });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: process.cwd() });
    const logPath = mgr.status(dispatched.id).logPath;
    // If the throw escapes the EventEmitter callback, the synchronous emit
    // surfaces it as an unhandled exception (and crashes the test process).
    // assert.doesNotThrow proves the callback swallowed the throw.
    assert.doesNotThrow(() => {
      child.stdout.emit("data", Buffer.from('{"type":"event"}\n'));
    });
    child.emit("exit", 0, null);
    const contents = fs.readFileSync(logPath, "utf8");
    // The structured error event reached the log with the executor prefix,
    // so classifyProviderFailure can see it on the trailing-log path.
    assert.ok(contents.includes('"name":"ExecutorNormalizationError"'), "structured ExecutorNormalizationError event must be in the log");
    assert.ok(contents.includes("boom from inside normalizeLogEvent"), "thrown message must be preserved for diagnosis");
  });

  test("a throwing normalizeLogEvent on the trailing-fragment path is also caught", () => {
    const child = fakeChild();
    const spawnFn = mock.fn(() => child);
    const fakeExecutor = {
      id: "opencode",
      taskIdPrefix: "oc",
      errorBucketPrefix: "opencode",
      defaultModel: "openai/gpt-5.6-luna",
      defaultSummaryModel: "opencode/mimo-v2.5-free",
      binaryName: "opencode",
      listModelsFn: async () => "",
      buildSpawnArgs: () => ["run", "--dir", process.cwd(), "--auto", "--format", "json", "-m", "x", "--", "hi"],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: () => { throw new Error("trailing throw"); },
      sandboxAuthFile: () => ({ extraRoBinds: [], sandboxedDataHome: "/tmp/unused", sandboxEnv: {} }),
    };
    const mgr = makeManager({ spawnFn, defaultExecutor: fakeExecutor });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: process.cwd() });
    const logPath = mgr.status(dispatched.id).logPath;
    // Trailing JSON fragment (no terminating newline) -- exercises the
    // .on("end", ...) path. The trailing fragment and inline path share
    // one normalization helper, but the trailing branch is its own
    // emit call site, so it's covered explicitly.
    child.stdout.emit("data", Buffer.from('{"type":"trailing-event"}'));
    assert.doesNotThrow(() => {
      child.stdout.emit("end");
    });
    child.emit("exit", 0, null);
    const contents = fs.readFileSync(logPath, "utf8");
    assert.ok(contents.includes('"name":"ExecutorNormalizationError"'), "trailing-fragment path must also write the structured error event");
    assert.ok(contents.includes("trailing throw"), "thrown message must reach the log from the trailing path");
  });

  test("a task that emits only a normalizing-throw event settles with an executor-prefixed structured failure reason", async () => {
    // End-to-end check: a real executor whose normalizeLogEvent throws on
    // every event must not leave the task unclassified. The structured
    // error event written by the handler carries an unknown error class
    // name (`ExecutorNormalizationError`) which routes through the
    // structured-error fallthrough in classifyProviderFailure, producing
    // an executor-prefixed bucket.
    const child = fakeChild(9610);
    const fakeExecutor = {
      id: "opencode",
      taskIdPrefix: "oc",
      errorBucketPrefix: "opencode",
      defaultModel: "openai/gpt-5.6-luna",
      defaultSummaryModel: "opencode/mimo-v2.5-free",
      binaryName: "opencode",
      listModelsFn: async () => "",
      buildSpawnArgs: () => ["run", "--dir", process.cwd(), "--auto", "--format", "json", "-m", "x", "--", "hi"],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: () => { throw new Error("always throws"); },
      sandboxAuthFile: () => ({ extraRoBinds: [], sandboxedDataHome: "/tmp/unused", sandboxEnv: {} }),
    };
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      defaultExecutor: fakeExecutor,
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    child.stdout.emit("data", Buffer.from('{"type":"event"}\n'));
    child.emit("exit", 0, null);
    // The watcher is async -- give classifyProviderFailure a chance to
    // scan the trailing log and set failureReason before we assert.
    await new Promise((r) => setTimeout(r, 40));
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "opencode_executornormalizationerror");
    assert.ok(s.failureDetail?.includes("always throws"), "failureDetail must carry the original thrown message for diagnosis");
  });
});

describe("boot-failure surfacing (exit non-zero with zero parseable events)", () => {
  test("raw capture from a boot crash becomes failureReason boot_failure with the fatal Error line as detail", () => {
    const child = fakeChild(7301);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      'Warning: No models match pattern "kimi-coding/k2p5"\n' +
        'Error: Extension "/x/y.js" error: Provider y: "baseUrl" is required when defining models.\n'
    );
    child.emit("exit", 1, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail", "exitCode"] });
    assert.equal(r.failureReason, "boot_failure");
    assert.equal(
      r.failureDetail,
      'Error: Extension "/x/y.js" error: Provider y: "baseUrl" is required when defining models.'
    );
    assert.equal(r.exitCode, 1);
    assert.equal(
      mgr.status(dispatched.id).failureReason,
      "boot_failure",
      "the status snapshot (and thus list rows) must carry the reason"
    );
  });

  test("the pi executor gets the prefixed pi_boot_failure bucket", () => {
    const child = fakeChild(7302);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "pi" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "Error: auth.json not found\n");
    child.emit("exit", 1, null);
    assert.equal(mgr.result(dispatched.id, { fields: ["failureReason"] }).failureReason, "pi_boot_failure");
  });

  test("with no Error-prefixed line, the last non-JSON line becomes the detail", () => {
    const child = fakeChild(7303);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "warning: something odd\npanic: runtime exploded\n");
    child.emit("exit", 1, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail"] });
    assert.equal(r.failureReason, "boot_failure");
    assert.equal(r.failureDetail, "panic: runtime exploded");
  });

  test("a crash after real events leaves failureReason to the curated classifier (gate holds)", () => {
    const child = fakeChild(7304);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "step_start", part: {} }) + "\nError: some mid-run stderr noise\n"
    );
    child.emit("exit", 1, null);
    assert.equal(mgr.result(dispatched.id, { fields: ["failureReason"] }).failureReason, null);
  });

  test("exit 0 with only raw text is not classified as a boot failure", () => {
    const child = fakeChild(7305);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "Error: text from a child that still exited 0\n");
    child.emit("exit", 0, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason"] });
    assert.equal(r.status, "done");
    assert.equal(r.failureReason, null);
  });

  test("an event line larger than the 64KiB head window still blocks boot classification (whole-log gate)", () => {
    const child = fakeChild(7306);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    // A long answer is one NDJSON line; a head-only event scan sees a
    // truncated fragment, fails JSON.parse, and would misclassify this
    // working task as a boot crash.
    const longAnswer = JSON.stringify({ type: "text", part: { messageID: "m1", text: "x".repeat(70 * 1024) } });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, longAnswer + "\n");
    child.emit("exit", 1, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail"] });
    assert.equal(r.failureReason, null);
    assert.equal(r.failureDetail, null);
  });

  test("a log whose only content is one oversized raw line past the scan window yields no garbage detail", () => {
    const child = fakeChild(7307);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "Error: " + "x".repeat(70000) + "\n");
    child.emit("exit", 1, null);
    // The scan window starts mid-line; the partial first line is dropped
    // rather than promoted to evidence, so nothing classifiable remains.
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail"] });
    assert.equal(r.failureReason, null);
    assert.equal(r.failureDetail, null);
  });

  test("an oversized noise line before a real Error line still surfaces the real one", () => {
    const child = fakeChild(7308);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "w".repeat(70000) + "\n" + "Error: fatal baseUrl missing\n");
    child.emit("exit", 1, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail"] });
    assert.equal(r.failureReason, "boot_failure");
    assert.equal(r.failureDetail, "Error: fatal baseUrl missing");
  });

  test("unparseable brace-starting stderr is evidence, not an event", () => {
    const child = fakeChild(7309);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    const dump = '{ provider: "x", error: "boom" }';
    fs.writeFileSync(mgr.status(dispatched.id).logPath, dump + "\n");
    child.emit("exit", 1, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail"] });
    assert.equal(r.failureReason, "boot_failure");
    assert.equal(r.failureDetail, dump);
  });

  test("a signal-killed eventless child is not classified as a boot failure", () => {
    const child = fakeChild(7310);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "Warning: something harmless\n");
    child.emit("exit", null, "SIGKILL");
    const s = mgr.status(dispatched.id);
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, null, "an external kill is not a boot failure even during startup");
  });

  test("a watcher-set failureReason survives an eventless non-zero exit (gate does not clobber)", async () => {
    const child = fakeChild(7311);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, 'Error: Extension "/x/y.js" blew up at load\n');
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"), "watchdog must fire on the eventless silence");
    // Graceful-trap exit: non-zero code after the watchdog already named
    // the failure. The boot gate must leave the existing reason alone.
    child.emit("exit", 1, null);
    assert.equal(mgr.result(dispatched.id, { fields: ["failureReason"] }).failureReason, "no_output_timeout");
  });
});
