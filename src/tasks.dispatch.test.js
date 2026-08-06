import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskManager } from "./tasks.js";
import { makeManager, fakeChild, LUNA_MODEL, MIMIMAX_MODEL, UNUSED_TMP, SPAWN_OPENCODE_ENOENT } from "./tasks.test-helpers.js";

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
    assert.deepEqual(captured.args, [
      "run", "--dir", os.tmpdir(), "--auto", "--format", "json",
      "-m", MIMIMAX_MODEL, "--variant", "max", "--", "hello",
    ]);
    assert.equal(captured.opts.cwd, os.tmpdir());
    assert.equal(captured.opts.detached, true);
  });

  test("defaults to openai/gpt-5.6-luna --variant high when no model is given", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    assert.deepEqual(captured.slice(6, 10), ["-m", LUNA_MODEL, "--variant", "high"]);
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

  test("an unrecognized --session-id with no --model still falls back to the hardcoded default", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_never_seen", executor: "opencode" });
    assertDispatchedModel(captured, LUNA_MODEL);
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
      sandboxAuthFile: () => ({ extraRoBinds: [], extraRwPairBinds: [], sandboxedDataHome: UNUSED_TMP, sandboxEnv: {} }),
    };
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); }, defaultExecutor: fakePi });
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
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    // Same literal sessionId string, but the earlier task belongs to a
    // different executor -- resolving executor: "pi" here must not inherit
    // the opencode task's model just because the sessionId string matches.
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: MIMIMAX_MODEL, sessionId: "ses_collide", executor: "opencode" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_collide", executor: "pi" });
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
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-spawn-error-advisor-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-spawn-error-advisor-tmp-"));
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
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-spawn-throw-extract-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-spawn-throw-extract-tmp-"));
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
    const prompt = "x".repeat(96 * 1024);

    mgr.dispatch({ prompt, directory: os.tmpdir() });

    assert.equal(captured.args.includes("-f"), false);
    assert.equal(captured.args[captured.args.length - 1], prompt);
  });

  test("a prompt over the argv-safe threshold is written to a scratch file and attached via -f, never appearing in argv", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args, opts) => { captured = { args, opts }; return fakeChild(); } });
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

  test("TASKFERRY_LOWERDIR_STAGGER_MS=0 disables the gate (tasks launch as fast as rate/concurrency limits already allow)", () => {
    const children = [];
    const originalEnv = process.env.TASKFERRY_LOWERDIR_STAGGER_MS;
    process.env.TASKFERRY_LOWERDIR_STAGGER_MS = "0";
    try {
      const mgr = createTaskManager({
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "axi-stagger-disabled-")),
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
      });

      mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
      const second = mgr.dispatch({ prompt: "second", directory: os.tmpdir() });

      assert.equal(second.status, "running", "with the stagger disabled, the second launch must start synchronously");
      assert.equal(children.length, 2);
    } finally {
      if (originalEnv === undefined) delete process.env.TASKFERRY_LOWERDIR_STAGGER_MS;
      else process.env.TASKFERRY_LOWERDIR_STAGGER_MS = originalEnv;
    }
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
      config,
      sandboxEnabled: false,
      spawnFn: () => {
        const child = fakeChild();
        children.push(child);
        return child;
      },
      killFn: () => {},
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
