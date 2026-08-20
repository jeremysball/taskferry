import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskManager } from "./tasks.js";
import { hashFingerprint, VARIANTS_CACHE_SCHEMA } from "./variants-cache.js";
import { trackManager, makeManager, fakeChild, LUNA_MODEL, MIMIMAX_MODEL, MINIMAX_MODEL, SOL_MODEL, SPAWN_OPENCODE_ENOENT, preserveEnvVars, mkdtempTracked, AXI_TASKS_TEST_DIR, AXI_TASKS_CACHE_DIR, AXI_TASKS_OVERLAY_DIR, makeFakeExecutor } from "./tasks.test-helpers.js";

// The literal suffix appended to every dispatch prompt by outputDirPromptBlock.
// Tests assert on it directly to verify the prompt was augmented; one constant
// keeps the duplicated literal below sonarjs/no-duplicate-string's threshold.
const PERSISTENT_OUTPUT_DIR_HEADING = "\n\n## Persistent output dir";

describe("dispatch() lifecycle, driven through an injected spawnFn (no real opencode process)", () => {
  test("passes the right argv and spawn options through to spawnFn", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => {
        captured = { cmd, args, opts };
        return fakeChild();
      },
    });
    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), model: MIMIMAX_MODEL, variant: "max", executor: "opencode" });
    assert.equal(captured.cmd, "opencode");
    assert.deepEqual(captured.args.slice(0, 11), [
      "run", "--dir", os.tmpdir(), "--auto", "--format", "json",
      "-m", MIMIMAX_MODEL, "--variant", "max", "--",
    ]);
    // taskferry#423: dispatch augments the user prompt with the scratch-dir
    // block so workers know where to drop deliverables that must survive
    // turn end.
    assert.ok(captured.args.at(-1).startsWith("hello" + PERSISTENT_OUTPUT_DIR_HEADING),
      `expected augmented prompt tail, got: ${captured.args.at(-1)}`);
    assert.equal(captured.opts.cwd, os.tmpdir());
    assert.equal(captured.opts.detached, true);
  });

  test("dispatch without --model and without a resolvable --session-id throws", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild(), autoModel: false });
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" }),
      /error: --model is required\nhelp: name the model/
    );
  });

  test("a rejected dispatch (missing --model) does not orphan an output dir on disk (PR #474 review, taskferry#423)", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild(), autoModel: false });
    assert.throws(() => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" }));
    const outputsRoot = path.join(mgr.paths.STATE_DIR, "outputs");
    const leftover = fs.existsSync(outputsRoot) ? fs.readdirSync(outputsRoot) : [];
    assert.deepEqual(leftover, [], `expected no orphan output dirs, found: ${JSON.stringify(leftover)}`);
  });

  test("a dispatch that fails between output-dir creation and queueing does not orphan an output dir on disk (taskferry#510)", () => {
    const throwingTable = { get: () => { throw new Error("injected failure between mkdir and persist"); } };
    const mgr = makeManager({ spawnFn: () => fakeChild(), opencodeVariantsTable: throwingTable });
    assert.throws(() => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode" }), /injected failure/);
    const outputsRoot = path.join(mgr.paths.STATE_DIR, "outputs");
    const leftover = fs.existsSync(outputsRoot) ? fs.readdirSync(outputsRoot) : [];
    assert.deepEqual(leftover, [], `expected no orphan output dirs after injected failure, found: ${JSON.stringify(leftover)}`);
    // The half-queued state must not linger in memory either -- a follow-up
    // dispatch should succeed and create its own dir without seeing the
    // failed id in any provider queue.
    const second = mgr.dispatch({ prompt: "ok", directory: os.tmpdir() });
    assert.ok(second.id);
    assert.ok(fs.existsSync(path.join(outputsRoot, second.id)));
  });

  test("a dispatch that fails inside buildSpawnArgs after the queue shift rolls back scheduler and does not orphan output dir (taskferry#510 follow-up)", () => {
    let builds = 0;
    let spawns = 0;
    const throwingExecutor = makeFakeExecutor({
      buildSpawnArgs: () => {
        builds++;
        if (builds === 1) throw new Error("build failed");
        return [];
      },
    });
    const mgr = makeManager({
      spawnFn: () => { spawns++; return fakeChild(); },
      defaultExecutor: throwingExecutor,
      maxDispatchesPerWindow: 1,
      dispatchWindowMs: 60000,
      maxConcurrentTasks: 10,
    });
    assert.throws(() => mgr.dispatch({ prompt: "first", directory: os.tmpdir() }), /build failed/);
    const outputsRoot = path.join(mgr.paths.STATE_DIR, "outputs");
    const leftover = fs.existsSync(outputsRoot) ? fs.readdirSync(outputsRoot) : [];
    assert.deepEqual(leftover, [], `expected no orphan output dirs after buildSpawnArgs failure, found: ${JSON.stringify(leftover)}`);
    assert.equal(builds, 1);
    assert.equal(spawns, 0, "failed build should not have spawned");
    // Scheduler must be rolled back: a phantom launchTimes entry would keep the
    // next dispatch queued under maxDispatchesPerWindow: 1.
    const second = mgr.dispatch({ prompt: "second", directory: os.tmpdir() });
    assert.equal(mgr.status(second.id).status, "running", "second dispatch should launch immediately, not remain queued due to phantom launchTimes");
    assert.equal(builds, 2);
    assert.equal(spawns, 1);
    assert.ok(fs.existsSync(path.join(outputsRoot, second.id)));
  });

  test("fs.rmSync failure during dispatch cleanup surfaces instead of being swallowed (taskferry#510)", (t) => {
    const mgr = makeManager({ spawnFn: () => fakeChild(), opencodeVariantsTable: { get: () => { throw new Error("injected"); } } });
    const originalRmSync = fs.rmSync;
    t.mock.method(fs, "rmSync", (target, opts) => {
      if (String(target).includes(`${path.sep}outputs${path.sep}`)) throw new Error("rm failed");
      return originalRmSync(target, opts);
    });
    assert.throws(() => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode" }), /rm failed/);
  });

  test("failed dispatch does not strand a queued provider-rate-limited task's timer (taskferry#510 timer rollback)", async () => {
    let spawns = 0;
    let builds = 0;
    const mgr = makeManager({
      spawnFn: () => { spawns++; return fakeChild(); },
      defaultExecutor: makeFakeExecutor({
        buildSpawnArgs: (ctx) => {
          builds++;
          if (ctx.model === "other/bad") throw new Error("build failed");
          return [];
        },
      }),
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 100,
      maxConcurrentTasks: 10,
      lowerdirStaggerMs: 0,
      providerLimits: new Map([["openai", { maxDispatchesPerWindow: 1, maxConcurrentTasks: 10 }]]),
    });
    // First opencode consumes its provider window and launches immediately.
    const first = mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: LUNA_MODEL });
    assert.equal(mgr.status(first.id).status, "running");
    assert.equal(spawns, 1);
    assert.equal(builds, 1);
    // Second opencode hits its provider dispatch window and queues, arming a timer.
    const second = mgr.dispatch({ prompt: "second", directory: os.tmpdir(), model: LUNA_MODEL });
    assert.equal(mgr.status(second.id).status, "queued");
    assert.equal(spawns, 1);
    assert.equal(builds, 1);
    // Third dispatch from an unlimited provider would launch immediately but its
    // build throws. runLaunchQueuedTasks clears the pre-existing timer before the
    // throw, so rollback must re-arm it or the second task strands.
    assert.throws(() => mgr.dispatch({ prompt: "third", directory: os.tmpdir(), model: "other/bad" }), /build failed/);
    assert.equal(mgr.status(second.id).status, "queued");
    assert.equal(spawns, 1);
    assert.equal(builds, 2);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(mgr.status(second.id).status, "running", "queued provider-rate-limited task should launch after timer re-armed");
    assert.equal(spawns, 2);
    assert.equal(builds, 3);
    const outputsRoot = path.join(mgr.paths.STATE_DIR, "outputs");
    const leftover = fs.existsSync(outputsRoot) ? fs.readdirSync(outputsRoot) : [];
    assert.equal(leftover.length, 2, `expected 2 output dirs (first+second), got ${JSON.stringify(leftover)}`);
    assert.ok(fs.existsSync(path.join(outputsRoot, first.id)));
    assert.ok(fs.existsSync(path.join(outputsRoot, second.id)));
  });

  /** @param {string[]} args @param {string} model */
  function assertDispatchedModel(args, model) {
    assert.equal(args[args.indexOf("-m") + 1], model);
  }

  test("resuming with --session-id and no --model inherits the model of the task that owned that session (issue #47)", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: MIMIMAX_MODEL, sessionId: "ses_abc", executor: "opencode" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_abc", executor: "opencode" });
    assertDispatchedModel(captured, MIMIMAX_MODEL);
  });

  test("resuming with --session-id and an explicit --model still uses the explicit model", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: MIMIMAX_MODEL, sessionId: "ses_abc", executor: "opencode" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), model: "opencode/other-model", sessionId: "ses_abc", executor: "opencode" });
    assertDispatchedModel(captured, "opencode/other-model");
  });

  test("an unrecognized --session-id with no --model throws, naming the session id", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    assert.throws(
      () => mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_never_seen", executor: "opencode" }),
      /error: no task found for session id "ses_never_seen" to inherit a model from\nhelp:/
    );
  });

  test("resuming with --session-id and no --executor inherits the executor of the task that owned that session", () => {
    let capturedCmd = null;
    const mgr = makeManager({ spawnFn: (cmd) => { capturedCmd = cmd; return fakeChild(); } });
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: MINIMAX_MODEL, sessionId: "ses_exec", executor: "pi" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_exec" });
    assert.equal(capturedCmd, "pi");
  });

  test("resuming with --session-id and an explicit --executor still uses the explicit executor", () => {
    let capturedCmd = null;
    const mgr = makeManager({ spawnFn: (cmd) => { capturedCmd = cmd; return fakeChild(); } });
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: MINIMAX_MODEL, sessionId: "ses_exec2", executor: "pi" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), model: MINIMAX_MODEL, sessionId: "ses_exec2", executor: "opencode" });
    assert.equal(capturedCmd, "opencode");
  });

  test("a session-inheriting resume that matches defaultExecutor reuses that exact instance instead of building a fresh one", () => {
    // Uses a custom fake as defaultExecutor (not the real piExecutor()) so a
    // regression back to unconditionally calling resolveExecutor(executorId)
    // is observable: that path ignores this injected instance entirely and
    // would spawn with the real pi executor's own buildSpawnArgs instead.
    let captured = null;
    const fakePi = makeFakeExecutor({
      defaultSummaryModel: "fake-pi/marker-model",
      buildSpawnArgs: () => ["--fake-pi-marker"],
    });
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); }, defaultExecutor: fakePi });
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: MINIMAX_MODEL, sessionId: "ses_reuse", executor: "pi" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_reuse" });
    assert.deepEqual(captured, ["--fake-pi-marker"]);
  });

  test("an unrecognized --session-id with no --executor still falls back to the manager's default executor", () => {
    let capturedCmd = null;
    const mgr = makeManager({ spawnFn: (cmd) => { capturedCmd = cmd; return fakeChild(); } });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), model: MINIMAX_MODEL, sessionId: "ses_exec_never_seen" });
    assert.equal(capturedCmd, "pi");
  });

  test("a sessionId that collides across executors does not leak the other executor's model when --executor is given explicitly", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    // Same literal sessionId string, but the earlier task belongs to a
    // different executor -- resolving executor: "pi" here must not inherit
    // the opencode task's model just because the sessionId string matches.
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: MIMIMAX_MODEL, sessionId: "ses_collide", executor: "opencode" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), model: MINIMAX_MODEL, sessionId: "ses_collide", executor: "pi" });
    // pi's buildSpawnArgs splits a slashed model into --provider/--model,
    // unlike opencode's single -m flag -- assert pi's own default model
    // (minimax/MiniMax-M2.7), not the opencode task's MIMIMAX_MODEL.
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

  test("normalizes the task directory before persistence and event emission", () => {
    const root = mkdtempTracked("axi-tasks-directory-");
    const realDirectory = path.join(root, "real");
    const linkedDirectory = path.join(root, "linked");
    fs.mkdirSync(realDirectory);
    fs.symlinkSync(realDirectory, linkedDirectory, "dir");
    const events = [];
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child, onEvent: (event) => events.push(event) });

    const dispatched = mgr.dispatch({ prompt: "hi", directory: linkedDirectory });
    child.emit("exit", 0, null);

    assert.equal(dispatched.directory, realDirectory);
    assert.ok(events.every((event) => event.directory === realDirectory));
    mgr.flushPersist();
    const onDisk = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    assert.equal(onDisk.find((task) => task.id === dispatched.id).directory, realDirectory);
  });
});

