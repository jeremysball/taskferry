import { test, describe, mock, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { makeManager, fakeChild, baseTask, DIFF_LINE, OVERLAY_DIR_PENDING, EBUSY_ERROR, SPAWN_BWRAP_TIMEOUT, TOOL_CALLS, NONE_OBSERVED, FINAL_ANSWER } from "./tasks.test-helpers.js";
import { defaultRunCommand as changesetDefaultRunCommand } from "./changeset.js";

describe("cancel()", () => {
  test("sends SIGTERM to the negative pid (process group), then escalates to SIGKILL after graceMs if still running", async () => {
    const child = fakeChild(777);
    const killCalls = [];
    const mgr = makeManager({ spawnFn: () => child, killFn: (pid, signal) => killCalls.push({ pid, signal }) });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    mgr.cancel(dispatched.id, { graceMs: 15 });
    assert.deepEqual(killCalls, [{ pid: -777, signal: "SIGTERM" }]);

    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(killCalls, [{ pid: -777, signal: "SIGTERM" }, { pid: -777, signal: "SIGKILL" }]);
  });

  test("does not escalate to SIGKILL if the task already exited within the grace period", async () => {
    const child = fakeChild(888);
    const killCalls = [];
    const mgr = makeManager({ spawnFn: () => child, killFn: (pid, signal) => killCalls.push({ pid, signal }) });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    mgr.cancel(dispatched.id, { graceMs: 15 });
    child.emit("exit", null, "SIGTERM"); // settles before the escalation timer fires

    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(killCalls, [{ pid: -888, signal: "SIGTERM" }]); // no SIGKILL follow-up
  });

  test("stops the watchdog so cancellation cannot add a failureReason before the child exits", async () => {
    const child = fakeChild(889);
    const killCalls = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killCalls.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    mgr.cancel(dispatched.id, { graceMs: 1000 });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(mgr.status(dispatched.id).failureReason, null);
    assert.deepEqual(killCalls, [{ pid: -889, signal: "SIGTERM" }]);
    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).status, "cancelled");
  });

  test("replaces an existing cancellation escalation timer", async () => {
    const child = fakeChild(890);
    const killCalls = [];
    const mgr = makeManager({ spawnFn: () => child, killFn: (pid, signal) => killCalls.push({ pid, signal }) });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    mgr.cancel(dispatched.id, { graceMs: 15 });
    mgr.cancel(dispatched.id, { graceMs: 100 });
    await new Promise((r) => setTimeout(r, 30));

    assert.deepEqual(killCalls, [
      { pid: -890, signal: "SIGTERM" },
      { pid: -890, signal: "SIGTERM" },
    ]);
    child.emit("exit", null, "SIGTERM");
  });

  test("falls back to the plain pid if group signaling (-pid) raises ESRCH", () => {
    const child = fakeChild(999);
    const killCalls = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (pid < 0) {
          const err = new Error("No such process");
          err.code = "ESRCH";
          throw err;
        }
      },
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    mgr.cancel(dispatched.id);
    assert.deepEqual(killCalls, [{ pid: -999, signal: "SIGTERM" }, { pid: 999, signal: "SIGTERM" }]);
  });

  test("returns a no-op note instead of throwing or signaling when the task isn't running", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1", status: "done" })] });
    const result = mgr.cancel("t1");
    assert.equal(result.status, "done");
    assert.match(result.note, /task is already done; nothing to cancel/);
  });

  test("a persisted 'running' task reloads as 'unknown' and is also treated as settled", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1", status: "running" })] });
    assert.equal(mgr.status("t1").status, "unknown");
    const result = mgr.cancel("t1");
    assert.match(result.note, /task is already unknown; nothing to cancel/);
  });

  test("a persisted queued task reloads as 'unknown' and is never launched", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1", status: "queued", pid: null })] });
    assert.equal(mgr.status("t1").status, "unknown");
  });
});

