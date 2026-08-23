/* eslint-disable -- test helper file, not subject to production lint limits */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDaemon } from "./daemon.js";

function temporaryPaths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-daemon-restart-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    stateDir: path.join(root, "state"),
    runtimeDir: path.join(root, "run"),
    socketPath: path.join(root, "run", "daemon.sock"),
  };
}

function fakeManagerFactory(tasks = [], opts = {}) {
  let captured;
  const manager = {
    list: () => ({
      counts: { queued: 0, running: tasks.filter((t) => t.status === "running").length, done: 0, crashed: 0, cancelled: 0, unknown: 0 },
      tasks: tasks.map(({ id, status, directory }) => ({ id, status, model: "test/model", startedAt: "2026-07-15T00:00:00.000Z", directory })),
    }),
    status: (id) => { throw new Error("unused"); },
    taskDirectory: (id) => tasks[0]?.directory || "/tmp",
    setActivitySubscriptions() {},
    close() {},
    ...opts.extra,
  };
  return {
    factory(options) {
      fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
      captured = options;
      return manager;
    },
    get options() { return captured; },
    manager,
  };
}

function sourceFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-daemon-source-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = path.join(dir, "daemon.js");
  fs.writeFileSync(entry, "// fixture\n");
  return { dir, entry };
}

