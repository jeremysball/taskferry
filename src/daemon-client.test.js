import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "./daemon.js";
import { connectClient, ensureDaemonStarted, resolveDaemonSupervisor, startDaemonBooter, startDaemonViaSystemd } from "./client.js";
import { withFileLock } from "./state-lock.js";

// These tests exercise detached startup in isolated directories; never let a
// host's enabled user unit take ownership of a test daemon.
process.env.TASKFERRY_DAEMON_SUPERVISOR = "spawn";

const TEST_MODEL = "test/model";
const TASK_STATE = "task.state";
const DAEMON_BOOT_ERR = "daemon-boot.err";
const PRESERVED_LOG_CONTENT = "preserve me";
const TEST_STARTED_AT = "2026-07-15T00:00:00.000Z";
const TASK_WAIT = "task.wait";
const SYSTEM_HEALTH = "system.health";
const CHECK_GATE_FAILURE_DETAIL = `error: check gate failed for t1
  command: npm test (from .taskferry.toml)
  exit: 1
  output tail:
    2 tests failed
changeset NOT accepted. To fix forward, resume the worker session:
  taskferry dispatch --session-id ses_1 --parent-task t1 \\
    --prompt "Fix: check gate failed. See taskferry result t1 --fields checkOutputTail"`;

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

  test("preserves a multi-line manager failure through the daemon-client RPC round trip", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const managerFactory = (options) => {
      const manager = fake.factory(options);
      manager.accept = () => { throw new Error(CHECK_GATE_FAILURE_DETAIL); };
      return manager;
    };
    const daemon = await startDaemon({ ...paths, taskManagerFactory: managerFactory });
    t.after(() => daemon.close());
    const client = await connectClient({ socketPath: paths.socketPath, autoStart: false });
    t.after(() => client.close());

    await assert.rejects(
      () => client.request("task.accept", { taskId: "t1" }),
      (error) => {
        assert.equal(error.code, "REQUEST_FAILED");
        assert.equal(error.message, CHECK_GATE_FAILURE_DETAIL);
        assert.match(error.message, /output tail:\n {4}2 tests failed/);
        assert.match(error.message, /taskferry dispatch --session-id ses_1 --parent-task t1/);
        return true;
      }
    );
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

});