describe("accept()/reject()", () => {
  // The fixture's overlay root lives under this host's actual tmpdir (not a
  // hardcoded "/tmp", which would fail on hosts where os.tmpdir() resolves
  // elsewhere) so cleanupOverlay's containment check (Task 7, review finding
  // #12) accepts it. It's a dedicated mkdtemp'd subdirectory, not the bare
  // os.tmpdir() itself -- the manager's startup sweepOrphanedOverlays() scans
  // every task's overlayDirs.tmpRoot, and a fixture pointing straight at real
  // os.tmpdir() made every test in this block scan (and act on) whatever a
  // real, concurrently-running daemon actually has in /tmp (issue #253).
  const fixtureTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-accept-reject-tmp-"));
  const fixtureRoot = path.join(fixtureTmpRoot, OVERLAY_DIR_PENDING);
  // Each pendingTaskFixture() call writes a real .patch file to the host
  // tmpdir; track them here and remove them once the whole suite finishes
  // instead of leaking one per invocation (issue #253).
  const createdDiffPaths = [];
  after(() => {
    for (const p of createdDiffPaths) {
      try {
        fs.unlinkSync(p);
      } catch {
        // already gone or never created -- nothing to clean up
      }
    }
  });
  function pendingTaskFixture(overrides = {}) {
    // accept() now refuses to hand a missing diff file to git apply (Task 4
    // review finding #1), so the fixture must record a diffPath whose file
    // actually exists on disk. The content is irrelevant -- runCommand is
    // mocked -- only the file's existence matters. A unique tmp path per
    // fixture call keeps parallel tests from clobbering each other.
    const diffPath = path.join(os.tmpdir(), `taskferry-accept-diff-${process.pid}-${Math.random().toString(36).slice(2)}.patch`); // eslint-disable-line sonarjs/pseudo-random -- test fixture randomness, not security-sensitive
    fs.writeFileSync(diffPath, DIFF_LINE);
    createdDiffPaths.push(diffPath);
    return {
      ...baseTask({ id: "t_pending", status: "done" }),
      role: "dispatch",
      changesetStatus: "pending",
      diffPath,
      overlayDirs: { root: fixtureRoot, tmpRoot: fixtureTmpRoot, upperDir: path.join(fixtureRoot, "upper", "main"), workDir: path.join(fixtureRoot, "work", "main"), rwBinds: [] },
      preDispatchHead: "abc123",
      ...overrides,
    };
  }

  test("accept() applies the diff, marks the changeset accepted, and cleans up", async () => {
    let applyCalled = false;
    let cleanedRoot = null;
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: (command, args) => {
        if (command === "git" && args[2] === "apply") applyCalled = true;
        return { status: 0, stdout: "", stderr: "" };
      },
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });
    const result = await mgr.accept("t_pending");
    assert.equal(result.changesetStatus, "accepted");
    assert.equal(result.applied, true);
    assert.equal(applyCalled, true);
    assert.equal(cleanedRoot, fixtureRoot);
    assert.equal(mgr.status("t_pending").changesetStatus, "accepted");
  });

  test("accept() leaves changesetStatus pending and does not clean up when apply fails", async () => {
    let cleanedRoot = null;
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: (command) => {
        if (command === "git") return { status: 1, stdout: "", stderr: "error: patch does not apply\n" };
        return { status: 0, stdout: "", stderr: "" };
      },
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });
    const result = await mgr.accept("t_pending");
    assert.equal(result.applied, false);
    assert.match(result.reason, /patch does not apply/);
    assert.equal(mgr.status("t_pending").changesetStatus, "pending");
    assert.equal(cleanedRoot, null);
  });

  test("reject() discards the changeset without applying and cleans up", async () => {
    let applyCalled = false;
    let cleanedRoot = null;
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: (command, args) => {
        if (command === "git" && args[2] === "apply") applyCalled = true;
        return { status: 0, stdout: "", stderr: "" };
      },
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });
    const result = await mgr.reject("t_pending");
    assert.equal(result.changesetStatus, "rejected");
    assert.equal(applyCalled, false);
    assert.equal(cleanedRoot, fixtureRoot);
    assert.equal(mgr.status("t_pending").changesetStatus, "rejected");
  });

  test("reject() cleans an overlay using its recorded tmpRoot after the live tmpRoot changes", async () => {
    const recordedTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-recorded-overlay-"));
    const liveTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-live-overlay-"));
    const root = path.join(recordedTmpRoot, OVERLAY_DIR_PENDING);
    fs.mkdirSync(path.join(root, "upper", "main"), { recursive: true });
    fs.mkdirSync(path.join(root, "work", "main"), { recursive: true });
    const mgr = makeManager({
      overlayTmpRoot: liveTmpRoot,
      tasksFixture: [pendingTaskFixture({
        overlayDirs: {
          root,
          tmpRoot: recordedTmpRoot,
          upperDir: path.join(root, "upper", "main"),
          workDir: path.join(root, "work", "main"),
          rwBinds: [],
        },
      })],
    });

    const result = await mgr.reject("t_pending");
    assert.equal(result.changesetStatus, "rejected");
    assert.equal(result.cleanupFailed, undefined);
    assert.equal(fs.existsSync(root), false);
  });

  test("accept() on an advisor task throws a clear, non-applying error", async () => {
    const mgr = makeManager({ tasksFixture: [pendingTaskFixture({ id: "t_advisor", role: "advisor", changesetStatus: "rejected" })] });
    await assert.rejects(() => mgr.accept("t_advisor"), /role "advisor" and cannot be accepted/);
  });

  test("accept() on a task with no pending changeset throws", async () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t_none" })] });
    await assert.rejects(() => mgr.accept("t_none"), /no pending changeset/);
  });

  test("accept() on a task whose extraction failed errors usefully and keeps the overlay (regression: review finding #2)", async () => {
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture({ diffPath: null, changesetError: SPAWN_BWRAP_TIMEOUT })],
    });
    await assert.rejects(() => mgr.accept("t_pending"), /changeset was never extracted.*ETIMEDOUT/s);
    assert.ok(mgr.status("t_pending").overlayDirs, "the preserved overlay is the user's only copy of the changes");
  });

  test("accept() errors usefully when the recorded diff file is no longer on disk (regression: review finding #1)", async () => {
    // The diffPath is recorded in tasks.json but the file itself is gone
    // (partial stateDir cleanup, a tampered tasks.json, etc.). Without this
    // check, git apply would surface its own "can't open patch" message
    // against a path the user has no reason to suspect -- fail with a
    // clear, actionable error before that happens.
    const missingDiffPath = path.join(os.tmpdir(), `taskferry-does-not-exist-${process.pid}-${Math.random().toString(36).slice(2)}.patch`); // eslint-disable-line sonarjs/pseudo-random -- test fixture randomness, not security-sensitive
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture({ diffPath: missingDiffPath })],
    });
    await assert.rejects(() => mgr.accept("t_pending"), /diff file at \/tmp\/taskferry-does-not-exist-/);
    await assert.rejects(() => mgr.accept("t_pending"), /cannot be applied without its diff/);
  });

  test("accept() on a non-git target whose overlay vanished errors instead of applying nothing (regression: review finding #7)", async () => {
    // A reboot clears the tmpfs overlay; the pending changeset can never be
    // re-applied. Fail loudly rather than rsyncing a missing tree.
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture({
        preDispatchHead: null, // non-git target
        overlayDirs: { root: fixtureRoot, tmpRoot: fixtureTmpRoot, upperDir: path.join(fixtureRoot, "upper", "main"), workDir: path.join(fixtureRoot, "work", "main"), rwBinds: [] }, // never created on disk
      })],
    });
    await assert.rejects(() => mgr.accept("t_pending"), /overlay is gone/);
  });

  test("accept() surfaces a failed cleanup via cleanupFailed and leaves overlayDirs for the sweep (regression: review finding #11)", async () => {
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "" }),
      rmOverlayTreeFn: () => { throw new Error(EBUSY_ERROR); },
    });
    const result = await mgr.accept("t_pending");
    assert.equal(result.applied, true);
    assert.equal(result.changesetStatus, "accepted");
    assert.equal(result.cleanupFailed, true, "a failed cleanup must not be swallowed");
    assert.ok(mgr.status("t_pending").overlayDirs, "overlayDirs must stay set so the daemon-startup sweep retries");
  });

  test("reject() surfaces a failed cleanup and leaves overlayDirs for the sweep", async () => {
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      rmOverlayTreeFn: () => { throw new Error(EBUSY_ERROR); },
    });
    const result = await mgr.reject("t_pending");
    assert.equal(result.changesetStatus, "rejected");
    assert.equal(result.cleanupFailed, true);
    assert.ok(mgr.status("t_pending").overlayDirs);
  });

  // Persist-before-cleanup must be followed by a second persist after the
  // cleanup actually clears overlayDirs, so the durable task record
  // doesn't keep claiming an overlay exists for an overlay that was
  // just removed. Otherwise: after a restart, the task record on disk
  // has overlayDirs populated even though the overlay is gone -- the
  // startup sweep would still clean it up (rm -rf on a missing path is
  // idempotent), but the record lies until the sweep runs.
  function readPersistedTask(mgr, taskId) {
    mgr.flushPersist();
    const tasks = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    return tasks.find((t) => t.id === taskId);
  }

  test("accept() persists the cleared overlay metadata after successful cleanup (regression: review followup #1)", async () => {
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "" }),
      rmOverlayTreeFn: () => {},
    });
    const result = await mgr.accept("t_pending");
    assert.equal(result.changesetStatus, "accepted");
    assert.equal(result.applied, true);
    assert.equal(result.cleanupFailed, undefined);
    const onDisk = readPersistedTask(mgr, "t_pending");
    assert.equal(onDisk.changesetStatus, "accepted", "status must be durable");
    assert.equal(onDisk.overlayDirs, null, "cleared overlay metadata must be durable, not claim an overlay still exists");
  });

  test("reject() persists the cleared overlay metadata after successful cleanup (regression: review followup #1)", async () => {
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      rmOverlayTreeFn: () => {},
    });
    const result = await mgr.reject("t_pending");
    assert.equal(result.changesetStatus, "rejected");
    assert.equal(result.cleanupFailed, undefined);
    const onDisk = readPersistedTask(mgr, "t_pending");
    assert.equal(onDisk.changesetStatus, "rejected", "status must be durable");
    assert.equal(onDisk.overlayDirs, null, "cleared overlay metadata must be durable, not claim an overlay still exists");
  });

  test("accept() leaves overlayDirs durable on cleanup failure so the startup sweep can retry (regression: review followup #1)", async () => {
    // Symmetric to the success cases: when cleanup fails, both the
    // status and overlayDirs must be durable on disk so the
    // daemon-startup sweep can pick up the orphan and retry the removal.
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "" }),
      rmOverlayTreeFn: () => { throw new Error(EBUSY_ERROR); },
    });
    const result = await mgr.accept("t_pending");
    assert.equal(result.cleanupFailed, true);
    const onDisk = readPersistedTask(mgr, "t_pending");
    assert.equal(onDisk.changesetStatus, "accepted");
    assert.ok(onDisk.overlayDirs, "overlayDirs must persist on cleanup failure so the startup sweep retries");
    assert.equal(onDisk.overlayDirs.root, fixtureRoot);
  });
});

