import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./commands.js";

const trackedTmpDirs = [];
after(() => {
  for (const d of trackedTmpDirs) fs.rmSync(d, { recursive: true, force: true });
});


// Split out of commands.test.js (sonarjs max-lines fixup, merge of #340 and
// #334): watch/streaming coverage for the commands-stream.js delegate --
// event printing/coloring/collapsing, --task-id/--all subscription
// selection, the already-settled catch-up path, and --flush-interval
// batching. Self-contained -- its own tmp-dir/fakeClient/fakeIo/setupWatch
// helper copies, only imports runCommand from ./commands.js.

// -- Constants ----------------------------------------------------------------

const TASKFERRY_TEST_TMP_PREFIX = "taskferry-commands-stream-test-";
const TASK_STATE_EVENT_TYPE = "task.state";
const TASK_STATUS_METHOD = "task.status";

// -- Helpers --------------------------------------------------------------------

function mkTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); trackedTmpDirs.push(dir); return dir;
}

function mkTmpRoot(prefix) {
  return fs.realpathSync(mkTmpDir(prefix));
}

function fakeIo({ isTTY } = {}) {
  const stdout = [];
  return { stdout: { write: (chunk) => stdout.push(chunk), isTTY }, lines: stdout };
}

function fakeClient({ onSubscribe } = {}) {
  const closed = { value: false };
  return {
    closed,
    async request() {
      throw new Error("request() not stubbed for this test");
    },
    async subscribe(params, onEvent) {
      if (onSubscribe) onSubscribe(params, onEvent);
      return "sub-1";
    },
    close() {
      closed.value = true;
    },
  };
}

// Common scaffolding for a `watch` test: a realpath'd tmp dir, an
// AbortController, a fakeClient whose subscribe captures the onEvent
// callback into `state.deliver`, and a fakeIo. Returns everything the test
// needs to call runCommand("watch", ...) and then push events.
function setupWatch({ prefix = TASKFERRY_TEST_TMP_PREFIX, isTTY = false } = {}) {
  const root = mkTmpRoot(prefix);
  const controller = new AbortController();
  const state = { deliver: null };
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      state.deliver = onEvent;
    },
  });
  const io = fakeIo({ isTTY });
  return { deliver: (event) => state.deliver(event), root, controller, client, io };
}

function deliverState({ deliver, sequence, taskId, directory, status, previousStatus, activity }) {
  deliver({ type: TASK_STATE_EVENT_TYPE, sequence, taskId, directory, status, previousStatus, activity });
}

// -- Watch tests --------------------------------------------------------------

test("watch prints each event through formatWatchEvent and resolves on abort", async () => {
  const { root, controller, client, io, deliver } = setupWatch();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: false }, { signal: controller.signal,  cwd: root ,  client,  io});

  deliver({ sequence: 1, type: TASK_STATE_EVENT_TYPE, taskId: "oc_1", directory: root, status: "running" });
  controller.abort();
  const result = await pending;

  assert.equal(result.directory, root);
  assert.equal(result.watching, false);
  assert.equal(io.lines.length, 1);
  assert.match(io.lines[0], /oc_1/);
});

test("watch colors the status only when stdout is a TTY", async () => {
  const { root, controller, client, io, deliver } = setupWatch({ isTTY: true });

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: false }, { signal: controller.signal,  cwd: root ,  client,  io});

  deliverState({ sequence: 1,  taskId: "oc_1",  directory: root,  status: "done",  previousStatus: "running" ,  deliver});
  controller.abort();
  await pending;

  assert.ok(io.lines[0].includes("\x1b[32mdone\x1b[0m"));
});

test("watch never colors ndjson output even when stdout is a TTY", async () => {
  const { root, controller, client, io, deliver } = setupWatch({ isTTY: true });

  const pending = runCommand("watch", { directory: root, format: "ndjson", summaries: false }, { signal: controller.signal,  cwd: root ,  client,  io});

  deliverState({ sequence: 1,  taskId: "oc_1",  directory: root,  status: "done",  previousStatus: "running" ,  deliver});
  controller.abort();
  await pending;

  assert.ok(!io.lines[0].includes("\x1b["));
});

