import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createTaskManager, DEFAULT_SUMMARY_MODEL } from "./tasks.js";
import { makeManager, fakeChild, AXI_TASKS_ORPHAN, AXI_TASKS_TEST_DIR, AXI_TASKS_CACHE_DIR, TASKS_STATE_FILE, OVERLAY_DIR_PENDING, DIFF_LINE, SPAWN_BWRAP_TIMEOUT, SOL_MODEL, baseTask } from "./tasks.test-helpers.js";

const CHECK_GATE_CONFIG = `check = "npm test"\n`;
const CHECK_GATE_HEAD = "abc123\n";
const CHECK_GATE_DIFF = "diff --git a/f b/f\n+changed\n";
const CHECK_GATE_SESSION_ID = "ses_gate_fix";

function fakeGateChild(pid = 9000) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function dispatchAndSettleWithRunningGate({ directory, killFn = () => {}, onEvent, rmOverlayTreeFn }) {
  fs.writeFileSync(path.join(directory, ".taskferry.toml"), CHECK_GATE_CONFIG);
  const spawns = [];
  const mgr = makeManager({
    spawnFn: (cmd, args, opts) => {
      const child = spawns.length === 0 ? fakeChild() : fakeGateChild();
      spawns.push({ cmd, args, opts, child });
      return child;
    },
    sandboxEnabled: true,
    overlayEnabled: true,
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    checkOverlaySupportFn: () => ({ supported: true }),
    platform: "linux",
    killFn,
    onEvent,
    runOverlayCommandFn: (command, args) => {
      if (command === "bwrap") return { status: 0, stdout: CHECK_GATE_DIFF, stderr: "" };
      if (args?.[0] === "-C") return { status: 0, stdout: CHECK_GATE_HEAD, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    ...(rmOverlayTreeFn && { rmOverlayTreeFn }),
  });
  const dispatched = mgr.dispatch({ model: SOL_MODEL, executor: "opencode", prompt: "hello", directory });
  spawns[0].child.stdout.emit("data", Buffer.from(`${JSON.stringify({ sessionID: CHECK_GATE_SESSION_ID })}\n`));
  spawns[0].child.emit("exit", 0, null);
  return { mgr, dispatched, gateChild: spawns[1].child };
}

function pendingCheckGateTask(directory, overrides = {}) {
  const diffPath = path.join(directory, "changes.patch");
  fs.writeFileSync(diffPath, DIFF_LINE);
  return {
    ...baseTask({ directory, id: "t_pending", sessionId: CHECK_GATE_SESSION_ID }),
    role: "dispatch",
    changesetStatus: "pending",
    diffPath,
    preDispatchHead: "abc123",
    checkStatus: "none",
    checkCommand: null,
    checkExitCode: null,
    checkOutputTail: null,
    ...overrides,
  };
}

function managerWithPendingCheckGateTask(task) {
  return makeManager({
    tasksFixture: [task],
    runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "" }),
  });
}