// taskferry#328: overlaySleepFn threads through TWO independent call paths
// -- extraction at settlement (covered by tasks.changeset.test.js's
// overlay-mount-busy reclassification tests) and accept/apply
// (acceptTaskChangeset -> applyChangeset -> applyNonGitChangeset ->
// runExtractionBwrap). Before this test, only the extraction path had
// coverage proving the injected sleep actually fires through the manager
// API -- a regression that broke overlaySleepFn forwarding specifically in
// the accept closure would have gone undetected (code review finding on PR
// #333). A standalone describe block (own fixture, not the "accept()/
// reject()" block's shared pendingTaskFixture()) so this one addition
// doesn't push that block's line count over the sonarjs function-length cap.
describe("accept(): overlaySleepFn threading (taskferry#328)", () => {
  test("accept() on a non-git target threads overlaySleepFn through applyChangeset's overlay-mount-busy retry", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-accept-sleepfn-"));
    const overlayRoot = path.join(tmpRoot, "overlay");
    fs.mkdirSync(path.join(overlayRoot, "upper", "main"), { recursive: true });
    fs.mkdirSync(path.join(overlayRoot, "work", "main"), { recursive: true });
    const diffPath = path.join(tmpRoot, "t_pending.patch");
    fs.writeFileSync(diffPath, DIFF_LINE);
    const bwrapMessage =
      "bwrap: Can't make overlay mount on /newroot/workspace with options " +
      "upperdir=/tmp/upper,workdir=/tmp/work,lowerdir=/oldroot/workspace,userxattr: Device or resource busy";
    let bwrapAttempts = 0;
    const sleeps = [];
    const mgr = makeManager({
      tasksFixture: [{
        ...baseTask({ id: "t_pending", status: "done" }),
        role: "dispatch",
        changesetStatus: "pending",
        diffPath,
        preDispatchHead: null, // non-git target -> applyNonGitChangeset
        overlayDirs: { tmpRoot, root: overlayRoot, upperDir: path.join(overlayRoot, "upper", "main"), workDir: path.join(overlayRoot, "work", "main"), rwBinds: [] },
      }],
      runOverlayCommandFn: () => {
        bwrapAttempts += 1;
        if (bwrapAttempts < 3) return { status: 1, stdout: "", stderr: bwrapMessage };
        return { status: 0, stdout: "", stderr: "" };
      },
      rmOverlayTreeFn: () => {},
      overlaySleepFn: (ms) => sleeps.push(ms),
    });

    const result = await mgr.accept("t_pending");

    assert.equal(result.applied, true, "the apply must succeed once the retry clears the busy mount");
    assert.equal(bwrapAttempts, 3, "must retry the apply bwrap through the same busy-race backoff extraction uses");
    assert.deepEqual(sleeps, [100, 300], "overlaySleepFn must be invoked for each retry, proving it reaches applyNonGitChangeset via acceptTaskChangeset, not just extraction");
  });
});

