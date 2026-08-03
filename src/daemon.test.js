import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { prepareSocket, removeStaleSocketIfUnchanged, startDaemon } from "./daemon.js";
import { resolveRuntimeDir } from "./paths.js";

const TEST_MODEL = "test/model";
const TASK_ADVISOR = "task.advisor";
const SYSTEM_HEALTH = "system.health";
const TEST_STARTED_AT = "2026-07-15T00:00:00.000Z";
const TASK_WAIT = "task.wait";
const TASK_STATUS = "task.status";
const SLOW_REQUEST_ID = "slow-request";

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

    await peer.request("advise", TASK_ADVISOR, { prompt: "hi", directory: paths.root, model: "m", executor: "pi" });

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

    await peer.request("advise", TASK_ADVISOR, { prompt: "hi", directory: paths.root, model: "m", env: { FOO: "bar" } });

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

    await peer.request("advise", TASK_ADVISOR, { prompt: "hi", directory: paths.root, model: "m", variant: "high", timeoutMs: 30000 });

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

    const response = await peer.request("advise", TASK_ADVISOR, { prompt: "hi", directory: paths.root, model: "m", executor: "pi" });

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
    const health = await peer.request("health", SYSTEM_HEALTH);
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

});

describe("Unix socket daemon: concurrency", () => {
  test("multiplexes concurrent out-of-order responses on one connection", async (t) => {
      const paths = temporaryPaths(t);
      const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const slow = peer.request(SLOW_REQUEST_ID, TASK_WAIT, { taskId: "slow", timeoutMs: 100 });
    const fast = peer.request("fast-request", TASK_WAIT, { taskId: "fast", timeoutMs: 100 });
    const first = await Promise.race([slow, fast]);

    assert.equal(first.id, "fast-request");
    assert.equal((await slow).id, SLOW_REQUEST_ID);
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

    const slow = peer.request("slow", TASK_WAIT, { taskId: "slow", timeoutMs: 100 });
    const rejected = await peer.request("overflow", SYSTEM_HEALTH);

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "SERVER_BUSY");
    assert.equal((await slow).ok, true);
  });
});

describe("Unix socket daemon: profiling (env/config toggles and rotation)", () => {
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

    await peer.request("health-1", SYSTEM_HEALTH);

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

    await peer.request("health-1", SYSTEM_HEALTH);

    const perfLogPath = path.join(paths.stateDir, "perf.log");
    const lines = fs.readFileSync(perfLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.some((line) => line.method === SYSTEM_HEALTH));
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

    await peer.request("health-1", SYSTEM_HEALTH);

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

    await peer.request("health-1", SYSTEM_HEALTH);
    await peer.request("slow-1", TASK_WAIT, { taskId: "slow", timeoutMs: 100 });

    const perfLogPath = path.join(paths.stateDir, "perf.log");
    const lines = fs.readFileSync(perfLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.some((line) => line.method === SYSTEM_HEALTH && line.ok === true));
    assert.ok(lines.some((line) => line.method === TASK_WAIT && line.durationMs >= 10));
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
      await peer.request(`health-${i}`, SYSTEM_HEALTH);
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
      await peer.request(`health-${i}`, SYSTEM_HEALTH);
    }

    const perfLogPath = path.join(paths.stateDir, "perf.log");
    assert.equal(fs.existsSync(`${perfLogPath}.1`), false, "a garbage max-bytes value must not rotate on every write");
    const lines = fs.readFileSync(perfLogPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 5, "all 5 requests should have accumulated in one file, not been rotated away individually");
  });
});

