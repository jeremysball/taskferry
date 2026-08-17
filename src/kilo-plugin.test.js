import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";
import kiloPlugin, { createKiloPlugin } from "./kilo-plugin.js";
import { createTaskManager, DEFAULT_SUMMARY_MODEL } from "./tasks.js";
import { TEST_DEFAULT_MODEL, preserveEnvVars } from "./tasks.test-helpers.js";

const trackedTmpDirs = [];
const trackedManagers = [];
function trackManager(manager) {
  trackedManagers.push(manager);
  const realDispatch = manager.dispatch;
  manager.dispatch = (opts) => {
    if (opts.model == null && opts.sessionId == null) {
      return realDispatch({ ...opts, model: TEST_DEFAULT_MODEL });
    }
    return realDispatch(opts);
  };
  return manager;
}
after(() => {
  for (const manager of trackedManagers) {
    try {
      manager.flushPersist();
    } catch {
      // Best-effort: nothing pending, or its stateDir is already gone.
    }
  }
  for (const d of trackedTmpDirs) fs.rmSync(d, { recursive: true, force: true });
});


const STATE_EVENT = "task.state";
const ACTIVITY_EVENT = "task.activity";

function temporaryDirectory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-kilo-plugin-test-")); trackedTmpDirs.push(dir); return dir;
}

function fakeKiloClient() {
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

test("returns no hooks in a taskferry child process", async (t) => {
  preserveEnvVars(t, ["TASKFERRY_CHILD"]);
  process.env.TASKFERRY_CHILD = "1";
  assert.deepEqual(await kiloPlugin({}), {});
});

test("subscribes once for the realpathed workspace and closes through dispose", async () => {
  const directory = temporaryDirectory();
  const kilo = fakeKiloClient();
  const daemon = fakeDaemon();
  let connectCalls = 0;
  const hooks = await createKiloPlugin({ client: kilo.client, directory }, {
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

test("renders task state changes as dynamic toasts with Kilo variants", async () => {
  const kilo = fakeKiloClient();
  const daemon = fakeDaemon();
  const hooks = await createKiloPlugin({ client: kilo.client, directory: temporaryDirectory() }, {
    connectClientFn: async () => daemon,
  });
  const onEvent = daemon.subscriptions[0].onEvent;

  onEvent({ type: STATE_EVENT, taskId: "oc_run", status: "running", activity: "working" });
  onEvent({ type: STATE_EVENT, taskId: "oc_done", status: "done", activity: null });
  onEvent({ type: STATE_EVENT, taskId: "oc_crashed", status: "crashed", activity: "failed" });
  onEvent({ type: STATE_EVENT, taskId: "oc_cancelled", status: "cancelled", activity: null });
  await Promise.resolve();

  assert.deepEqual(kilo.toasts.map(({ body }) => ({
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
  const kilo = fakeKiloClient();
  const daemon = fakeDaemon(context);
  const hooks = await createKiloPlugin({ client: kilo.client, directory }, {
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

test("exposes kilo-native chat.system.transform alias", async () => {
  const kilo = fakeKiloClient();
  const daemon = fakeDaemon({ tasks: [{ id: "k1", status: "running" }] });
  const hooks = await createKiloPlugin({ client: kilo.client, directory: temporaryDirectory() }, {
    connectClientFn: async () => daemon,
  });
  assert.equal(hooks["chat.system.transform"], hooks["experimental.chat.system.transform"]);
  const output = { system: [] };
  await hooks["chat.system.transform"]({ sessionID: "s", model: {} }, output);
  assert.match(output.system[0], /k1/);
  await hooks.dispose();
});

test("exposes getTaskferryState for statusline polling", async () => {
  const kilo = fakeKiloClient();
  const daemon = fakeDaemon({ tasks: [{ id: "a", status: "running", activity: "working" }, { id: "b", status: "done" }] });
  const hooks = await createKiloPlugin({ client: kilo.client, directory: temporaryDirectory() }, {
    connectClientFn: async () => daemon,
  });
  const state = /** @type {any} */ (hooks).getTaskferryState();
  assert.equal(state.active.length, 1);
  assert.equal(state.unseenTerminal.length, 1);
  assert.match(state.block, /Taskferry tasks:/);
  await hooks.dispose();
});

test("does not consume a terminal transition when it is only observed, then consumes it after injection", async () => {
  const kilo = fakeKiloClient();
  const daemon = fakeDaemon();
  const hooks = await createKiloPlugin({ client: kilo.client, directory: temporaryDirectory() }, {
    connectClientFn: async () => daemon,
  });
  const onEvent = daemon.subscriptions[0].onEvent;
  onEvent({ type: STATE_EVENT, taskId: "oc_ab12", status: "done", activity: null });

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
  const kilo = fakeKiloClient();
  const daemon = fakeDaemon();
  const hooks = await createKiloPlugin({ client: kilo.client, directory: temporaryDirectory() }, {
    connectClientFn: async () => daemon,
  });
  const onEvent = daemon.subscriptions[0].onEvent;

  onEvent({ type: STATE_EVENT, taskId: "oc_active", status: "running", activity: null });
  onEvent({ type: STATE_EVENT, taskId: "oc_terminal", status: "done", activity: null });

  onEvent({ type: ACTIVITY_EVENT, taskId: "oc_active", activity: "still working" });
  onEvent({ type: ACTIVITY_EVENT, taskId: "oc_terminal", activity: "wrapped up" });
  onEvent({ type: ACTIVITY_EVENT, taskId: "oc_active", activity: 42 });
  onEvent({ type: ACTIVITY_EVENT, taskId: "oc_unknown", activity: "ignored, no such task" });

  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "session-1", model: {} }, output);

  assert.match(output.system[0], /running · oc_active: still working/);
  assert.match(output.system[0], /done · oc_terminal: wrapped up/);
  await hooks.dispose();
});

test("logs daemon connection failures and leaves Kilo hooks usable", async () => {
  const kilo = fakeKiloClient();
  const hooks = await createKiloPlugin({ client: kilo.client, directory: temporaryDirectory() }, {
    connectClientFn: async () => { throw new Error("daemon unavailable"); },
  });

  assert.equal(kilo.logs.length, 1);
  assert.equal(kilo.logs[0].body.level, "error");
  assert.match(kilo.logs[0].body.message, /daemon unavailable/);
  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "session-1", model: {} }, output);
  assert.deepEqual(output.system, []);
});

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  child.stdout = new EventEmitter();
  return child;
}

test("sets TASKFERRY_CHILD for dispatch and summary children (kilo parity)", async () => {
  const stateDir = temporaryDirectory();
  const children = [];
  const manager = trackManager(createTaskManager({
    stateDir,
    sandboxEnabled: false,
    spawnFn: (_command, _args, options) => {
      const child = fakeChild(5000 + children.length + 1);
      children.push({ child, options });
      return child;
    },
    killFn: () => {},
    maxDispatchesPerWindow: 100,
    dispatchWindowMs: 60000,
    listModelsFn: async () => `${DEFAULT_SUMMARY_MODEL}\n`,
  }));
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