describe("summarize() changeset exposure", () => {
  test("exposes changeset fields only when they are meaningful", () => {
    const overlayDirs = {
      root: path.join(os.tmpdir(), OVERLAY_DIR_PENDING),
      tmpRoot: os.tmpdir(),
      upperDir: path.join(os.tmpdir(), OVERLAY_DIR_PENDING, "upper", "main"),
      workDir: path.join(os.tmpdir(), OVERLAY_DIR_PENDING, "work", "main"),
      rwBinds: [],
    };
    const mgr = makeManager({
      tasksFixture: [
        baseTask({ id: "t_plain", role: "dispatch", changesetStatus: "none", overlayDirs: null, changesetError: null }),
        baseTask({ id: "t_advisor", role: "advisor", changesetStatus: "none" }),
        baseTask({ id: "t_pending", role: "dispatch", changesetStatus: "pending", changesetError: SPAWN_BWRAP_TIMEOUT, overlayDirs }),
      ],
    });

    const plain = mgr.status("t_plain");
    assert.equal("role" in plain, false);
    assert.equal("changesetStatus" in plain, false);
    assert.equal("overlayDirs" in plain, false);
    assert.equal("changesetError" in plain, false);

    const advisor = mgr.status("t_advisor");
    assert.equal(advisor.role, "advisor");
    assert.equal(advisor.changesetStatus, "none");

    const pending = mgr.status("t_pending");
    assert.equal(pending.role, "dispatch");
    assert.equal(pending.changesetStatus, "pending");
    assert.deepEqual(pending.overlayDirs, overlayDirs);
    assert.equal(pending.changesetError, SPAWN_BWRAP_TIMEOUT);
  });
});

describe("list()", () => {
  test("empty state is explicit, not an empty array", () => {
    const mgr = makeManager();
    const l = mgr.list();
    assert.deepEqual(l.counts, { queued: 0, running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0 });
    assert.equal(l.tasks, "none found (this server process's lifetime)");
  });

  test("tallies counts across mixed statuses, including a rehydrated 'unknown'", () => {
    const mgr = makeManager({
      tasksFixture: [
        baseTask({ id: "t1", status: "done" }),
        baseTask({ id: "t2", status: "crashed" }),
        baseTask({ id: "t3", status: "cancelled" }),
        baseTask({ id: "t4", status: "running" }), // becomes "unknown" on load
      ],
    });
    assert.deepEqual(mgr.list().counts, { queued: 0, running: 0, done: 1, crashed: 1, cancelled: 1, unknown: 1 });
  });

  test("rows use the minimal schema plus failureReason, not the full detail object", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1" })] });
    const row = mgr.list().tasks[0];
    assert.deepEqual(Object.keys(row).sort(), ["directory", "failureReason", "id", "model", "startedAt", "status"]);
  });

  test("sorts newest first by startedAt", () => {
    const mgr = makeManager({
      tasksFixture: [
        baseTask({ id: "older", startedAt: "2026-07-13T09:00:00.000Z" }),
        baseTask({ id: "newer", startedAt: "2026-07-13T11:00:00.000Z" }),
      ],
    });
    assert.deepEqual(mgr.list().tasks.map((t) => t.id), ["newer", "older"]);
  });
});

