import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSocket, removeStaleSocketIfUnchanged, startDaemon } from "./daemon.js";
import { connectClient, ensureDaemonStarted, startDaemonBooter } from "./client.js";
import { withFileLock } from "./state-lock.js";
import { resolveRuntimeDir } from "./paths.js";

// Explicitly resets the three profiling-related vars before applying
// per-test overrides, so an ambient TASKFERRY_PROFILING_ENABLED (etc.) set
// in the developer's own shell can't leak into these tests via the
// `...process.env` spread and flip their pass/fail outcome.
function profilingTestEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.TASKFERRY_PROFILING_ENABLED;
  delete env.TASKFERRY_SLOW_REQUEST_MS;
  delete env.TASKFERRY_PERF_LOG_MAX_BYTES;
  return { ...env, ...overrides };
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
          ? tasks.map(({ id, status, model = "test/model", startedAt = "2026-07-15T00:00:00.000Z", directory }) => ({ id, status, model, startedAt, directory }))
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
    // XDG_RUNTIME_DIR unexported but /run/user/<uid> genuinely exists: use it
    // rather than drifting to the state dir (the split-brain-daemon bug).
    assert.equal(
      resolveRuntimeDir({ env: {}, stateDir: "/state", uid: 1000, pathExists: () => true }),
      path.join("/run/user/1000", "taskferry")
    );
    // Only when /run/user/<uid> truly doesn't exist does it fall back.
    assert.equal(
      resolveRuntimeDir({ env: {}, stateDir: "/state", uid: 1000, pathExists: () => false }),
      path.join("/state", "run")
    );
    // No uid available at all (non-POSIX platform) also falls back. `null`,
    // not `undefined` -- an explicit `undefined` in a destructured param
    // re-triggers that param's default value instead of overriding it.
    assert.equal(resolveRuntimeDir({ env: {}, stateDir: "/state", uid: null }), path.join("/state", "run"));
  });

  test("rejects unsupported operating systems before touching the socket", async (t) => {
    const paths = temporaryPaths(t);
    await assert.rejects(() => startDaemon({ ...paths, platform: "win32" }), /Linux and macOS/);
    assert.equal(fs.existsSync(paths.socketPath), false);
  });

  describe("task.accept / task.reject", () => {
    test("task.accept invokes manager.accept(taskId)", async (t) => {
      const paths = temporaryPaths(t);
      const fake = fakeManagerFactory();
      const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
      t.after(() => daemon.close());
      const peer = await openPeer(paths.socketPath);
      t.after(() => peer.close());

      const response = await peer.request("accept", "task.accept", { taskId: "t1" });

      assert.equal(response.ok, true, response.error?.message);
      assert.deepEqual(fake.calls.at(-1), ["accept", "t1"]);
      assert.equal(response.result.changesetStatus, "accepted");
    });

    test("task.reject invokes manager.reject(taskId)", async (t) => {
      const paths = temporaryPaths(t);
      const fake = fakeManagerFactory();
      const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
      t.after(() => daemon.close());
      const peer = await openPeer(paths.socketPath);
      t.after(() => peer.close());

      const response = await peer.request("reject", "task.reject", { taskId: "t1" });

      assert.equal(response.ok, true, response.error?.message);
      assert.deepEqual(fake.calls.at(-1), ["reject", "t1"]);
      assert.equal(response.result.changesetStatus, "rejected");
    });
  });

  test("forwards an executor param on task.dispatch to manager.dispatch(params)", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    await peer.request("dispatch", "task.dispatch", { prompt: "hi", directory: paths.root, executor: "pi" });

    assert.deepEqual(fake.calls.at(-1), ["dispatch", { prompt: "hi", directory: paths.root, executor: "pi" }]);
  });

  test("forwards an executor param on task.advisor to manager.advisor({ executor })", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    await peer.request("advise", "task.advisor", { prompt: "hi", directory: paths.root, model: "m", executor: "pi" });

    const lastAdvisorCall = fake.calls.filter((call) => call[0] === "advisor").at(-1);
    assert.deepEqual(lastAdvisorCall, ["advisor", { prompt: "hi", directory: paths.root, model: "m", executor: "pi" }]);
  });

  test("forwards an env param on task.summary to manager.summarize", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    await peer.request("summarize", "task.summary", { taskId: "t1", env: { FOO: "bar" } });

    const lastSummarizeCall = fake.calls.filter((call) => call[0] === "summarize").at(-1);
    assert.deepEqual(lastSummarizeCall, ["summarize", "t1", { taskId: "t1", env: { FOO: "bar" } }]);
  });

  test("forwards the whole validated task.summary params object (not a field-list rebuild), so a new field the manager accepts rides through without a daemon.js change", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    await peer.request("summarize", "task.summary", { taskId: "t1", maxWords: 200, env: { FOO: "bar" } });

    const lastSummarizeCall = fake.calls.filter((call) => call[0] === "summarize").at(-1);
    assert.deepEqual(lastSummarizeCall, ["summarize", "t1", { taskId: "t1", maxWords: 200, env: { FOO: "bar" } }]);
  });

  test("forwards an env param on task.advisor to manager.advisor", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    await peer.request("advise", "task.advisor", { prompt: "hi", directory: paths.root, model: "m", env: { FOO: "bar" } });

    const lastAdvisorCall = fake.calls.filter((call) => call[0] === "advisor").at(-1);
    assert.deepEqual(lastAdvisorCall, ["advisor", { prompt: "hi", directory: paths.root, model: "m", env: { FOO: "bar" } }]);
  });

  test("forwards the whole validated task.advisor params object (not a field-list rebuild), so a new field the manager accepts rides through without a daemon.js change", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    await peer.request("advise", "task.advisor", { prompt: "hi", directory: paths.root, model: "m", variant: "high", timeoutMs: 30000 });

    const lastAdvisorCall = fake.calls.filter((call) => call[0] === "advisor").at(-1);
    assert.deepEqual(lastAdvisorCall, ["advisor", { prompt: "hi", directory: paths.root, model: "m", variant: "high", timeoutMs: 30000 }]);
  });

  test("propagates manager.advisor() errors through the RPC layer", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const baseFactory = fake.factory;
    const factory = (options) => {
      const manager = baseFactory(options);
      manager.advisor = () => {
        throw new Error("error: executor pi failed\nhelp: inspect the pi worker configuration");
      };
      return manager;
    };
    const daemon = await startDaemon({ ...paths, taskManagerFactory: factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const response = await peer.request("advise", "task.advisor", { prompt: "hi", directory: paths.root, model: "m", executor: "pi" });

    assert.equal(response.ok, false);
    assert.equal(response.error.code, "REQUEST_FAILED");
    assert.equal(response.error.message, "executor pi failed");
    assert.equal(response.error.help, "inspect the pi worker configuration");
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

  test("does not write perf.log or flag slow requests unless TASKFERRY_PROFILING_ENABLED=1", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({
      ...paths,
      env: profilingTestEnv({ TASKFERRY_SLOW_REQUEST_MS: "0" }),
      taskManagerFactory: fake.factory,
    });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    await peer.request("health-1", "system.health");

    assert.equal(fs.existsSync(path.join(paths.stateDir, "perf.log")), false);
  });

  test("enables profiling from config.json's profilingEnabled when the env var is unset", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({
      ...paths,
      env: profilingTestEnv(),
      taskManagerFactory: fake.factory,
      taskManagerOptions: { config: { profilingEnabled: true } },
    });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    await peer.request("health-1", "system.health");

    const perfLogPath = path.join(paths.stateDir, "perf.log");
    const lines = fs.readFileSync(perfLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.some((line) => line.method === "system.health"));
  });

  test("TASKFERRY_PROFILING_ENABLED=0 overrides a config.json profilingEnabled: true", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({
      ...paths,
      env: profilingTestEnv({ TASKFERRY_PROFILING_ENABLED: "0" }),
      taskManagerFactory: fake.factory,
      taskManagerOptions: { config: { profilingEnabled: true } },
    });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    await peer.request("health-1", "system.health");

    assert.equal(fs.existsSync(path.join(paths.stateDir, "perf.log")), false);
  });

  test("writes per-request latency to perf.log and flags slow requests via env threshold when enabled", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({
      ...paths,
      env: profilingTestEnv({ TASKFERRY_PROFILING_ENABLED: "1", TASKFERRY_SLOW_REQUEST_MS: "10" }),
      taskManagerFactory: fake.factory,
    });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const stderrChunks = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrChunks.push(String(chunk));
      return originalWrite(chunk, ...rest);
    };
    t.after(() => {
      process.stderr.write = originalWrite;
    });

    await peer.request("health-1", "system.health");
    await peer.request("slow-1", "task.wait", { taskId: "slow", timeoutMs: 100 });

    const perfLogPath = path.join(paths.stateDir, "perf.log");
    const lines = fs.readFileSync(perfLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.some((line) => line.method === "system.health" && line.ok === true));
    assert.ok(lines.some((line) => line.method === "task.wait" && line.durationMs >= 10));
    assert.ok(stderrChunks.some((chunk) => chunk.includes("slow request: task.wait")));
  });

  test("rotates perf.log to perf.log.1 once it would exceed TASKFERRY_PERF_LOG_MAX_BYTES", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({
      ...paths,
      env: profilingTestEnv({ TASKFERRY_PROFILING_ENABLED: "1", TASKFERRY_PERF_LOG_MAX_BYTES: "120" }),
      taskManagerFactory: fake.factory,
    });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    for (let i = 0; i < 5; i++) {
      await peer.request(`health-${i}`, "system.health");
    }

    const perfLogPath = path.join(paths.stateDir, "perf.log");
    const rotatedPath = `${perfLogPath}.1`;
    assert.ok(fs.existsSync(rotatedPath), "expected perf.log.1 to exist after rotation");
    assert.ok(fs.statSync(perfLogPath).size <= 120, "live perf.log should stay under the configured max");
  });

  test("falls back to the default max-bytes/slow-request-ms on a non-numeric env override instead of rotating every write", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({
      ...paths,
      env: profilingTestEnv({
        TASKFERRY_PROFILING_ENABLED: "1",
        TASKFERRY_PERF_LOG_MAX_BYTES: "garbage",
        TASKFERRY_SLOW_REQUEST_MS: "not-a-number",
      }),
      taskManagerFactory: fake.factory,
    });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    for (let i = 0; i < 5; i++) {
      await peer.request(`health-${i}`, "system.health");
    }

    const perfLogPath = path.join(paths.stateDir, "perf.log");
    assert.equal(fs.existsSync(`${perfLogPath}.1`), false, "a garbage max-bytes value must not rotate on every write");
    const lines = fs.readFileSync(perfLogPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 5, "all 5 requests should have accumulated in one file, not been rotated away individually");
  });

  test("reports ok:false when the response could not be delivered even though invoke() itself did not throw", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({
      ...paths,
      env: profilingTestEnv({ TASKFERRY_PROFILING_ENABLED: "1" }),
      taskManagerFactory: fake.factory,
      maxOutboundBytes: 1,
    });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    // The oversized-response write destroys the socket before a reply ever
    // arrives, so this request's promise never settles -- fire it without
    // awaiting and instead wait for the server-side write/destroy to happen.
    void peer.request("health-1", "system.health");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const perfLogPath = path.join(paths.stateDir, "perf.log");
    const lines = fs.readFileSync(perfLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const entry = lines.find((line) => line.method === "system.health");
    assert.ok(entry, "expected a perf.log entry for the oversized-response request");
    assert.equal(entry.ok, false, "ok should be false when writeMessage could not deliver the response");
  });

  test("times and logs SERVER_BUSY-rejected and malformed requests too, not just ones that reach invoke()", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({
      ...paths,
      env: profilingTestEnv({ TASKFERRY_PROFILING_ENABLED: "1" }),
      taskManagerFactory: fake.factory,
      maxInFlightRequests: 1,
    });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const slow = peer.request("slow-request", "task.wait", { taskId: "slow", timeoutMs: 100 });
    const rejected = await peer.request("overflow", "system.health");
    assert.equal(rejected.error.code, "SERVER_BUSY");
    await slow;
    peer.socket.write("not valid json\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const perfLogPath = path.join(paths.stateDir, "perf.log");
    const lines = fs.readFileSync(perfLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.some((line) => line.method === "system.health" && line.ok === false), "expected the SERVER_BUSY rejection to be logged");
    assert.ok(lines.some((line) => line.method === "parse_error" && line.ok === false), "expected the malformed request to be logged");
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

  test("does not call manager.status() for tasks outside the requested workspace", async (t) => {
    const paths = temporaryPaths(t);
    const otherDirectory = path.join(paths.root, "other");
    fs.mkdirSync(otherDirectory);
    const tasks = [
      { id: "here", status: "done", directory: paths.root, model: "test/model", startedAt: "2026-07-15T02:00:00.000Z" },
      { id: "there-1", status: "done", directory: otherDirectory, model: "test/model", startedAt: "2026-07-15T01:00:00.000Z" },
      { id: "there-2", status: "done", directory: otherDirectory, model: "test/model", startedAt: "2026-07-15T00:00:00.000Z" },
    ];
    const fake = fakeManagerFactory(tasks);
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    await peer.request("context", "task.context", { directory: paths.root });

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

  test("event.subscribe with taskId resolves the directory server-side, without a client-side task.status round-trip (issue #59)", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory([{ id: "one", status: "done", directory: paths.root }]);
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const sub = await peer.request("sub", "event.subscribe", { taskId: "one" });
    assert.equal(sub.ok, true);
    assert.ok(sub.result.subscriptionId);

    fake.emit({ type: "task.state", taskId: "one", directory: paths.root, status: "running" });
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

    const rejected = await peer.request("sub", "event.subscribe", { taskId: "missing" });
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

  test("prepareSocket backs off between retries instead of busy-spinning under sustained contention", async (t) => {
    // Regression test: a competing daemon boot that keeps replacing the
    // socket file (so removeStaleSocketIfUnchanged's CAS never wins) used to
    // make prepareSocket's retry loop spin as fast as socketHealth resolves
    // (sub-millisecond on a refused/missing socket), pegging a CPU core with
    // no backoff. Fabricate that contention deterministically instead of
    // racing real timers/files: each loop iteration does exactly 2
    // fs.statSync calls on the socket path (prepareSocket's own identity
    // check, then removeStaleSocketIfUnchanged's re-check). Make the first
    // `rounds` pairs return two *different* fabricated ctimeMs values each
    // (so the CAS always sees a mismatch and retries), then fall back to
    // the real, unmodified stat so the identity naturally matches and the
    // loop can finally converge. Assert real wall-clock time elapsed
    // roughly matches retryDelayMs * rounds rather than ~0ms.
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(paths.socketPath, "contender");
    const rounds = 5;
    const retryDelayMs = 20;
    let statCalls = 0;

    const originalStatSync = fs.statSync;
    t.mock.method(fs, "statSync", (target, ...rest) => {
      const real = originalStatSync(target, ...rest);
      if (target !== paths.socketPath) return real;
      statCalls++;
      if (statCalls <= rounds * 2) return { ...real, ctimeMs: statCalls };
      return real;
    });

    const started = Date.now();
    await prepareSocket(paths.runtimeDir, paths.socketPath, 250, retryDelayMs);
    const elapsedMs = Date.now() - started;

    assert.ok(statCalls > rounds * 2, `expected contention to force retries past round ${rounds}, only reached ${statCalls} stat calls`);
    assert.ok(
      elapsedMs >= retryDelayMs * rounds * 0.5,
      `expected backoff to make this take roughly ${retryDelayMs * rounds}ms+, took ${elapsedMs}ms`,
    );
  });

  test("prepareSocket backs off on a sustained ENOENT race between existsSync and statSync too", async (t) => {
    // The CAS-contention path above isn't the only way this loop can retry
    // fast: a competing process racing to delete/recreate the socket file
    // right between prepareSocket's existsSync check and its statSync call
    // hits the ENOENT catch branch instead, which used to `continue` straight
    // back to the top of the loop with no backoff at all. Fabricate that
    // race deterministically: existsSync always reports the file present,
    // but statSync throws ENOENT for the first `rounds` calls, then resolves
    // for real so the loop can converge.
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(paths.socketPath, "contender");
    const rounds = 5;
    const retryDelayMs = 20;
    let statCalls = 0;

    t.mock.method(fs, "existsSync", (target) => (target === paths.socketPath ? true : fs.existsSync(target)));
    const originalStatSync = fs.statSync;
    t.mock.method(fs, "statSync", (target, ...rest) => {
      if (target !== paths.socketPath) return originalStatSync(target, ...rest);
      statCalls++;
      if (statCalls <= rounds) {
        const error = new Error("ENOENT: no such file or directory");
        error.code = "ENOENT";
        throw error;
      }
      return originalStatSync(target, ...rest);
    });

    const started = Date.now();
    await prepareSocket(paths.runtimeDir, paths.socketPath, 250, retryDelayMs);
    const elapsedMs = Date.now() - started;

    assert.ok(statCalls > rounds, `expected the ENOENT race to force retries past round ${rounds}, only reached ${statCalls} stat calls`);
    assert.ok(
      elapsedMs >= retryDelayMs * rounds * 0.5,
      `expected backoff to make this take roughly ${retryDelayMs * rounds}ms+, took ${elapsedMs}ms`,
    );
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

  test("startDaemonBooter fires the injected spawn function once and returns without waiting on it", async (t) => {
    const paths = temporaryPaths(t);
    const spawnCalls = [];
    await startDaemonBooter({
      ...paths,
      spawnBooterFn: (args) => spawnCalls.push(args),
    });

    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(Object.keys(spawnCalls[0]).sort(), ["env", "runtimeDir", "socketPath", "stateDir"]);
    assert.equal(spawnCalls[0].socketPath, paths.socketPath);
  });

  test("startDaemonBooter clears a stale boot-error file before spawning", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const errorPath = path.join(paths.runtimeDir, "daemon-boot.err");
    fs.writeFileSync(errorPath, "stale failure from a previous boot attempt");

    await startDaemonBooter({ ...paths, spawnBooterFn: () => {} });

    assert.equal(fs.existsSync(errorPath), false);
  });

  test("client.js's direct-execution guard runs ensureDaemonStarted() when invoked through a symlink", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-client-symlink-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const realClient = fileURLToPath(new URL("./client.js", import.meta.url));
    const link = path.join(root, "taskferry-daemon-client");
    fs.symlinkSync(realClient, link, "file");

    // A malformed config.json makes ensureDaemonStarted() fail fast, so the
    // file's presence or absence proves whether the guard's symlink
    // resolution ran.
    const configHome = path.join(root, "config-home");
    fs.mkdirSync(path.join(configHome, "taskferry"), { recursive: true });
    fs.writeFileSync(path.join(configHome, "taskferry", "config.json"), "{ not valid json");
    const runtimeDir = path.join(root, "run");

    // The guard sets process.exitCode = 1 on this forced failure, so a
    // non-zero subprocess exit is the expected outcome, not a test failure.
    try {
      execFileSync(process.execPath, [link], {
        env: { ...process.env, XDG_CONFIG_HOME: configHome, TASKFERRY_RUNTIME_DIR: runtimeDir },
        encoding: "utf8",
      });
    } catch {
      // expected: see comment above.
    }

    const bootError = fs.readFileSync(path.join(runtimeDir, "daemon-boot.err"), "utf8");
    assert.match(bootError, /could not parse/);
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

  test("default auto-start fires a detached booter and does not block on its own boot completing", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const fake = fakeManagerFactory();
    let daemon;
    let spawnCalls = 0;
    const client = await connectClient({
      socketPath: paths.socketPath,
      stateDir: paths.stateDir,
      runtimeDir: paths.runtimeDir,
      retryDelayMs: 5,
      startupTimeoutMs: 500,
      spawnBooterFn: () => {
        spawnCalls++;
        // Stands in for the detached subprocess: starts the real daemon
        // well after connectClient's own auto-start call has returned, to
        // prove connectClient isn't blocked waiting on it in-process.
        setTimeout(() => {
          startDaemon({ ...paths, taskManagerFactory: fake.factory }).then((started) => { daemon = started; });
        }, 30);
      },
    });
    t.after(() => client.close());
    t.after(() => daemon?.close());

    assert.equal(spawnCalls, 1);
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

  test("includes a boot-error file's contents in the timeout error", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.runtimeDir, "daemon-boot.err"),
      "error: could not parse /fake/config.json: bad json\nhelp: fix it"
    );

    await assert.rejects(
      () => connectClient({
        socketPath: paths.socketPath,
        stateDir: paths.stateDir,
        runtimeDir: paths.runtimeDir,
        startupTimeoutMs: 20,
        retryDelayMs: 5,
        ensureDaemonFn: () => {},
      }),
      /daemon boot failed: error: could not parse \/fake\/config\.json/
    );
  });

  test("includes a booter-stderr log's contents in the timeout error when no boot-error file exists", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.runtimeDir, "daemon-boot-stderr.log"),
      "SyntaxError: Unexpected token 'x' in client.js\n    at Module._compile"
    );

    await assert.rejects(
      () => connectClient({
        socketPath: paths.socketPath,
        stateDir: paths.stateDir,
        runtimeDir: paths.runtimeDir,
        startupTimeoutMs: 20,
        retryDelayMs: 5,
        ensureDaemonFn: () => {},
      }),
      /booter subprocess failed before startup: SyntaxError: Unexpected token 'x' in client\.js/
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