describe("changeset extraction at settlement", () => {
  test("extracts a diff and leaves changesetStatus pending for a settled dispatch with an active overlay", () => {
    let extractCommand = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-tmp-"));
    let child;
    const mgr = makeManager({
      spawnFn: (_cmd, _args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      // Only capture the bwrap call: extraction also issues `git rev-parse
      // HEAD` calls through this same fn (the pre-retry guard, plus the
      // post-retry re-check added for taskferry#329), which would otherwise
      // overwrite extractCommand and hide the bwrap call this test pins.
      runOverlayCommandFn: (command, args) => { if (command === "bwrap") { extractCommand = { command, args }; } return { status: 0, stdout: DIFF_LINE, stderr: "" }; },
      overlayTmpRoot,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const status = mgr.status(result.id);
    assert.equal(status.changesetStatus, "pending");
    assert.equal(mgr.result(result.id, { fields: ["diff"] }).diff, DIFF_LINE);
    assert.equal(extractCommand.command, "bwrap");
  });

  test("auto-rejects and cleans up an advisor's changeset at settlement", async () => {
    let cleanedRoot = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-advisor-extract-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-advisor-extract-tmp-"));
    let child;
    const mgr = makeManager({
      spawnFn: (_cmd, _args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "" }),
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
      overlayTmpRoot,
    });

    const advisePromise = mgr.advisor({ prompt: "hello", model: SOL_MODEL, directory });
    setImmediate(() => child.emit("exit", 0, null));
    const advised = await advisePromise;

    const status = mgr.status(advised.task_id);
    assert.equal(status.changesetStatus, "rejected");
    assert.ok(cleanedRoot);
  });

  test("re-mounts persisted git-common-dir sub-overlays during extraction", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-git-dir-"));
    execFileSync("git", ["init", "-q", directory]);
    fs.writeFileSync(path.join(directory, "f.txt"), "base\n");
    execFileSync("git", ["-C", directory, "add", "-A"]);
    execFileSync("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-common-"));
    const gitWorktreeAdminDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-gitdir-"));
    let extractArgs = null;
    let child;
    const mgr = makeManager({
      spawnFn: (_cmd, _args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => gitWorktreeAdminDir,
      // Only capture the bwrap call's args -- see the sibling test above
      // (taskferry#329) for why a later git rev-parse call would otherwise
      // clobber extractArgs with something that has no --overlay-src flags.
      runOverlayCommandFn: (command, args) => { if (command === "bwrap") { extractArgs = args; } return { status: 0, stdout: "diff --git a/f.txt b/f.txt\n", stderr: "" }; },
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const overlaySrcCount = extractArgs.filter((a) => a === "--overlay-src").length;
    assert.ok(overlaySrcCount >= 2);
    assert.ok(extractArgs.includes(gitWorktreeAdminDir));
    assert.equal(mgr.status(result.id).changesetStatus, "pending");
  });

  test("auto-resolves a zero-change extraction to accepted and cleans up immediately", () => {
    let cleanedRoot = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-empty-extract-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-empty-extract-tmp-"));
    let child;
    const mgr = makeManager({
      spawnFn: (_cmd, _args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "" }),
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
      overlayTmpRoot,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const status = mgr.status(result.id);
    assert.equal(status.changesetStatus, "accepted");
    assert.ok(cleanedRoot);
    assert.equal("overlayDirs" in status, false);
  });

  test("extracts a changeset for a cancelled task too", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-cancel-extract-dir-"));
    let child;
    const mgr = makeManager({
      spawnFn: (_cmd, _args) => { child = fakeChild(); return child; },
      killFn: () => {},
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: () => ({ status: 0, stdout: DIFF_LINE, stderr: "" }),
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    mgr.cancel(result.id);
    child.emit("exit", null, "SIGTERM");

    const status = mgr.status(result.id);
    assert.equal(status.status, "cancelled");
    assert.equal(status.changesetStatus, "pending");
    assert.equal(mgr.result(result.id, { fields: ["diff"] }).diff, DIFF_LINE);
  });

  test("records extraction errors and keeps the overlay for recovery", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-failed-extract-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-failed-extract-tmp-"));
    let cleanedAny = false;
    let child;
    const mgr = makeManager({
      spawnFn: (_cmd, _args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error(SPAWN_BWRAP_TIMEOUT), { code: "ETIMEDOUT" }) }),
      rmOverlayTreeFn: () => { cleanedAny = true; },
      overlayTmpRoot,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const status = mgr.status(result.id);
    assert.equal(status.changesetStatus, "pending");
    assert.match(status.changesetError, /ETIMEDOUT/);
    assert.equal(mgr.result(result.id, { fields: ["diff"] }).diff, null);
    assert.ok(status.overlayDirs);
    assert.equal(cleanedAny, false);
  });

});

describe("accept() check-gate gating", () => {
  test("accept refuses a still-running check gate without --force", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-accept-running-"));
    const signals = [];
    const { mgr, dispatched, gateChild } = dispatchAndSettleWithRunningGate({
      directory,
      killFn: (pid, signal) => signals.push({ pid, signal }),
    });

    await assert.rejects(() => mgr.accept(dispatched.id, {}), /check gate still running/);
    const acceptPromise = mgr.accept(dispatched.id, { force: true });
    assert.ok(signals.some(({ pid, signal }) => pid < 0 && signal === "SIGTERM"));
    gateChild.emit("exit", null, "SIGTERM");
    const accepted = await acceptPromise;

    assert.equal(accepted.applied, true);
    assert.equal(mgr.status(dispatched.id).changesetStatus, "accepted");
  });

  test("accept refuses a failed check gate without --force, with the fix-forward message", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-accept-failed-"));
    const task = pendingCheckGateTask(directory, {
      checkStatus: "failed",
      checkCommand: "npm test",
      checkExitCode: 1,
      checkOutputTail: "2 tests failed",
    });
    const mgr = managerWithPendingCheckGateTask(task);

    await assert.rejects(
      () => mgr.accept(task.id, {}),
      (error) => {
        assert.match(error.message, /command: npm test \(from \.taskferry\.toml\)/);
        assert.match(error.message, /exit: 1/);
        assert.match(error.message, /2 tests failed/);
        assert.match(error.message, new RegExp(`taskferry dispatch --session-id ${CHECK_GATE_SESSION_ID} --parent-task ${task.id}`));
        return true;
      }
    );
  });

  test("accept --force on a failed gate succeeds and records checkOverride: true", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-accept-force-"));
    const task = pendingCheckGateTask(directory, {
      checkStatus: "failed",
      checkCommand: "npm test",
      checkExitCode: 1,
      checkOutputTail: "2 tests failed",
    });
    const mgr = managerWithPendingCheckGateTask(task);

    const accepted = await mgr.accept(task.id, { force: true });

    assert.equal(accepted.applied, true);
    assert.equal(mgr.status(task.id).checkOverride, true);
  });

  test("accept on a passed or absent (checkStatus 'none') gate needs no --force", async () => {
    for (const checkStatus of ["passed", "none"]) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `axi-gate-accept-${checkStatus}-`));
      const task = pendingCheckGateTask(directory, { checkStatus });
      const mgr = managerWithPendingCheckGateTask(task);

      const accepted = await mgr.accept(task.id, {});

      assert.equal(accepted.applied, true);
      assert.equal(mgr.status(task.id).changesetStatus, "accepted");
    }
  });
});