describe("daemon source-change restart behavior", () => {
  test("restarts immediately by default even when tasks are running (no wait-for-idle)", async (t) => {
    const paths = temporaryPaths(t);
    const { dir, entry } = sourceFixture(t);
    const fake = fakeManagerFactory([{ id: "t1", status: "running", directory: paths.root }]);
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

    const bumped = new Date(Date.now() + 60_000);
    fs.utimesSync(entry, bumped, bumped);

    const net = await import("node:net");
    const { EventEmitter } = await import("node:events");
    const socket = net.createConnection(paths.socketPath);
    await EventEmitter.once(socket, "connect");
    socket.setEncoding("utf8");
    let buffer = "";
    const pending = new Map();
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    });
    const request = (id, method, params = {}) => new Promise((resolve) => { pending.set(id, resolve); socket.write(`${JSON.stringify({ version: 1, id, method, params })}\n`); });
    await request("health", "system.health");
    await new Promise((r) => setTimeout(r, 30));
    socket.destroy();

    assert.equal(spawnCalls.length, 1, "daemon should have restarted immediately despite running tasks when restartWaitForIdle is not set");
    assert.equal(exitCalls, 1);
  });

  test("when restartWaitForIdle is true via config, defers restart while tasks are running", async (t) => {
    const paths = temporaryPaths(t);
    const { dir, entry } = sourceFixture(t);
    const fake = fakeManagerFactory([{ id: "t1", status: "running", directory: paths.root }]);
    const spawnCalls = [];
    let exitCalls = 0;
    const daemon = await startDaemon({
      ...paths,
      taskManagerFactory: fake.factory,
      taskManagerOptions: { config: { restartWaitForIdle: true } },
      sourceDir: dir,
      daemonEntry: entry,
      spawnReplacement: (args) => spawnCalls.push(args),
      exitProcess: () => { exitCalls++; },
    });
    t.after(() => daemon.close());

    const bumped = new Date(Date.now() + 60_000);
    fs.utimesSync(entry, bumped, bumped);

    const net = await import("node:net");
    const { EventEmitter } = await import("node:events");
    const socket = net.createConnection(paths.socketPath);
    await EventEmitter.once(socket, "connect");
    socket.setEncoding("utf8");
    let buffer = "";
    const pending = new Map();
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    });
    const request = (id, method, params = {}) => new Promise((resolve) => { pending.set(id, resolve); socket.write(`${JSON.stringify({ version: 1, id, method, params })}\n`); });
    await request("health", "system.health");
    await new Promise((r) => setTimeout(r, 30));
    socket.destroy();

    assert.equal(spawnCalls.length, 0, "daemon should NOT restart while running when restartWaitForIdle:true");
    assert.equal(exitCalls, 0);
  });

  test("when restartWaitForIdle true, restarts once idle", async (t) => {
    const paths = temporaryPaths(t);
    const { dir, entry } = sourceFixture(t);
    let running = true;
    const fake = {
      factory(options) {
        fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
        return {
          list: () => ({
            counts: running ? { queued: 0, running: 1, done: 0, crashed: 0, cancelled: 0, unknown: 0 } : { queued: 0, running: 0, done: 1, crashed: 0, cancelled: 0, unknown: 0 },
            tasks: [],
          }),
          status: () => { throw new Error("unused"); },
          taskDirectory: () => "/tmp",
          setActivitySubscriptions() {},
          close() {},
        };
      },
    };
    const spawnCalls = [];
    let exitCalls = 0;
    const daemon = await startDaemon({
      ...paths,
      taskManagerFactory: fake.factory,
      taskManagerOptions: { config: { restartWaitForIdle: true } },
      sourceDir: dir,
      daemonEntry: entry,
      spawnReplacement: (args) => spawnCalls.push(args),
      exitProcess: () => { exitCalls++; },
    });
    t.after(() => daemon.close());

    const bumped = new Date(Date.now() + 60_000);
    fs.utimesSync(entry, bumped, bumped);

    const net = await import("node:net");
    const { EventEmitter } = await import("node:events");
    const socket = net.createConnection(paths.socketPath);
    await EventEmitter.once(socket, "connect");
    socket.setEncoding("utf8");
    let buffer = "";
    const pending = new Map();
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    });
    const request = (id, method, params = {}) => new Promise((resolve) => { pending.set(id, resolve); socket.write(`${JSON.stringify({ version: 1, id, method, params })}\n`); });
    await request("health", "system.health");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(spawnCalls.length, 0, "should defer while running");
    running = false;
    await request("health2", "system.health");
    await new Promise((r) => setTimeout(r, 30));
    socket.destroy();
    assert.equal(spawnCalls.length, 1, "should restart once idle when defer enabled");
    assert.equal(exitCalls, 1);
  });

  test("env var TASKFERRY_RESTART_WAIT_FOR_IDLE overrides config", async (t) => {
    const paths = temporaryPaths(t);
    const { dir, entry } = sourceFixture(t);
    const fake = fakeManagerFactory([{ id: "t1", status: "running", directory: paths.root }]);
    const spawnCalls = [];
    const orig = process.env.TASKFERRY_RESTART_WAIT_FOR_IDLE;
    process.env.TASKFERRY_RESTART_WAIT_FOR_IDLE = "1";
    t.after(() => {
      if (orig === undefined) delete process.env.TASKFERRY_RESTART_WAIT_FOR_IDLE;
      else process.env.TASKFERRY_RESTART_WAIT_FOR_IDLE = orig;
    });
    const daemon = await startDaemon({
      ...paths,
      taskManagerFactory: fake.factory,
      taskManagerOptions: { config: { restartWaitForIdle: false } },
      sourceDir: dir,
      daemonEntry: entry,
      spawnReplacement: (args) => spawnCalls.push(args),
      exitProcess: () => {},
    });
    t.after(() => daemon.close());
    const bumped = new Date(Date.now() + 60_000);
    fs.utimesSync(entry, bumped, bumped);
    const net = await import("node:net");
    const { EventEmitter } = await import("node:events");
    const socket = net.createConnection(paths.socketPath);
    await EventEmitter.once(socket, "connect");
    socket.setEncoding("utf8");
    let buffer = "";
    const pending = new Map();
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    });
    const request = (id, method, params = {}) => new Promise((resolve) => { pending.set(id, resolve); socket.write(`${JSON.stringify({ version: 1, id, method, params })}\n`); });
    await request("health", "system.health");
    await new Promise((r) => setTimeout(r, 30));
    socket.destroy();
    assert.equal(spawnCalls.length, 0, "env var should force defer even when config says false");
  });
});