describe("dispatch() lifecycle: exit settlement and spawn-failure cleanup", () => {
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

    child.emit("error", new Error(SPAWN_OPENCODE_ENOENT));

    const settled = mgr.status(dispatched.id);
    assert.equal(settled.status, "crashed");
    const full = mgr.result(dispatched.id);
    assert.equal(full.spawnError, SPAWN_OPENCODE_ENOENT);
  });

  test("child.on('error') still runs changeset extraction/cleanup so a spawn-failed task doesn't strand its overlay", () => {
    // The overlay is created during the sandbox block, BEFORE the spawn
    // attempt. If the spawn errors (ENOENT), the overlay would otherwise sit
    // on disk with changesetStatus still "pending" and no extraction ever
    // booked against it -- the spawn-error path must run the same
    // extractChangesetForTask() the exit path does.
    let extractCalls = 0;
    const directory = mkdtempTracked("axi-spawn-error-extract-");
    const overlayTmpRoot = mkdtempTracked("axi-spawn-error-extract-tmp-");
    const child = fakeChild();
    const mgr = makeManager({
      spawnFn: () => child,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: () => { extractCalls++; return { status: 0, stdout: "", stderr: "" }; },
      overlayTmpRoot,
    });

    const dispatched = mgr.dispatch({ prompt: "hi", directory });
    const preErrorCalls = extractCalls;

    child.emit("error", new Error(SPAWN_OPENCODE_ENOENT));

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
    const directory = mkdtempTracked("axi-spawn-error-advisor-");
    const overlayTmpRoot = mkdtempTracked("axi-spawn-error-advisor-tmp-");
    let child = fakeChild();
    const mgr = makeManager({
      spawnFn: (_cmd, _args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "" }),
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
      overlayTmpRoot,
    });

    const advisePromise = mgr.advisor({ prompt: "hi", model: "openai/gpt-5.6-sol", directory });
    child.emit("error", new Error(SPAWN_OPENCODE_ENOENT));
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
    const directory = mkdtempTracked("axi-spawn-throw-extract-");
    const overlayTmpRoot = mkdtempTracked("axi-spawn-throw-extract-tmp-");
    const mgr = makeManager({
      spawnFn: () => { throw new Error("spawn failed synchronously"); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: () => { extractCalls++; return { status: 0, stdout: "", stderr: "" }; },
      overlayTmpRoot,
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
      spawnFn: (_cmd, _args, _opts) => { const child = fakeChild(); setImmediate(() => child.emit("exit", 0, null)); return child; },
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
    const mgr = makeManager({ spawnFn: (_cmd, args, opts) => { captured = { args, opts }; return fakeChild(); } });
    // Pick a size that stays below the threshold even after the #423 scratch-dir
    // tail (~600 bytes) is appended, so the dispatcher still passes the prompt
    // inline rather than spilling it to a temp file.
    const prompt = "x".repeat(96 * 1024 - 1024);

    mgr.dispatch({ prompt, directory: os.tmpdir() });

    assert.equal(captured.args.includes("-f"), false);
    assert.ok(captured.args.at(-1).startsWith(prompt + PERSISTENT_OUTPUT_DIR_HEADING),
      `expected prompt+augmented tail, got prefix ${captured.args.at(-1).slice(0, 64)}`);
  });

  test("a prompt over the argv-safe threshold is written to a scratch file and attached via -f, never appearing in argv", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args, opts) => { captured = { args, opts }; return fakeChild(); } });
    const prompt = "x".repeat(96 * 1024 + 1);

    mgr.dispatch({ prompt, directory: os.tmpdir(), executor: "opencode" });

    assert.ok(captured.args.includes("-f"), "expected -f attachment flag in argv");
    const attachment = captured.args[captured.args.indexOf("-f") + 1];
    // taskferry#423: the file contains the augmented prompt (literal user
    // prompt + scratch-dir tail) -- the augmentation is what the worker
    // actually sees; the file content matches what would have been passed
    // inline if argv were large enough.
    const fileContent = fs.readFileSync(attachment, "utf8");
    assert.ok(fileContent.startsWith(prompt + PERSISTENT_OUTPUT_DIR_HEADING),
      `expected file to start with prompt + scratch-dir tail, got prefix: ${fileContent.slice(0, 96)}`);
    assert.equal(fs.statSync(attachment).mode & 0o777, 0o600);
    assert.ok(!captured.args.includes(prompt), "the raw oversized prompt must never be passed as a single argv element");
    // A short instruction still follows "--" so opencode has a message, per its own CLI contract.
    assert.equal(captured.args[captured.args.length - 2], "--");
    assert.match(captured.args[captured.args.length - 1], /attached/i);
  });

  test("the scratch prompt file is deleted once the task settles", () => {
    const child = fakeChild();
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args, opts) => { captured = { args, opts }; return child; } });
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
    const mgr = makeManager({ spawnFn: (_cmd, args, opts) => { captured = { args, opts }; return child; } });
    const prompt = "x".repeat(96 * 1024 + 1);

    mgr.dispatch({ prompt, directory: os.tmpdir() });
    const attachment = captured.args[captured.args.indexOf("-f") + 1];

    child.emit("error", new Error(SPAWN_OPENCODE_ENOENT));

    assert.equal(fs.existsSync(attachment), false);
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

