import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskManager } from "./tasks.js";
import {
  makeManager,
  makeFakeOpencodeExecutor,
  trackManager,
  mkdtempTracked,
  fakeChild,
  baseTask,
  TOOL_CALLS,
  TASKS_STATE_FILE,
  AXI_TASKS_OVERLAY_DIR,
} from "./tasks.test-helpers.js";

function readRecord(stateDir, taskId) {
  const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, TASKS_STATE_FILE), "utf8"));
  return onDisk.find((t) => t.id === taskId);
}

function stepFinish({ messageID = "m1", reason = "stop", tokens = { total: 10 }, cost = 0.001 } = {}) {
  return JSON.stringify({ type: "step_finish", part: { messageID, reason, tokens, cost } });
}

describe("accounting persistence", () => {
  test("a settled task's summed cost/tokens are stored on its tasks.json record", () => {
    const child = fakeChild();
    const mgr = makeManager({
      spawnFn: () => child,
      defaultExecutor: makeFakeOpencodeExecutor({ buildSpawnArgs: () => ["run", "--format", "json"] }),
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    child.stdout.emit("data", Buffer.from(
      [
        JSON.stringify({ type: "text", part: { messageID: "m1", text: "one" } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: TOOL_CALLS, tokens: { total: 100, input: 10, output: 90 }, cost: 0.001 } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m2", reason: "stop", tokens: { total: 200, input: 20, output: 180 }, cost: 0.002 } }),
      ].join("\n") + "\n"
    ));
    child.emit("exit", 0, null);

    assert.equal(mgr.status(dispatched.id).status, "done");
    mgr.flushPersist();

    const record = readRecord(mgr._stateDir, dispatched.id);
    assert.equal(record.cost, 0.003);
    assert.deepEqual(record.tokens, { total: 300, input: 30, output: 270 });
  });

  test("a task whose log has no step_finish stores null cost/tokens", () => {
    const child = fakeChild();
    const mgr = makeManager({
      spawnFn: () => child,
      defaultExecutor: makeFakeOpencodeExecutor({ buildSpawnArgs: () => ["run", "--format", "json"] }),
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "text", part: { messageID: "m1", text: "partial" } }) + "\n"));
    child.emit("exit", 0, null);

    assert.equal(mgr.status(dispatched.id).status, "done");
    mgr.flushPersist();

    const record = readRecord(mgr._stateDir, dispatched.id);
    assert.equal(record.cost, null);
    assert.equal(record.tokens, null);
  });

  test("an explicit zero cost is stored as zero, not as an absent value", () => {
    const child = fakeChild();
    const mgr = makeManager({
      spawnFn: () => child,
      defaultExecutor: makeFakeOpencodeExecutor({ buildSpawnArgs: () => ["run", "--format", "json"] }),
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    child.stdout.emit("data", Buffer.from(stepFinish({ cost: 0 }) + "\n"));
    child.emit("exit", 0, null);
    mgr.flushPersist();

    const record = readRecord(mgr._stateDir, dispatched.id);
    assert.equal(record.cost, 0);
    assert.notEqual(record.cost, null);
  });

  test("result() reads persisted accounting even when the log is gone", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "missing.ndjson"), cost: 0.007, tokens: { total: 42 } })],
    });
    const r = mgr.result("t1");
    assert.equal(r.cost, 0.007);
    assert.deepEqual(r.tokens, { total: 42 });
  });

  test("result() falls back to parsing the log for legacy records without stored accounting", () => {
    const log = [
      JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop", tokens: { total: 7 }, cost: 0.0007 } }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    const r = mgr.result("t1");
    assert.equal(r.cost, 0.0007);
    assert.deepEqual(r.tokens, { total: 7 });
  });

  test("reading a legacy record materializes its accounting on the record", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": stepFinish({ tokens: { total: 7 }, cost: 0.0007 }) },
    });
    assert.equal(readRecord(mgr._stateDir, "t1").cost, undefined);

    mgr.result("t1");
    mgr.flushPersist();

    const record = readRecord(mgr._stateDir, "t1");
    assert.equal(record.cost, 0.0007);
    assert.deepEqual(record.tokens, { total: 7 });
  });

  test("re-reading a materialized record reports the same total instead of summing it again", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": stepFinish({ tokens: { total: 7 }, cost: 0.0007 }) },
    });
    assert.equal(mgr.result("t1").cost, 0.0007);
    assert.equal(mgr.result("t1").cost, 0.0007);
    mgr.flushPersist();

    assert.equal(readRecord(mgr._stateDir, "t1").cost, 0.0007);
  });

  test("a transcript that grew after the record was stamped is re-accounted", () => {
    const child = fakeChild();
    const mgr = makeManager({
      spawnFn: () => child,
      defaultExecutor: makeFakeOpencodeExecutor({ buildSpawnArgs: () => ["run", "--format", "json"] }),
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    child.stdout.emit("data", Buffer.from(stepFinish({ cost: 0.001 }) + "\n"));
    child.emit("exit", 0, null);
    mgr.flushPersist();
    assert.equal(readRecord(mgr._stateDir, dispatched.id).cost, 0.001);

    // A child that outlived its daemon keeps writing to the same transcript.
    fs.appendFileSync(path.join(mgr._stateDir, "logs", `${dispatched.id}.ndjson`), stepFinish({ messageID: "m2", cost: 0.005 }) + "\n");

    assert.equal(mgr.result(dispatched.id).cost, 0.006);
    mgr.flushPersist();
    assert.equal(readRecord(mgr._stateDir, dispatched.id).cost, 0.006);
  });

  test("a readable transcript with no usage does not erase the record's stored totals", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson"), cost: 0.007, tokens: { total: 42 } })],
      logs: { "t1.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "no usage here" } }) + "\n" },
    });
    assert.equal(mgr.result("t1").cost, 0.007);
    mgr.flushPersist();
    assert.equal(readRecord(mgr._stateDir, "t1").cost, 0.007);
  });

  test("a readable transcript with no usage on a legacy record materializes null cost/tokens", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "no usage here" } }) + "\n" },
    });
    assert.equal(mgr.result("t1").cost, null);
    mgr.flushPersist();
    const record = readRecord(mgr._stateDir, "t1");
    assert.equal(record.cost, null);
    assert.equal(record.tokens, null);
  });

  test("a settled task's accounting survives a daemon restart", () => {
    const child = fakeChild();
    const mgr = makeManager({
      spawnFn: () => child,
      defaultExecutor: makeFakeOpencodeExecutor({ buildSpawnArgs: () => ["run", "--format", "json"] }),
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    child.stdout.emit("data", Buffer.from(stepFinish({ cost: 0.001 }) + "\n"));
    child.emit("exit", 0, null);
    mgr.flushPersist();

    // The transcript is gone (deleted from disk); only the record's own
    // accounting remains, which is what the restarted daemon has to report.
    fs.rmSync(path.join(mgr._stateDir, "logs", `${dispatched.id}.ndjson`), { force: true });

    const restarted = trackManager(createTaskManager({
      stateDir: mgr._stateDir,
      cacheDir: mgr._cacheDir,
      overlayTmpRoot: mkdtempTracked(AXI_TASKS_OVERLAY_DIR),
      sandboxEnabled: false,
      overlayEnabled: false,
      taskRetentionDays: 0,
      spawnFn: () => fakeChild(4243),
      killFn: () => {},
    }));

    assert.equal(restarted.result(dispatched.id).cost, 0.001);
  });
});
