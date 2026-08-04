import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "./daemon.js";
import { connectClient, ensureDaemonStarted, startDaemonBooter } from "./client.js";
import { withFileLock } from "./state-lock.js";

const TEST_MODEL = "test/model";
const TASK_STATE = "task.state";
const DAEMON_BOOT_ERR = "daemon-boot.err";
const TEST_STARTED_AT = "2026-07-15T00:00:00.000Z";
const TASK_WAIT = "task.wait";
const SYSTEM_HEALTH = "system.health";

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

describe("multiplexed daemon client: request correlation, subscriptions, and auto-start", () => {
  test("correlates concurrent responses by id on one connection", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const client = await connectClient({ socketPath: paths.socketPath, autoStart: false });
    t.after(() => client.close());

    const slow = client.request(TASK_WAIT, { taskId: "slow", timeoutMs: 100 });
    const fast = client.request(TASK_WAIT, { taskId: "fast", timeoutMs: 100 });
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
    fake.emit({ type: TASK_STATE, taskId: "here", directory: paths.root });
    fake.emit({ type: TASK_STATE, taskId: "there", directory: otherDirectory });
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
    const errorPath = path.join(paths.runtimeDir, DAEMON_BOOT_ERR);
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

    const bootError = fs.readFileSync(path.join(runtimeDir, DAEMON_BOOT_ERR), "utf8");
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
    assert.equal((await client.request(SYSTEM_HEALTH)).healthy, true);
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
    assert.equal((await client.request(SYSTEM_HEALTH)).healthy, true);
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

});

describe("multiplexed daemon client: boot-failure reporting and malformed messages", () => {
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
      path.join(paths.runtimeDir, DAEMON_BOOT_ERR),
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

    await assert.rejects(() => client.request(SYSTEM_HEALTH), /exceeds 32 bytes/);
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

    await assert.rejects(() => client.request(SYSTEM_HEALTH), /invalid event envelope/);
  });

  test("rejects non-object daemon messages", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const server = net.createServer((socket) => socket.once("data", () => socket.end("null\n")));
    await new Promise((resolve) => server.listen(paths.socketPath, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const client = await connectClient({ socketPath: paths.socketPath, autoStart: false });
    t.after(() => client.close());

    await assert.rejects(() => client.request(SYSTEM_HEALTH), /invalid daemon message/);
  });
});