test("watch collapses a multi-line activity event to exactly one written line", async () => {
  const { root, controller, client, io, deliver } = setupWatch();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: true }, { signal: controller.signal,  cwd: root ,  client,  io});

  deliver({
    sequence: 1,
    type: "task.activity",
    taskId: "oc_1",
    directory: root,
    status: "running",
    activity: "Inspecting the server\nchecking Playwright logs\nand env vars",
  });
  controller.abort();
  await pending;

  assert.equal(io.lines.length, 1);
  assert.equal((io.lines[0].match(/\n/g) || []).length, 1);
  assert.match(io.lines[0], /oc_1/);
  assert.match(io.lines[0], /Inspecting the server checking Playwright logs and env vars/);
});

test("watch --task-id filters events to one task and exits on its terminal event", async () => {
  const { root, client, io, deliver } = setupWatch();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: false, taskId: "oc_1" }, { cwd: root ,  client,  io});

  deliverState({ sequence: 1,  taskId: "oc_2",  directory: root,  status: "running" ,  deliver});
  deliverState({ sequence: 2,  taskId: "oc_1",  directory: root,  status: "running" ,  deliver});
  deliverState({ sequence: 3,  taskId: "oc_1",  directory: root,  status: "done" ,  deliver});

  const result = await pending;
  assert.equal(result.watching, false);
  assert.equal(io.lines.length, 2, "only the matching task's events should print");
  assert.match(io.lines[0], /oc_1/);
  assert.match(io.lines[0], /running/);
  assert.match(io.lines[1], /oc_1/);
  assert.match(io.lines[1], /done/);
});

test("watch --task-id subscribes by taskId directly, without a task.status pre-fetch round-trip (issue #59)", async () => {
  const fromTask = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const elsewhere = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let deliver;
  const client = fakeClient({
    onSubscribe: (params, onEvent) => {
      deliver = onEvent;
      assert.equal(params.taskId, "oc_9");
      assert.equal("directory" in params, false, "directory must not be pre-fetched; the daemon resolves it from taskId");
    },
  });
  client.request = async (method, params) => {
    assert.equal(method, TASK_STATUS_METHOD, "the only allowed request is the already-terminal catch-up check, not a directory pre-fetch");
    assert.equal(params.taskId, "oc_9");
    return { directory: fromTask, status: "running" };
  };
  const io = fakeIo();

  const pending = runCommand("watch", { directory: void 0, format: "toon", summaries: false, taskId: "oc_9" }, { cwd: elsewhere ,  client,  io});

  await new Promise((resolve) => setImmediate(resolve));

  deliverState({ sequence: 1,  taskId: "oc_9",  directory: fromTask,  status: "crashed" ,  deliver});
  const result = await pending;

  assert.equal(result.event.status, "crashed");
  assert.equal(result.directory, fromTask);
  assert.equal(client.closed.value, true);
});

test("watch --all subscribes with {all: true} instead of a directory, and receives events from every workspace (taskferry#315)", async () => {
  const here = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const elsewhere = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const controller = new AbortController();
  let subscribeParams;
  let deliverFn;
  const client = fakeClient({
    onSubscribe: (params, onEvent) => {
      subscribeParams = params;
      deliverFn = onEvent;
    },
  });
  const io = fakeIo();

  const pending = runCommand("watch", { directory: void 0, all: true, format: "toon", summaries: false, taskId: void 0 }, { signal: controller.signal, cwd: here, client, io });

  assert.deepEqual(subscribeParams, { all: true });

  deliverState({ sequence: 1, taskId: "oc_1", directory: here, status: "running", deliver: deliverFn });
  deliverState({ sequence: 2, taskId: "oc_2", directory: elsewhere, status: "running", deliver: deliverFn });
  controller.abort();
  await pending;

  assert.equal(io.lines.length, 2, "events from both workspaces should print, not just the cwd's");
  assert.match(io.lines[0], /oc_1/);
  assert.match(io.lines[1], /oc_2/);
});

test("watch --task-id resolves immediately for an already-settled task instead of hanging", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const client = fakeClient({
    onSubscribe: () => {
      // No terminal event will ever be delivered: the task was already terminal
      // before the subscription registered.
    },
  });
  client.request = async (method, params) => {
    if (method === TASK_STATUS_METHOD) return { id: params.taskId, status: "crashed", directory: root };
    throw new Error(`unexpected request: ${method}`);
  };
  const io = fakeIo();

  const result = await runCommand("watch", { directory: void 0, format: "toon", summaries: false, taskId: "oc_7" }, { cwd: root ,  client,  io});

  assert.equal(result.event.status, "crashed");
  assert.equal(client.closed.value, true);
});