describe("reject() check-gate gating", () => {
  test("reject is always allowed regardless of checkStatus, even without --force", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-reject-failed-"));
    const task = pendingCheckGateTask(directory, {
      checkStatus: "failed",
      checkCommand: "npm test",
      checkExitCode: 1,
    });
    const mgr = managerWithPendingCheckGateTask(task);

    const rejected = await mgr.reject(task.id);

    assert.equal(rejected.changesetStatus, "rejected");
    assert.equal(mgr.status(task.id).checkOverride, undefined);
  });

  test("reject while the gate is still running kills the gate and waits for it to exit before releasing the overlay", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-reject-running-"));
    const signals = [];
    let released = false;
    const { mgr, dispatched, gateChild } = dispatchAndSettleWithRunningGate({
      directory,
      killFn: (pid, signal) => signals.push({ pid, signal }),
      rmOverlayTreeFn: () => { released = true; },
    });

    const rejectPromise = mgr.reject(dispatched.id);
    assert.ok(signals.some(({ pid, signal }) => pid < 0 && signal === "SIGTERM"));
    assert.equal(released, false);
    gateChild.emit("exit", null, "SIGTERM");
    const rejected = await rejectPromise;

    assert.equal(released, true);
    assert.equal(rejected.changesetStatus, "rejected");
    const status = mgr.status(dispatched.id);
    assert.equal(status.changesetStatus, "rejected");
    assert.equal(status.checkStatus, "running");
  });

  test("a gate that settles after a reject is a no-op", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-reject-late-exit-"));
    const activityEvents = [];
    const { mgr, dispatched, gateChild } = dispatchAndSettleWithRunningGate({
      directory,
      killFn: () => {},
      onEvent: (event) => {
        if (event.type === "task.activity") activityEvents.push(event);
      },
      rmOverlayTreeFn: () => {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    const rejectPromise = mgr.reject(dispatched.id);
    gateChild.emit("exit", null, "SIGTERM");
    await rejectPromise;
    await new Promise((resolve) => setImmediate(resolve));
    const activityCount = activityEvents.length;
    gateChild.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    const status = mgr.status(dispatched.id);
    assert.equal(status.changesetStatus, "rejected");
    assert.equal(status.checkStatus, "running");
    assert.equal(status.checkOverride, undefined);
    assert.equal(activityEvents.length, activityCount);
  });
});