describe("result()", () => {
  test("joins only the final step's text as `message`, keeps everything as `narration`", () => {
    const log = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "I'm about to run ls" } }),
      JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: TOOL_CALLS } }),
      JSON.stringify({ type: "text", part: { messageID: "m2", text: "Final answer text" } }),
      JSON.stringify({
        type: "step_finish",
        part: { messageID: "m2", reason: "stop", tokens: { total: 100 }, cost: 0.001 },
      }),
      JSON.stringify({ sessionID: "ses_from_log" }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    const r = mgr.result("t1");
    assert.equal(r.message, "Final answer text");
    assert.equal(r.narration, "I'm about to run ls\n\nFinal answer text");
    assert.deepEqual(r.tokens, { total: 100 });
    assert.equal(r.cost, 0.001);
    assert.equal(r.sessionId, "ses_from_log");
    assert.equal(r.narrationTruncated, false);
    assert.equal(r.narrationTotalChars, r.narration.length);
    assert.equal("next" in r, false);
  });

  test("sums tokens and cost across every step_finish instead of keeping only the last (issue #201)", () => {
    const log = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "step one" } }),
      JSON.stringify({
        type: "step_finish",
        part: {
          messageID: "m1",
          reason: TOOL_CALLS,
          tokens: { total: 100, input: 10, output: 20, reasoning: 5, cache: { write: 1, read: 2 } },
          cost: 0.001,
        },
      }),
      JSON.stringify({ type: "text", part: { messageID: "m2", text: "step two" } }),
      JSON.stringify({
        type: "step_finish",
        part: {
          messageID: "m2",
          reason: "stop",
          tokens: { total: 200, input: 15, output: 25, reasoning: 10, cache: { write: 3, read: 4 } },
          cost: 0.002,
        },
      }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    const r = mgr.result("t1");
    assert.deepEqual(r.tokens, { total: 300, input: 25, output: 45, reasoning: 15, cache: { write: 4, read: 6 } });
    assert.equal(r.cost, 0.003);
  });

  test("falls back to the last message seen when no step_finish reason 'stop' exists", () => {
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "partial output before a crash" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "crashed", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    assert.equal(mgr.result("t1").message, "partial output before a crash");
  });

  test("truncates narration past 2000 chars by default, with a `next` hint to escape it", () => {
    const filler = "x".repeat(3000);
    const log = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: filler } }),
      JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: TOOL_CALLS } }),
      JSON.stringify({ type: "text", part: { messageID: "m2", text: "final" } }),
      JSON.stringify({ type: "step_finish", part: { messageID: "m2", reason: "stop" } }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    const r = mgr.result("t1");
    const expectedFull = filler + "\n\nfinal";
    assert.equal(r.narrationTruncated, true);
    assert.equal(r.narrationTotalChars, expectedFull.length);
    assert.equal(r.narration, expectedFull.slice(0, 2000) + "…");
    assert.match(r.next, /full: true.*t1/);
    assert.equal(r.message, "final"); // message itself is never truncated
  });

  test("full: true returns the untruncated narration", () => {
    const filler = "x".repeat(3000);
    const log = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: filler } }),
      JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "done", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    const r = mgr.result("t1", { full: true });
    assert.equal(r.narrationTruncated, false);
    assert.equal(r.narration, filler);
    assert.equal("next" in r, false);
  });

  test("a task with no matching log file still returns cleanly (empty message/narration)", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "crashed", logPath: path.join(logDir, "missing.ndjson") })],
    });
    const r = mgr.result("t1");
    assert.equal(r.message, "");
    assert.equal(r.narration, "");
  });

  test("returns a polite 'still running' message without reading the log, for a running task", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const r = mgr.result(dispatched.id);
    assert.equal(r.status, "running");
    assert.match(r.message, /still running/);
  });

  test("projects only requested fields while retaining the task envelope", () => {
    const log = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: FINAL_ANSWER } }),
      JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    assert.deepEqual(mgr.result("t1", { fields: ["message"] }), {
      taskId: "t1",
      status: "done",
      message: FINAL_ANSWER,
    });
  });

  test("rejects a full narration request that omits narration from fields", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1" })] });
    assert.throws(() => mgr.result("t1", { full: true, fields: ["message"] }), /full requires narration/);
  });

  test("returns null for selected fields unavailable on a running task", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const task = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.deepEqual(mgr.result(task.id, { fields: ["tokens"] }), {
      taskId: task.id,
      status: "running",
      tokens: null,
    });
  });

  test("does not expose partial output from an unknown summary task", () => {
    const mgr = makeManager({
      tasksFixture: [baseTask({ id: "t1", status: "running", summaryOf: { sourceTaskId: "source" } })],
    });
    const r = mgr.result("t1", { fields: ["message"] });
    assert.equal(r.status, "unknown");
    assert.match(r.message, /partial output is unavailable/);
  });
});