describe("multiplexed daemon client: daemon launch diagnostics", () => {
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

  test("startDaemonBooter preserves a stale boot-error file", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const errorPath = path.join(paths.runtimeDir, DAEMON_BOOT_ERR);
    fs.writeFileSync(errorPath, "stale failure from a previous boot attempt");
    await startDaemonBooter({ ...paths, spawnBooterFn: () => {} });
    assert.equal(fs.readFileSync(errorPath, "utf8"), "stale failure from a previous boot attempt");
  });

  test("refuses to replace a symlink at the booter log path", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const target = path.join(paths.root, "user-log");
    fs.writeFileSync(target, PRESERVED_LOG_CONTENT);
    const id = "12345678-1234-4234-8234-123456789abc";
    fs.symlinkSync(target, path.join(paths.runtimeDir, `booter-${id}.log`));
    await assert.rejects(() => startDaemonBooter({
      ...paths, env: { ...process.env, TASKFERRY_BOOT_ATTEMPT: id },
    }), /EEXIST/);
    assert.equal(fs.readFileSync(target, "utf8"), PRESERVED_LOG_CONTENT);
  });

  test("refuses to replace a symlink at the daemon log path", (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const target = path.join(paths.root, "user-log");
    fs.writeFileSync(target, PRESERVED_LOG_CONTENT);
    const id = "12345678-1234-4234-8234-123456789abc";
    fs.symlinkSync(target, path.join(paths.runtimeDir, `daemon-${id}.log`));
    assert.throws(() => ensureDaemonStarted({
      ...paths, env: { ...process.env, TASKFERRY_BOOT_ATTEMPT: id },
      isDaemonReadySync: () => false, supervisorFn: () => "spawn", loadConfigFn: () => ({}),
    }), /EEXIST/);
    assert.equal(fs.readFileSync(target, "utf8"), PRESERVED_LOG_CONTENT);
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

    const result = (() => {
      try {
        execFileSync(process.execPath, [link], {
          env: { ...process.env, XDG_CONFIG_HOME: configHome, TASKFERRY_RUNTIME_DIR: runtimeDir },
          encoding: "utf8", stdio: "pipe",
        });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    assert.match(String(result?.stderr), /could not parse/);
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

  test("never reports diagnostics from earlier startup attempts", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(paths.runtimeDir, DAEMON_BOOT_ERR), "old boot error");
    fs.writeFileSync(path.join(paths.runtimeDir, "daemon-boot-stderr.log"), "old stderr");
    await assert.rejects(() => connectClient({
      ...paths, startupTimeoutMs: 20, retryDelayMs: 5, ensureDaemonFn: () => {},
    }), (error) => {
      assert.doesNotMatch(error.message, /old boot error|old stderr/);
      return true;
    });
  });

  test("reports diagnostics from the current detached daemon attempt", async (t) => {
    const paths = temporaryPaths(t);
    const missing = path.join(paths.root, "missing.env");
    await assert.rejects(() => connectClient({
      ...paths,
      env: { ...process.env, XDG_CONFIG_HOME: path.join(paths.root, "config"), TASKFERRY_DAEMON_SUPERVISOR: "spawn", TASKFERRY_ENV_FILE: missing },
      startupTimeoutMs: 6500, retryDelayMs: 20,
    }), (error) => {
      assert.match(error.message, /missing\.env/);
      return true;
    });
    const logs = fs.readdirSync(paths.runtimeDir).filter((name) => /^daemon-.*\.log$/.test(name));
    const daemonLog = logs.find((name) => fs.readFileSync(path.join(paths.runtimeDir, name), "utf8").includes(missing));
    assert.ok(daemonLog);
    assert.equal(fs.statSync(path.join(paths.runtimeDir, daemonLog)).mode & 0o777, 0o600);
  });

  test("does not follow a substituted diagnostic symlink", async (t) => {
    const paths = temporaryPaths(t);
    const target = path.join(paths.root, "private");
    fs.writeFileSync(target, "not a daemon diagnostic");
    await assert.rejects(() => connectClient({
      ...paths, startupTimeoutMs: 20, retryDelayMs: 5,
      ensureDaemonFn: ({ env }) => {
        fs.mkdirSync(paths.runtimeDir, { recursive: true });
        fs.symlinkSync(target, path.join(paths.runtimeDir, `daemon-${env.TASKFERRY_BOOT_ATTEMPT}.log`));
      },
    }), (error) => {
      assert.doesNotMatch(error.message, /not a daemon diagnostic/);
      return true;
    });
    assert.equal(fs.readFileSync(target, "utf8"), "not a daemon diagnostic");
  });

  test("concurrent startup attempts report only their own diagnostics", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const attempt = (message) => connectClient({
      ...paths, startupTimeoutMs: 40, retryDelayMs: 5,
      ensureDaemonFn: ({ env }) => {
        fs.writeFileSync(path.join(paths.runtimeDir, `booter-${env.TASKFERRY_BOOT_ATTEMPT}.log`), message);
      },
    }).then(() => "", (error) => error.message);
    const [first, second] = await Promise.all([attempt("first failure"), attempt("second failure")]);
    assert.match(first, /first failure/);
    assert.doesNotMatch(first, /second failure/);
    assert.match(second, /second failure/);
    assert.doesNotMatch(second, /first failure/);
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

describe("supervised daemon startup (systemd --user)", () => {
  test("asks systemd to start the unit instead of spawning a detached daemon", (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const started = [];
    let ready = false;
    const result = ensureDaemonStarted({
      ...paths,
      env: { ...process.env, TASKFERRY_DAEMON_SUPERVISOR: "systemd" },
      startupTimeoutMs: 200,
      retryDelayMs: 1,
      isDaemonReadySync: () => ready,
      spawnDaemonFn: () => { throw new Error("a supervised client must never spawn a detached daemon"); },
      systemdStartFn: ({ unit }) => {
        started.push(unit);
        ready = true;
      },
    });

    assert.equal(result, true);
    assert.deepEqual(started, ["taskferry-daemon.service"]);
  });

  test("the unit's runtime marker selects supervision without an env var", (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(paths.runtimeDir, "systemd-supervised"), "");
    const started = [];
    let ready = false;

    assert.equal(ensureDaemonStarted({
      ...paths,
      env: { ...process.env, TASKFERRY_DAEMON_SUPERVISOR: "" },
      startupTimeoutMs: 200,
      retryDelayMs: 1,
      isDaemonReadySync: () => ready,
      spawnDaemonFn: () => { throw new Error("marker should have selected systemd"); },
      systemdStartFn: () => { started.push("systemd"); ready = true; },
    }), true);
    assert.deepEqual(started, ["systemd"]);
  });

  test("an explicit spawn override wins over the marker", (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(paths.runtimeDir, "systemd-supervised"), "");

    assert.equal(resolveDaemonSupervisor({ env: { ...process.env, TASKFERRY_DAEMON_SUPERVISOR: "spawn" }, runtimeDir: paths.runtimeDir }), "spawn");
    assert.equal(resolveDaemonSupervisor({ env: { ...process.env, TASKFERRY_DAEMON_SUPERVISOR: "" }, runtimeDir: paths.runtimeDir }), "systemd");
    assert.equal(resolveDaemonSupervisor({ env: { ...process.env, TASKFERRY_DAEMON_SUPERVISOR: "" }, runtimeDir: path.join(paths.root, "nope"), runFn: () => ({ status: 1, stdout: "disabled\n" }) }), "spawn");
  });

  test("an enabled path unit selects supervision before the first service start", (t) => {
    const paths = temporaryPaths(t);
    const calls = [];
    const supervisor = resolveDaemonSupervisor({
      env: { TASKFERRY_DAEMON_SUPERVISOR: "", PATH: "/untrusted/bin" },
      runtimeDir: paths.runtimeDir,
      runFn: (command, args) => { calls.push([command, args]); return { status: 0 }; },
    });
    assert.equal(supervisor, "systemd");
    assert.deepEqual(calls, [["/usr/bin/systemctl", ["--user", "is-enabled", "taskferry-daemon.path"]]]);
  });

  test("a user manager failure does not select an unsupervised daemon", (t) => {
    const paths = temporaryPaths(t);
    assert.throws(() => resolveDaemonSupervisor({
      env: {}, runtimeDir: paths.runtimeDir,
      runFn: () => ({ status: 1, stderr: "Failed to connect to bus: No such file or directory" }),
    }), /cannot determine whether/u);
    assert.equal(resolveDaemonSupervisor({
      env: {}, runtimeDir: paths.runtimeDir,
      runFn: () => ({ status: 1, stderr: "Failed to get unit file state for example: No such file or directory" }),
    }), "spawn");
    assert.throws(() => resolveDaemonSupervisor({
      env: {}, runtimeDir: paths.runtimeDir, runFn: () => ({ status: 1, stdout: "", stderr: "" }),
    }), /cannot determine whether/u);
    assert.throws(() => resolveDaemonSupervisor({
      env: {}, runtimeDir: paths.runtimeDir, runFn: () => ({ error: Object.assign(new Error("missing"), { code: "ENOENT" }) }),
    }), /TASKFERRY_DAEMON_SUPERVISOR=spawn/u);
    assert.equal(resolveDaemonSupervisor({
      env: { TASKFERRY_DAEMON_SUPERVISOR: "spawn" }, runtimeDir: paths.runtimeDir,
      runFn: () => { throw new Error("spawn override must skip discovery"); },
    }), "spawn");
  });

  test("systemctl invocation is user-scoped and names the unit", () => {
    const calls = [];
    startDaemonViaSystemd({
      env: { TASKFERRY_DAEMON_UNIT: "custom-daemon.service", PATH: "/untrusted/bin" },
      runFn: (command, args, options) => {
        calls.push([command, args, options.timeout]);
        return { status: 0 };
      },
    });

    assert.deepEqual(calls, [["/usr/bin/systemctl", ["--user", "start", "custom-daemon.service"], 10000]]);
  });

  test("the start lock outlasts the systemctl timeout and the readiness poll", (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    let observed;
    const result = ensureDaemonStarted({
      ...paths,
      env: { ...process.env, TASKFERRY_DAEMON_SUPERVISOR: "systemd" },
      startupTimeoutMs: 500,
      retryDelayMs: 1,
      isDaemonReadySync: () => true,
      withLockFn: (_lockPath, callback, options) => {
        observed = options;
        return callback();
      },
    });

    assert.equal(result, false);
    assert.ok(observed.timeoutMs >= 500 + 10000, "lock must outlast a systemctl timeout plus the readiness poll");
    assert.equal(observed.timeoutMs, observed.staleMs);
  });

  test("a failed systemctl start surfaces journal guidance instead of spawning", () => {
    assert.throws(
      () => startDaemonViaSystemd({ env: {}, runFn: () => ({ status: 5 }) }),
      (error) => {
        assert.match(error.message, /systemctl --user start taskferry-daemon\.service exited 5/);
        assert.match(error.message, /journalctl --user -u taskferry-daemon\.service/);
        assert.match(error.message, /TASKFERRY_DAEMON_SUPERVISOR=spawn/);
        return true;
      }
    );
    assert.throws(
      () => startDaemonViaSystemd({ env: {}, runFn: () => ({ error: new Error("spawn systemctl ENOENT") }) }),
      /cannot execute \/usr\/bin\/systemctl/
    );
  });
});

describe("daemon boot failure after bind", () => {
  test("a manager construction failure releases the bound socket and exits instead of serving", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-boot-failure-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateDir = path.join(root, "state");
    const runtimeDir = path.join(root, "run");
    const socketPath = path.join(runtimeDir, "daemon.sock");
    const configHome = path.join(root, "config");
    fs.mkdirSync(configHome, { recursive: true });
    const child = spawn(process.execPath, [fileURLToPath(new URL("./daemon.js", import.meta.url))], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        TASKFERRY_STATE_DIR: stateDir,
        TASKFERRY_RUNTIME_DIR: runtimeDir,
        TASKFERRY_SOCKET_PATH: socketPath,
        TASKFERRY_ENV_FILE: path.join(root, "missing.env"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    t.after(() => child.kill("SIGKILL"));
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`daemon stayed alive after a boot failure; stderr: ${stderr}`)),
        10000
      );
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /env file not found/);
    assert.equal(fs.existsSync(socketPath), false);
  });
});