test("watch --flush-interval batches multiple events for the same and different taskIds into one flushed block", async () => {
  const { root, controller, client, io, deliver } = setupWatch();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: true, flushIntervalMs: 1000 }, { signal: controller.signal,  cwd: root ,  client,  io});

  deliverState({ sequence: 1,  taskId: "oc_1",  directory: root,  status: "running" ,  deliver});
  deliverState({ sequence: 2,  taskId: "oc_2",  directory: root,  status: "running" ,  deliver});
  deliverState({ sequence: 3,  taskId: "oc_1",  directory: root,  status: "done" ,  deliver}); // last-write-wins for oc_1

  assert.equal(io.lines.length, 0, "nothing should be written before the first flush tick");

  await new Promise((resolve) => setTimeout(resolve, 1100));
  controller.abort();
  await pending;

  // toon/plain format renders one line per buffered event, same as today's
  // per-event output, just written together at flush time instead of
  // streamed individually -- Map preserves oc_1's original insertion
  // position, so it flushes first even though its value was last updated.
  assert.equal(io.lines.length, 2, "one line per distinct taskId, written together at the flush tick");
  assert.match(io.lines[0], /oc_1/);
  assert.match(io.lines[0], /done/);
  assert.doesNotMatch(io.lines[0], /running/, "oc_1's stale running event must not appear, only its final done");
  assert.match(io.lines[1], /oc_2/);
  assert.match(io.lines[1], /running/);
});

test("watch --flush-interval emits nothing on a tick where no events arrived", async () => {
  const { root, controller, client, io } = setupWatch();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: true, flushIntervalMs: 200 }, { signal: controller.signal,  cwd: root ,  client,  io});

  await new Promise((resolve) => setTimeout(resolve, 450));
  controller.abort();
  await pending;

  assert.equal(io.lines.length, 0);
});

test("watch --flush-interval --task-id flushes the terminal event synchronously before exiting, not left buffered", async () => {
  const { root, client, io, deliver } = setupWatch();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: true, flushIntervalMs: 60000, taskId: "oc_1" }, { cwd: root ,  client,  io});

  deliverState({ sequence: 1,  taskId: "oc_1",  directory: root,  status: "running" ,  deliver});
  deliverState({ sequence: 2,  taskId: "oc_1",  directory: root,  status: "done" ,  deliver});

  const result = await pending;

  assert.equal(result.watching, false);
  assert.equal(io.lines.length, 1, "the terminal event must flush immediately, not wait for a 60s tick that never fires in this test");
  assert.match(io.lines[0], /done/);
});

test("watch --flush-interval --format ndjson wraps buffered events in a single watch.flush envelope", async () => {
  const { root, controller, client, io, deliver } = setupWatch();

  const pending = runCommand("watch", { directory: root, format: "ndjson", summaries: true, flushIntervalMs: 100 }, { signal: controller.signal,  cwd: root ,  client,  io});

  deliverState({ sequence: 1,  taskId: "oc_1",  directory: root,  status: "running" ,  deliver});

  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  await pending;

  assert.equal(io.lines.length, 1);
  const parsed = JSON.parse(io.lines[0]);
  assert.equal(parsed.type, "watch.flush");
  assert.equal(typeof parsed.timestamp, "string");
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].taskId, "oc_1");
});

test("watch --flush-interval flushes buffered events on abort instead of silently dropping them", async () => {
  // Regression test: on SIGINT/SIGTERM or an injected AbortSignal, the
  // buffered events must still be emitted -- otherwise up to one
  // `--flush-interval` window's worth of events would be silently
  // dropped on a clean (exit code 0) abort, even though the user
  // explicitly opted into buffered/batched output.
  const { root, controller, client, io, deliver } = setupWatch();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: true, flushIntervalMs: 60000 }, { signal: controller.signal,  cwd: root ,  client,  io});

  // Populate the buffer with events but don't wait for the (60s) flush
  // tick -- the abort must happen first, otherwise this test would
  // pass for the wrong reason (just by hitting the timer eventually).
  deliverState({ sequence: 1,  taskId: "oc_1",  directory: root,  status: "running" ,  deliver});
  deliverState({ sequence: 2,  taskId: "oc_2",  directory: root,  status: "running" ,  deliver});
  assert.equal(io.lines.length, 0, "nothing should be written before the flush tick or abort");

  controller.abort();
  const result = await pending;

  assert.equal(result.watching, false);
  assert.equal(io.lines.length, 2, "both buffered events must be flushed on abort, not silently dropped");
  assert.match(io.lines[0], /oc_1/);
  assert.match(io.lines[1], /oc_2/);
});
