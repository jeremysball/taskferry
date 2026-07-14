import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskManager } from "./tasks.js";

// Builds an isolated task manager backed by a temp state dir and, unless
// overridden, fake spawnFn/killFn so no test ever touches a real `opencode`
// process or a real OS signal. `tasksFixture`/`logs` seed tasks.json and
// logs/ *before* the manager loads them (createTaskManager's loadPersisted()
// runs synchronously in the constructor, same as the old module-level code
// did at import time). `tasksFixture` may be an array or `(logDir) => array`
// for fixtures whose logPath needs to point inside the real log dir.
function makeManager({ tasksFixture = [], logs = {}, spawnFn, killFn, listModelsFn, verifySummaryAgentFn, maxDispatchesPerWindow, dispatchWindowMs, advisorSessionTtlMs } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-test-"));
  const logDir = path.join(stateDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const fixtureTasks = typeof tasksFixture === "function" ? tasksFixture(logDir) : tasksFixture;
  fs.writeFileSync(path.join(stateDir, "tasks.json"), JSON.stringify(fixtureTasks, null, 2));
  for (const [name, content] of Object.entries(logs)) {
    fs.writeFileSync(path.join(logDir, name), content);
  }

  return createTaskManager({
    stateDir,
    spawnFn: spawnFn ?? (() => { throw new Error("spawnFn was not injected for this test"); }),
    killFn: killFn ?? (() => { throw new Error("killFn was not injected for this test"); }),
    listModelsFn: listModelsFn ?? (() => "opencode-go/deepseek-v4-flash\n"),
    verifySummaryAgentFn: verifySummaryAgentFn ?? (async () => {}),
    ...(maxDispatchesPerWindow != null ? { maxDispatchesPerWindow } : {}),
    ...(dispatchWindowMs != null ? { dispatchWindowMs } : {}),
    ...(advisorSessionTtlMs != null ? { advisorSessionTtlMs } : {}),
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

describe("dispatch() input validation (throws before spawning anything)", () => {
  test("rejects a missing prompt", () => {
    const mgr = makeManager();
    assert.throws(() => mgr.dispatch({ directory: "/tmp" }), /error: prompt is required/);
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
    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), model: "opencode-go/minimax-m3", variant: "max" });
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
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.deepEqual(captured.slice(6, 10), ["-m", "openai/gpt-5.6-luna", "--variant", "high"]);
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

  test("a clean exit(0) settles the task to 'done'", () => {
    const child = fakeChild(555);
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.equal(dispatched.status, "running");
    assert.equal(dispatched.pid, 555);
    assert.match(dispatched.next, /taskferry_poll or taskferry_status/);

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

describe("unknown task_id (status/cancel/wait/result share one error path)", () => {
  test("status() throws with an actionable help line", () => {
    const mgr = makeManager();
    assert.throws(
      () => mgr.status("nope"),
      /error: unknown task_id: nope\nhelp: run taskferry_list to see valid task ids/
    );
  });

  test("cancel() throws the same formatted error", () => {
    const mgr = makeManager();
    assert.throws(() => mgr.cancel("nope"), /error: unknown task_id: nope/);
  });

  test("result() throws the same formatted error", () => {
    const mgr = makeManager();
    assert.throws(() => mgr.result("nope"), /error: unknown task_id: nope/);
  });

  test("poll() throws synchronously (not a rejected promise) for an unknown id", () => {
    const mgr = makeManager();
    assert.throws(() => mgr.poll("nope"), /error: unknown task_id: nope/);
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
      spawnFn: (cmd, args, opts) => {
        captured = args;
        return child;
      },
    });

    const advisorPromise = mgr.advisor({
      prompt: "how should I shard this counter?",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
      variant: "max",
      timeout_ms: 5000,
    });

    assert.deepEqual(captured, [
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

  test("returns status: running with a task_id and session_id when the timeout elapses first", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });

    const advisorPromise = mgr.advisor({
      prompt: "long question",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
      timeout_ms: 20,
    });
    const row2 = mgr.list().tasks[0];
    const dispatched = { id: row2.id, logPath: path.join(mgr.paths.LOG_DIR, `${row2.id}.ndjson`) };
    fs.writeFileSync(dispatched.logPath, JSON.stringify({ sessionID: "ses_midrun" }));

    const advised = await advisorPromise;
    assert.equal(advised.status, "running");
    assert.equal(advised.task_id, dispatched.id);
    assert.equal(advised.session_id, "ses_midrun");
    assert.match(advised.note, /taskferry_poll or taskferry_advisor again with session_id/);
  });

  test("when the timeout elapses before opencode has written a session id, the note points at taskferry_poll with task_id instead of fabricating a session_id", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });

    const advisorPromise = mgr.advisor({
      prompt: "long question",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
      timeout_ms: 20,
    });
    // No log file written at all -- opencode hasn't emitted a session id yet.

    const advised = await advisorPromise;
    assert.equal(advised.status, "running");
    assert.equal(advised.session_id, null);
    assert.match(advised.note, /taskferry_poll with task_id/);
    assert.equal(advised.note.includes('session_id ""'), false);
  });

  test("a dispatch validation error is reported under taskferry_advisor, not taskferry_dispatch", async () => {
    const mgr = makeManager();
    await assert.rejects(
      () => mgr.advisor({ prompt: "", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" }),
      (err) => {
        assert.match(err.message, /taskferry_advisor requires a non-empty prompt string/);
        assert.equal(err.message.includes("taskferry_dispatch"), false);
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
      session_id: "ses_live",
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
    });

    const advisorPromise = mgr.advisor({
      prompt: "resuming after a nap",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
      session_id: "ses_long_gone",
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
    const mgr = makeManager({ spawnFn: () => child });

    const advisorPromise = mgr.advisor({ prompt: "hi", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
    child.emit("exit", 1, null);

    const advised = await advisorPromise;
    assert.equal(advised.status, "crashed");
    assert.equal(advised.exitCode, 1);
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

  test("rows use the minimal 4-field schema, not the full detail object", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1" })] });
    const row = mgr.list().tasks[0];
    assert.deepEqual(Object.keys(row).sort(), ["id", "model", "startedAt", "status"]);
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
});

describe("summarize()", () => {
  test("uses an isolated tool-denied agent and private attachment", async () => {
    let captured;
    let verifiedEnv;
    const child = fakeChild();
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Investigated the issue" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      spawnFn: (command, args, options) => {
        captured = { command, args, options };
        return child;
      },
      verifySummaryAgentFn: async (env) => { verifiedEnv = env; },
    });

    const summary = await mgr.summarize("source", { maxWords: 150 });
    assert.equal(captured.command, "opencode");
    assert.ok(captured.args.includes("--pure"));
    assert.ok(captured.args.includes("--agent"));
    assert.equal(captured.args.includes("--auto"), false);
    const attachment = captured.args[captured.args.indexOf("-f") + 1];
    assert.equal(fs.statSync(attachment).mode & 0o777, 0o600);
    assert.equal(captured.options.cwd, mgr.paths.SUMMARY_DIR);
    assert.match(captured.options.env.OPENCODE_CONFIG_CONTENT, /"\*":"deny"/);
    assert.equal(verifiedEnv.OPENCODE_CONFIG_CONTENT, captured.options.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(summary.summaryTask.status, "running");

    child.emit("exit", 0, null);
    assert.equal(fs.existsSync(attachment), false);
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

  test("does not launch when the effective summary agent isolation check fails", async () => {
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "progress" } });
    let spawned = false;
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      spawnFn: () => { spawned = true; return fakeChild(); },
      verifySummaryAgentFn: async () => { throw new Error("bash is enabled"); },
    });
    await assert.rejects(mgr.summarize("source"), /summary agent isolation check failed/);
    assert.equal(spawned, false);
    assert.equal(mgr.list().tasks.length, 1);
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
});