describe("result() diffStat field", () => {
  // The diffStat path now shells out to `git apply --numstat <diffPath>` via
  // the runOverlayCommandFn delegate (review finding #13, root-cause fix).
  // The fake here mirrors the real git format: one `<adds>\t<dels>\t<path>`
  // line per file; the test never touches a real git binary.
  test("shells out to git apply --numstat and sums the tab-separated counts (regression: review finding #13)", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_stat", logPath: path.join(logDir, "t_stat.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_stat.patch"),
      }],
      logs: { "t_stat.ndjson": "" },
      runOverlayCommandFn: (command, args) => {
        if (command === "git" && args[0] === "apply" && args[1] === "--numstat") {
          return { status: 0, stdout: "2\t1\tone.txt\n0\t1\ttwo.txt\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_stat.patch"), "diff --git a/one.txt b/one.txt\n");
    const result = mgr.result("t_stat", { fields: ["diffStat"] });
    assert.deepEqual(result.diffStat, { files: 2, additions: 2, deletions: 2 });
    assert.deepEqual(mgr.result("t_stat").diffStat, { files: 2, additions: 2, deletions: 2 });
  });

  test("reports a non-zero file count for a non-git-style diff (regression: review finding #13, non-git)", () => {
    // The pre-fix hand-rolled scan counted only `diff --git` headers, so
    // every non-git changeset reported files:0 regardless of how many files
    // actually changed. The new path routes both kinds through git apply
    // --numstat, which parses both `diff --git` and plain `diff -ruN`
    // headers. This delegate unit test mocks the run command with the same
    // output git would emit for a two-file non-git extraction; the patch
    // content matches what the mock claims to produce so the test exercises
    // the parser contract rather than skipping the patch entirely.
    const patch = [
      "diff -ruN a/existing.txt b/existing.txt",
      "--- a/existing.txt\t2026-01-01 00:00:00.000000000 -0500",
      "+++ b/existing.txt\t2026-01-01 00:00:00.000000000 -0500",
      "@@ -1 +1,2 @@",
      "-original",
      "+modified",
      "+added",
      "diff -ruN a/newfile.txt b/newfile.txt",
      "--- a/newfile.txt\t1969-12-31 19:00:00.000000000 -0500",
      "+++ b/newfile.txt\t2026-01-01 00:00:00.000000000 -0500",
      "@@ -0,0 +1 @@",
      "+new content",
      "",
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_nongit", logPath: path.join(logDir, "t_nongit.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_nongit.patch"),
      }],
      logs: { "t_nongit.ndjson": "" },
      runOverlayCommandFn: (command, args) => {
        if (command === "git" && args[0] === "apply" && args[1] === "--numstat") {
          return { status: 0, stdout: "2\t1\tmerged/existing.txt\n1\t0\tmerged/newfile.txt\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_nongit.patch"), patch);
    const result = mgr.result("t_nongit", { fields: ["diffStat"] });
    assert.notEqual(result.diffStat.files, 0, "non-git diffs must not silently report 0 files");
    assert.deepEqual(result.diffStat, { files: 2, additions: 3, deletions: 1 });
  });

  test("parses a real diff -ruN patch via the real git apply --numstat parser (regression followup: central compatibility claim)", () => {
    // The delegate unit test above mocks git's output. This test verifies
    // the central compatibility claim the brief called out: that git apply
    // --numstat actually parses the diff -ruN format extractNonGitDiff
    // produces, and the parser sums the columns git emits. Inject
    // changeset.js's real defaultRunCommand so the test exercises the real
    // Git binary rather than a synthetic mock.
    const patch = [
      "diff -ruN a/existing.txt b/existing.txt",
      "--- a/existing.txt\t2026-01-01 00:00:00.000000000 -0500",
      "+++ b/existing.txt\t2026-01-01 00:00:00.000000000 -0500",
      "@@ -1 +1,2 @@",
      "-original",
      "+modified",
      "+added",
      "diff -ruN a/newfile.txt b/newfile.txt",
      "--- a/newfile.txt\t1969-12-31 19:00:00.000000000 -0500",
      "+++ b/newfile.txt\t2026-01-01 00:00:00.000000000 -0500",
      "@@ -0,0 +1 @@",
      "+new content",
      "",
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_real_nongit", logPath: path.join(logDir, "t_real_nongit.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_real_nongit.patch"),
      }],
      logs: { "t_real_nongit.ndjson": "" },
      runOverlayCommandFn: changesetDefaultRunCommand,
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_real_nongit.patch"), patch);
    const result = mgr.result("t_real_nongit", { fields: ["diffStat"] });
    // Real git apply --numstat must report non-zero counts for this
    // representative diff -ruN patch; previously the hand-rolled scan
    // reported files:0 for every non-git changeset.
    assert.notEqual(result.diffStat.files, 0, "git apply --numstat must parse real diff -ruN output");
    // The patch has 2 additions + 1 deletion in existing.txt and 1
    // addition in newfile.txt.
    assert.equal(result.diffStat.files, 2);
    assert.equal(result.diffStat.additions, 3);
    assert.equal(result.diffStat.deletions, 1);
  });

  test("falls back to a zero stat when git apply --numstat fails to parse the diff", () => {
    // Failure mode: a plain `diff -ru` (without `-N`) extraction whose
    // "Only in ..." lines confuse git apply. The diff text is still
    // readable via `result --diff`, only the human-readable summary is
    // uncomputable; returning a zero stat is the documented fallback.
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_unparsable", logPath: path.join(logDir, "t_unparsable.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_unparsable.patch"),
      }],
      logs: { "t_unparsable.ndjson": "" },
      runOverlayCommandFn: (command, args) => {
        if (command === "git" && args[0] === "apply" && args[1] === "--numstat") {
          return { status: 128, stdout: "", stderr: "error: No valid patches in input\n" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_unparsable.patch"), "Only in b: newfile.txt\n");
    const result = mgr.result("t_unparsable", { fields: ["diffStat"] });
    assert.deepEqual(result.diffStat, { files: 0, additions: 0, deletions: 0 });
  });

  test("treats a non-zero git apply --numstat exit as parse failure even when stdout is non-empty (regression followup)", () => {
    // git apply --numstat exits 0 on success and a non-zero status on any
    // failure (corrupt patch, parse error, etc.). A non-zero status with
    // partial stdout should NOT be parsed -- a failed invocation can
    // produce partial output that would, if read, give a misleading
    // non-zero count. The fallback is the zero stat.
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_status1", logPath: path.join(logDir, "t_status1.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_status1.patch"),
      }],
      logs: { "t_status1.ndjson": "" },
      runOverlayCommandFn: (command, args) => {
        if (command === "git" && args[0] === "apply" && args[1] === "--numstat") {
          return { status: 1, stdout: "5\t3\tmerged/leftover.txt\n", stderr: "error: corrupt patch\n" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_status1.patch"), "garbage\n");
    const result = mgr.result("t_status1", { fields: ["diffStat"] });
    assert.deepEqual(result.diffStat, { files: 0, additions: 0, deletions: 0 }, "non-zero status must zero the stat, not parse partial stdout");
  });
});

describe("result() diff field", () => {
  test("returns the cached patch text for fields: ['diff']", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_diff", logPath: path.join(logDir, "t_diff.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_diff.patch"),
      }],
      logs: { "t_diff.ndjson": "" },
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_diff.patch"), DIFF_LINE);
    const result = mgr.result("t_diff", { fields: ["diff"] });
    assert.equal(result.diff, DIFF_LINE);
  });

  test("returns null for a task with no diffPath", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t_no_diff" })] });
    const result = mgr.result("t_no_diff", { fields: ["diff"] });
    assert.equal(result.diff, null);
  });
});