describe("per-provider concurrency and dispatch-rate limits", () => {
  test("a provider at its own dispatch-rate cap is skipped so another provider's queued task still launches (round-robin, taskferry#235)", () => {
    const children = [];
    const mgr = makeManager({
      maxConcurrentTasks: 10,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
      providerLimits: { "opencode-go": { maxConcurrentTasks: 1 } },
      spawnFn: () => {
        const c = fakeChild(9200 + children.length);
        children.push(c);
        return c;
      },
    });

    const first = mgr.dispatch({ prompt: "p0", directory: os.tmpdir(), model: MIMIMAX_MODEL });
    const second = mgr.dispatch({ prompt: "p1", directory: os.tmpdir(), model: MIMIMAX_MODEL });
    const third = mgr.dispatch({ prompt: "p2", directory: os.tmpdir(), model: LUNA_MODEL });

    assert.equal(mgr.status(first.id).status, "running", "opencode-go's first task launches");
    assert.equal(mgr.status(second.id).status, "queued", "opencode-go's second task is capped at maxConcurrentTasks: 1");
    assert.equal(mgr.status(third.id).status, "running", "openai's task launches despite opencode-go's queue being blocked");

    children[0].emit("exit", 0, null);
    assert.equal(mgr.status(second.id).status, "running", "freeing opencode-go's own slot lets its queued task launch");
  });

  test("a Map-shaped providerLimits using the documented config key names is normalized, not passed through unnormalized", () => {
    const children = [];
    const callerMap = new Map([["opencode-go", { maxConcurrentTasks: 1 }]]);
    const mgr = makeManager({
      maxConcurrentTasks: 10,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
      providerLimits: callerMap,
      spawnFn: () => {
        const c = fakeChild(9300 + children.length);
        children.push(c);
        return c;
      },
    });

    // Pre-fix the Map was returned verbatim, so dispatchLimit stayed undefined
    // and providerCanLaunch's `launchTimes.length < undefined` was always
    // false -- the provider queued forever instead of launching at all.
    const first = mgr.dispatch({ prompt: "p0", directory: os.tmpdir(), model: MIMIMAX_MODEL });
    assert.equal(mgr.status(first.id).status, "running", "an omitted maxDispatchesPerWindow means unlimited, not zero");

    const second = mgr.dispatch({ prompt: "p1", directory: os.tmpdir(), model: MIMIMAX_MODEL });
    assert.equal(mgr.status(second.id).status, "queued", "the Map's maxConcurrentTasks: 1 is still honored");

    // The caller's Map is copied, not aliased: mutating it must not retune a
    // live scheduler.
    callerMap.set("opencode-go", { maxConcurrentTasks: 99 });
    assert.equal(mgr.status(second.id).status, "queued", "mutating the caller's Map does not change live limits");

    // Drain so the scheduler stops re-arming its concurrency poll timer.
    children[0].emit("exit", 0, null);
    assert.equal(mgr.status(second.id).status, "running", "freeing the slot lets the queued task launch");
  });

  test("a provider's maxDispatchesPerWindow queues its next task until the dispatch window passes (taskferry#235)", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const children = [];
      const mgr = makeManager({
        maxConcurrentTasks: 10,
        maxDispatchesPerWindow: 10,
        dispatchWindowMs: 60000,
        providerLimits: { "opencode-go": { maxDispatchesPerWindow: 2 } },
        spawnFn: () => {
          const c = fakeChild(9250 + children.length);
          children.push(c);
          return c;
        },
      });

      const first = mgr.dispatch({ prompt: "p0", directory: os.tmpdir(), model: MIMIMAX_MODEL });
      const second = mgr.dispatch({ prompt: "p1", directory: os.tmpdir(), model: MIMIMAX_MODEL });
      const third = mgr.dispatch({ prompt: "p2", directory: os.tmpdir(), model: MIMIMAX_MODEL });

      assert.equal(mgr.status(first.id).status, "running", "opencode-go's first task launches");
      assert.equal(mgr.status(second.id).status, "running", "opencode-go's second task launches within its 2-per-window budget");
      assert.equal(mgr.status(third.id).status, "queued", "opencode-go's third task is capped at maxDispatchesPerWindow: 2");
      assert.equal(children.length, 2);

      t.mock.timers.tick(60000);

      assert.equal(mgr.status(third.id).status, "running", "the dispatch window passing lets the queued task launch");
      assert.equal(children.length, 3);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("global maxConcurrentTasks still caps total launches even when every provider has headroom under its own limit", () => {
    const children = [];
    const mgr = makeManager({
      maxConcurrentTasks: 1,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
      providerLimits: { "opencode-go": { maxConcurrentTasks: 5 }, openai: { maxConcurrentTasks: 5 } },
      spawnFn: () => {
        const c = fakeChild(9300 + children.length);
        children.push(c);
        return c;
      },
    });

    const first = mgr.dispatch({ prompt: "p0", directory: os.tmpdir(), model: MIMIMAX_MODEL });
    const second = mgr.dispatch({ prompt: "p1", directory: os.tmpdir(), model: LUNA_MODEL });

    assert.equal(mgr.status(first.id).status, "running");
    assert.equal(mgr.status(second.id).status, "queued", "global maxConcurrentTasks: 1 still binds across providers");

    children[0].emit("exit", 0, null);
    assert.equal(mgr.status(second.id).status, "running", "freeing the global slot lets the other provider's task launch");
  });

  test("an unconfigured provider is unlimited on its own axis (only the global ceiling applies)", () => {
    const children = [];
    const mgr = makeManager({
      maxConcurrentTasks: 4,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
      providerLimits: { "opencode-go": { maxConcurrentTasks: 1 } },
      spawnFn: () => {
        const c = fakeChild(9400 + children.length);
        children.push(c);
        return c;
      },
    });

    const dispatched = [
      mgr.dispatch({ prompt: "p0", directory: os.tmpdir(), model: LUNA_MODEL }),
      mgr.dispatch({ prompt: "p1", directory: os.tmpdir(), model: LUNA_MODEL }),
      mgr.dispatch({ prompt: "p2", directory: os.tmpdir(), model: LUNA_MODEL }),
    ];
    for (const d of dispatched) assert.equal(mgr.status(d.id).status, "running", "openai has no providerLimits entry, so only the global cap (4) applies");
  });

  test("cancelling a queued task removes it from its own provider's queue, not another provider's", () => {
    const children = [];
    const mgr = makeManager({
      maxConcurrentTasks: 1,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
      spawnFn: () => {
        const c = fakeChild(9500 + children.length);
        children.push(c);
        return c;
      },
    });

    mgr.dispatch({ prompt: "p0", directory: os.tmpdir(), model: MIMIMAX_MODEL });
    const queuedA = mgr.dispatch({ prompt: "p1", directory: os.tmpdir(), model: MIMIMAX_MODEL });
    const queuedB = mgr.dispatch({ prompt: "p2", directory: os.tmpdir(), model: LUNA_MODEL });

    const cancelled = mgr.cancel(queuedA.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(mgr.status(queuedB.id).status, "queued", "cancelling opencode-go's queued task must not touch openai's queued task");

    children[0].emit("exit", 0, null);
    assert.equal(mgr.status(queuedB.id).status, "running", "openai's queued task still launches once the global slot frees");
  });
});

describe("lowerdir launch stagger (taskferry#318: bwrap overlay-mount EBUSY under concurrent launches)", () => {
  // Allow a few ms of scheduling jitter below the nominal stagger: the
  // assertion cares about "roughly staggered, not simultaneous", not
  // millisecond-exact spacing, and a strict >= threshold flakes under load.
  const JITTER_TOLERANCE_MS = 15;

  test("two queued tasks launch at least lowerdirStaggerMs apart, never simultaneously", async () => {
    const children = [];
    const mgr = makeManager({
      lowerdirStaggerMs: 80,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
      maxConcurrentTasks: 10,
      spawnFn: () => {
        const child = fakeChild(6000 + children.length);
        children.push({ child, at: Date.now() });
        return child;
      },
    });

    mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
    mgr.dispatch({ prompt: "second", directory: os.tmpdir() });

    assert.equal(children.length, 1, "the second launch must not start synchronously alongside the first");

    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(children.length, 2);
    assert.ok(
      children[1].at - children[0].at >= 80 - JITTER_TOLERANCE_MS,
      `expected roughly >= 80ms between launches, got ${children[1].at - children[0].at}ms`
    );
  });

  test("three or more queued tasks each launch at least lowerdirStaggerMs after the previous one", async () => {
    const children = [];
    const mgr = makeManager({
      lowerdirStaggerMs: 60,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
      maxConcurrentTasks: 10,
      spawnFn: () => {
        const child = fakeChild(6100 + children.length);
        children.push({ child, at: Date.now() });
        return child;
      },
    });

    mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
    mgr.dispatch({ prompt: "second", directory: os.tmpdir() });
    mgr.dispatch({ prompt: "third", directory: os.tmpdir() });

    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(children.length, 3);
    assert.ok(children[1].at - children[0].at >= 60 - JITTER_TOLERANCE_MS);
    assert.ok(children[2].at - children[1].at >= 60 - JITTER_TOLERANCE_MS);
  });

  test("TASKFERRY_LOWERDIR_STAGGER_MS=0 disables the gate (tasks launch as fast as rate/concurrency limits already allow)", (t) => {
    const children = [];
    preserveEnvVars(t, ["TASKFERRY_LOWERDIR_STAGGER_MS"]);
    process.env.TASKFERRY_LOWERDIR_STAGGER_MS = "0";
    const mgr = trackManager(createTaskManager({
      stateDir: mkdtempTracked("axi-stagger-disabled-"),
      sandboxEnabled: false,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
      maxConcurrentTasks: 10,
      spawnFn: () => {
        const child = fakeChild(6200 + children.length);
        children.push(child);
        return child;
      },
      killFn: () => {},
    }));

    mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
    const second = mgr.dispatch({ prompt: "second", directory: os.tmpdir() });

    assert.equal(second.status, "running", "with the stagger disabled, the second launch must start synchronously");
    assert.equal(children.length, 2);
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
    children[0].emit("error", new Error(SPAWN_OPENCODE_ENOENT));
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

});

describe("config file precedence (maxConcurrentTasks)", () => {
  function managerWithLimit(t, { env, config }) {
    const stateDir = mkdtempTracked("axi-cfg-precedence-");
    const children = [];
    preserveEnvVars(t, ["TASKFERRY_MAX_CONCURRENT_TASKS"]);
    if (env === undefined) delete process.env.TASKFERRY_MAX_CONCURRENT_TASKS;
    else process.env.TASKFERRY_MAX_CONCURRENT_TASKS = env;
    const manager = trackManager(createTaskManager({
      stateDir,
      config,
      sandboxEnabled: false,
      spawnFn: () => {
        const child = fakeChild();
        children.push(child);
        return child;
      },
      killFn: () => {},
    }));
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
    const mgr = managerWithLimit(t, { env: void 0, config: { maxConcurrentTasks: 1 } });
    mgr.dispatch({ prompt: "a", directory: process.cwd(), model: "m" });
    const second = mgr.dispatch({ prompt: "b", directory: process.cwd(), model: "m" });
    assert.equal(mgr.status(second.id).status, "queued");
  });

  test("built-in default used when both env and config are unset", (t) => {
    const mgr = managerWithLimit(t, { env: void 0, config: {} });
    for (let i = 0; i < 4; i++) mgr.dispatch({ prompt: `p${i}`, directory: process.cwd(), model: "m" });
    const fifth = mgr.dispatch({ prompt: "p5", directory: process.cwd(), model: "m" });
    assert.equal(mgr.status(fifth.id).status, "queued");
  });
});

describe("dispatch() class tag persistence and summary surfacing", () => {
  test("dispatch persists the class tag and surfaces it in the summary", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), class: "implementer" });
    assert.equal(dispatched.class, "implementer");
    const status = mgr.status(dispatched.id);
    assert.equal(status.class, "implementer");
  });

  test("dispatch without a class tag omits it from the summary", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.equal("class" in dispatched, false);
  });
});

