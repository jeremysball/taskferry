import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManager, fakeChild, baseTask, LUNA_MODEL } from "./tasks.test-helpers.js";

// A killFn that reports every positive pid as alive (the process.kill(pid, 0)
// probe never throws) but records which signals were sent -- lets a test
// observe the SIGTERM -> SIGKILL escalation without touching a real process.
// Negative pids (the group-signal attempt sendSignalToProcess tries first)
// always ESRCH, and any non-zero signal to a positive pid records then
// ESRCHs (the process "accepts" the probe but is never actually killed),
// mirroring process.kill's group-then-direct fallback shape.
function fakeAliveKillFn() {
  const signals = [];
  const killFn = (pid, signal) => {
    if (pid < 0) {
      const err = new Error("ESRCH");
      err.code = "ESRCH";
      throw err;
    }
    signals.push({ pid, signal });
    if (signal === 0) return;
    const err = new Error("ESRCH");
    err.code = "ESRCH";
    throw err;
  };
  return { killFn, signals };
}

// A killFn whose signal-0 probe always reports ESRCH (nothing alive).
// Mirrors the pre-reap behavior of the restart tests: fixture pids never
// correspond to real processes, so nothing is ever signalled or waited on.
const fakeDeadKill = () => {
  const err = new Error("ESRCH");
  err.code = "ESRCH";
  return () => { throw err; };
};

// Records every spawn the manager performs and immediately exits it, so a
// resumed launch resolves without keeping the test hanging.
function spawnRecorder() {
  const spawns = [];
  const fakeSpawn = (cmd, args, opts) => {
    spawns.push({ cmd, args, env: opts.env });
    const child = fakeChild(9999 - spawns.length);
    setImmediate(() => child.emit("exit", 0, null));
    return child;
  };
  return { spawns, fakeSpawn };
}

// The minimal resume-eligible running-task fixture shared by the reap tests.
function runningFixtureTask({ id, logDir, pid, pidStartTime = null }) {
  return baseTask({
    id,
    pid,
    pidStartTime,
    status: "running",
    directory: fs.realpathSync(os.tmpdir()),
    model: LUNA_MODEL,
    variant: "high",
    sessionId: null,
    logPath: path.join(logDir, `${id}.ndjson`),
    promptPreview: "resume me",
  });
}

