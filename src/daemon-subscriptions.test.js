import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { startDaemon } from "./daemon.js";

const TEST_MODEL = "test/model";
const EVENT_SUBSCRIBE = "event.subscribe";
const TASK_STATE = "task.state";
const TASK_CONTEXT = "task.context";
const IN_WORKTREE_TASK_ID = "in-worktree";
const TEST_STARTED_AT = "2026-07-15T00:00:00.000Z";
const GIT_EMAIL = "user.email=t@t";
const GIT_NAME = "user.name=t";

// A real main-checkout + linked-worktree pair (`git worktree add`), the
// exact layout taskferry#315 reports as silently invisible to a root-scoped
// watch/list: a dispatch's recorded `directory` is the worktree's own path,
// not the main checkout's. Returns realpath'd directories so callers can
// compare them directly against what the daemon's own realpathSync-based
// normalizeDirectory() would produce.
function gitWorktreeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-daemon-worktree-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mainRepo = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(mainRepo);
  spawnSync("git", ["init", "-q", mainRepo]);
  fs.writeFileSync(path.join(mainRepo, "tracked.txt"), "base\n");
  spawnSync("git", ["-C", mainRepo, "add", "-A"]);
  spawnSync("git", ["-C", mainRepo, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "base"]);
  spawnSync("git", ["-C", mainRepo, "worktree", "add", "-q", worktree, "-b", "feat"]);
  return { mainRepo: fs.realpathSync(mainRepo), worktree: fs.realpathSync(worktree) };
}

function temporaryPaths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-daemon-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    stateDir: path.join(root, "state"),
    runtimeDir: path.join(root, "run"),
    socketPath: path.join(root, "run", "daemon.sock"),
  };
}

function fakeManagerFactory(tasks = [], { checkSummaryModelReady } = {}) {
  let onEvent;
  let capturedOptions;
  const calls = [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const manager = {
    dispatch(params) {
      calls.push(["dispatch", params]);
      return { id: "new-task", status: "queued", ...params };
    },
    cancel(taskId, options) {
      calls.push(["cancel", taskId, options]);
      return { id: taskId, status: "cancelled" };
    },
    accept(taskId) {
      calls.push(["accept", taskId]);
      return { taskId, changesetStatus: "accepted", applied: true };
    },
    reject(taskId) {
      calls.push(["reject", taskId]);
      return { taskId, changesetStatus: "rejected" };
    },
    status(taskId) {
      calls.push(["status", taskId]);
      const task = byId.get(taskId);
      if (!task) throw new Error(`error: unknown task_id: ${taskId}\nhelp: run taskferry_list to see valid task ids`);
      return task;
    },
    taskDirectory(taskId) {
      calls.push(["taskDirectory", taskId]);
      const task = byId.get(taskId);
      if (!task) throw new Error(`error: unknown task id: ${taskId}\nhelp: run taskferry list to see valid task ids`);
      return task.directory;
    },
    async poll(taskId, options) {
      calls.push(["poll", taskId, options]);
      const delay = taskId === "slow" ? 30 : 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { id: taskId, status: "done" };
    },
    list() {
      calls.push(["list"]);
      return {
        counts: { queued: 0, running: 0, done: tasks.length, crashed: 0, cancelled: 0, unknown: 0 },
        tasks: tasks.length
          ? tasks.map(({ id, status, model = TEST_MODEL, startedAt = TEST_STARTED_AT, directory }) => ({ id, status, model, startedAt, directory }))
          : "none found (this server process's lifetime)",
      };
    },
    result(taskId, options) {
      calls.push(["result", taskId, options]);
      return { taskId, status: "done", message: "result" };
    },
    tail(taskId, options) {
      calls.push(["tail", taskId, options]);
      return { taskId, text: "tail" };
    },
    summarize(taskId, options) {
      calls.push(["summarize", taskId, options]);
      return { sourceTaskId: taskId, summary: "summary" };
    },
    advisor(params) {
      calls.push(["advisor", params]);
      return { status: "done", message: "advice" };
    },
    checkSummaryModelReady: checkSummaryModelReady ?? (async () => {}),
    setActivitySubscriptions() {},
  };

  return {
    factory(options) {
      // Real createTaskManager() always creates stateDir at construction
      // time; mirror that here so tests relying on stateDir already
      // existing (e.g. profiling's perf.log) match production behavior.
      fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
      capturedOptions = options;
      onEvent = options.onEvent;
      return manager;
    },
    emit(event) {
      onEvent(event);
    },
    get options() {
      return capturedOptions;
    },
    calls,
  };
}

async function openPeer(socketPath) {
  const socket = net.createConnection(socketPath);
  await EventEmitter.once(socket, "connect");
  let buffer = "";
  const pending = new Map();
  const events = [];
  const eventWaiters = [];

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    const handleLine = (line) => {
      const message = JSON.parse(line);
      if (message.type === "event") {
        events.push(message);
        for (const waiter of eventWaiters.splice(0)) waiter();
      } else {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    };
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) handleLine(line);
    }
  });

  return {
    socket,
    request(id, method, params = {}) {
      const response = new Promise((resolve) => pending.set(id, resolve));
      socket.write(`${JSON.stringify({ version: 1, id, method, params })}\n`);
      return response;
    },
    async waitForEvents(count) {
      while (events.length < count) {
        await new Promise((resolve) => eventWaiters.push(resolve));
      }
      return events.slice(0, count);
    },
    close() {
      socket.destroy();
    },
  };
}