describe("dispatch() prompt augmentation from .taskferry.toml", () => {
  const DISPATCH_PROMPT = "Fix the bug";
  const TOML_CHECK_BODY = `check = "npm run check"\n`;
  const TOML_FILENAME = ".taskferry.toml";
  const VERIFICATION_MARKER = "Verification (required)";

  test("appends the verification block to a dispatch's prompt when .taskferry.toml declares a check command", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-dispatch-checkcmd-"));
    fs.writeFileSync(path.join(dir, TOML_FILENAME), TOML_CHECK_BODY);
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: DISPATCH_PROMPT, directory: dir, executor: "opencode", model: MIMIMAX_MODEL, variant: "max" });
    // opencode's spawn ends with `-- "<prompt>"`; the trailing positional is the augmented prompt.
    assert.equal(captured.at(-2), "--");
    const spawnedPrompt = /** @type {string} */ (captured.at(-1));
    assert.match(spawnedPrompt, /Fix the bug/);
    assert.match(spawnedPrompt, /## Verification \(required\)/);
    assert.match(spawnedPrompt, /npm run check/);
  });

  test("does not inject the verification block for advisor dispatches, but does inject the output-dir block", () => {
    // Advisor dispatches are sandbox-required by ADR 0001 (the dispatch path's
    // pre-spawn plan refuses to launch an advisor without sandbox+overlay --
    // resolvedSpawnPlan() throws "advisor dispatch requires overlay-gated
    // writes" otherwise). Mirror the existing advisor tests' full bwrap mock
    // so the spawnFn actually fires and the trailing prompt is observable.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-advisor-checkcmd-"));
    fs.writeFileSync(path.join(dir, TOML_FILENAME), TOML_CHECK_BODY);
    let captured = null;
    const mgr = makeManager({
      spawnFn: (_cmd, args) => { captured = args; return fakeChild(); },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });
    mgr.advisor({ prompt: "Review this", directory: dir, model: SOL_MODEL, executor: "opencode" });
    // Advisor's argv is the bwrap invocation; the trailing positional keeps
    // the user prompt with no verification block (advisor role never gates
    // on projectConfig.check) but WITH the persistent-output-dir block --
    // advisor dispatches get the exact same outputDir/TASKFERRY_OUTPUT_DIR
    // allocation as a dispatch (taskferry#423), and the prompt block is now
    // gated on that allocation existing, not on role (taskferry#504: the
    // old role-only gate left the allocation silently undiscoverable to the
    // worker).
    const spawnedPrompt = /** @type {string} */ (captured.at(-1));
    assert.match(spawnedPrompt, /Review this/);
    assert.ok(/## Persistent output dir/.test(spawnedPrompt), "advisor prompt must contain the persistent-output-dir block");
    assert.ok(!captured.join(" ").includes(VERIFICATION_MARKER));
  });

  test("does not inject the verification block for --no-overlay dispatches", () => {
    // Plan's global constraint: --no-overlay dispatches never get prompt injection
    // (no overlay worktree to gate against). Mirror the in-block-hook dispatch's
    // setup but pass noOverlay: true; the trailing positional must be the
    // literal prompt, with no verification block anywhere in the spawned argv.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-nooverlay-checkcmd-"));
    fs.writeFileSync(path.join(dir, TOML_FILENAME), TOML_CHECK_BODY);
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: DISPATCH_PROMPT, directory: dir, noOverlay: true, executor: "opencode", model: MIMIMAX_MODEL, variant: "max" });
    assert.equal(captured.at(-2), "--");
    // taskferry#423: scratch-dir block is always appended (independent of the
    // verification block, which IS gated on overlay); the literal user prompt
    // still comes first.
    assert.ok(captured.at(-1).startsWith(DISPATCH_PROMPT + PERSISTENT_OUTPUT_DIR_HEADING),
      `expected DISPATCH_PROMPT + scratch-dir tail, got: ${captured.at(-1)}`);
    assert.ok(!captured.join(" ").includes(VERIFICATION_MARKER));
  });

  test("no .taskferry.toml: dispatch prompt is unmodified, no verification block appended", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-no-checkcmd-"));
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    const dispatched = mgr.dispatch({ prompt: DISPATCH_PROMPT, directory: dir, executor: "opencode", model: MIMIMAX_MODEL, variant: "max" });
    // opencode's trailing positional is the literal prompt + scratch-dir tail.
    // No .taskferry.toml means no verification block, but the scratch-dir
    // tail is independent of project config (taskferry#423).
    assert.equal(captured.at(-2), "--");
    assert.ok(captured.at(-1).startsWith(DISPATCH_PROMPT + PERSISTENT_OUTPUT_DIR_HEADING),
      `expected DISPATCH_PROMPT + scratch-dir tail, got: ${captured.at(-1)}`);
    assert.ok(!captured.join(" ").includes(VERIFICATION_MARKER));
    // Prompt is well under the 200-char preview threshold, so promptTotalChars stays unset.
    assert.equal("promptTotalChars" in dispatched, false);
    assert.equal(dispatched.promptPreview, DISPATCH_PROMPT);
  });
});