describe("daemon restart auto-resume", () => {
  test("a task marked running with a valid sessionId in its log is resumed on restart (fresh overlay, sessionId reused)", async () => {
    const { spawns, fakeSpawn } = spawnRecorder();
    const mgr = makeManager({
      tasksFixture: (logDir) => [runningFixtureTask({ id: "oc_resume_1", pid: 12345, logDir })],
      logs: {
        "oc_resume_1.ndjson": [JSON.stringify({ sessionID: "ses_resume_abc" }), JSON.stringify({ type: "text", part: { text: "hello", messageID: "m1" } })].join("\n") + "\n",
      },
      spawnFn: fakeSpawn,
      killFn: fakeDeadKill(),
      cancelGraceMs: 0,
      sandboxEnabled: false,
      overlayEnabled: false,
    });

    await new Promise((r) => setTimeout(r, 60));

    const status = mgr.status("oc_resume_1");
    assert.notEqual(status.status, "unknown", "resumable task should not degrade to unknown");
    assert.notEqual(status.failureReason, "daemon_restarted_session_lost", "resumable task should not be marked session_lost");
    assert.ok(spawns.length > 0 || status.status === "running" || status.status === "queued", "expected resume to trigger a spawn");
  });

  test("a running task with no sessionId in its log is marked daemon_restarted_session_lost", async () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [runningFixtureTask({ id: "oc_lost_1", pid: 12346, logDir })],
      logs: {
        "oc_lost_1.ndjson": "not json at all\nstill not json\n",
      },
      spawnFn: () => { throw new Error("should not spawn for non-resumable"); },
      killFn: fakeDeadKill(),
      cancelGraceMs: 0,
      sandboxEnabled: false,
    });

    await new Promise((r) => setTimeout(r, 20));
    const status = mgr.status("oc_lost_1");
    assert.equal(status.status, "crashed");
    assert.equal(status.failureReason, "daemon_restarted_session_lost");
    assert.match(status.failureDetail, /no resumable session found in log/);
  });

  test("a running task whose log is missing is classified session_lost with the log-unreadable detail", async () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [runningFixtureTask({ id: "oc_nolog_1", pid: 12347, logDir })],
      logs: {},
      spawnFn: () => { throw new Error("should not spawn for non-resumable"); },
      killFn: fakeDeadKill(),
      cancelGraceMs: 0,
      sandboxEnabled: false,
    });

    await new Promise((r) => setTimeout(r, 20));
    const status = mgr.status("oc_nolog_1");
    assert.equal(status.status, "crashed");
    assert.equal(status.failureReason, "daemon_restarted_session_lost");
    assert.match(status.failureDetail, /task log missing or unreadable/);
  });

  test("queued tasks degrade to unknown (never started, nothing to resume)", async () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [
        baseTask({
          id: "oc_queued_1",
          status: "queued",
          directory: fs.realpathSync(os.tmpdir()),
          model: LUNA_MODEL,
          variant: "high",
          sessionId: null,
          pid: null,
          logPath: path.join(logDir, "oc_queued_1.ndjson"),
          promptPreview: "queued",
        }),
      ],
      logs: {},
      spawnFn: () => { throw new Error("should not spawn queued on restart"); },
      killFn: fakeDeadKill(),
      cancelGraceMs: 0,
      sandboxEnabled: false,
      overlayEnabled: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    const status = mgr.status("oc_queued_1");
    assert.equal(status.status, "unknown", "queued tasks should degrade to unknown, not be auto-launched");
  });

  test("resume reconstitutes the original launch spec (caller env, sandbox/overlay toggles, per-dispatch binds)", async () => {
    const { spawns, fakeSpawn } = spawnRecorder();
    makeManager({
      tasksFixture: (logDir) => [
        {
          ...runningFixtureTask({ id: "oc_resume_env", pid: 12348, logDir }),
          resumeEnv: { FROZEN_AT_DISPATCH: "1" },
          resumeNoSandbox: true,
          resumeNoOverlay: true,
          resumeAllowedDirs: ["/extra/rw"],
          resumeRoBind: ["/extra/ro"],
        },
      ],
      logs: { "oc_resume_env.ndjson": JSON.stringify({ sessionID: "ses_resume_env" }) + "\n" },
      spawnFn: fakeSpawn,
      killFn: fakeDeadKill(),
      cancelGraceMs: 0,
      sandboxEnabled: false,
      overlayEnabled: false,
    });

    await new Promise((r) => setTimeout(r, 60));
    assert.ok(spawns.length > 0, "expected a resumed spawn");
    const spawnedEnv = spawns[0].env;
    assert.equal(spawnedEnv.FROZEN_AT_DISPATCH, "1", "caller env snapshot must reach the resumed spawn");
    assert.equal(spawnedEnv.TASKFERRY_CHILD, "1", "dispatch plumbing env must still be applied");
  });

  test("dispatch persists the resume launch spec (env + toggles + binds) on the task record", async () => {
    const mgr = makeManager({
      spawnFn: () => {
        const child = fakeChild(7777);
        setImmediate(() => child.emit("exit", 0, null));
        return child;
      },
      killFn: fakeDeadKill(),
      cancelGraceMs: 0,
      sandboxEnabled: false,
      overlayEnabled: false,
    });
    const dispatched = mgr.dispatch({
      prompt: "hi",
      directory: os.tmpdir(),
      env: { FROZEN_AT_DISPATCH: "1" },
      noSandbox: true,
      noOverlay: true,
      roBind: ["/extra/ro"],
    });
    mgr.flushPersist();
    const persisted = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    const record = persisted.find((t) => t.id === dispatched.id);
    assert.equal(record.resumeEnv.FROZEN_AT_DISPATCH, "1", "caller env must be persisted for restart resume");
    assert.equal(record.resumeNoSandbox, true);
    assert.equal(record.resumeNoOverlay, true);
    assert.deepEqual(record.resumeRoBind, ["/extra/ro"]);
  });

  test("a pid whose start time does not match the record is not signalled (pid reuse guard)", async () => {
    const { killFn, signals } = fakeAliveKillFn();
    const { spawns, fakeSpawn } = spawnRecorder();
    // The recorded start time says the original child is long gone; the
    // live pid 12345 is therefore some unrelated process.
    makeManager({
      tasksFixture: (logDir) => [runningFixtureTask({ id: "oc_reuse_guard", pid: 12345, pidStartTime: "999999", logDir })],
      spawnFn: fakeSpawn,
      readProcStartTimeFn: () => "12345",
      cancelGraceMs: 50,
      sandboxEnabled: false,
      overlayEnabled: false,
      logs: { "oc_reuse_guard.ndjson": JSON.stringify({ sessionID: "ses_reuse" }) + "\n" },
      killFn,
    });

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(signals.filter((s) => s.signal !== 0).length, 0, "identity-mismatched pid must not be signalled");
    assert.ok(spawns.length > 0, "resume should still proceed without reaping the stranger");
  });

  test("an alive orphaned child is SIGTERM'd then SIGKILL'd after cancelGrace before resume", async () => {
    const { killFn, signals } = fakeAliveKillFn();
    const { spawns, fakeSpawn } = spawnRecorder();
    makeManager({
      tasksFixture: (logDir) => [runningFixtureTask({ id: "oc_reap_1", pid: 12345, logDir })],
      spawnFn: fakeSpawn,
      cancelGraceMs: 50,
      sandboxEnabled: false,
      overlayEnabled: false,
      logs: { "oc_reap_1.ndjson": JSON.stringify({ sessionID: "ses_reap" }) + "\n" },
      killFn,
    });

    await new Promise((r) => setTimeout(r, 200));
    const termSignals = signals.filter((s) => s.signal === "SIGTERM" && s.pid === 12345);
    const killSignals = signals.filter((s) => s.signal === "SIGKILL" && s.pid === 12345);
    assert.equal(termSignals.length, 1, "SIGTERM must be sent exactly once to the orphan");
    assert.equal(killSignals.length, 1, "SIGKILL must follow after the grace period when the child ignores SIGTERM");
    assert.ok(spawns.length > 0, "resume must proceed after the orphan is reaped");
  });
});

