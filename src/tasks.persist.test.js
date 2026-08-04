import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskManager, isOutsideDirectory } from "./tasks.js";
import { makeManager, fakeChild, baseTask, AXI_TASKS_TEST_DIR, TASKS_STATE_FILE, LUNA_MODEL, NOT_REACHED, WS_REPO } from "./tasks.test-helpers.js";

describe("persistTask() durability across concurrent manager instances", () => {
  test("two manager instances sharing a state dir each persist their own tasks via debounced flush", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), AXI_TASKS_TEST_DIR));
    const mgrA = createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => fakeChild(1001),
      killFn: () => { throw new Error("not used"); },
    });
    const a = mgrA.dispatch({ prompt: "from A", directory: os.tmpdir() });
    // Flush A's debounced write immediately via close()
    mgrA.close();

    const onDiskA = JSON.parse(fs.readFileSync(path.join(stateDir, TASKS_STATE_FILE), "utf8"));
    assert.ok(onDiskA.some((t) => t.id === a.id), "manager A's task must be on disk after close()");

    const mgrB = createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => fakeChild(1002),
      killFn: () => { throw new Error("not used"); },
    });
    const b = mgrB.dispatch({ prompt: "from B", directory: os.tmpdir() });
    mgrB.close();

    const onDiskB = JSON.parse(fs.readFileSync(path.join(stateDir, TASKS_STATE_FILE), "utf8"));
    const ids = onDiskB.map((t) => t.id);
    assert.ok(ids.includes(a.id), "manager A's task must survive in loadPersisted");
    assert.ok(ids.includes(b.id), "manager B's task must be persisted");
  });

  test("malformed tasks.json surfaces as a structured error instead of throwing at construction", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), AXI_TASKS_TEST_DIR));
    fs.writeFileSync(path.join(stateDir, TASKS_STATE_FILE), "{ not valid json");
    const mgr = createTaskManager({ stateDir, sandboxEnabled: false, spawnFn: () => fakeChild(), killFn: () => {} });
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir() }),
      /error: could not read persisted task state/
    );
  });
});

describe("isOutsideDirectory()", () => {
  test("is true for a genuinely outside sibling path", () => {
    assert.equal(isOutsideDirectory(WS_REPO, "/workspace/other"), true);
  });

  test("is false for a path nested inside the directory", () => {
    assert.equal(isOutsideDirectory(WS_REPO, "/workspace/repo/.git"), false);
  });

  test("does not misclassify a nested directory whose name happens to start with '..' as outside", () => {
    assert.equal(isOutsideDirectory(WS_REPO, "/workspace/repo/..foo"), false);
  });

  test("is true for the parent directory itself", () => {
    assert.equal(isOutsideDirectory("/workspace/repo/sub", WS_REPO), true);
  });
});

describe("executorId on persisted tasks (Task 5: legacy records default to opencode at load)", () => {
  test("a persisted task with no executorId defaults to \"opencode\" on load", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        id: "oc_legacy", status: "done", directory: "/tmp", model: LUNA_MODEL, variant: "high",
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
    const mgr = makeManager({ spawnFn: () => { throw new Error(NOT_REACHED); } });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: process.cwd(), executor: "pi" });
    const status = mgr.status(dispatched.id);
    assert.equal(status.executorId, "pi");
  });

  test("dispatch() with no executor defaults to pi", () => {
    const mgr = makeManager({ spawnFn: () => { throw new Error(NOT_REACHED); } });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: process.cwd() });
    const status = mgr.status(dispatched.id);
    assert.equal(status.executorId, "pi");
  });

  test("dispatch() with an unknown executor name throws", () => {
    const mgr = makeManager({ spawnFn: () => { throw new Error(NOT_REACHED); } });
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