describe("dispatch() omitted --variant resolution (defaultVariant: highest)", () => {
  const THINKING_FLAG = "--thinking";

  test("omitted --variant on pi requests max (highest), by default", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: MIMIMAX_MODEL, executor: "pi" });
    assert.ok(captured.includes(THINKING_FLAG));
    assert.equal(captured[captured.indexOf(THINKING_FLAG) + 1], "max");
  });

  test("omitted --variant on opencode resolves the model's ranked-highest cached variant", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (_cmd, args) => { captured = args; return fakeChild(); },
      opencodeVariantsTable: new Map([[LUNA_MODEL, ["low", "high", "max"]]]),
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode" });
    assert.deepEqual(captured.slice(captured.indexOf("-m"), captured.indexOf("--")), ["-m", LUNA_MODEL, "--variant", "max"]);
    // taskferry#423: the trailing positional is the literal prompt + scratch-dir tail.
    assert.ok(captured.at(-1).startsWith("hi" + PERSISTENT_OUTPUT_DIR_HEADING),
      `expected 'hi' + scratch-dir tail, got: ${captured.at(-1)}`);
  });

  test("omitted --variant on opencode with no cache entry for the model sends no flag", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); }, opencodeVariantsTable: new Map() });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode" });
    assert.equal(captured.includes("--variant"), false);
  });

  test("explicit --variant is never reinterpreted, even against a cached table", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (_cmd, args) => { captured = args; return fakeChild(); },
      opencodeVariantsTable: new Map([[LUNA_MODEL, ["low", "high", "max"]]]),
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, variant: "low", executor: "opencode" });
    assert.equal(captured[captured.indexOf("--variant") + 1], "low");
  });

  test("a resumed session with no --variant inherits the resumed task's own variant, not a fresh highest", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: MIMIMAX_MODEL, variant: "low", sessionId: "ses_v", executor: "opencode" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_v", executor: "opencode" });
    assert.equal(captured[captured.indexOf("--variant") + 1], "low");
  });

  test("a configured defaultVariant of a concrete level is requested verbatim when --variant is omitted", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); }, defaultVariant: "medium" });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: MIMIMAX_MODEL, executor: "pi" });
    assert.equal(captured[captured.indexOf(THINKING_FLAG) + 1], "medium");
  });
});