describe("Unix socket daemon: workspace filtering", () => {
  test("filters list/context by workspace and builds context from list plus status", async (t) => {
    const paths = temporaryPaths(t);
    const otherDirectory = path.join(paths.root, "other");
    fs.mkdirSync(otherDirectory);
    const tasks = [
      { id: "here", status: "done", directory: paths.root, model: TEST_MODEL, startedAt: "2026-07-15T02:00:00.000Z" },
      { id: "there", status: "done", directory: otherDirectory, model: TEST_MODEL, startedAt: "2026-07-15T01:00:00.000Z" },
    ];
    const fake = fakeManagerFactory(tasks);
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const listed = await peer.request("list", "task.list", { directory: paths.root });
    const context = await peer.request("context", TASK_CONTEXT, { directory: paths.root });

    assert.deepEqual(listed.result.tasks.map((task) => task.id), ["here"]);
    assert.equal(listed.result.counts.done, 1);
    assert.equal(context.result.directory, fs.realpathSync(paths.root));
    assert.deepEqual(context.result.tasks.map((task) => task.id), ["here"]);
    assert.equal(context.result.tasks[0].directory, paths.root);
  });

  test("does not call manager.status() for tasks outside the requested workspace", async (t) => {
    const paths = temporaryPaths(t);
    const otherDirectory = path.join(paths.root, "other");
    fs.mkdirSync(otherDirectory);
    const tasks = [
      { id: "here", status: "done", directory: paths.root, model: TEST_MODEL, startedAt: "2026-07-15T02:00:00.000Z" },
      { id: "there-1", status: "done", directory: otherDirectory, model: TEST_MODEL, startedAt: "2026-07-15T01:00:00.000Z" },
      { id: "there-2", status: "done", directory: otherDirectory, model: TEST_MODEL, startedAt: TEST_STARTED_AT },
    ];
    const fake = fakeManagerFactory(tasks);
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    await peer.request("context", TASK_CONTEXT, { directory: paths.root });

    const statusCalls = fake.calls.filter((call) => call[0] === "status").map((call) => call[1]);
    assert.deepEqual(statusCalls, ["here"]);
  });

  test("supports multiple clients and multiple filtered subscriptions per connection", async (t) => {
    const paths = temporaryPaths(t);
    const otherDirectory = path.join(paths.root, "other");
    fs.mkdirSync(otherDirectory);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const first = await openPeer(paths.socketPath);
    const second = await openPeer(paths.socketPath);
    t.after(() => first.close());
    t.after(() => second.close());

    const firstHere = await first.request("sub-here", EVENT_SUBSCRIBE, { directory: paths.root });
    const firstThere = await first.request("sub-there", EVENT_SUBSCRIBE, { directory: otherDirectory });
    const secondHere = await second.request("sub-second", EVENT_SUBSCRIBE, { directory: paths.root });
    assert.notEqual(firstHere.result.subscriptionId, firstThere.result.subscriptionId);
    assert.notEqual(firstHere.result.subscriptionId, secondHere.result.subscriptionId);

    fake.emit({ type: TASK_STATE, taskId: "one", directory: paths.root, status: "running" });
    fake.emit({ type: TASK_STATE, taskId: "two", directory: otherDirectory, status: "done" });

    const firstEvents = await first.waitForEvents(2);
    const secondEvents = await second.waitForEvents(1);
    assert.deepEqual(firstEvents.map((message) => message.subscriptionId), [
      firstHere.result.subscriptionId,
      firstThere.result.subscriptionId,
    ]);
    assert.deepEqual(secondEvents.map((message) => message.event.taskId), ["one"]);
    assert.equal(daemon.stats().connections, 2);
    assert.equal(daemon.stats().subscriptions, 3);
  });

});

