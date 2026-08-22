// taskferry#515 -- a daemon must refuse to boot (or provably reclaim) when
// another daemon process for the same state dir exists, because a second
// daemon's boot-time orphan sweeps would delete the first daemon's
// in-flight overlays. The gate is: socket bind wins exclusivity, then the
// daemon.pid record is checked under the bind lock -- refuse if the
// recorded owner is genuinely alive (signal-0 + /proc start-time identity),
// otherwise claim the record for this boot.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDaemon } from "./daemon.js";

function temporaryPaths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-daemon-singleton-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    stateDir: path.join(root, "state"),
    runtimeDir: path.join(root, "run"),
    socketPath: path.join(root, "run", "daemon.sock"),
  };
}

function fakeManagerFactory() {
  const calls = [];
  const manager = {
    list: () => ({ counts: { queued: 0, running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0 }, tasks: [] }),
    setActivitySubscriptions() {},
    close() { calls.push(["close"]); },
  };
  return {
    factory(options) {
      fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
      return manager;
    },
    calls,
    manager,
  };
}

function procStartTime(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(/\s+/);
  return stat.length >= 31 ? stat[stat.length - 31] : null;
}

const DAEMON_PID_FILE = "daemon.pid";
const pidfileOwnedByUs = (stateDir) => fs.readFileSync(path.join(stateDir, DAEMON_PID_FILE), "utf8").startsWith(`${process.pid} `);

describe("Unix socket daemon: singleton gate (taskferry#515)", () => {
  test("refuses to boot when daemon.pid records a live process even though no socket is listening", async (t) => {
    // The zombie-daemon case: a daemon that failed to exit cleanly left its
    // pidfile, its process is still alive (signal-0 + /proc start-time
    // identity match), but its socket is gone. A fresh boot must refuse
    // rather than sweep the zombie's live-task overlays (taskferry#515).
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const startTime = procStartTime(process.pid);
    assert.ok(startTime, "test process must have a readable /proc start time for this test to be meaningful");
    fs.writeFileSync(path.join(paths.stateDir, DAEMON_PID_FILE), `${process.pid} ${startTime}\n`);

    let factoryCalls = 0;
    const fake = fakeManagerFactory();
    const originalFactory = fake.factory;
    await assert.rejects(
      () => startDaemon({
        ...paths,
        taskManagerFactory: (options) => { factoryCalls++; return originalFactory(options); },
        exitProcess: () => { throw new Error("singleton gate refused boot"); },
      }),
      /singleton gate refused boot/,
    );
    assert.equal(factoryCalls, 0, "the manager factory must never be constructed by a refused daemon (its sweeps would delete the live daemon's overlays)");
    assert.equal(fs.existsSync(paths.socketPath), false, "a refused boot must not bind the socket");
    assert.equal(pidfileOwnedByUs(paths.stateDir), true, "the refused boot must not overwrite the live owner's pidfile");
  });

  test("reclaims a daemon.pid whose owner is provably dead (no listener + dead pid) and boots normally", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    // pid 2_000_000_000 is above any real pid_max and never answers signal 0.
    fs.writeFileSync(path.join(paths.stateDir, DAEMON_PID_FILE), "2000000000 0\n");
    const fake = fakeManagerFactory();

    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());

    assert.equal(pidfileOwnedByUs(paths.stateDir), true, "the boot must claim the pidfile for itself once the recorded owner is proven dead");
    assert.equal(fake.calls.length, 0, "manager should be running, not closed");
  });

  test("writes and unclaims daemon.pid across a clean daemon lifecycle", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    const pidFilePath = path.join(paths.stateDir, DAEMON_PID_FILE);
    assert.equal(fs.existsSync(pidFilePath), true, "a booted daemon records itself in daemon.pid");
    assert.equal(pidfileOwnedByUs(paths.stateDir), true);

    await daemon.close();
    assert.equal(fs.existsSync(pidFilePath), false, "a clean shutdown must unclaim daemon.pid so the next boot starts fresh");

    // And a second boot on the same state dir must succeed after the clean
    // shutdown (no stale refusal).
    const second = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => second.close());
    assert.equal(fs.existsSync(pidFilePath), true);
  });

  test("unclaims daemon.pid on the source-change restart path so the replacement daemon can claim it", async (t) => {
    // Regression: makeMaybeRestart used to close with the raw close (which
    // left daemon.pid claiming the dying process), and the replacement
    // daemon booting against the still-unreaped zombie -- which still
    // passes the signal-0 probe -- would refuse its own incarnation.
    const paths = temporaryPaths(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-daemon-src-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const entry = path.join(dir, "daemon.js");
    fs.writeFileSync(entry, "// fixture\n");
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
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          const msg = JSON.parse(line);
          pending.get(msg.id)?.(msg);
          pending.delete(msg.id);
        }
      }
    });
    const request = (id, method, params = {}) => new Promise((resolve) => { pending.set(id, resolve); socket.write(`${JSON.stringify({ version: 1, id, method, params })}\n`); });
    await request("health", "system.health");
    await new Promise((r) => setTimeout(r, 30));
    socket.destroy();

    assert.equal(spawnCalls.length, 1, "daemon should have restarted on source change");
    assert.equal(exitCalls, 1);
    assert.equal(fs.existsSync(path.join(paths.stateDir, DAEMON_PID_FILE)), false, "the restart path must unclaim daemon.pid before the replacement boots");
  });
});
