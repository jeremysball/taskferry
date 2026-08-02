import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskManager } from "./tasks.js";
import { createTaskEvents } from "./events.js";

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  child.stdout = new EventEmitter();
  return child;
}

function makeManager({ tasks = [], spawnFn, killFn, onEvent, maxConcurrentTasks = 4 } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-events-test-"));
  fs.writeFileSync(path.join(stateDir, "tasks.json"), JSON.stringify(tasks, null, 2));
  return createTaskManager({
    stateDir,
    sandboxEnabled: false,
    spawnFn: spawnFn ?? (() => fakeChild()),
    killFn: killFn ?? (() => {}),
    onEvent,
    maxConcurrentTasks,
    maxDispatchesPerWindow: 100,
    dispatchWindowMs: 60000,
  });
}

function persistedTask(overrides = {}) {
  return {
    id: "persisted",
    status: "running",
    directory: os.tmpdir(),
    model: "openai/gpt-5.6-luna",
    variant: "high",
    sessionId: null,
    pid: 123,
    startedAt: "2026-07-15T00:00:00.000Z",
    endedAt: null,
    exitCode: null,
    signal: null,
    logPath: path.join(os.tmpdir(), "persisted.ndjson"),
    promptPreview: "persisted task",
    promptTotalChars: null,
    spawnError: null,
    cancelRequested: false,
    internal: false,
    ...overrides,
  };
}