describe("defaultVariant validation applies to TASKFERRY_DEFAULT_VARIANT and rawOptions too, not just config.json", () => {
  // Regression: config.json's defaultVariant field is validated during
  // loadConfig()'s parseAndValidateConfig(), but createTaskManager()'s own
  // rawOptions.defaultVariant/TASKFERRY_DEFAULT_VARIANT resolution used to
  // skip that check entirely, so an invalid value there would silently
  // reach resolveVariant() and resolve to "send no flag" instead of failing
  // loudly at construction time.
  test("an invalid TASKFERRY_DEFAULT_VARIANT env var throws at manager construction", (t) => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    preserveEnvVars(t, ["TASKFERRY_DEFAULT_VARIANT"]);
    process.env.TASKFERRY_DEFAULT_VARIANT = "medium-plus";
    assert.throws(() => createTaskManager({
      stateDir,
      cacheDir: mkdtempTracked(AXI_TASKS_CACHE_DIR),
      sandboxEnabled: false,
      overlayEnabled: false,
      overlayTmpRoot: mkdtempTracked(AXI_TASKS_OVERLAY_DIR),
      lowerdirStaggerMs: 0,
      spawnFn: () => fakeChild(),
      killFn: () => {},
    }), /error: defaultVariant must be one of highest, off, minimal, low, medium, high, xhigh, max \(got "medium-plus"\)/);
  });

  test("an invalid rawOptions.defaultVariant (a programmatic caller) throws too", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    assert.throws(() => createTaskManager({
      stateDir,
      cacheDir: mkdtempTracked(AXI_TASKS_CACHE_DIR),
      sandboxEnabled: false,
      overlayEnabled: false,
      overlayTmpRoot: mkdtempTracked(AXI_TASKS_OVERLAY_DIR),
      lowerdirStaggerMs: 0,
      spawnFn: () => fakeChild(),
      killFn: () => {},
      defaultVariant: "bogus-level",
    }), /error: defaultVariant must be one of highest, off, minimal, low, medium, high, xhigh, max \(got "bogus-level"\)/);
  });
});