describe("changeset extraction at settlement: overlay-mount-busy reclassification", () => {
  test("reclassifies a real no_output_timeout crash as overlay_mount_busy when the bwrap overlay-busy message is the real cause", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-overlay-busy-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-overlay-busy-tmp-"));
    const bwrapMessage =
      "bwrap: Can't make overlay mount on /newroot/workspace with options " +
      "upperdir=/tmp/upper,workdir=/tmp/work,lowerdir=/oldroot/workspace,userxattr: Device or resource busy";
    const child = fakeChild(7200);
    // Every runOverlayCommandFn call below reports the busy signature, so
    // extraction's retry-with-backoff (changeset.js's runExtractionBwrap)
    // exhausts all three retries before giving up. Injecting overlaySleepFn
    // (taskferry#328) keeps that ~1.3s of real backoff out of the test's
    // wall-clock time -- and the captured `sleeps` doubles as proof the
    // retry loop actually ran, not just that the final error classified
    // correctly.
    const sleeps = [];
    const mgr = makeManager({
      overlayTmpRoot,
      spawnFn: () => child,
      killFn: () => {},
      noOutputTimeoutMs: 20,
      watchdogPollMs: 5,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: () => ({ status: null, stdout: "", stderr: "", error: new Error(bwrapMessage) }),
      rmOverlayTreeFn: () => {},
      overlaySleepFn: (ms) => sleeps.push(ms),
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    // Let the watchdog fire first, exactly like the real crash: the child
    // never produces output (bwrap is stuck failing to mount), the watchdog
    // SIGTERMs it and stamps failureReason: "no_output_timeout" BEFORE the
    // exit handler ever runs extractChangesetForTask().
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(mgr.status(result.id).failureReason, "no_output_timeout", "sanity: the watchdog must have fired first");

    child.emit("exit", null, "SIGTERM");

    const status = mgr.status(result.id);
    assert.equal(status.failureReason, "overlay_mount_busy", "the confirmed bwrap cause must overwrite the generic no_output_timeout guess");
    assert.match(status.failureDetail, /Device or resource busy/);
    assert.match(status.changesetError, /Device or resource busy/);
    assert.deepEqual(sleeps, [100, 300, 900], "must exhaust the full retry backoff, injected through the manager API, before giving up");
  });

  // Regression (taskferry#327 review finding): a non-git target's extraction
  // bwrap fails with the exact status shape bwrap itself produces on a real
  // overlay-mount-busy setup failure -- status: 1, no `error`, the busy text
  // in stderr -- which collides with `diff -ruN`'s own exit-1-for-
  // differences-found convention. The prior fix (mocked with {status: null,
  // error: ...}, an ETIMEDOUT shape, not a real bwrap die()) never exercised
  // this exact collision and would have silently accepted an empty diff.
  test("a real bwrap status-1 overlay-busy failure on a non-git target still reclassifies as overlay_mount_busy (does not fail open as a zero-change accept)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-overlay-busy-nongit-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-overlay-busy-nongit-tmp-"));
    const bwrapMessage =
      "bwrap: Can't make overlay mount on /newroot/workspace with options " +
      "upperdir=/tmp/upper,workdir=/tmp/work,lowerdir=/oldroot/workspace,userxattr: Device or resource busy";
    const child = fakeChild(7200);
    // See the sibling test above (taskferry#328): overlaySleepFn keeps the
    // full retry-backoff out of this test's real wall-clock time.
    const sleeps = [];
    const mgr = makeManager({
      overlayTmpRoot,
      spawnFn: () => child,
      killFn: () => {},
      noOutputTimeoutMs: 20,
      watchdogPollMs: 5,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: () => ({ status: 1, stdout: "", stderr: bwrapMessage, error: null }),
      rmOverlayTreeFn: () => {},
      overlaySleepFn: (ms) => sleeps.push(ms),
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");

    const status = mgr.status(result.id);
    assert.equal(status.failureReason, "overlay_mount_busy", "a real bwrap exit-1 overlay-busy failure must never be mistaken for diff's own exit-1 (differences found)");
    assert.notEqual(status.changesetStatus, "accepted", "must not silently accept an empty diff when extraction actually failed");
    assert.equal(mgr.result(result.id, { fields: ["diff"] }).diff, null, "no patch may be persisted for a failed extraction");
    assert.deepEqual(sleeps, [100, 300, 900], "must exhaust the full retry backoff, injected through the manager API, before giving up");
  });

  test("an unrelated extraction error does not touch failureReason", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-overlay-unrelated-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-overlay-unrelated-tmp-"));
    let child;
    const mgr = makeManager({
      overlayTmpRoot,
      spawnFn: () => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error(SPAWN_BWRAP_TIMEOUT), { code: "ETIMEDOUT" }) }),
      rmOverlayTreeFn: () => {},
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const status = mgr.status(result.id);
    assert.equal(status.failureReason, null, "an unrelated extraction error must not invent a failureReason");
    assert.match(status.changesetError, /ETIMEDOUT/);
  });
});

