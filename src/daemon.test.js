import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { removeStaleSocketIfUnchanged, startDaemon } from "./daemon.js";
import { connectClient, ensureDaemonStarted } from "./client.js";
import { withFileLock } from "./state-lock.js";
import { resolveRuntimeDir } from "./paths.js";

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
    status(taskId) {
      calls.push(["status", taskId]);
      const task = byId.get(taskId);
      if (!task) throw new Error(`error: unknown task_id: ${taskId}\nhelp: run taskferry_list to see valid task ids`);
      return task;
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
          ? tasks.map(({ id, status, model = "test/model", startedAt = "2026-07-15T00:00:00.000Z" }) => ({ id, status, model, startedAt }))
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
      capturedOptions = options;
      onEvent = options.onEvent;
      return manager;
    },
    calls,
    emit(event) {
      onEvent(event);
    },
    get options() {
      return capturedOptions;
    },
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
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.type === "event") {
        events.push(message);
        for (const waiter of eventWaiters.splice(0)) waiter();
      } else {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
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

describe("Unix socket daemon", () => {
  test("resolves runtime directories in the required precedence order", () => {
    assert.equal(resolveRuntimeDir({ env: { TASKFERRY_RUNTIME_DIR: "/explicit", XDG_RUNTIME_DIR: "/xdg" }, stateDir: "/state" }), "/explicit");
    assert.equal(resolveRuntimeDir({ env: { XDG_RUNTIME_DIR: "/xdg" }, stateDir: "/state" }), path.join("/xdg", "taskferry"));
    assert.equal(resolveRuntimeDir({ env: {}, stateDir: "/state" }), path.join("/state", "run"));
  });

  test("rejects unsupported operating systems before touching the socket", async (t) => {
    const paths = temporaryPaths(t);
    await assert.rejects(() => startDaemon({ ...paths, platform: "win32" }), /Linux and macOS/);
    assert.equal(fs.existsSync(paths.socketPath), false);
  });

  test("creates protected runtime/socket paths and serves ordinary requests", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());

    assert.equal(fs.statSync(paths.runtimeDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(paths.socketPath).mode & 0o777, 0o600);

    const peer = await openPeer(paths.socketPath);
    const health = await peer.request("health", "system.health");
    const dispatched = await peer.request("dispatch", "task.dispatch", { prompt: "hello", directory: paths.root });
    peer.close();

    assert.equal(health.ok, true);
    assert.deepEqual(health.result, { healthy: true, pid: process.pid, version: 1 });
    assert.equal(dispatched.result.id, "new-task");
    assert.deepEqual(fake.calls.at(-1), ["dispatch", { prompt: "hello", directory: paths.root }]);
  });

  test("passes runtimeDir through to the task manager factory", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());

    assert.equal(fake.options.runtimeDir, paths.runtimeDir);
  });

  test("multiplexes concurrent out-of-order responses on one connection", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const slow = peer.request("slow-request", "task.wait", { taskId: "slow", timeoutMs: 100 });
    const fast = peer.request("fast-request", "task.wait", { taskId: "fast", timeoutMs: 100 });
    const first = await Promise.race([slow, fast]);

    assert.equal(first.id, "fast-request");
    assert.equal((await slow).id, "slow-request");
    assert.ok(fake.calls.some((call) => call[0] === "poll"));
  });

  test("caps globally in-flight requests so disconnected waits stay bounded", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({
      ...paths,
      taskManagerFactory: fake.factory,
      maxInFlightRequests: 1,
    });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const slow = peer.request("slow", "task.wait", { taskId: "slow", timeoutMs: 100 });
    const rejected = await peer.request("overflow", "system.health");

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "SERVER_BUSY");
    assert.equal((await slow).ok, true);
  });

  test("filters list/context by workspace and builds context from list plus status", async (t) => {
    const paths = temporaryPaths(t);
    const otherDirectory = path.join(paths.root, "other");
    fs.mkdirSync(otherDirectory);
    const tasks = [
      { id: "here", status: "done", directory: paths.root, model: "test/model", startedAt: "2026-07-15T02:00:00.000Z" },
      { id: "there", status: "done", directory: otherDirectory, model: "test/model", startedAt: "2026-07-15T01:00:00.000Z" },
    ];
    const fake = fakeManagerFactory(tasks);
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const listed = await peer.request("list", "task.list", { directory: paths.root });
    const context = await peer.request("context", "task.context", { directory: paths.root });

    assert.deepEqual(listed.result.tasks.map((task) => task.id), ["here"]);
    assert.equal(listed.result.counts.done, 1);
    assert.equal(context.result.directory, fs.realpathSync(paths.root));
    assert.deepEqual(context.result.tasks.map((task) => task.id), ["here"]);
    assert.equal(context.result.tasks[0].directory, paths.root);
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

    const firstHere = await first.request("sub-here", "event.subscribe", { directory: paths.root });
    const firstThere = await first.request("sub-there", "event.subscribe", { directory: otherDirectory });
    const secondHere = await second.request("sub-second", "event.subscribe", { directory: paths.root });
    assert.notEqual(firstHere.result.subscriptionId, firstThere.result.subscriptionId);
    assert.notEqual(firstHere.result.subscriptionId, secondHere.result.subscriptionId);

    fake.emit({ type: "task.state", taskId: "one", directory: paths.root, status: "running" });
    fake.emit({ type: "task.state", taskId: "two", directory: otherDirectory, status: "done" });

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

  test("event.subscribe with summaries: true rejects upfront when the summary model isn't ready, without registering a subscription", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory([], {
      checkSummaryModelReady: async () => {
        throw new Error("error: summary model is unavailable: opencode/hy3-free\nhelp: set TASKFERRY_SUMMARY_MODEL to an installed model, then retry taskferry_summary");
      },
    });
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const rejected = await peer.request("sub", "event.subscribe", { directory: paths.root, summaries: true });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error.message, /summary model is unavailable/);

    // Confirm no subscription was actually registered: a plain (non-summaries)
    // subscribe still succeeds afterward, proving the daemon didn't crash or
    // wedge its subscription state on the earlier rejection.
    const plain = await peer.request("sub2", "event.subscribe", { directory: paths.root });
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

    await first.request("sub-first", "event.subscribe", { directory: paths.root, originSessionId: "sess-A" });
    await second.request("sub-second", "event.subscribe", { directory: paths.root, originSessionId: "sess-B" });

    fake.emit({ type: "task.state", taskId: "one", directory: paths.root, status: "running", originSessionId: "sess-A" });
    fake.emit({ type: "task.state", taskId: "two", directory: paths.root, status: "running", originSessionId: "sess-B" });
    fake.emit({ type: "task.state", taskId: "three", directory: paths.root, status: "done" });

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

    const rawSub = await rawPeer.request("sub-raw", "event.subscribe", { directory: paths.root });
    const summarySub = await summaryPeer.request("sub-summary", "event.subscribe", { directory: paths.root, summaries: true });

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

    await rawPeer.request("sub-raw", "event.subscribe", { directory: paths.root });
    await summaryPeer.request("sub-summary", "event.subscribe", { directory: paths.root, summaries: true });

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
    await peer.request("sub", "event.subscribe", { directory: paths.root });
    assert.equal(daemon.stats().subscriptions, 1);

    peer.socket.end();
    await EventEmitter.once(peer.socket, "close");

    assert.deepEqual(daemon.stats(), { connections: 0, subscriptions: 0 });
    assert.doesNotThrow(() => fake.emit({ type: "task.state", directory: paths.root }));
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
    await peer.request("sub", "event.subscribe", { directory: paths.root });
    const closed = EventEmitter.once(peer.socket, "close");

    fake.emit({ type: "task.state", taskId: "large-event", directory: paths.root, payload: "x".repeat(1000) });
    await closed;

    assert.deepEqual(daemon.stats(), { connections: 0, subscriptions: 0 });
  });

  test("removes a stale socket only after a refused health check", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(paths.socketPath, "stale");
    const fake = fakeManagerFactory();

    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());

    assert.equal(fs.statSync(paths.socketPath).isSocket(), true);
    const peer = await openPeer(paths.socketPath);
    assert.equal((await peer.request("health", "system.health")).ok, true);
    peer.close();
  });

  test("does not unlink a socket path replaced after the health check", (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(paths.socketPath, "stale");
    const checkedIdentity = fs.statSync(paths.socketPath);
    fs.unlinkSync(paths.socketPath);
    fs.writeFileSync(paths.socketPath, "replacement");

    assert.equal(removeStaleSocketIfUnchanged(paths.socketPath, checkedIdentity, paths.runtimeDir), false);
    assert.equal(fs.readFileSync(paths.socketPath, "utf8"), "replacement");
  });

  test("preserves a socket when a listener accepts the health check", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const incumbent = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write(`${JSON.stringify({ version: 1, id: "health-check", ok: true, result: { healthy: true } })}\n`);
      });
    });
    await new Promise((resolve, reject) => incumbent.listen(paths.socketPath, (error) => error ? reject(error) : resolve()));
    t.after(() => new Promise((resolve) => incumbent.close(resolve)));

    await assert.rejects(
      () => startDaemon({ ...paths, taskManagerFactory: fakeManagerFactory().factory, healthCheckTimeoutMs: 50 }),
      /already listening/
    );
    assert.equal(fs.existsSync(paths.socketPath), true);
  });

  test("rehydrates persisted queued/running tasks as unknown through createTaskManager", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const persisted = ["queued", "running"].map((status, index) => ({
      id: `old-${index}`,
      status,
      directory: paths.root,
      model: "test/model",
      variant: null,
      sessionId: null,
      pid: 100 + index,
      startedAt: "2026-07-15T00:00:00.000Z",
      endedAt: null,
      exitCode: null,
      signal: null,
      logPath: path.join(paths.stateDir, `old-${index}.ndjson`),
      promptPreview: "old",
      spawnError: null,
      cancelRequested: false,
      internal: false,
    }));
    fs.writeFileSync(path.join(paths.stateDir, "tasks.json"), JSON.stringify(persisted));
    const daemon = await startDaemon(paths);
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const statuses = await Promise.all(persisted.map((task, index) => peer.request(`status-${index}`, "task.status", { taskId: task.id })));
    assert.deepEqual(statuses.map((response) => response.result.status), ["unknown", "unknown"]);
  });

  describe("self-restart on source change", () => {
    function sourceFixture(t) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-daemon-source-"));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const entry = path.join(dir, "daemon.js");
      fs.writeFileSync(entry, "// fixture entry, never actually executed by these tests\n");
      return { dir, entry };
    }

    test("does not restart while source is unchanged, even with a spawn stub wired up", async (t) => {
      const paths = temporaryPaths(t);
      const { dir, entry } = sourceFixture(t);
      const fake = fakeManagerFactory();
      const spawnCalls = [];
      const daemon = await startDaemon({
        ...paths,
        taskManagerFactory: fake.factory,
        sourceDir: dir,
        daemonEntry: entry,
        spawnReplacement: (args) => spawnCalls.push(args),
      });
      t.after(() => daemon.close());
      const peer = await openPeer(paths.socketPath);
      t.after(() => peer.close());

      await peer.request("health", "system.health");
      await peer.request("health-2", "system.health");

      assert.equal(spawnCalls.length, 0);
    });

    test("restarts immediately when idle and a source file changes after startup", async (t) => {
      const paths = temporaryPaths(t);
      const { dir, entry } = sourceFixture(t);
      const fake = fakeManagerFactory();
      const spawnCalls = [];
      let exitCalls = 0;
      const daemon = await startDaemon({
        ...paths,
        taskManagerFactory: fake.factory,
        sourceDir: dir,
        daemonEntry: entry,
        spawnReplacement: (args) => spawnCalls.push(args),
        exitProcess: () => { exitCalls++; },
      });
      t.after(() => daemon.close());
      const peer = await openPeer(paths.socketPath);

      // Bump mtime forward unambiguously — same-millisecond edits on a fast
      // filesystem could otherwise leave mtimeMs unchanged.
      const bumped = new Date(Date.now() + 60_000);
      fs.utimesSync(entry, bumped, bumped);

      await peer.request("health", "system.health");
      // The restart itself is async (close() + spawn + exit); give it a tick.
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0].daemonEntry, entry);
      assert.equal(exitCalls, 1);
      assert.equal(fs.existsSync(paths.socketPath), false);
      peer.close();
    });

    test("defers restart until no tasks are running or queued", async (t) => {
      const paths = temporaryPaths(t);
      const { dir, entry } = sourceFixture(t);
      const busyManagerFactory = () => ({
        list: () => ({ counts: { queued: 0, running: 1, done: 0, crashed: 0, cancelled: 0, unknown: 0 }, tasks: [] }),
        status: () => { throw new Error("unused"); },
      });
      const spawnCalls = [];
      let exitCalls = 0;
      const daemon = await startDaemon({
        ...paths,
        taskManagerFactory: busyManagerFactory,
        sourceDir: dir,
        daemonEntry: entry,
        spawnReplacement: (args) => spawnCalls.push(args),
        exitProcess: () => { exitCalls++; },
      });
      t.after(() => daemon.close());
      const peer = await openPeer(paths.socketPath);
      t.after(() => peer.close());

      const bumped = new Date(Date.now() + 60_000);
      fs.utimesSync(entry, bumped, bumped);

      await peer.request("health", "system.health");
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(spawnCalls.length, 0, "must not restart while a task is still running");
      assert.equal(exitCalls, 0);
      assert.equal(fs.existsSync(paths.socketPath), true);
    });
  });
});