describe("opencode variants cache lookup uses the per-dispatch caller env, not the daemon's own process.env", () => {
  // Regression: resolveOpencodeVariants() used to read process.env directly,
  // so a caller-forwarded env override (a different credential/base URL for
  // this one dispatch) had no effect on which cached model catalog was
  // consulted -- the daemon's own env always won. FAKE_TF_TEST_API_KEY is
  // a made-up name unlikely to already be set on any real host's env.
  const FAKE_KEY_NAME = "FAKE_TF_TEST_API_KEY";

  // The daemon's effective env for a dispatch is process.env layered with
  // the caller's per-dispatch override (buildSanitizedEnvironment()'s merge
  // in tasks.js), not the override object alone -- fingerprint the fixture
  // the same way, or a real *_API_KEY already present in this test runner's
  // own process.env would make the fixture's fingerprint never match.
  function writeRealVariantsCache(cacheDir, dispatchEnv, models) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "opencode-variants.json"), JSON.stringify({
      schema: VARIANTS_CACHE_SCHEMA,
      generatedAt: new Date().toISOString(),
      fingerprint: hashFingerprint({ ...process.env, ...dispatchEnv }),
      models: Object.fromEntries(models),
    }));
  }

  test("a dispatch-scoped env override that matches the cache's fingerprint resolves the variant", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    const defaultCacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const dispatchEnv = { [FAKE_KEY_NAME]: "dispatch-scoped-value" };
    writeRealVariantsCache(defaultCacheDir, dispatchEnv, new Map([[LUNA_MODEL, ["low", "high", "max"]]]));
    let captured = null;
    const mgr = trackManager(createTaskManager({
      stateDir,
      cacheDir: defaultCacheDir,
      sandboxEnabled: false,
      overlayEnabled: false,
      overlayTmpRoot: mkdtempTracked(AXI_TASKS_OVERLAY_DIR),
      lowerdirStaggerMs: 0,
      spawnFn: (_cmd, args) => { captured = args; return fakeChild(); },
      killFn: () => {},
    }));
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode", env: dispatchEnv });
    assert.equal(captured[captured.indexOf("--variant") + 1], "max");
  });

  test("without the matching env override, the cache misses and no --variant flag is sent (proves process.env alone isn't consulted)", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    const defaultCacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const dispatchEnv = { [FAKE_KEY_NAME]: "dispatch-scoped-value" };
    writeRealVariantsCache(defaultCacheDir, dispatchEnv, new Map([[LUNA_MODEL, ["low", "high", "max"]]]));
    let captured = null;
    const mgr = trackManager(createTaskManager({
      stateDir,
      cacheDir: defaultCacheDir,
      sandboxEnabled: false,
      overlayEnabled: false,
      overlayTmpRoot: mkdtempTracked(AXI_TASKS_OVERLAY_DIR),
      lowerdirStaggerMs: 0,
      spawnFn: (_cmd, args) => { captured = args; return fakeChild(); },
      killFn: () => {},
    }));
    // No `env` override on this dispatch -- the real daemon process.env
    // never has FAKE_TF_TEST_API_KEY set, so the fingerprint can't match.
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode" });
    assert.equal(captured.includes("--variant"), false);
  });
});

