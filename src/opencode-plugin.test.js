import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import taskferryPlugin, { createOpenCodePlugin } from "./opencode-plugin.js";
import { createTaskManager } from "./tasks.js";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-opencode-plugin-test-"));
}

function fakeOpenCodeClient() {
  const logs = [];
  const toasts = [];
  return {
    logs,
    toasts,
    client: {
      app: { log: async (entry) => logs.push(entry) },
      tui: { showToast: async (entry) => toasts.push(entry) },
    },
  };
}

function fakeDaemon(context = { tasks: [] }) {
  const subscriptions = [];
  let closeCalls = 0;
  return {
    subscriptions,
    get closeCalls() { return closeCalls; },
    request: async (method, params) => {
      assert.equal(method, "task.context");
      assert.equal(params.directory, fs.realpathSync(params.directory));
      return context;
    },
    subscribe: async (params, onEvent) => {
      subscriptions.push({ params, onEvent });
      return `subscription-${subscriptions.length}`;
    },
    close: () => { closeCalls++; },
  };
}

test("returns no hooks in a taskferry child process", async () => {
  const previous = process.env.TASKFERRY_CHILD;
  process.env.TASKFERRY_CHILD = "1";
  try {
    assert.deepEqual(await taskferryPlugin({}), {});
  } finally {
    if (previous === undefined) delete process.env.TASKFERRY_CHILD;
    else process.env.TASKFERRY_CHILD = previous;
  }
});

test("subscribes once for the realpathed workspace and closes through dispose", async () => {
  const directory = temporaryDirectory();
  const opencode = fakeOpenCodeClient();
  const daemon = fakeDaemon();
  let connectCalls = 0;
  const hooks = await createOpenCodePlugin({ client: opencode.client, directory }, {
    connectClientFn: async () => {
      connectCalls++;
      return daemon;
    },
  });

  assert.equal(connectCalls, 1);
  assert.equal(daemon.subscriptions.length, 1);
  assert.deepEqual(daemon.subscriptions[0].params, { directory: fs.realpathSync(directory) });

  await hooks.dispose();
  await hooks.dispose();
  assert.equal(daemon.closeCalls, 1);
});

test("renders task state changes as dynamic toasts with OpenCode variants", async () => {
  const opencode = fakeOpenCodeClient();
  const daemon = fakeDaemon();
  const hooks = await createOpenCodePlugin({ client: opencode.client, directory: temporaryDirectory() }, {
    connectClientFn: async () => daemon,
  });
  const onEvent = daemon.subscriptions[0].onEvent;

  onEvent({ type: "task.state", taskId: "oc_run", status: "running", activity: "working" });
  onEvent({ type: "task.state", taskId: "oc_done", status: "done", activity: null });
  onEvent({ type: "task.state", taskId: "oc_crashed", status: "crashed", activity: "failed" });
  onEvent({ type: "task.state", taskId: "oc_cancelled", status: "cancelled", activity: null });
  await Promise.resolve();

  assert.deepEqual(opencode.toasts.map(({ body }) => ({
    title: body.title,
    message: body.message,
    variant: body.variant,
  })), [
    { title: "Taskferry(running · oc_run)", message: "working", variant: "info" },
    { title: "Taskferry(done · oc_done)", message: "Task done", variant: "success" },
    { title: "Taskferry(crashed · oc_crashed)", message: "failed", variant: "error" },
    { title: "Taskferry(cancelled · oc_cancelled)", message: "Task cancelled", variant: "warning" },
  ]);
  await hooks.dispose();
});

test("injects active and unseen terminal tasks in at most five rows", async () => {
  const directory = temporaryDirectory();
  const context = {
    tasks: [
      { id: "queued", status: "queued" },
      { id: "running", status: "running" },
      { id: "done", status: "done" },
      { id: "crashed", status: "crashed" },
      { id: "cancelled", status: "cancelled" },
      { id: "done-later", status: "done" },
    ],
  };
  const opencode = fakeOpenCodeClient();
  const daemon = fakeDaemon(context);
  const hooks = await createOpenCodePlugin({ client: opencode.client, directory }, {
    connectClientFn: async () => daemon,
  });
  const transform = hooks["experimental.chat.system.transform"];
  const firstOutput = { system: [] };

  await transform({ sessionID: "session-1", model: {} }, firstOutput);

  assert.equal(firstOutput.system.length, 1);
  assert.match(firstOutput.system[0], /Taskferry tasks:/);
  assert.match(firstOutput.system[0], /queued · queued/);
  assert.match(firstOutput.system[0], /running · running/);
  assert.match(firstOutput.system[0], /done · done/);
  assert.match(firstOutput.system[0], /crashed · crashed/);
  assert.match(firstOutput.system[0], /cancelled · cancelled/);
  assert.match(firstOutput.system[0], /\+1 more/);
  assert.doesNotMatch(firstOutput.system[0], /done-later/);
  await hooks.dispose();
});

