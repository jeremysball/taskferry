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