describe("opencode variants cache warm-up", () => {
  test("createTaskManager() triggers a refresh when the cache is stale, using the opencode executor's listModelVariantsFn", async () => {
    let called = 0;
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    const defaultCacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    trackManager(createTaskManager({
      stateDir,
      cacheDir: defaultCacheDir,
      sandboxEnabled: false,
      overlayEnabled: false,
      overlayTmpRoot: mkdtempTracked(AXI_TASKS_OVERLAY_DIR),
      lowerdirStaggerMs: 0,
      spawnFn: () => fakeChild(),
      killFn: () => {},
      listModelsFn: async () => "",
      opencodeListModelVariantsFn: async () => { called++; return new Map(); },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(called, 1);
  });

  test("warm-up writes the cache under the daemon's effective env (envFileVars included), so an omitted --variant resolves the model's cached highest", async () => {
    // Regression: warmAndScheduleVariantsCacheRefresh() fingerprinted the
    // cache against raw process.env, but resolveOpencodeVariants() reads it
    // under the sanitized merge (process.env + envFileVars + caller env).
    // When envFileVars overrides a fingerprint-relevant var, the warm's file
    // never matched a dispatch's read -- every dispatch was a cache miss and
    // the highest-thinking default silently never applied. FAKE_TF_TEST_API_KEY
    // is unlikely to already be set on any real host's env.
    const FAKE_KEY_NAME = "FAKE_TF_TEST_API_KEY";
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    const defaultCacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const cacheFile = path.join(defaultCacheDir, "opencode-variants.json");
    let captured = null;
    const mgr = trackManager(createTaskManager({
      stateDir,
      cacheDir: defaultCacheDir,
      sandboxEnabled: false,
      overlayEnabled: false,
      overlayTmpRoot: mkdtempTracked(AXI_TASKS_OVERLAY_DIR),
      lowerdirStaggerMs: 0,
      spawnFn: (_cmd, args) => { captured = args; return fakeChild(); },
      killFn: () => {},
      // envFile config whose contents override a credential var the
      // fingerprint reads (the effective spawn env for every dispatch).
      envFileVars: { [FAKE_KEY_NAME]: "from-env-file" },
      opencodeListModelVariantsFn: async () => new Map([[LUNA_MODEL, ["low", "high", "max"]]]),
    }));
    // The daemon warms the cache in the background; wait for the file rather
    // than racing the async refresh.
    for (let i = 0; i < 100 && !fs.existsSync(cacheFile); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(cacheFile), true, "warm should have written the variants cache");
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode" });
    assert.equal(captured[captured.indexOf("--variant") + 1], "max");
  });
});