describe("tail()", () => {
  test("returns a Unicode-safe suffix of the latest text event", () => {
    const log = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "older" } }),
      JSON.stringify({ type: "text", part: { messageID: "m2", text: "alpha😀beta" } }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": log },
    });
    assert.deepEqual(mgr.tail("t1", { chars: 5 }), {
      taskId: "t1",
      status: "done",
      text: "😀beta",
      textTotalChars: 10,
      truncated: true,
    });
  });

  test("returns a definitive no-text response", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1" })] });
    const r = mgr.tail("t1");
    assert.equal(r.text, NONE_OBSERVED);
    assert.equal(r.textTotalChars, 0);
    assert.equal(r.truncated, false);
  });

  test("validates the requested suffix length", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1" })] });
    assert.throws(() => mgr.tail("t1", { chars: 0 }), /chars must be a positive integer/);
  });

  test("accepts a request up to the 131072 ceiling and rejects above it", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1" })] });
    assert.doesNotThrow(() => mgr.tail("t1", { chars: 131072 }));
    assert.throws(() => mgr.tail("t1", { chars: 131073 }), /chars must be a positive integer no greater than 131072/);
  });

  test("falls back to raw captured output for a crashed task that never emitted an event", () => {
    const raw = 'Error: Extension "/x/y.js" error: Provider y: "baseUrl" is required when defining models.';
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "crashed", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": raw + "\n" },
    });
    const r = mgr.tail("t1");
    assert.equal(r.text, raw);
    assert.equal(r.textTotalChars, raw.length);
    assert.equal(r.truncated, false);
  });

  test("keeps the none-observed response once any parseable event exists, even with no narration", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "crashed", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": JSON.stringify({ type: "step_start", part: {} }) + "\nError: mid-run stderr noise\n" },
    });
    assert.equal(mgr.tail("t1").text, NONE_OBSERVED);
  });

  test("raw-capture fallback respects the chars suffix and reports truncation", () => {
    const raw = "Error: " + "x".repeat(1500);
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "crashed", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": raw + "\n" },
    });
    const r = mgr.tail("t1");
    assert.equal(Array.from(r.text).length, 1000);
    assert.equal(r.textTotalChars, raw.length);
    assert.equal(r.truncated, true);
  });

  test("an eventless crashed task with an empty log keeps the none-observed response", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "crashed", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": "" },
    });
    assert.equal(mgr.tail("t1").text, NONE_OBSERVED);
  });

  test("a watchdog-killed eventless task shows its raw capture (failureReason does not gate tail)", () => {
    const raw = 'Error: Extension "/x/y.js" blew up at load';
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "t1", status: "crashed", failureReason: "no_output_timeout", logPath: path.join(logDir, "t1.ndjson") })],
      logs: { "t1.ndjson": raw + "\n" },
    });
    assert.equal(mgr.tail("t1").text, raw);
  });
});