describe("task lifecycle events", () => {
  test("emits queued before launch, running after spawn, and done after settlement", () => {
    const events = [];
    const child = fakeChild();
    let eventsSeenAtSpawn;
    const manager = makeManager({
      onEvent: (event) => events.push(event),
      spawnFn: () => {
        eventsSeenAtSpawn = events.map((event) => event.status);
        return child;
      },
    });

    const dispatched = manager.dispatch({ prompt: "test events", directory: os.tmpdir() });
    assert.deepEqual(eventsSeenAtSpawn, ["queued"]);
    assert.deepEqual(events.map((event) => event.status), ["queued", "running"]);

    child.emit("exit", 0, null);

    assert.deepEqual(events.map((event) => event.status), ["queued", "running", "done"]);
    assert.deepEqual(events.map((event) => event.previousStatus), [null, "queued", "running"]);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
    assert.deepEqual(Object.keys(events[0]), [
      "sequence",
      "type",
      "taskId",
      "directory",
      "originSessionId",
      "status",
      "previousStatus",
      "occurredAt",
      "activity",
      "outputWatermark",
    ]);
    assert.equal(events[0].type, "task.state");
    assert.equal(events[0].taskId, dispatched.id);
    assert.equal(events[0].directory, fs.realpathSync(os.tmpdir()));
    assert.equal(events[0].activity, null);
    assert.equal(events[0].outputWatermark, null);
    assert.ok(events.every((event) => !Number.isNaN(Date.parse(event.occurredAt))));
  });

  test("emits crashed after an unsuccessful child settlement", () => {
    const events = [];
    const child = fakeChild();
    const manager = makeManager({ onEvent: (event) => events.push(event), spawnFn: () => child });

    manager.dispatch({ prompt: "crash", directory: os.tmpdir() });
    child.emit("exit", 1, null);

    assert.deepEqual(events.map((event) => event.status), ["queued", "running", "crashed"]);
  });

  test("emits cancelled when a queued task is cancelled before launch", () => {
    const events = [];
    const firstChild = fakeChild();
    const manager = makeManager({
      onEvent: (event) => events.push(event),
      spawnFn: () => firstChild,
      maxConcurrentTasks: 1,
    });
    const first = manager.dispatch({ prompt: "first", directory: os.tmpdir() });
    const queued = manager.dispatch({ prompt: "second", directory: os.tmpdir() });

    manager.cancel(queued.id);
    firstChild.emit("exit", 0, null);

    const queuedEvents = events.filter((event) => event.taskId === queued.id);
    assert.deepEqual(queuedEvents.map((event) => event.status), ["queued", "cancelled"]);
    assert.equal(queuedEvents[1].previousStatus, "queued");
    assert.equal(manager.status(first.id).status, "done");
  });

  test("emits unknown when an active persisted task is reloaded", () => {
    const events = [];
    makeManager({ tasks: [persistedTask()], onEvent: (event) => events.push(event) });

    assert.equal(events.length, 1);
    assert.equal(events[0].status, "unknown");
    assert.equal(events[0].previousStatus, "running");
    assert.equal(events[0].sequence, 1);
  });

  test("does not duplicate a running event when cancellation persists the same status", () => {
    const events = [];
    const child = fakeChild();
    const manager = makeManager({
      onEvent: (event) => events.push(event),
      spawnFn: () => child,
      killFn: () => {},
    });
    const task = manager.dispatch({ prompt: "cancel", directory: os.tmpdir() });

    manager.cancel(task.id, { graceMs: 60000 });
    const beforeSettlement = events.map((event) => event.status);
    child.emit("exit", null, "SIGTERM");

    assert.deepEqual(beforeSettlement, ["queued", "running"]);
    assert.deepEqual(events.map((event) => event.status), ["queued", "running", "cancelled"]);
  });

  test("uses one monotonic sequence across tasks for the manager lifetime", () => {
    const events = [];
    const firstChild = fakeChild();
    const manager = makeManager({
      onEvent: (event) => events.push(event),
      spawnFn: () => firstChild,
      maxConcurrentTasks: 1,
    });
    const first = manager.dispatch({ prompt: "first", directory: os.tmpdir() });
    const second = manager.dispatch({ prompt: "second", directory: os.tmpdir() });

    manager.cancel(second.id);
    firstChild.emit("exit", 0, null);

    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
    assert.deepEqual(events.map((event) => event.taskId), [first.id, first.id, second.id, second.id, first.id]);
  });

  test("excludes internal tasks from the user event stream", () => {
    const events = [];
    const child = fakeChild();
    const manager = makeManager({ onEvent: (event) => events.push(event), spawnFn: () => child });
    const task = manager.dispatch({ prompt: "internal", directory: os.tmpdir(), internal: true });

    child.emit("exit", 0, null);

    assert.deepEqual(events, []);
    manager.flushPersist();
    const onDisk = JSON.parse(fs.readFileSync(manager.paths.TASKS_FILE, "utf8"));
    assert.equal(onDisk.find((entry) => entry.id === task.id).internal, true);
  });

  test("keeps persisted summary tasks from older state files out of the event stream", () => {
    const events = [];
    const summary = persistedTask({
      internal: undefined,
      summaryOf: { sourceTaskId: "source" },
    });

    makeManager({ tasks: [summary], onEvent: (event) => events.push(event) });

    assert.deepEqual(events, []);
  });

  test("emitState includes the task's originSessionId on the emitted event", () => {
    const events = [];
    const { emitState } = createTaskEvents((event) => events.push(event));
    emitState({ id: "t1", directory: "/tmp/project", status: "running", originSessionId: "sess-abc" });
    assert.equal(events[0].originSessionId, "sess-abc");
  });

  test("emitState defaults originSessionId to null when the task has none", () => {
    const events = [];
    const { emitState } = createTaskEvents((event) => events.push(event));
    emitState({ id: "t1", directory: "/tmp/project", status: "running" });
    assert.equal(events[0].originSessionId, null);
  });

  test("does not let an event callback failure change task lifecycle", () => {
    const child = fakeChild();
    const diagnostics = [];
    const originalConsoleError = console.error;
    console.error = (...args) => diagnostics.push(args);

    try {
      const manager = makeManager({
        onEvent: () => {
          throw new Error("observer failed");
        },
        spawnFn: () => child,
      });

      const task = manager.dispatch({ prompt: "survive observer", directory: os.tmpdir() });
      child.emit("exit", 0, null);

      assert.equal(manager.status(task.id).status, "done");
      assert.equal(diagnostics.length, 3);
      assert.equal(diagnostics[0][0], "Dropped task.state event after onEvent failure");
      assert.deepEqual(diagnostics[0][1], {
        taskId: task.id,
        status: "queued",
        sequence: 1,
      });
      assert.equal(diagnostics[0][2].message, "observer failed");
    } finally {
      console.error = originalConsoleError;
    }
  });
});