test("does not consume a terminal transition when it is only observed, then consumes it after injection", async () => {
  const opencode = fakeOpenCodeClient();
  const daemon = fakeDaemon();
  const hooks = await createOpenCodePlugin({ client: opencode.client, directory: temporaryDirectory() }, {
    connectClientFn: async () => daemon,
  });
  const onEvent = daemon.subscriptions[0].onEvent;
  onEvent({ type: "task.state", taskId: "oc_ab12", status: "done", activity: null });

  const previewOutput = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "session-1" }, previewOutput);
  assert.match(previewOutput.system[0], /done · oc_ab12/);

  const firstOutput = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "session-1", model: {} }, firstOutput);
  assert.match(firstOutput.system[0], /done · oc_ab12/);

  const secondOutput = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "session-1", model: {} }, secondOutput);
  assert.equal(secondOutput.system.length, 0);
  await hooks.dispose();
});

test("task.activity events refresh activity text for active and unseen-terminal rows, and ignore non-string activity", async () => {
  const opencode = fakeOpenCodeClient();
  const daemon = fakeDaemon();
  const hooks = await createOpenCodePlugin({ client: opencode.client, directory: temporaryDirectory() }, {
    connectClientFn: async () => daemon,
  });
  const onEvent = daemon.subscriptions[0].onEvent;

  onEvent({ type: "task.state", taskId: "oc_active", status: "running", activity: null });
  onEvent({ type: "task.state", taskId: "oc_terminal", status: "done", activity: null });

  onEvent({ type: "task.activity", taskId: "oc_active", activity: "still working" });
  onEvent({ type: "task.activity", taskId: "oc_terminal", activity: "wrapped up" });
  onEvent({ type: "task.activity", taskId: "oc_active", activity: 42 });
  onEvent({ type: "task.activity", taskId: "oc_unknown", activity: "ignored, no such task" });

  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "session-1", model: {} }, output);

  assert.match(output.system[0], /running · oc_active: still working/);
  assert.match(output.system[0], /done · oc_terminal: wrapped up/);
  await hooks.dispose();
});

test("logs daemon connection failures and leaves OpenCode hooks usable", async () => {
  const opencode = fakeOpenCodeClient();
  const hooks = await createOpenCodePlugin({ client: opencode.client, directory: temporaryDirectory() }, {
    connectClientFn: async () => { throw new Error("daemon unavailable"); },
  });

  assert.equal(opencode.logs.length, 1);
  assert.equal(opencode.logs[0].body.level, "error");
  assert.match(opencode.logs[0].body.message, /daemon unavailable/);
  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "session-1", model: {} }, output);
  assert.deepEqual(output.system, []);
});

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  return child;
}

test("sets TASKFERRY_CHILD for dispatch and summary children", async () => {
  const stateDir = temporaryDirectory();
  const children = [];
  const manager = createTaskManager({
    stateDir,
    spawnFn: (_command, _args, options) => {
      const child = fakeChild(5000 + children.length + 1);
      children.push({ child, options });
      return child;
    },
    killFn: () => {},
    maxDispatchesPerWindow: 100,
    dispatchWindowMs: 60000,
    listModelsFn: async () => "opencode/hy3-free\n",
    verifySummaryAgentFn: async () => {},
  });
  const task = manager.dispatch({ prompt: "dispatch", directory: stateDir });
  const sourceChild = children[0];
  assert.equal(sourceChild.options.env.TASKFERRY_CHILD, "1");
  sourceChild.child.emit("exit", 0, null);

  fs.writeFileSync(manager.paths.LOG_DIR + "/" + `${task.id}.ndjson`, JSON.stringify({
    type: "text",
    part: { messageID: "message", text: "completed" },
  }) + "\n");
  await manager.summarize(task.id);
  assert.equal(children.at(-1).options.env.TASKFERRY_CHILD, "1");
});