describe("boot-time sweep of orphaned prompt scratch files in PROMPT_DIR", () => {
  function seedPromptDir(stateDir, entries) {
    const promptDir = path.join(stateDir, "prompts");
    fs.mkdirSync(promptDir, { recursive: true, mode: 0o700 });
    for (const name of entries) fs.writeFileSync(path.join(promptDir, name), "leftover prompt contents");
  }

  test("removes prompt files whose task id is not in the loaded task set", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), AXI_TASKS_ORPHAN));
    seedPromptDir(stateDir, [
      "oc_orphan_aaaaaaaa.prompt.txt",
      "oc_orphan_bbbbbbbb.prompt.txt",
    ]);

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts"));
    assert.deepEqual(remaining, []);
  });

  test("removes prompt files that belong to a tracked terminal task", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), AXI_TASKS_ORPHAN));
    const tracked = "oc_keepme_cccccccc";
    seedPromptDir(stateDir, [`${tracked}.prompt.txt`, "oc_orphan_dddddddd.prompt.txt"]);
    fs.writeFileSync(
      path.join(stateDir, TASKS_STATE_FILE),
      JSON.stringify([baseTask({ id: tracked, status: "done" })], null, 2)
    );

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts"));
    assert.deepEqual(remaining, []);
  });

  test("removes prompt files for persisted tasks already marked 'unknown' after a crash", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), AXI_TASKS_ORPHAN));
    const crashed = "oc_running_eeeeeeee";
    seedPromptDir(stateDir, [`${crashed}.prompt.txt`]);
    fs.writeFileSync(
      path.join(stateDir, TASKS_STATE_FILE),
      JSON.stringify([baseTask({ id: crashed, status: "unknown" })], null, 2)
    );

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts"));
    assert.deepEqual(remaining, []);
  });

  test("ignores unrelated files in PROMPT_DIR that don't match the prompt-file naming pattern", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), AXI_TASKS_ORPHAN));
    seedPromptDir(stateDir, ["unrelated.txt", ".DS_Store", "README"]);

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts")).sort();
    assert.deepEqual(remaining, [".DS_Store", "README", "unrelated.txt"]);
  });

  test("removes prompt files for both orphaned and tracked terminal tasks", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), AXI_TASKS_ORPHAN));
    const tracked = "oc_trackedfffffff";
    seedPromptDir(stateDir, [
      `${tracked}.prompt.txt`,
      "oc_orphan_11111111.prompt.txt",
      "oc_orphan_22222222.prompt.txt",
    ]);
    fs.writeFileSync(
      path.join(stateDir, TASKS_STATE_FILE),
      JSON.stringify([baseTask({ id: tracked, status: "done" })], null, 2)
    );

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts"));
    assert.deepEqual(remaining, []);
  });

  test("boot-time sweep is a no-op when PROMPT_DIR is empty", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), AXI_TASKS_ORPHAN));
    seedPromptDir(stateDir, []);

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts"));
    assert.deepEqual(remaining, []);
  });

  test("removes prompt files for every persisted status after running and queued reload as unknown", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), AXI_TASKS_ORPHAN));
    const ids = {
      done: "oc_done_00000001",
      crashed: "oc_crash_00000002",
      cancelled: "oc_cancel_00000003",
      queued: "oc_queue_00000004",
      running: "oc_runnin_00000005",
    };
    seedPromptDir(stateDir, Object.values(ids).map((id) => `${id}.prompt.txt`));
    fs.writeFileSync(
      path.join(stateDir, TASKS_STATE_FILE),
      JSON.stringify([
        baseTask({ id: ids.done, status: "done" }),
        baseTask({ id: ids.crashed, status: "crashed", exitCode: 1 }),
        baseTask({ id: ids.cancelled, status: "cancelled", signal: "SIGTERM" }),
        baseTask({ id: ids.queued, status: "queued", pid: null }),
        baseTask({ id: ids.running, status: "running" }),
      ], null, 2)
    );

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts")).sort();
    assert.deepEqual(remaining, []);
  });

  test("boot-time sweep creates PROMPT_DIR when it doesn't exist (first daemon boot ever)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), AXI_TASKS_ORPHAN));
    // Deliberately don't create PROMPT_DIR; the manager's mkdir loop at
    // line 512 creates it, and the sweep then has nothing to do.
    assert.equal(fs.existsSync(path.join(stateDir, "prompts")), false);

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    assert.equal(fs.existsSync(path.join(stateDir, "prompts")), true);
    assert.deepEqual(fs.readdirSync(path.join(stateDir, "prompts")), []);
  });

  test("removes every scratch prompt from a mixed orphaned and tracked terminal directory", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), AXI_TASKS_ORPHAN));
    const tracked = ["oc_track11111111", "oc_track22222222"];
    const orphans = ["oc_orphan_aaaaaaa1", "oc_orphan_aaaaaaa2", "oc_orphan_aaaaaaa3", "oc_orphan_aaaaaaa4"];
    seedPromptDir(stateDir, [
      ...tracked.map((id) => `${id}.prompt.txt`),
      ...orphans.map((id) => `${id}.prompt.txt`),
    ]);
    fs.writeFileSync(
      path.join(stateDir, TASKS_STATE_FILE),
      JSON.stringify([
        baseTask({ id: tracked[0], status: "done" }),
        baseTask({ id: tracked[1], status: "crashed", exitCode: 1 }),
      ], null, 2)
    );

    createTaskManager({
      stateDir,
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => { throw new Error("not used"); },
    });

    const remaining = fs.readdirSync(path.join(stateDir, "prompts")).sort();
    assert.deepEqual(remaining, []);
  });
});