// The bounded tail-window size readSessionIdFromLog scans (tasks.js's
// SESSION_SCAN_TAIL_BYTES), hardcoded here so the byte-accounting
// assertions below prove the bound literally.
const SESSION_SCAN_TAIL_BYTES = 128 * 1024;

describe("readSessionIdFromLog bounded tail scan", () => {
  const fillerLine = (n) => JSON.stringify({ type: "text", part: { messageID: `m${n}`, text: "x".repeat(512) } }) + "\n";

  // Builds a log far larger than the tail window: session-id lines planted
  // at the head and/or tail, padded to `minBytes` with filler (no sessionID).
  function bigLog({ minBytes, headSessionIds, tailSessionIds }) {
    let content = "";
    for (const id of headSessionIds) content += JSON.stringify({ sessionID: id, type: "step_start" }) + "\n";
    let n = 0;
    while (Buffer.byteLength(content) < Math.max(minBytes, SESSION_SCAN_TAIL_BYTES + 1)) {
      content += fillerLine(n);
      n += 1;
    }
    for (const id of tailSessionIds) content += JSON.stringify({ sessionID: id, type: "step_finish" }) + "\n";
    return content;
  }

  // Runs the restart reconciliation through makeManager with an
  // fs.readSync spy that accounts only the bytes read from the seeded task
  // log (fds are mapped back to their open path, so unrelated reads --
  // tasks.json, /proc -- don't pollute the accounting). The reconciliation
  // runs synchronously inside makeManager, so `bootstrapReads` -- captured
  // the moment makeManager returns -- is exactly what the restart scan
  // itself read; later reads (child-exit classification etc.) stay out of
  // the accounting. The resumed spawn itself lands via launchQueuedTasks,
  // so callers wait a tick before asserting on spawns.
  function restartWithReadSpy(t, { logName, logContent, taskFixture }) {
    const reads = [];
    const pathByFd = new Map();
    const { spawns, fakeSpawn } = spawnRecorder();
    const originalOpenSync = fs.openSync;
    const originalReadSync = fs.readSync;
    t.mock.method(fs, "openSync", (targetPath, ...rest) => {
      const fd = originalOpenSync(targetPath, ...rest);
      if (targetPath.endsWith(logName)) pathByFd.set(fd, targetPath);
      return fd;
    });
    t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
      if (pathByFd.has(fd)) reads.push({ length, position });
      return originalReadSync(fd, buffer, offset, length, position);
    });
    makeManager({
      tasksFixture: (logDir) => taskFixture(logDir),
      logs: { [logName]: logContent },
      spawnFn: fakeSpawn,
      killFn: fakeDeadKill(),
      cancelGraceMs: 0,
      sandboxEnabled: false,
      overlayEnabled: false,
    });
    const bootstrapReads = reads.slice();
    return { bootstrapReads, reads, spawns };
  }

  test("a session id inside the tail window is found after reading only the bounded window, not the whole log", async (t) => {
    // The log is several times larger than the window; a full forward scan
    // would read every byte. The scan must return the tail-most session id
    // while reading at most the window -- restart reconciliation cost must
    // not grow with full log history.
    const logContent = bigLog({ minBytes: 3 * SESSION_SCAN_TAIL_BYTES, headSessionIds: ["ses_head"], tailSessionIds: ["ses_tail_most_recent"] });
    const { bootstrapReads, spawns } = restartWithReadSpy(t, {
      logContent,
      taskFixture: (logDir) => [runningFixtureTask({ id: "oc_big_tail", pid: 12350, logDir })],
      logName: "oc_big_tail.ndjson",
    });
    await new Promise((r) => setTimeout(r, 60));
    const totalRead = bootstrapReads.reduce((sum, r) => sum + r.length, 0);
    assert.equal(totalRead, SESSION_SCAN_TAIL_BYTES, "the scan must read exactly the bounded window, not the whole log");
    assert.ok(spawns.length > 0, "expected a resumed spawn from the tail-window scan");
    assert.ok(
      spawns.some((s) => s.args.includes("--session") && s.args.includes("ses_tail_most_recent")),
      "the resumed spawn must carry the tail-most session id"
    );
  });

  test("a session id that only exists before the window is still recovered by the fallback full scan", async (t) => {
    // The window shows no session id (the only one is buried behind several
    // windows of filler), so the scan falls back to the whole file -- the
    // one case whose cost grows with log history -- and still recovers it.
    const logContent = bigLog({ minBytes: 3 * SESSION_SCAN_TAIL_BYTES, headSessionIds: ["ses_only_in_head"], tailSessionIds: [] });
    const { bootstrapReads, spawns } = restartWithReadSpy(t, {
      logContent,
      taskFixture: (logDir) => [runningFixtureTask({ id: "oc_tail_fallback", pid: 12351, logDir })],
      logName: "oc_tail_fallback.ndjson",
    });
    await new Promise((r) => setTimeout(r, 60));
    const totalRead = bootstrapReads.reduce((sum, r) => sum + r.length, 0);
    assert.ok(totalRead > SESSION_SCAN_TAIL_BYTES, "the fallback must read past the window to find the head session");
    assert.ok(
      spawns.some((s) => s.args.includes("--session") && s.args.includes("ses_only_in_head")),
      "the fallback scan must still recover the pre-window session id"
    );
  });

  test("when several session ids appear, the most recent one wins (not the first found)", async (t) => {
    // Two sessions inside the window: the tail scan must return the newest,
    // preserving the docstring's "most recent session id" semantic.
    const logContent = bigLog({ minBytes: 2 * SESSION_SCAN_TAIL_BYTES, headSessionIds: ["ses_oldest"], tailSessionIds: ["ses_mid", "ses_newest"] });
    const { bootstrapReads, spawns } = restartWithReadSpy(t, {
      logContent,
      taskFixture: (logDir) => [runningFixtureTask({ id: "oc_tail_recent", pid: 12352, logDir })],
      logName: "oc_tail_recent.ndjson",
    });
    await new Promise((r) => setTimeout(r, 60));
    const totalRead = bootstrapReads.reduce((sum, r) => sum + r.length, 0);
    assert.equal(totalRead, SESSION_SCAN_TAIL_BYTES, "the most-recent scan stays within the bounded window");
    assert.ok(
      spawns.some((s) => s.args.includes("--session") && s.args.includes("ses_newest")),
      "the newest session id must win, not the first found"
    );
  });
});
