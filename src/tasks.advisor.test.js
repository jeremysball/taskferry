import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManager, fakeChild, SOL_MODEL, MINIMAX_MODEL, SHARD_QUESTION, SHARD_ANSWER, LONG_QUESTION, OCCUPYING_TASK, CONTINUE_FLAG } from "./tasks.test-helpers.js";

describe("advisor(): validation, completion, and timeouts", () => {
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
      spawnFn: (_cmd, args, _opts) => {
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
      prompt: SHARD_QUESTION,
      directory: os.tmpdir(),
      model: SOL_MODEL,
      variant: "max",
      timeoutMs: 5000,
      executor: "opencode",
    });

    // Advisor dispatches are overlay-gated under bwrap (ADR 0001), so the
    // captured args are the bwrap invocation; the executor command follows "--".
    // The trailing positional is the user prompt plus the persistent-output-dir
    // block: advisor dispatches get the same scratch dir as a regular dispatch
    // (taskferry#423), and the prompt block is now injected whenever an
    // outputDir was allocated, not gated by role (taskferry#504).
    const executorArgs = captured.slice(captured.indexOf("--") + 1);
    assert.deepEqual(executorArgs.slice(0, -1), [
      "opencode",
      "run", "--dir", os.tmpdir(), "--auto", "--format", "json",
      "-m", SOL_MODEL, "--variant", "max", "--",
    ]);
    const spawnedPrompt = executorArgs.at(-1);
    assert.match(spawnedPrompt, new RegExp(`^${SHARD_QUESTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(spawnedPrompt, /## Persistent output dir/);

    // Simulate opencode writing its result log, then exiting.
    const row1 = mgr.list().tasks[0];
    const dispatched = { id: row1.id, logPath: path.join(mgr.paths.LOG_DIR, `${row1.id}.ndjson`) };
    fs.writeFileSync(
      dispatched.logPath,
      [
        JSON.stringify({ type: "text", part: { messageID: "m1", text: SHARD_ANSWER } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop", tokens: { total: 50 }, cost: 0.002 } }),
        JSON.stringify({ sessionID: "ses_new" }),
      ].join("\n")
    );
    child.emit("exit", 0, null);

    const advised = await advisorPromise;
    assert.equal(advised.status, "done");
    assert.equal(advised.message, SHARD_ANSWER);
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
      prompt: SHARD_QUESTION,
      directory: os.tmpdir(),
      model: MINIMAX_MODEL,
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
          JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: SHARD_ANSWER }, message: { responseId: "m1" } }),
          JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", responseId: "m1", usage: { total: 50, cost: { total: 0.002 } } }] }),
        ].join("\n") + "\n"
      )
    );
    child.emit("exit", 0, null);

    const advised = await advisorPromise;
    assert.equal(advised.status, "done");
    assert.equal(advised.message, SHARD_ANSWER);
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
      prompt: LONG_QUESTION,
      directory: os.tmpdir(),
      model: SOL_MODEL,
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
    mgr.dispatch({ prompt: OCCUPYING_TASK, directory: os.tmpdir(), model: SOL_MODEL });

    const advisorPromise = mgr.advisor({
      prompt: LONG_QUESTION,
      directory: os.tmpdir(),
      model: SOL_MODEL,
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
      prompt: LONG_QUESTION,
      directory: os.tmpdir(),
      model: SOL_MODEL,
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
      () => mgr.advisor({ prompt: "", directory: os.tmpdir(), model: SOL_MODEL }),
      (err) => {
        assert.match(err.message, /taskferry advisor requires a non-empty prompt string/);
        assert.equal(err.message.includes("taskferry dispatch"), false);
        return true;
      }
    );
  });
});

describe("advisor(): timeout, queueing, and no-timeout shape", () => {
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
      prompt: LONG_QUESTION,
      directory: os.tmpdir(),
      model: SOL_MODEL,
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

describe("advisor(): session resume, expiry, and crash surfacing", () => {
  test("a fresh session_id within the TTL is passed through to dispatch (--continue --session)", async () => {
    const child = fakeChild();
    let captured = null;
    const mgr = makeManager({
      advisorSessionTtlMs: 60000,
      spawnFn: (_cmd, args) => {
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
    const firstPromise = mgr.advisor({ prompt: "q1", directory: os.tmpdir(), model: SOL_MODEL });
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
      model: SOL_MODEL,
      sessionId: "ses_live",
    });
    assert.equal(captured.includes(CONTINUE_FLAG), true);
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
      spawnFn: (_cmd, args) => {
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
      model: SOL_MODEL,
      sessionId: "ses_long_gone",
    });

    assert.equal(captured.includes(CONTINUE_FLAG), false);

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

    const advisorPromise = mgr.advisor({ prompt: "hi", directory: os.tmpdir(), model: SOL_MODEL });
    child.emit("exit", 1, null);

    const advised = await advisorPromise;
    assert.equal(advised.status, "crashed");
    assert.equal(advised.exitCode, 1);
  });
});