describe("Unix socket daemon: profiling (request-timing edge cases)", () => {
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
    void peer.request("health-1", SYSTEM_HEALTH);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const perfLogPath = path.join(paths.stateDir, "perf.log");
    const lines = fs.readFileSync(perfLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const entry = lines.find((line) => line.method === SYSTEM_HEALTH);
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

    const slow = peer.request(SLOW_REQUEST_ID, TASK_WAIT, { taskId: "slow", timeoutMs: 100 });
    const rejected = await peer.request("overflow", SYSTEM_HEALTH);
    assert.equal(rejected.error.code, "SERVER_BUSY");
    await slow;
    peer.socket.write("not valid json\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const perfLogPath = path.join(paths.stateDir, "perf.log");
    const lines = fs.readFileSync(perfLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.some((line) => line.method === SYSTEM_HEALTH && line.ok === false), "expected the SERVER_BUSY rejection to be logged");
    assert.ok(lines.some((line) => line.method === "parse_error" && line.ok === false), "expected the malformed request to be logged");
  });

  test("records ok:true for an error response that was successfully delivered, not just ok:false on any thrown exception", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({
      ...paths,
      env: profilingTestEnv({ TASKFERRY_PROFILING_ENABLED: "1" }),
      taskManagerFactory: fake.factory,
    });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const response = await peer.request("bad-task", TASK_STATUS, { taskId: "does-not-exist" });
    assert.equal(response.ok, false, "the RPC response itself should still report the error");

    const perfLogPath = path.join(paths.stateDir, "perf.log");
    const lines = fs.readFileSync(perfLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const entry = lines.find((line) => line.method === TASK_STATUS);
    assert.ok(entry, "expected a perf.log entry for the unknown-task request");
    assert.equal(entry.ok, true, "ok should be true once the error response was actually delivered over a healthy socket");
  });

  test("falls back to the default slow-request-ms on an empty-string env override instead of flagging every request as slow", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({
      ...paths,
      env: profilingTestEnv({ TASKFERRY_PROFILING_ENABLED: "1", TASKFERRY_SLOW_REQUEST_MS: "" }),
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

    await peer.request("health-1", SYSTEM_HEALTH);

    assert.ok(!stderrChunks.some((chunk) => chunk.includes("slow request:")), "an empty-string threshold must fall back to the default, not become 0");
  });

  test("times and logs oversized/unterminated buffers too, not just parseable request lines", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({
      ...paths,
      env: profilingTestEnv({ TASKFERRY_PROFILING_ENABLED: "1" }),
      taskManagerFactory: fake.factory,
    });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    peer.socket.write("x".repeat(1024 * 1024 + 1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const perfLogPath = path.join(paths.stateDir, "perf.log");
    const lines = fs.readFileSync(perfLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.some((line) => line.method === "request_too_large" && line.ok === false), "expected the oversized buffer to be logged");
  });
});

describe("Unix socket daemon: stale sockets", () => {
  test("removes a stale socket only after a refused health check", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(paths.socketPath, "stale");
    const fake = fakeManagerFactory();

    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());

    assert.equal(fs.statSync(paths.socketPath).isSocket(), true);
    const peer = await openPeer(paths.socketPath);
    assert.equal((await peer.request("health", SYSTEM_HEALTH)).ok, true);
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
});

describe("Unix socket daemon: rehydration and self-restart", () => {
  test("rehydrates persisted queued/running tasks as unknown through createTaskManager", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const persisted = ["queued", "running"].map((status, index) => ({
      status,
      id: `old-${index}`,
      directory: paths.root,
      model: TEST_MODEL,
      variant: null,
      sessionId: null,
      pid: 100 + index,
      startedAt: TEST_STARTED_AT,
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

    const statuses = await Promise.all(persisted.map((task, index) => peer.request(`status-${index}`, TASK_STATUS, { taskId: task.id })));
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

      await peer.request("health", SYSTEM_HEALTH);
      await peer.request("health-2", SYSTEM_HEALTH);

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

      await peer.request("health", SYSTEM_HEALTH);
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

      await peer.request("health", SYSTEM_HEALTH);
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(spawnCalls.length, 0, "must not restart while a task is still running");
      assert.equal(exitCalls, 0);
      assert.equal(fs.existsSync(paths.socketPath), true);
    });
  });
});
