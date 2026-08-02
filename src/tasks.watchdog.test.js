import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskManager } from "./tasks.js";
import { makeManager, fakeChild, DEFAULT_SUMMARY_MODEL, FINAL_ANSWER, STATUS_DONE_RE, QUOTA_ERROR } from "./tasks.test-helpers.js";

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
      { type: "text", part: { messageID: "m1", text: FINAL_ANSWER } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    const settled = mgr.status(dispatched.id);
    assert.equal(settled.status, "done");
    assert.equal("incomplete" in settled, false);
    assert.equal("finalMarker" in settled, false);
    assert.equal(mgr.result(dispatched.id).message, FINAL_ANSWER);
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
});

describe("output-completeness check at settlement time: --require-final-marker gating", () => {
  function writeLog(logPath, lines) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, lines.map((line) => JSON.stringify(line)).join("\n"));
  }

  test("--require-final-marker with a matching message leaves the task as a normal done", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({
      prompt: "hi",
      directory: os.tmpdir(),
      finalMarker: STATUS_DONE_RE,
    });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "Status: DONE" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    const settled = mgr.status(dispatched.id);
    assert.equal(settled.status, "done");
    assert.equal("incomplete" in settled, false);
    assert.equal(settled.finalMarker, STATUS_DONE_RE);
    const r = mgr.result(dispatched.id, { fields: ["message", "incomplete", "finalMarker"] });
    assert.equal(r.incomplete, null);
    assert.equal(r.finalMarker, STATUS_DONE_RE);
    assert.equal(r.message, "Status: DONE");
  });

  test("--require-final-marker with a non-matching message flags the task incomplete", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({
      prompt: "hi",
      directory: os.tmpdir(),
      finalMarker: STATUS_DONE_RE,
    });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "I forgot to follow the contract" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    const settled = mgr.status(dispatched.id);
    assert.equal(settled.status, "done");
    assert.equal(settled.incomplete, true);
    assert.equal(settled.finalMarker, STATUS_DONE_RE);
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
      finalMarker: STATUS_DONE_RE,
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
});

describe("output-completeness check at settlement time: validation, originSessionId, daemon restart", () => {
  function writeLog(logPath, lines) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, lines.map((line) => JSON.stringify(line)).join("\n"));
  }

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
      finalMarker: STATUS_DONE_RE,
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
    assert.equal(reloaded.finalMarker, STATUS_DONE_RE);
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
    fs.writeFileSync(mgr.status(dispatched.id).logPath, JSON.stringify({ type: "error", message: QUOTA_ERROR }) + "\n");
    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", 1, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail"] });
    assert.equal(r.failureReason, "payment_required");
    assert.equal(r.failureDetail, QUOTA_ERROR);
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