// The exact bug in taskferry#315: a dispatch that passed an explicit
// worktree `--directory` recorded that literal worktree path, and both
// task.list/task.context filtering and live event routing compared
// directories with a raw `===`, so a `--directory <main repo root>` watch
// was silently blind to it. These run without an injected resolveWorkspaceRoot
// -- startDaemon()'s real createWorkspaceRootResolver(), spawning real git --
// so they exercise the actual fix end to end, not a mocked comparison.
describe("Unix socket daemon: git-worktree-aware workspace matching (taskferry#315)", () => {
  test("task.list/task.context filtered by the main repo root also match a task dispatched into a linked worktree", async (t) => {
    const paths = temporaryPaths(t);
    const { mainRepo, worktree } = gitWorktreeFixture(t);
    const tasks = [
      { id: IN_WORKTREE_TASK_ID, status: "done", directory: worktree, model: TEST_MODEL, startedAt: TEST_STARTED_AT },
    ];
    const fake = fakeManagerFactory(tasks);
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const listed = await peer.request("list", "task.list", { directory: mainRepo });
    const context = await peer.request("context", TASK_CONTEXT, { directory: mainRepo });

    assert.deepEqual(listed.result.tasks.map((task) => task.id), [IN_WORKTREE_TASK_ID]);
    assert.deepEqual(context.result.tasks.map((task) => task.id), [IN_WORKTREE_TASK_ID]);
  });

  test("event.subscribe scoped to the main repo root also receives live events for a task dispatched into a linked worktree", async (t) => {
    const paths = temporaryPaths(t);
    const { mainRepo, worktree } = gitWorktreeFixture(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const sub = await peer.request("sub", EVENT_SUBSCRIBE, { directory: mainRepo });
    assert.equal(sub.ok, true);

    fake.emit({ type: TASK_STATE, taskId: IN_WORKTREE_TASK_ID, directory: worktree, status: "running" });
    const events = await peer.waitForEvents(1);
    assert.equal(events[0].event.taskId, IN_WORKTREE_TASK_ID);
  });

  test("does not cross-match two unrelated repos: a subscription for one repo's root does not receive the other repo's events", async (t) => {
    const paths = temporaryPaths(t);
    const { mainRepo: repoA } = gitWorktreeFixture(t);
    const { mainRepo: repoB } = gitWorktreeFixture(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    await peer.request("sub", EVENT_SUBSCRIBE, { directory: repoA });
    fake.emit({ type: TASK_STATE, taskId: "in-repo-a", directory: repoA, status: "running" });
    fake.emit({ type: TASK_STATE, taskId: "in-repo-b", directory: repoB, status: "running" });

    const events = await peer.waitForEvents(1);
    assert.deepEqual(events.map((message) => message.event.taskId), ["in-repo-a"]);
  });

  test("event.subscribe({ all: true }) receives every directory's events without a directory or taskId, and skips resolveWorkspaceRoot entirely", async (t) => {
    const paths = temporaryPaths(t);
    const otherDirectory = path.join(paths.root, "other");
    fs.mkdirSync(otherDirectory);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const sub = await peer.request("sub", EVENT_SUBSCRIBE, { all: true });
    assert.equal(sub.ok, true);

    fake.emit({ type: TASK_STATE, taskId: "one", directory: paths.root, status: "running" });
    fake.emit({ type: TASK_STATE, taskId: "two", directory: otherDirectory, status: "running" });

    const events = await peer.waitForEvents(2);
    assert.deepEqual(events.map((message) => message.event.taskId), ["one", "two"]);
  });
});

describe("Unix socket daemon: event subscription routing and teardown", () => {
  test("event.subscribe with taskId resolves the directory server-side, without a client-side task.status round-trip (issue #59)", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory([{ id: "one", status: "done", directory: paths.root }]);
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const sub = await peer.request("sub", EVENT_SUBSCRIBE, { taskId: "one" });
    assert.equal(sub.ok, true);
    assert.ok(sub.result.subscriptionId);

    fake.emit({ type: TASK_STATE, taskId: "one", directory: paths.root, status: "running" });
    const events = await peer.waitForEvents(1);
    assert.equal(events[0].event.taskId, "one");
  });

  test("event.subscribe rejects an unknown taskId", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory([]);
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const rejected = await peer.request("sub", EVENT_SUBSCRIBE, { taskId: "missing" });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error.message, /unknown task id/);
  });

  test("event.subscribe with summaries: true rejects upfront when the summary model isn't ready, without registering a subscription", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory([], {
      checkSummaryModelReady: async () => {
        throw new Error("error: summary model is unavailable: opencode/mimo-v2.5-free\nhelp: set TASKFERRY_SUMMARY_MODEL to an installed model, then retry taskferry_summary");
      },
    });
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const rejected = await peer.request("sub", EVENT_SUBSCRIBE, { directory: paths.root, summaries: true });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error.message, /summary model is unavailable/);

    // Confirm no subscription was actually registered: a plain (non-summaries)
    // subscribe still succeeds afterward, proving the daemon didn't crash or
    // wedge its subscription state on the earlier rejection.
    const plain = await peer.request("sub2", EVENT_SUBSCRIBE, { directory: paths.root });
    assert.equal(plain.ok, true);
    assert.ok(plain.result.subscriptionId);
  });

  test("event.subscribe with originSessionId only receives same-origin events, and origin-less events broadcast to everyone", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const first = await openPeer(paths.socketPath);
    const second = await openPeer(paths.socketPath);
    t.after(() => first.close());
    t.after(() => second.close());

    await first.request("sub-first", EVENT_SUBSCRIBE, { directory: paths.root, originSessionId: "sess-A" });
    await second.request("sub-second", EVENT_SUBSCRIBE, { directory: paths.root, originSessionId: "sess-B" });

    fake.emit({ type: TASK_STATE, taskId: "one", directory: paths.root, status: "running", originSessionId: "sess-A" });
    fake.emit({ type: TASK_STATE, taskId: "two", directory: paths.root, status: "running", originSessionId: "sess-B" });
    fake.emit({ type: TASK_STATE, taskId: "three", directory: paths.root, status: "done" });

    const firstEvents = await first.waitForEvents(2);
    const secondEvents = await second.waitForEvents(2);
    assert.deepEqual(firstEvents.map((message) => message.event.taskId), ["one", "three"]);
    assert.deepEqual(secondEvents.map((message) => message.event.taskId), ["two", "three"]);
  });

  test("routes each activity subscription its own summary variant from activityVariants", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const rawPeer = await openPeer(paths.socketPath);
    const summaryPeer = await openPeer(paths.socketPath);
    t.after(() => rawPeer.close());
    t.after(() => summaryPeer.close());

    const rawSub = await rawPeer.request("sub-raw", EVENT_SUBSCRIBE, { directory: paths.root });
    const summarySub = await summaryPeer.request("sub-summary", EVENT_SUBSCRIBE, { directory: paths.root, summaries: true });

    fake.emit({
      type: "task.activity",
      taskId: "oc_1",
      directory: paths.root,
      status: "running",
      activityVariants: {
        false: { includeSummary: false, activity: "raw narration", outputWatermark: 100 },
        true: { includeSummary: true, activity: "summarized narration", outputWatermark: 100 },
      },
    });

    const rawEvents = await rawPeer.waitForEvents(1);
    const summaryEvents = await summaryPeer.waitForEvents(1);

    assert.equal(rawEvents[0].event.activity, "raw narration");
    assert.equal(rawEvents[0].event.includeSummary, false);
    assert.equal(rawEvents[0].event.activityVariants, undefined);
    assert.equal(summaryEvents[0].event.activity, "summarized narration");
    assert.equal(summaryEvents[0].event.includeSummary, true);
    assert.equal(summaryEvents[0].event.activityVariants, undefined);
    assert.equal(rawEvents[0].subscriptionId, rawSub.result.subscriptionId);
    assert.equal(summaryEvents[0].subscriptionId, summarySub.result.subscriptionId);
  });

  test("skips a subscription when activityVariants lacks its requested variant", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const rawPeer = await openPeer(paths.socketPath);
    const summaryPeer = await openPeer(paths.socketPath);
    t.after(() => rawPeer.close());
    t.after(() => summaryPeer.close());

    await rawPeer.request("sub-raw", EVENT_SUBSCRIBE, { directory: paths.root });
    await summaryPeer.request("sub-summary", EVENT_SUBSCRIBE, { directory: paths.root, summaries: true });

    fake.emit({
      type: "task.activity",
      taskId: "oc_1",
      directory: paths.root,
      status: "running",
      activityVariants: {
        false: { includeSummary: false, activity: "raw only", outputWatermark: 50 },
      },
    });

    const rawEvents = await rawPeer.waitForEvents(1);
    assert.equal(rawEvents[0].event.activity, "raw only");

    const immediate = [];
    summaryPeer.socket.once("data", (chunk) => immediate.push(chunk));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(immediate.length, 0, "summary subscriber should not receive a raw-only variant");
  });

  test("cleans up all subscriptions when a client disconnects", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    await peer.request("sub", EVENT_SUBSCRIBE, { directory: paths.root });
    assert.equal(daemon.stats().subscriptions, 1);

    peer.socket.end();
    await EventEmitter.once(peer.socket, "close");

    assert.deepEqual(daemon.stats(), { connections: 0, subscriptions: 0 });
    assert.doesNotThrow(() => fake.emit({ type: TASK_STATE, directory: paths.root }));
  });

  test("disconnects a slow subscriber before its outbound queue can grow", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({
      ...paths,
      taskManagerFactory: fake.factory,
      maxOutboundBytes: 200,
    });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    await peer.request("sub", EVENT_SUBSCRIBE, { directory: paths.root });
    const closed = EventEmitter.once(peer.socket, "close");

    fake.emit({ type: TASK_STATE, taskId: "large-event", directory: paths.root, payload: "x".repeat(1000) });
    await closed;

    assert.deepEqual(daemon.stats(), { connections: 0, subscriptions: 0 });
  });

});