describe("poll()", () => {
  test("resolves immediately for a non-running task", async () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1", status: "crashed", exitCode: 1 })] });
    const settled = await mgr.poll("t1", { timeoutMs: 50 });
    assert.equal(settled.status, "crashed");
    assert.equal(settled.exitCode, 1);
  });

  test("resolves once the real exit event fires, before its timeout elapses", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    const waitPromise = mgr.poll(dispatched.id, { timeoutMs: 5000 });
    child.emit("exit", 0, null);
    const settled = await waitPromise;
    assert.equal(settled.status, "done");
  });

  test("with no timeoutMs, blocks until settlement instead of returning early", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    let resolved = false;
    const waitPromise = mgr.poll(dispatched.id).then((settled) => {
      resolved = true;
      return settled;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(resolved, false, "poll() must not resolve on its own without an explicit timeoutMs");

    child.emit("exit", 0, null);
    const settled = await waitPromise;
    assert.equal(settled.status, "done");
  });

  test("returns 'running' once its timeout elapses without an exit event", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    const settled = await mgr.poll(dispatched.id, { timeoutMs: 20 });
    assert.equal(settled.status, "running");
    assert.equal("outputTail" in settled, false);
  });

  test("returns the requested narration tail when its timeout elapses", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const output = "first chunk\nsecond chunk";
    fs.writeFileSync(
      dispatched.logPath,
      JSON.stringify({ type: "text", part: { messageID: "m1", text: output } })
    );

    const settled = await mgr.poll(dispatched.id, { timeoutMs: 20, tailChars: 6 });
    assert.equal(settled.status, "running");
    assert.equal(settled.outputTail, " chunk");
    assert.equal(settled.outputTailTotalChars, output.length);
    assert.equal(settled.outputTailTruncated, true);
  });

  test("with no options, resolves only once the task settles (no default 45s timer)", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    try {
      mock.timers.enable({ apis: ["setTimeout"] });
      const waitPromise = mgr.poll(dispatched.id);
      let settledYet = false;
      void waitPromise.then(() => { settledYet = true; });

      // Advance beyond the old default instead of waiting a short real-time interval.
      mock.timers.tick(45001);
      await Promise.resolve();
      assert.equal(settledYet, false, "poll() with no options must not resolve before the task settles");

      child.emit("exit", 0, null);
      const settled = await waitPromise;
      assert.equal(settled.status, "done");
    } finally {
      mock.timers.reset();
    }
  });

  test("with { timeoutMs: N }, still returns 'running' after Nms when the task hasn't settled (explicit override path)", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    try {
      mock.timers.enable({ apis: ["setTimeout"] });
      const waitPromise = mgr.poll(dispatched.id, { timeoutMs: 50000 });
      let settledYet = false;
      void waitPromise.then(() => { settledYet = true; });

      // The old implementation clamped this value to 45000ms.
      mock.timers.tick(45001);
      await Promise.resolve();
      assert.equal(settledYet, false, "timeoutMs above the old cap must not settle at 45000ms");

      mock.timers.tick(4999);
      const settled = await waitPromise;
      assert.equal(settled.status, "running");
      assert.equal("outputTail" in settled, false);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("daemon-restart handling for a check gate that was mid-flight", () => {
  // A daemon that crashed/was force-restarted while a check gate was running
  // (checkStatus: "running") leaves that status stuck forever -- nothing will
  // ever call startCheckGate()'s exit/error handlers for that task again,
  // because the child that would have called them died with the daemon. These
  // tests pin the boot-time reclassification ("running" -> "interrupted") and
  // the auto re-run for tasks whose overlay survived the crash.

  test("a task whose check gate was 'running' when the daemon last exited loads as 'interrupted', not silently 'passed'", () => {
    const mgr = makeManager({
      tasksFixture: [
        { id: "oc_interrupted1", status: "done", directory: os.tmpdir(), checkStatus: "running", checkCommand: "npm test", changesetStatus: "pending" },
      ],
    });
    const status = mgr.status("oc_interrupted1");
    assert.equal(status.checkStatus, "interrupted");
  });

  test("a task whose check gate had already settled ('passed') is left untouched on daemon restart", () => {
    const mgr = makeManager({
      tasksFixture: [
        { id: "oc_settled1", status: "done", directory: os.tmpdir(), checkStatus: "passed", checkCommand: "npm test", changesetStatus: "pending" },
      ],
    });
    assert.equal(mgr.status("oc_settled1").checkStatus, "passed");
  });

  test("a task already force-accepted/rejected while its gate was 'running' is left alone, not flipped to 'interrupted'", () => {
    // Review fix: changesetStatus left "accepted"/"rejected" but checkStatus
    // still "running" (the kill signal fired, but no exit event landed before
    // the daemon died) must NOT be reclassified -- the decision is already
    // made. A task that's already been decided is not this sweep's concern.
    const mgr = makeManager({
      tasksFixture: [
        { id: "oc_decided1", status: "done", directory: os.tmpdir(), checkStatus: "running", checkCommand: "npm test", changesetStatus: "accepted" },
        { id: "oc_decided2", status: "done", directory: os.tmpdir(), checkStatus: "running", checkCommand: "npm test", changesetStatus: "rejected" },
      ],
    });
    assert.equal(mgr.status("oc_decided1").checkStatus, "running");
    assert.equal(mgr.status("oc_decided2").checkStatus, "running");
  });

  test("a task whose gate was 'running' AND whose overlay is still live is automatically re-run on next daemon restart", () => {
    // The design's "the gate is re-runnable" promise: a daemon crash mid-gate
    // does not silently pass; the next daemon boot re-runs the gate, and the
    // user sees "running" again on `taskferry status <id>` instead of a
    // dead-looking "interrupted" with no further action. startCheckGate
    // flips checkStatus back to "running" before spawning, so the brief
    // "interrupted" write is not user-observable -- only the post-boot
    // "running" state is.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-rerun-"));
    fs.writeFileSync(path.join(directory, ".taskferry.toml"), `check = "true"\n`);
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-rerun-overlay-"));
    const overlayRoot = path.join(overlayTmpRoot, `taskferry-cow-oc_rerun1`);
    fs.mkdirSync(path.join(overlayRoot, "upper", "main"), { recursive: true });
    const spawns = [];
    const mgr = makeManager({
      tasksFixture: [{
        ...baseTask({ id: "oc_rerun1", directory }),
        role: "dispatch",
        changesetStatus: "pending",
        preDispatchHead: "abc123",
        checkStatus: "running",
        checkCommand: "true",
        checkExitCode: null,
        checkOutputTail: null,
        overlayDirs: { root: overlayRoot, tmpRoot: overlayTmpRoot, upperDir: path.join(overlayRoot, "upper", "main"), workDir: path.join(overlayRoot, "work", "main"), rwBinds: [] },
      }],
      spawnFn: (cmd, args, opts) => {
        const child = new EventEmitter();
        child.pid = 9001;
        child.unref = () => {};
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        spawns.push({ cmd, args, opts, child });
        return child;
      },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    // Auto re-run: the bwrap spawn is the one observable side effect of
    // startCheckGate() being called (no other boot path spawns a child).
    const bwrapSpawns = spawns.filter((s) => s.cmd === "bwrap");
    assert.equal(bwrapSpawns.length, 1, "startCheckGate must be invoked exactly once for the auto re-run");
    assert.ok(bwrapSpawns[0].args.includes("true"), "the re-run must execute the .taskferry.toml check command");
    assert.equal(mgr.status("oc_rerun1").checkStatus, "running", "the auto re-run flips checkStatus back to 'running' before the test can observe 'interrupted'");
  });

  test("restart with a live overlay best-effort kills any orphaned gate process before re-running", () => {
    // Review fix: an UNCLEAN daemon death (crash, OOM-kill, force-restart)
    // is the one path where nothing ever sent the gate a kill signal at all
    // (a graceful accept/reject/shutdown always does, via killGateAndWait).
    // Because the gate is spawned `detached: true` (Task 5), the persisted
    // `task.checkGatePid` IS that process group's leader pid, so a
    // best-effort group-kill against it on restart reaps any surviving
    // orphan from the previous daemon incarnation BEFORE a second gate
    // mounts the same overlay -- without this, two writers (the orphan and
    // the fresh re-run) can be live against the same upper/work dir at
    // once. `sendSignal` already swallows ESRCH (nothing there), so this is
    // safe to call unconditionally.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-kill-"));
    fs.writeFileSync(path.join(directory, ".taskferry.toml"), `check = "true"\n`);
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-kill-overlay-"));
    const overlayRoot = path.join(overlayTmpRoot, `taskferry-cow-oc_orphankill1`);
    fs.mkdirSync(path.join(overlayRoot, "upper", "main"), { recursive: true });
    const killCalls = [];
    const spawns = [];
    const mgr = makeManager({
      tasksFixture: [{
        ...baseTask({ id: "oc_orphankill1", directory }),
        role: "dispatch",
        changesetStatus: "pending",
        preDispatchHead: "abc123",
        checkStatus: "running",
        checkCommand: "true",
        checkGatePid: 12345,
        overlayDirs: { root: overlayRoot, tmpRoot: overlayTmpRoot, upperDir: path.join(overlayRoot, "upper", "main"), workDir: path.join(overlayRoot, "work", "main"), rwBinds: [] },
      }],
      spawnFn: (cmd, args, opts) => {
        const child = new EventEmitter();
        child.pid = 9002;
        child.unref = () => {};
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        spawns.push({ cmd, args, opts, child });
        return child;
      },
      killFn: (pid, signal) => killCalls.push({ pid, signal }),
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    const orphanKill = killCalls.find((k) => k.pid === -12345 && k.signal === "SIGTERM");
    assert.ok(orphanKill, `expected a process-group SIGTERM to -12345 to reap the orphan, got ${JSON.stringify(killCalls)}`);
    const bwrapSpawns = spawns.filter((s) => s.cmd === "bwrap");
    assert.equal(bwrapSpawns.length, 1, "the re-run still mounts exactly one fresh bwrap gate over the overlay");
    assert.equal(mgr.status("oc_orphankill1").checkStatus, "running", "the re-run flips checkStatus back to 'running'");
  });
});
