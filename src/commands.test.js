import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./commands.js";

function fakeIo() {
  const stdout = [];
  return { stdout: { write: (chunk) => stdout.push(chunk) }, lines: stdout };
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

test("watch prints each event through formatWatchEvent and resolves on abort", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const controller = new AbortController();
  let deliver;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  const io = fakeIo();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: false }, {
    client,
    io,
    signal: controller.signal,
    cwd: root,
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_1", directory: root, status: "running" });
  controller.abort();
  const result = await pending;

  assert.equal(result.directory, root);
  assert.equal(result.watching, false);
  assert.equal(io.lines.length, 1);
  assert.match(io.lines[0], /oc_1/);
});

test("watch --task-id filters events to one task and exits on its terminal event", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let deliver;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  const io = fakeIo();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: false, taskId: "oc_1" }, {
    client,
    io,
    cwd: root,
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_2", directory: root, status: "running" });
  deliver({ sequence: 2, type: "task.state", taskId: "oc_1", directory: root, status: "running" });
  deliver({ sequence: 3, type: "task.state", taskId: "oc_1", directory: root, status: "done" });

  const result = await pending;
  assert.equal(result.watching, false);
  assert.equal(io.lines.length, 2, "only the matching task's events should print");
  assert.match(io.lines[0], /oc_1/);
  assert.match(io.lines[0], /running/);
  assert.match(io.lines[1], /oc_1/);
  assert.match(io.lines[1], /done/);
});

test("watch --task-id resolves --directory from the task when omitted, and exits without abort", async () => {
  const fromTask = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let deliver;
  const client = fakeClient({
    onSubscribe: (params, onEvent) => {
      deliver = onEvent;
      assert.equal(params.directory, fromTask);
    },
  });
  client.request = async (method, params) => {
    assert.equal(method, "task.status");
    assert.equal(params.taskId, "oc_9");
    return { directory: fromTask };
  };
  const io = fakeIo();

  const pending = runCommand("watch", { directory: undefined, format: "toon", summaries: false, taskId: "oc_9" }, {
    client,
    io,
    cwd: elsewhere,
  });

  await new Promise((resolve) => setImmediate(resolve));

  deliver({ sequence: 1, type: "task.state", taskId: "oc_9", directory: fromTask, status: "crashed" });
  const result = await pending;

  assert.equal(result.event.status, "crashed");
  assert.equal(client.closed.value, true);
});

test("wait --summarize streams summaries then returns the same shape as plain wait", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let deliver;
  let currentStatus = "running";
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  client.request = async (method) => {
    if (method === "task.status") {
      return currentStatus === "running"
        ? { directory: root, status: currentStatus }
        : {
            id: "oc_5",
            status: currentStatus,
            startedAt: "2026-07-17T00:00:00.000Z",
            exitCode: 0,
            signal: null,
            directory: root,
            model: "anthropic/claude-3",
            prompt: "summarize the latest activity",
          };
    }
    throw new Error(`unexpected request: ${method}`);
  };
  const io = fakeIo();

  const pending = runCommand("wait", { taskId: "oc_5", timeoutMs: undefined, tailChars: undefined, full: false, summarize: true }, {
    client,
    io,
  });

  await new Promise((resolve) => setImmediate(resolve));

  deliver({ sequence: 1, type: "task.state", taskId: "oc_5", directory: root, status: "running", activity: "reading files" });
  currentStatus = "done";
  deliver({ sequence: 2, type: "task.state", taskId: "oc_5", directory: root, status: "done" });

  const result = await pending;
  assert.equal(result.id, "oc_5");
  assert.equal(result.status, "done");
  assert.equal(io.lines.length, 2, "both the running and done events should print");
  assert.equal(client.closed.value, false, "wait must not close the client itself; cli.js closes it");
  assert.deepEqual(result, {
    id: "oc_5",
    status: "done",
    startedAt: "2026-07-17T00:00:00.000Z",
    exitCode: 0,
    signal: null,
    next: 'Run taskferry result with task id "oc_5" to see the final message; pass --full here for directory/model/log path details',
  });
});

test("wait --summarize resolves immediately for an already-settled task instead of hanging", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const client = fakeClient({
    onSubscribe: () => {
      // No terminal event will ever be delivered on this subscription: the task
      // was already terminal before the subscribe call, so nothing broadcasts.
    },
  });
  client.request = async (method, params) => {
    if (method === "task.status") {
      return {
        id: params.taskId,
        status: "done",
        startedAt: "2026-07-17T00:00:00.000Z",
        exitCode: 0,
        signal: null,
        directory: root,
      };
    }
    throw new Error(`unexpected request: ${method}`);
  };
  const io = fakeIo();

  const result = await runCommand("wait", { taskId: "oc_6", timeoutMs: undefined, tailChars: undefined, full: false, summarize: true }, {
    client,
    io,
  });

  assert.equal(result.id, "oc_6");
  assert.equal(result.status, "done");
});

test("watch --task-id resolves immediately for an already-settled task instead of hanging", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const client = fakeClient({
    onSubscribe: () => {
      // No terminal event will ever be delivered: the task was already terminal
      // before the subscription registered.
    },
  });
  client.request = async (method, params) => {
    if (method === "task.status") {
      return { id: params.taskId, status: "crashed", directory: root };
    }
    throw new Error(`unexpected request: ${method}`);
  };
  const io = fakeIo();

  const result = await runCommand("watch", { directory: undefined, format: "toon", summaries: false, taskId: "oc_7" }, {
    client,
    io,
    cwd: root,
  });

  assert.equal(result.event.status, "crashed");
  assert.equal(client.closed.value, true);
});
