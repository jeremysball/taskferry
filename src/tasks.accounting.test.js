import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  makeManager,
  makeFakeOpencodeExecutor,
  fakeChild,
  baseTask,
  dispatchFakeTask,
  readPersistedTask,
  stepFinishEvent,
  waitFor,
  LUNA_MODEL,
} from "./tasks.test-helpers.js";

const MISSING_LOG = "missing.ndjson";
const READ_NEVER_WRITES = "a read must not write a total onto the record";

describe("accounting persistence", () => {
  test("a settled task's summed cost/tokens are stored on its tasks.json record", () => {
    const { mgr, task } = dispatchFakeTask({
      stdout: [
        JSON.stringify({ type: "text", part: { messageID: "m1", text: "one" } }),
        stepFinishEvent({ messageID: "m1", tokens: { total: 100, input: 10, output: 90 }, cost: 0.001 }),
        stepFinishEvent({ messageID: "m2", tokens: { total: 200, input: 20, output: 180 }, cost: 0.002 }),
      ],
    });

    assert.equal(mgr.status(task.id).status, "done");

    const record = readPersistedTask(mgr, task.id);
    assert.equal(record.cost, 0.003);
    assert.deepEqual(record.tokens, { total: 300, input: 30, output: 270 });
  });

  test("the stamped totals match an independent parse of the transcript", () => {
    const { mgr, task } = dispatchFakeTask({
      stdout: [
        stepFinishEvent({ messageID: "m1", tokens: { total: 100, input: 10, output: 90 }, cost: 0.001 }),
        stepFinishEvent({ messageID: "m2", tokens: { total: 200, input: 20, output: 180 }, cost: 0.002 }),
      ],
    });

    const record = readPersistedTask(mgr, task.id);

    // The transcript is parsed here rather than through the daemon's own
    // parser, so this check names the belief the stamp rests on: the totals
    // on the record are the ones a reader finds in the log. A change that
    // let the folded totals drift from the transcript would fail here even
    // though every other test in this file still passed.
    const events = fs.readFileSync(path.join(mgr._stateDir, "logs", `${task.id}.ndjson`), "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const loggedCost = events.reduce((sum, evt) => sum + (evt.part?.cost ?? 0), 0);
    const loggedTokens = events.reduce((sum, evt) => {
      if (!evt.part?.tokens) return sum;
      const next = { ...sum };
      for (const [key, value] of Object.entries(evt.part.tokens)) next[key] = (next[key] ?? 0) + value;
      return next;
    }, {});

    assert.equal(record.cost, loggedCost);
    assert.deepEqual(record.tokens, loggedTokens);
  });

  test("a failed log write leaves the record unaccounted for", async (t) => {
    const realWriteSync = fs.writeSync;
    t.mock.method(fs, "writeSync", (fd, data, ...rest) => {
      if (typeof data === "string" && data.includes("step_finish")) throw new Error("ENOSPC");
      return realWriteSync(fd, data, ...rest);
    });
    t.mock.method(console, "error", () => {});
    const { mgr, task } = dispatchFakeTask({
      stdout: [stepFinishEvent({ cost: 0.001 })],
      managerOptions: { stdoutDrainGraceMs: 60000 },
    });

    await waitFor(() => mgr.status(task.id).status === "done", "the task never settled");
    assert.equal(mgr.status(task.id).failureReason, "log_write_failed");

    const record = readPersistedTask(mgr, task.id);
    assert.equal(record.cost, undefined, "the daemon cannot vouch for a run whose totals only partly reached the transcript");
    assert.equal(record.tokens, undefined);
  });

  test("a task whose log has no step_finish stores null cost/tokens", () => {
    const { mgr, task } = dispatchFakeTask({
      stdout: [JSON.stringify({ type: "text", part: { messageID: "m1", text: "partial" } })],
    });

    assert.equal(mgr.status(task.id).status, "done");

    const record = readPersistedTask(mgr, task.id);
    assert.equal(record.cost, null);
    assert.equal(record.tokens, null);
  });

  test("an explicit zero cost is stored as zero, not as an absent value", () => {
    const { mgr, task } = dispatchFakeTask({ stdout: [stepFinishEvent({ cost: 0 })] });

    const record = readPersistedTask(mgr, task.id);
    assert.equal(record.cost, 0);
    assert.notEqual(record.cost, null);
  });
});

describe("accounting in results", () => {
  test("result() reads persisted accounting even when the log is gone", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, MISSING_LOG), cost: 0.007, tokens: { total: 42 } })],
    });
    const r = mgr.result("t1");
    assert.equal(r.cost, 0.007);
    assert.deepEqual(r.tokens, { total: 42 });
  });

  test("result() falls back to parsing the log for a legacy record without stored accounting", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": stepFinishEvent({ tokens: { total: 7 }, cost: 0.0007 }) + "\n" },
    });
    const r = mgr.result("t1");
    assert.equal(r.cost, 0.0007);
    assert.deepEqual(r.tokens, { total: 7 });
  });

  test("reading a legacy record never writes to the record", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": stepFinishEvent({ tokens: { total: 7 }, cost: 0.0007 }) + "\n" },
    });
    assert.equal(readPersistedTask(mgr, "t1").cost, undefined);

    mgr.result("t1");

    const record = readPersistedTask(mgr, "t1");
    assert.equal(record.cost, undefined, READ_NEVER_WRITES);
    assert.equal(record.tokens, undefined, READ_NEVER_WRITES);
  });

  test("re-reading a legacy record reports the same total instead of summing it again", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": stepFinishEvent({ tokens: { total: 7 }, cost: 0.0007 }) + "\n" },
    });
    assert.equal(mgr.result("t1").cost, 0.0007);
    assert.equal(mgr.result("t1").cost, 0.0007);

    assert.equal(readPersistedTask(mgr, "t1").cost, undefined, "the record is still unaccounted for");
  });

  test("a transcript that grew after the record was stamped is reported from the transcript", () => {
    const { mgr, task } = dispatchFakeTask({ stdout: [stepFinishEvent({ cost: 0.001 })] });
    assert.equal(readPersistedTask(mgr, task.id).cost, 0.001);

    // A child that outlived its daemon keeps writing to the same transcript.
    fs.appendFileSync(path.join(mgr._stateDir, "logs", `${task.id}.ndjson`), stepFinishEvent({ messageID: "m2", cost: 0.005 }) + "\n");

    assert.equal(mgr.result(task.id).cost, 0.006);
    assert.equal(
      readPersistedTask(mgr, task.id).cost,
      0.001,
      "the record keeps the total the daemon vouched for at settlement",
    );
  });

  test("a readable transcript with no usage does not erase the record's stored totals", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson"), cost: 0.007, tokens: { total: 42 } })],
      logs: { "t1.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "no usage here" } }) + "\n" },
    });
    assert.equal(mgr.result("t1").cost, 0.007);
    assert.equal(readPersistedTask(mgr, "t1").cost, 0.007);
  });

  test("a readable transcript with no usage on a legacy record reports null without writing the record", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "no usage here" } }) + "\n" },
    });
    assert.equal(mgr.result("t1").cost, null);
    assert.equal(mgr.result("t1").tokens, null);

    const record = readPersistedTask(mgr, "t1");
    assert.equal(record.cost, undefined, READ_NEVER_WRITES);
    assert.equal(record.tokens, undefined, READ_NEVER_WRITES);
  });

  test("a record with neither a readable transcript nor stored totals reports no usage at all", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, MISSING_LOG) })],
    });
    const r = mgr.result("t1");
    assert.equal(r.cost, undefined, "nothing is known about this run's usage");
    assert.equal(r.tokens, undefined, "nothing is known about this run's usage");
  });

  test("a record that stores only one of the two totals keeps the value it has", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, MISSING_LOG), cost: 0.007 })],
    });
    const r = mgr.result("t1");
    assert.equal(r.cost, 0.007);
    assert.equal(r.tokens, null, "the missing half is reported as unknown usage, not as a total");
  });

  test("a settled task's accounting survives a daemon restart", () => {
    const { mgr, task } = dispatchFakeTask({ stdout: [stepFinishEvent({ cost: 0.001 })] });
    assert.equal(readPersistedTask(mgr, task.id).cost, 0.001);

    // The transcript is gone (deleted from disk); only the record's own
    // accounting remains, which is what the restarted daemon has to report.
    fs.rmSync(path.join(mgr._stateDir, "logs", `${task.id}.ndjson`), { force: true });

    const restarted = makeManager({
      stateDir: mgr._stateDir,
      cacheDir: mgr._cacheDir,
      spawnFn: () => fakeChild(4243),
      killFn: () => {},
    });

    assert.equal(restarted.result(task.id).cost, 0.001);
  });

  test("a task whose launch preparation failed is accounted for as having used nothing", () => {
    const mgr = makeManager({
      defaultExecutor: makeFakeOpencodeExecutor({
        buildSpawnArgs: () => ["run", "--format", "json"],
        prepareLaunch: () => { throw new Error("opencode --version failed"); },
      }),
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    const record = readPersistedTask(mgr, dispatched.id);
    assert.equal(record.status, "crashed");
    assert.equal(record.cost, null, "the child never ran, so the daemon knows the run used nothing");
    assert.equal(record.tokens, null);
  });

  test("a resumed run whose launch preparation failed leaves the record unaccounted for", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({
        id: "oc_resume_prepare",
        status: "running",
        directory: fs.realpathSync(os.tmpdir()),
        model: LUNA_MODEL,
        sessionId: null,
        logPath: path.join(logDir, "oc_resume_prepare.ndjson"),
        promptPreview: "resume me",
      })],
      logs: {
        "oc_resume_prepare.ndjson": [
          JSON.stringify({ sessionID: "ses_resume_prepare" }),
          stepFinishEvent({ cost: 0.5 }),
        ].join("\n") + "\n",
      },
      defaultExecutor: makeFakeOpencodeExecutor({
        buildSpawnArgs: () => ["run", "--format", "json"],
        prepareLaunch: () => { throw new Error("opencode --version failed"); },
      }),
    });

    const record = readPersistedTask(mgr, "oc_resume_prepare");
    assert.equal(record.cost, undefined, "the transcript holds the previous run's usage, so this run's failure says nothing about the usage");
    assert.equal(record.tokens, undefined);
  });

  test("a task whose spawn failed is accounted for as having used nothing", () => {
    const mgr = makeManager({
      spawnFn: () => { throw new Error("spawn ENOENT"); },
      defaultExecutor: makeFakeOpencodeExecutor({ buildSpawnArgs: () => ["run", "--format", "json"] }),
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    const record = readPersistedTask(mgr, dispatched.id);
    assert.equal(record.cost, null, "the child never ran, so the daemon knows the run used nothing");
    assert.equal(record.tokens, null);
  });

  test("a resumed run whose spawn failed leaves the record unaccounted for", async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-accounting-resume-"));
    const mgr = makeManager({
      tasksFixture: (dir) => [baseTask({
        id: "oc_resume_acct",
        status: "running",
        directory: fs.realpathSync(os.tmpdir()),
        model: LUNA_MODEL,
        sessionId: null,
        logPath: path.join(dir, "oc_resume_acct.ndjson"),
        promptPreview: "resume me",
      })],
      logs: {
        "oc_resume_acct.ndjson": [
          JSON.stringify({ sessionID: "ses_resume_acct" }),
          stepFinishEvent({ cost: 0.5 }),
        ].join("\n") + "\n",
      },
      spawnFn: () => { throw new Error("spawn ENOENT"); },
      killFn: () => { const err = new Error("ESRCH"); err.code = "ESRCH"; throw err; },
      cancelGraceMs: 0,
    });

    await waitFor(() => mgr.status("oc_resume_acct").status === "crashed", "the resumed spawn never failed");

    const record = readPersistedTask(mgr, "oc_resume_acct");
    assert.equal(record.cost, undefined, "the transcript holds the previous run's events, so this run's failure says nothing about the usage");
    assert.equal(record.tokens, undefined);
    assert.equal(mgr.result("oc_resume_acct").cost, 0.5, "the transcript still reports the earlier run's usage");
    fs.rmSync(logDir, { recursive: true, force: true });
  });
});
