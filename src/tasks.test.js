import { test, describe, mock } from "node:test";
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
function makeManager({ tasksFixture = [], logs = {}, spawnFn, killFn, listModelsFn, verifySummaryAgentFn, maxDispatchesPerWindow, dispatchWindowMs, advisorSessionTtlMs, maxConcurrentTasks, noOutputTimeoutMs, postOutputNoOutputTimeoutMs, watchdogPollMs, maxWaitMs, keySlotsSpec, providerKeyEnvName, summaryKeySlot, summaryProviderKeyEnvName, onEvent } = {}) {
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
    ...(onEvent != null ? { onEvent } : {}),
    ...(maxDispatchesPerWindow != null ? { maxDispatchesPerWindow } : {}),
    ...(dispatchWindowMs != null ? { dispatchWindowMs } : {}),
    ...(advisorSessionTtlMs != null ? { advisorSessionTtlMs } : {}),
    ...(maxConcurrentTasks != null ? { maxConcurrentTasks } : {}),
    ...(noOutputTimeoutMs != null ? { noOutputTimeoutMs } : {}),
    ...(postOutputNoOutputTimeoutMs != null ? { postOutputNoOutputTimeoutMs } : {}),
    ...(watchdogPollMs != null ? { watchdogPollMs } : {}),
    ...(maxWaitMs != null ? { maxWaitMs } : {}),
    ...(keySlotsSpec != null ? { keySlotsSpec } : {}),
    ...(providerKeyEnvName != null ? { providerKeyEnvName } : {}),
    ...(summaryKeySlot != null ? { summaryKeySlot } : {}),
    ...(summaryProviderKeyEnvName != null ? { summaryProviderKeyEnvName } : {}),
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

describe("persistTask() durability across concurrent manager instances", () => {
  test("two manager instances writing concurrently both keep their own task record", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-test-"));
    const mgrA = createTaskManager({
      stateDir,
      spawnFn: () => fakeChild(1001),
      killFn: () => { throw new Error("not used"); },
    });
    const mgrB = createTaskManager({
      stateDir,
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
    const mgr = createTaskManager({ stateDir, spawnFn: () => fakeChild(), killFn: () => {} });
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
    assert.deepEqual(mgr.result(dispatched.id, { fields: ["failureReason", "keySlot"] }), {
      taskId: dispatched.id,
      status: "crashed",
      failureReason: "no_output_timeout",
      keySlot: null,
    });
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

describe("provider-usage-exhaustion detection", () => {
  test("a rate-limit diagnostic in the log stops the child early with failureReason provider_usage_exhausted", async () => {
    const child = fakeChild(7101);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000, // long enough that only exhaustion detection could trigger this
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "rate_limit_exceeded: please retry after 60s" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "provider_usage_exhausted");
  });

  test("an unterminated provider exhaustion diagnostic stops the child early", async () => {
    const child = fakeChild(7104);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "rate limit exceeded");

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "provider_usage_exhausted");
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
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
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
    assert.equal(s.failureReason, "provider_usage_exhausted");
  });

  test("ordinary crash text is not misclassified as provider exhaustion", () => {
    const child = fakeChild(7102);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "TypeError: cannot read property 'x' of undefined\n");
    child.emit("exit", 1, null);
    assert.equal(mgr.status(dispatched.id).status, "crashed");
    assert.equal(mgr.status(dispatched.id).failureReason, null);
  });

  test("a type:\"text\" narration event that legitimately mentions rate limits, quotas, or 429 is not misclassified as provider exhaustion (GLM-5.2 review finding)", async () => {
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

  test("with no timeout_ms, against an injected small maxWaitMs, still returns the bounded 'still running' + resumable session_id shape", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child, maxWaitMs: 30 });

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
    assert.match(advised.note, /taskferry_poll or taskferry_advisor again with session_id/);
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

describe("key slots (summary tasks)", () => {
  test("a configured summary key slot is injected without exposing any key-slot source variables", async (t) => {
    process.env.AXI_TEST_SUMMARY_PRIMARY = "sk-summary-secret";
    process.env.AXI_TEST_SUMMARY_BACKUP = "sk-backup-secret";
    t.after(() => {
      delete process.env.AXI_TEST_SUMMARY_PRIMARY;
      delete process.env.AXI_TEST_SUMMARY_BACKUP;
    });
    let capturedEnv = null;
    let modelsEnv = null;
    const mgr = makeManager({
      tasksFixture: (logDir) => [{ ...baseTask({ id: "src1", status: "done", logPath: path.join(logDir, "src1.ndjson") }) }],
      logs: { "src1.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the thing" } }) + "\n" },
      spawnFn: (cmd, args, opts) => { capturedEnv = opts.env; return fakeChild(); },
      listModelsFn: (env) => {
        modelsEnv = env;
        return "opencode-go/deepseek-v4-flash\n";
      },
      keySlotsSpec: "summary-slot:AXI_TEST_SUMMARY_PRIMARY,backup:AXI_TEST_SUMMARY_BACKUP",
      summaryKeySlot: "summary-slot",
      summaryProviderKeyEnvName: "DEEPSEEK_API_KEY",
    });
    await mgr.summarize("src1");
    assert.equal(capturedEnv.DEEPSEEK_API_KEY, "sk-summary-secret");
    assert.equal("AXI_TEST_SUMMARY_PRIMARY" in capturedEnv, false);
    assert.equal("AXI_TEST_SUMMARY_BACKUP" in capturedEnv, false);
    assert.equal(modelsEnv.DEEPSEEK_API_KEY, "sk-summary-secret");
    assert.equal("AXI_TEST_SUMMARY_PRIMARY" in modelsEnv, false);
    assert.equal("AXI_TEST_SUMMARY_BACKUP" in modelsEnv, false);
  });

  test("an unset summary key slot source variable fails the summary request before spawning", async () => {
    delete process.env.AXI_TEST_SUMMARY_UNSET;
    const mgr = makeManager({
      tasksFixture: (logDir) => [{ ...baseTask({ id: "src1", status: "done", logPath: path.join(logDir, "src1.ndjson") }) }],
      logs: { "src1.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the thing" } }) + "\n" },
      spawnFn: () => { throw new Error("must not spawn"); },
      keySlotsSpec: "summary-slot:AXI_TEST_SUMMARY_UNSET",
      summaryKeySlot: "summary-slot",
      summaryProviderKeyEnvName: "DEEPSEEK_API_KEY",
    });
    await assert.rejects(() => mgr.summarize("src1"), /error: summary key slot "summary-slot" source variable AXI_TEST_SUMMARY_UNSET is not set/);
  });

  test("summarize without a summary key_slot keeps the ambient summary provider key when a slot's source var shares its name (GLM-5.2 review of PR #23, finding 4)", async (t) => {
    process.env.DEEPSEEK_API_KEY = "sk-default-summary-secret";
    process.env.AXI_TEST_SUMMARY_BACKUP = "sk-backup-secret";
    t.after(() => {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.AXI_TEST_SUMMARY_BACKUP;
    });
    let capturedEnv = null;
    const mgr = makeManager({
      tasksFixture: (logDir) => [{ ...baseTask({ id: "src1", status: "done", logPath: path.join(logDir, "src1.ndjson") }) }],
      logs: { "src1.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the thing" } }) + "\n" },
      spawnFn: (cmd, args, opts) => { capturedEnv = opts.env; return fakeChild(); },
      listModelsFn: () => "opencode-go/deepseek-v4-flash\n",
      keySlotsSpec: "primary:DEEPSEEK_API_KEY,backup:AXI_TEST_SUMMARY_BACKUP",
      summaryProviderKeyEnvName: "DEEPSEEK_API_KEY",
    });
    await mgr.summarize("src1");
    assert.equal(capturedEnv.DEEPSEEK_API_KEY, "sk-default-summary-secret");
    assert.equal("AXI_TEST_SUMMARY_BACKUP" in capturedEnv, false);
  });
});