describe("multiplexed daemon client", () => {
  test("correlates concurrent responses by id on one connection", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const client = await connectClient({ socketPath: paths.socketPath, autoStart: false });
    t.after(() => client.close());

    const slow = client.request("task.wait", { taskId: "slow", timeoutMs: 100 });
    const fast = client.request("task.wait", { taskId: "fast", timeoutMs: 100 });
    const first = await Promise.race([
      slow.then((result) => ({ name: "slow", result })),
      fast.then((result) => ({ name: "fast", result })),
    ]);

    assert.equal(first.name, "fast");
    assert.deepEqual(await slow, { id: "slow", status: "done" });
  });

  test("routes multiple event subscriptions independently on the shared connection", async (t) => {
    const paths = temporaryPaths(t);
    const otherDirectory = path.join(paths.root, "other");
    fs.mkdirSync(otherDirectory);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const client = await connectClient({ socketPath: paths.socketPath, autoStart: false });
    t.after(() => client.close());
    const hereEvents = [];
    const thereEvents = [];

    const hereSubscription = await client.subscribe({ directory: paths.root }, (event) => hereEvents.push(event));
    const thereSubscription = await client.subscribe({ directory: otherDirectory }, (event) => thereEvents.push(event));
    fake.emit({ type: "task.state", taskId: "here", directory: paths.root });
    fake.emit({ type: "task.state", taskId: "there", directory: otherDirectory });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.notEqual(hereSubscription, thereSubscription);
    assert.deepEqual(hereEvents.map((event) => event.taskId), ["here"]);
    assert.deepEqual(thereEvents.map((event) => event.taskId), ["there"]);
  });

  test("auto-starts after an initial connection failure and retries", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    let daemon;
    let starts = 0;
    const client = await connectClient({
      socketPath: paths.socketPath,
      stateDir: paths.stateDir,
      runtimeDir: paths.runtimeDir,
      retryDelayMs: 5,
      startupTimeoutMs: 500,
      ensureDaemonFn: async () => {
        starts++;
        daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
      },
    });
    t.after(() => client.close());
    t.after(() => daemon.close());

    assert.equal(starts, 1);
    assert.equal((await client.request("system.health")).healthy, true);
  });

  test("uses withFileLock so racing auto-start attempts spawn only one daemon", (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    let ready = false;
    let spawns = 0;
    let lockCalls = 0;
    const options = {
      ...paths,
      env: { ...process.env, XDG_CONFIG_HOME: path.join(paths.root, "config") },
      startupTimeoutMs: 100,
      retryDelayMs: 1,
      withLockFn(lockPath, callback, lockOptions) {
        lockCalls++;
        return withFileLock(lockPath, callback, lockOptions);
      },
      isDaemonReadySync: () => ready,
      spawnDaemonFn: () => {
        spawns++;
        ready = true;
      },
    };

    assert.equal(ensureDaemonStarted(options), true);
    assert.equal(ensureDaemonStarted(options), false);
    assert.equal(lockCalls, 2);
    assert.equal(spawns, 1);
    assert.equal(fs.existsSync(path.join(paths.runtimeDir, "daemon-start.lock")), false);
  });

  test("propagates a loadConfig() error without calling spawnDaemonFn", (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    let spawns = 0;
    const options = {
      ...paths,
      startupTimeoutMs: 100,
      retryDelayMs: 1,
      isDaemonReadySync: () => false,
      spawnDaemonFn: () => {
        spawns++;
      },
      loadConfigFn: () => {
        throw new Error("error: could not parse /fake/config.json: bad json\nhelp: fix it");
      },
    };

    assert.throws(() => ensureDaemonStarted(options), /error: could not parse \/fake\/config\.json/);
    assert.equal(spawns, 0);
  });

  test("reports bounded startup failures with actionable help", async (t) => {
    const paths = temporaryPaths(t);
    await assert.rejects(
      () => connectClient({
        socketPath: paths.socketPath,
        stateDir: paths.stateDir,
        runtimeDir: paths.runtimeDir,
        startupTimeoutMs: 20,
        retryDelayMs: 5,
        ensureDaemonFn: () => {},
      }),
      /error: taskferry daemon did not become ready.*help:/s
    );
  });

  test("rejects oversized unterminated daemon messages", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const server = net.createServer((socket) => socket.once("data", () => socket.end("x".repeat(64))));
    await new Promise((resolve) => server.listen(paths.socketPath, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const client = await connectClient({ socketPath: paths.socketPath, autoStart: false, maxBufferBytes: 32 });
    t.after(() => client.close());

    await assert.rejects(() => client.request("system.health"), /exceeds 32 bytes/);
  });

  test("rejects malformed daemon event envelopes instead of queueing them", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const server = net.createServer((socket) => socket.once("data", (chunk) => {
      const request = JSON.parse(String(chunk).trim());
      socket.write(`${JSON.stringify({ version: 1, type: "event", event: {} })}\n`);
      socket.write(`${JSON.stringify({ version: 1, id: request.id, ok: true, result: { healthy: true } })}\n`);
    }));
    await new Promise((resolve) => server.listen(paths.socketPath, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const client = await connectClient({ socketPath: paths.socketPath, autoStart: false });
    t.after(() => client.close());

    await assert.rejects(() => client.request("system.health"), /invalid event envelope/);
  });

  test("rejects non-object daemon messages", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const server = net.createServer((socket) => socket.once("data", () => socket.end("null\n")));
    await new Promise((resolve) => server.listen(paths.socketPath, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const client = await connectClient({ socketPath: paths.socketPath, autoStart: false });
    t.after(() => client.close());

    await assert.rejects(() => client.request("system.health"), /invalid daemon message/);
  });
});