describe("sweepOrphanedOverlays()", () => {
  test("removes an overlay directory whose task id is unknown to this manager (crash before extraction ever ran)", () => {
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-tmp-"));
    fs.mkdirSync(path.join(overlayTmpRoot, "taskferry-cow-oc_gone", "upper", "main"), { recursive: true });
    let cleanedRoot = null;
    makeManager({
      overlayTmpRoot,
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });
    assert.equal(cleanedRoot, path.join(overlayTmpRoot, "taskferry-cow-oc_gone"));
  });

  test("a legacy persisted task (overlayDirs.tmpRoot === undefined, predating creation-time tmpRoot persistence) gets its containment root migrated to the pre-upgrade os.tmpdir() default, not today's overlayTmpRoot -- and the sweep finds/cleans it there", () => {
    // Regression: loadPersisted() used to stamp a legacy record's tmpRoot
    // with the *current* overlayTmpRoot -- fine when that was always plain
    // os.tmpdir(), but wrong now that overlayTmpRoot defaults to
    // runtimeDir/overlay (taskferry#286). A legacy overlay's real on-disk
    // location is still under the old os.tmpdir() default; stamping the
    // new root would point releaseOverlay()'s containment guard and this
    // sweep's scan set at a directory that never held the overlay,
    // silently orphaning it forever. Uses readdirFn injection (not a real
    // dir under the real host os.tmpdir()) so this test can't act on
    // another concurrent process's real overlay on a shared host -- see
    // 04d5e48's "stop overlay tests from scanning and acting on real host
    // /tmp".
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-legacy-new-root-"));
    const legacyRoot = path.join(os.tmpdir(), "taskferry-cow-t_legacy");
    const cleanedRoots = [];
    const mgr = makeManager({
      overlayTmpRoot,
      tasksFixture: [{
        ...baseTask({ id: "t_legacy" }),
        role: "dispatch",
        changesetStatus: "accepted",
        overlayDirs: {
          root: legacyRoot,
          // tmpRoot deliberately omitted: simulates a legacy record that
          // predates tmpRoot persistence (tasks.js backfills it via
          // `tmpRoot === undefined`, which an absent key also satisfies).
          upperDir: path.join(legacyRoot, "upper", "main"),
          workDir: path.join(legacyRoot, "work", "main"),
        },
      }],
      readdirFn: (p) => {
        if (p === overlayTmpRoot) return [];
        if (p === os.tmpdir()) return ["taskferry-cow-t_legacy"];
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      },
      rmOverlayTreeFn: (p) => { cleanedRoots.push(p); },
    });
    assert.deepEqual(cleanedRoots, [legacyRoot], "the sweep must scan the legacy os.tmpdir() root (not just the new overlayTmpRoot) and clean the legacy overlay found there");
    assert.equal("overlayDirs" in mgr.status("t_legacy"), false, "cleanup succeeded, so the task record's overlayDirs must be cleared");
  });

  test("does not sweep an overlay directory whose task still has a pending changeset", () => {
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-tmp-"));
    const overlayRoot = path.join(overlayTmpRoot, OVERLAY_DIR_PENDING);
    fs.mkdirSync(path.join(overlayRoot, "upper", "main"), { recursive: true });
    let cleanedAny = false;
    makeManager({
      overlayTmpRoot,
      tasksFixture: [{
        ...baseTask({ id: "t_pending" }),
        role: "dispatch",
        changesetStatus: "pending",
        overlayDirs: { root: overlayRoot, tmpRoot: overlayTmpRoot, upperDir: path.join(overlayRoot, "upper", "main"), workDir: path.join(overlayRoot, "work", "main") },
      }],
      rmOverlayTreeFn: () => { cleanedAny = true; },
    });
    assert.equal(cleanedAny, false);
  });

  test("does nothing when overlayTmpRoot doesn't exist or is empty", () => {
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-empty-"));
    assert.doesNotThrow(() => makeManager({ overlayTmpRoot }));
  });

  test("sweeps a resolved task overlay under its recorded non-live tmpRoot and persists clearing overlayDirs", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-resolved-state-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-resolved-overlay-"));
    const liveOverlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-live-overlay-"));
    const overlayRoot = path.join(overlayTmpRoot, "taskferry-cow-t_resolved");
    fs.mkdirSync(path.join(overlayRoot, "upper", "main"), { recursive: true });
    const task = {
      ...baseTask({ id: "t_resolved", directory: os.tmpdir() }),
      role: "dispatch",
      changesetStatus: "accepted",
      overlayDirs: {
        root: overlayRoot,
        tmpRoot: overlayTmpRoot,
        upperDir: path.join(overlayRoot, "upper", "main"),
        workDir: path.join(overlayRoot, "work", "main"),
      },
    };
    const tasksFile = path.join(stateDir, TASKS_STATE_FILE);
    fs.writeFileSync(tasksFile, JSON.stringify([task], null, 2));
    const mgr = createTaskManager({
      stateDir,
      overlayTmpRoot: liveOverlayTmpRoot,
      sandboxEnabled: false,
      cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), AXI_TASKS_CACHE_DIR)),
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => {},
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
    });

    assert.equal(fs.existsSync(overlayRoot), false);
    assert.equal("overlayDirs" in mgr.status(task.id), false);
    mgr.flushPersist();
    const persisted = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    assert.equal(persisted[0].overlayDirs, null);
  });

  test("two managers with distinct runtimeDirs and no explicit overlayTmpRoot never collide on the same overlay namespace (taskferry#286)", () => {
    // Regression for the shared-/tmp sweep collision: before scoping
    // overlayTmpRoot under runtimeDir, every manager's real default was the
    // same plain os.tmpdir(), so a second (e.g. restarting) daemon's startup
    // sweep could delete a first daemon's in-flight overlay out from under
    // it even though the two had fully isolated stateDir/runtimeDir.
    const runtimeDirA = fs.mkdtempSync(path.join(os.tmpdir(), "axi-runtime-a-"));
    const runtimeDirB = fs.mkdtempSync(path.join(os.tmpdir(), "axi-runtime-b-"));
    const stateDirA = fs.mkdtempSync(path.join(os.tmpdir(), AXI_TASKS_TEST_DIR));
    const stateDirB = fs.mkdtempSync(path.join(os.tmpdir(), AXI_TASKS_TEST_DIR));
    const mgrA = createTaskManager({
      stateDir: stateDirA,
      runtimeDir: runtimeDirA,
      sandboxEnabled: false,
      cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "axi-cache-a-")),
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => {},
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
    });
    const mgrB = createTaskManager({
      stateDir: stateDirB,
      runtimeDir: runtimeDirB,
      sandboxEnabled: false,
      cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "axi-cache-b-")),
      spawnFn: () => { throw new Error("not used"); },
      killFn: () => {},
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
    });
    assert.notEqual(mgrA.paths.OVERLAY_TMP_ROOT, mgrB.paths.OVERLAY_TMP_ROOT);
    assert.ok(mgrA.paths.OVERLAY_TMP_ROOT.startsWith(runtimeDirA));
    assert.ok(mgrB.paths.OVERLAY_TMP_ROOT.startsWith(runtimeDirB));
  });
});