describe("key slots (dispatch)", () => {
  test("dispatch with an unconfigured key_slot throws before spawning anything", () => {
    const mgr = makeManager({ spawnFn: () => { throw new Error("must not spawn"); } });
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), keySlot: "primary" }),
      /error: key_slot given but TASKFERRY_PROVIDER_KEY_ENV is not configured/
    );
  });

  test("dispatch with a key_slot name not in the registry throws before spawning anything", () => {
    const mgr = makeManager({
      spawnFn: () => { throw new Error("must not spawn"); },
      keySlotsSpec: "primary:SOME_SOURCE_VAR",
      providerKeyEnvName: "OPENCODE_GO_API_KEY",
    });
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), keySlot: "backup" }),
      /error: unknown key_slot: backup/
    );
  });

  test("dispatch with a configured key_slot whose source env var is unset throws before spawning anything", () => {
    delete process.env.AXI_TEST_UNSET_KEY_SOURCE;
    const mgr = makeManager({
      spawnFn: () => { throw new Error("must not spawn"); },
      keySlotsSpec: "primary:AXI_TEST_UNSET_KEY_SOURCE",
      providerKeyEnvName: "OPENCODE_GO_API_KEY",
    });
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), keySlot: "primary" }),
      /error: key_slot "primary" source variable AXI_TEST_UNSET_KEY_SOURCE is not set/
    );
  });

  test("a valid key_slot passes only the configured target env var to the spawned child, and only the slot name is persisted", (t) => {
    process.env.AXI_TEST_KEY_PRIMARY = "sk-super-secret-value";
    process.env.AXI_TEST_KEY_BACKUP = "sk-backup-secret-value";
    t.after(() => {
      delete process.env.AXI_TEST_KEY_PRIMARY;
      delete process.env.AXI_TEST_KEY_BACKUP;
    });
    let capturedOpts = null;
    const child = fakeChild();
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { capturedOpts = opts; return child; },
      keySlotsSpec: "primary:AXI_TEST_KEY_PRIMARY,backup:AXI_TEST_KEY_BACKUP",
      providerKeyEnvName: "OPENCODE_GO_API_KEY",
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), keySlot: "primary" });
    assert.equal(dispatched.keySlot, "primary");
    assert.equal(capturedOpts.env.OPENCODE_GO_API_KEY, "sk-super-secret-value");
    assert.equal("AXI_TEST_KEY_PRIMARY" in capturedOpts.env, false);
    assert.equal("AXI_TEST_KEY_BACKUP" in capturedOpts.env, false);

    const onDisk = fs.readFileSync(mgr.paths.TASKS_FILE, "utf8");
    assert.ok(!onDisk.includes("sk-super-secret-value"), "the raw key value must never reach tasks.json");
    assert.ok(!onDisk.includes("sk-backup-secret-value"), "other raw key values must never reach tasks.json");
    assert.ok(onDisk.includes('"keySlot": "primary"'));

    child.emit("exit", 0, null);
    assert.equal(mgr.result(dispatched.id).keySlot, "primary");
  });

  test("dispatch without key_slot still strips every configured source variable", (t) => {
    process.env.AXI_TEST_KEY_PRIMARY = "sk-primary-secret-value";
    process.env.AXI_TEST_KEY_BACKUP = "sk-backup-secret-value";
    t.after(() => {
      delete process.env.AXI_TEST_KEY_PRIMARY;
      delete process.env.AXI_TEST_KEY_BACKUP;
    });
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, _opts) => { capturedOpts = _opts; return fakeChild(); },
      keySlotsSpec: "primary:AXI_TEST_KEY_PRIMARY,backup:AXI_TEST_KEY_BACKUP",
      providerKeyEnvName: "OPENCODE_GO_API_KEY",
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    assert.ok(capturedOpts.env);
    assert.equal("AXI_TEST_KEY_PRIMARY" in capturedOpts.env, false);
    assert.equal("AXI_TEST_KEY_BACKUP" in capturedOpts.env, false);
    assert.equal("OPENCODE_GO_API_KEY" in capturedOpts.env, false);
  });

  test("dispatch without key_slot keeps the ambient provider key when a slot's source var shares its name (GLM-5.2 review finding)", (t) => {
    // The documented setup registers the server's default key as a slot too
    // (TASKFERRY_PROVIDER_KEY_ENV and one slot's source both named
    // OPENCODE_GO_API_KEY) so it can also be picked explicitly. Without the
    // fix, environmentWithoutKeySlotSources() strips that variable even when
    // no key_slot was requested, leaving the child with no key at all.
    process.env.OPENCODE_GO_API_KEY = "sk-default-secret-value";
    process.env.AXI_TEST_KEY_BACKUP = "sk-backup-secret-value";
    t.after(() => {
      delete process.env.OPENCODE_GO_API_KEY;
      delete process.env.AXI_TEST_KEY_BACKUP;
    });
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); },
      keySlotsSpec: "primary:OPENCODE_GO_API_KEY,backup:AXI_TEST_KEY_BACKUP",
      providerKeyEnvName: "OPENCODE_GO_API_KEY",
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    assert.equal(capturedOpts.env.OPENCODE_GO_API_KEY, "sk-default-secret-value");
    assert.equal("AXI_TEST_KEY_BACKUP" in capturedOpts.env, false);
  });
});
