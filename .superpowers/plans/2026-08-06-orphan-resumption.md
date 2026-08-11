# Orphan Resumption on Daemon Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the daemon restarts (self-restart on source change, or a crash/manual kill+respawn) while a task is `running`/`queued`, stop unconditionally flattening it to an unlabeled `unknown` — poll whether its recorded pid actually survived, and if it did, wait it out and settle it through the normal completion pipeline instead of losing track of it.

**Architecture:** Two small, independently-testable primitives (a liveness probe with a PID-reuse guard, and a poll-to-exit loop that reuses the existing exit-settlement pipeline) replace one unconditional line in `loadPersistedTask`. Once resumption exists, the idle-gated self-restart in `daemon-server.js` no longer protects against anything, so it's removed — a source-signature change now restarts immediately instead of waiting for a fleet-wide idle window that a busy shared daemon may never hit.

**Tech Stack:** Node.js (`node:fs`, `node:child_process`'s `process.kill`, `/proc/<pid>/stat` parsing), `node --test`.

**Source design doc:** `.superpowers/specs/2026-08-05-orphan-resumption-design.md` — read it before starting; this plan implements it section by section (§1 → Task 2, §2 → Task 3, §4 → Task 4). Section 3's completeness-tagging distinction folds into Task 2/3's `orphanedByRestart` stamping — `evaluateOutputCompleteness()` itself is confirmed to need no code change and none of these tasks touch it.

## Global Constraints

- No config-file/env-var surface for the new poll interval — same precedent as `TASKFERRY_WATCHDOG_POLL_MS` (`src/tasks.js:1316-1322`, "internal plumbing with no config-file equivalent"). Test-only override via `orphanResumePollMs` on `createTaskManager()`'s options bag.
- No new CLI subcommand — resumption runs automatically at daemon startup, per the design doc's Non-goals.
- `evaluateOutputCompleteness()` (`src/tasks.js:3902`) is not modified by any task in this plan — confirmed to read only `task.logPath` fresh off disk every call, already correct for a resumed task with zero changes.
- Every new internal helper follows this codebase's existing convention: not exported from `tasks.js` (see the module's `export` list — only `DEFAULT_SUMMARY_MODEL`, `bucketFor`, `parseAllowedDirs`, `parseEnvDenylist`, `parseSandboxDenylist`, `isOutsideDirectory`, `createTaskManager` are public). Test everything through `createTaskManager()`/`makeManager()` behavior, matching every other internal helper (`attemptCrashRecovery`, `resolveChildExitStatus`, etc.).
- Real-exercise verification (Task 3's last step) is mandatory before this feature is considered done — this design's entire premise rests on real OS process/pipe semantics a mock can't represent (per the project's own "mocked tests aren't proof at a system boundary" rule).

---

### Task 1: PID start-time capture (the raw material for the reuse guard)

**Files:**
- Modify: `src/tasks.js`
  - `Task` typedef, `src/tasks.js:30-66` — add `pidStartedAt`
  - `TaskSummary` typedef, `src/tasks.js:69-103` — add `pidStartedAt`
  - `summarizeOptionalFields()`, `src/tasks.js:2433-2446` — surface it conditionally, same pattern as `incomplete`
  - `resolveCoreOptions()`, `src/tasks.js:2824-2841` — new `readFileFn` option, default `fs.readFileSync`
  - new helper `readProcessStartTime(pid, ctx)`, placed just above `loadPersistedTask` (`src/tasks.js:2341`)
  - `spawnTaskChild()`, `src/tasks.js:1272-1273` — stamp `task.pidStartedAt` right after `task.pid` is assigned
  - the `startTask:` ctx object literal, `src/tasks.js:3396` — thread `readFileFn` through so `spawnTaskChild` can reach it
- Modify: `src/tasks.test-helpers.js` — `buildManagerOptions()`, `src/tasks.test-helpers.js:186-228` — add a `readFileFn` passthrough
- Test: `src/tasks.orphan-resumption.test.js` (new file)

**Interfaces:**
- Produces: `readProcessStartTime(pid: number, ctx: {readFileFn: (path: string) => string}): string|null` — reads `/proc/<pid>/stat` field 22 (`starttime`, in clock ticks since boot — the same data `ps -o lstart=` reads), returns it as a string for equality comparison only (never parsed as a number or converted to wall-clock time). Returns `null` if the file can't be read.
- Produces: `Task.pidStartedAt: string|null` (optional field) — consumed by Task 2's liveness guard.
- Produces: `ResolvedTaskManagerOptions.readFileFn: (path: string) => string` (via `resolveCoreOptions`'s return type flowing into the `ResolvedTaskManagerOptions` typedef automatically) — consumed by Task 2 and Task 3.

- [ ] **Step 1: Write the failing tests**

Create `src/tasks.orphan-resumption.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fakeChild, makeManager } from "./tasks.test-helpers.js";

const SAMPLE_STAT = "5555 (node) S 1 5555 5555 0 -1 4194560 289797 0 42 0 1082 340 5 2 20 0 12 0 987654321 1289546752 27604 0";

describe("pidStartedAt capture at spawn time (Task 1: PID-reuse guard raw material)", () => {
  test("spawning a task stamps task.pidStartedAt from the injected readFileFn, keyed off the spawned pid", () => {
    const child = fakeChild(5555);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      readFileFn: (p) => {
        assert.equal(p, "/proc/5555/stat");
        return SAMPLE_STAT;
      },
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.equal(mgr.status(dispatched.id).pidStartedAt, "987654321");
  });

  test("when /proc is unreadable at spawn time, pidStartedAt stays null and spawning still succeeds", () => {
    const child = fakeChild(6666);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      readFileFn: () => { throw new Error("ENOENT: no such file"); },
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const status = mgr.status(dispatched.id);
    assert.equal(status.status, "running");
    assert.equal(status.pidStartedAt, null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/tasks.orphan-resumption.test.js`
Expected: FAIL — `readFileFn` isn't a recognized option yet (or `pidStartedAt` is always `undefined`/missing from `status()`'s output), so both assertions on `pidStartedAt` fail.

- [ ] **Step 3: Add `pidStartedAt` to the `Task`/`TaskSummary` typedefs**

In `src/tasks.js`, `Task` typedef (around line 38-39):

```js
 * @property {number|null} pid
 * @property {string|null} [pidStartedAt]
 * @property {string} startedAt
```

Same addition to the `TaskSummary` typedef (around line 76-77):

```js
 * @property {number|null} pid
 * @property {string|null} [pidStartedAt]
 * @property {string} startedAt
```

- [ ] **Step 4: Surface `pidStartedAt` in `summarizeOptionalFields()`**

In `src/tasks.js:2433-2446`, add one more conditional spread (mirrors the existing `incomplete`/`finalMarker` pattern — this is the mechanism that makes it visible via `mgr.status()`/`taskferry status`):

```js
function summarizeOptionalFields(task) {
  const { promptTotalChars, incomplete, finalMarker, finalStatus, executorId, class: taskClass } = task;
  return {
    ...(promptTotalChars != null ? { promptTotalChars } : {}),
    ...(task.summaryOf ? { summaryOf: task.summaryOf } : {}),
    ...(incomplete === true ? { incomplete: true } : {}),
    ...(finalMarker != null ? { finalMarker } : {}),
    ...(finalStatus != null ? { finalStatus } : {}),
    ...(taskClass != null ? { class: taskClass } : {}),
    ...(executorId != null ? { executorId } : {}),
    ...(task.pidStartedAt != null ? { pidStartedAt: task.pidStartedAt } : {}),
    ...(task.overlayDirs != null ? { overlayDirs: task.overlayDirs } : {}),
    ...(task.changesetError != null ? { changesetError: task.changesetError } : {}),
  };
}
```

- [ ] **Step 5: Add the `readFileFn` option**

In `src/tasks.js`'s `resolveCoreOptions()` (line 2824-2841), add a line right after `killFn`:

```js
    killFn: rawOptions.killFn ?? /** @type {(pid: number, signal: NodeJS.Signals) => void} */ ((pid, signal) => process.kill(pid, signal)),
    readFileFn: rawOptions.readFileFn ?? ((filePath) => fs.readFileSync(filePath, "utf8")),
```

- [ ] **Step 6: Implement `readProcessStartTime()`**

In `src/tasks.js`, immediately above `loadPersistedTask` (before line 2341's doc comment):

```js
/**
 * Reads a process's start time from /proc/<pid>/stat (field 22, `starttime`
 * in clock ticks since boot -- the same data `ps -o lstart=` reads under
 * the hood). Used purely as an equality-comparable PID-reuse guard, never
 * converted to wall-clock time: a pid can outlive the daemon process and
 * get recycled to an unrelated process while the daemon is down, and this
 * is the cheapest signal available to tell "still my task" apart from
 * "reused pid, unrelated process" without any extra dependency. Returns
 * null when unreadable (non-Linux, or the process is already gone) -- the
 * caller treats null as "can't confirm, not alive."
 * @param {number} pid
 * @param {{readFileFn: (path: string) => string}} ctx
 * @returns {string|null}
 */
function readProcessStartTime(pid, ctx) {
  let stat;
  try {
    stat = ctx.readFileFn(`/proc/${pid}/stat`);
  } catch {
    return null;
  }
  // Field 2 (`comm`) is parenthesized and can itself contain spaces or
  // parens, so split from the *last* ')' rather than a naive whitespace
  // split on the whole line.
  const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // afterComm[0] is field 3 (state); starttime is field 22, i.e. afterComm[19].
  return afterComm[19] ?? null;
}
```

- [ ] **Step 7: Stamp `task.pidStartedAt` at spawn time**

In `src/tasks.js`'s `spawnTaskChild()` (line 1272-1273), change:

```js
    task.status = "running";
    task.pid = child.pid ?? null;
```

to:

```js
    task.status = "running";
    task.pid = child.pid ?? null;
    task.pidStartedAt = task.pid != null ? readProcessStartTime(task.pid, ctx) : null;
```

- [ ] **Step 8: Thread `readFileFn` into the `startTask` ctx**

In `src/tasks.js:3396`, the giant `startTask:` object-literal line, find `sendSignal: (pid, signal) => ctx.helpers.sendSignal(pid, signal),` and add `readFileFn: ctx.opts.readFileFn,` immediately after it (anywhere in that object literal works; placing it next to `sendSignal` keeps the process-level bindings grouped).

- [ ] **Step 9: Add the `readFileFn` test-helper passthrough**

In `src/tasks.test-helpers.js`'s `buildManagerOptions()` (line 186-228), add one line among the other `passthroughIfSet` calls:

```js
    ...passthroughIfSet({ readFileFn: options.readFileFn }, "readFileFn", "readFileFn"),
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `node --test src/tasks.orphan-resumption.test.js`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/tasks.js src/tasks.test-helpers.js src/tasks.orphan-resumption.test.js
git commit -m "feat(tasks): capture a task's process start time at spawn for a future PID-reuse guard"
```

---

### Task 2: Liveness check replaces the blanket flatten-to-unknown

**Files:**
- Modify: `src/tasks.js`
  - `Task` typedef, `src/tasks.js:30-66` — add `orphanedByRestart`
  - `TaskSummary` typedef, `src/tasks.js:69-103` — add `orphanedByRestart`
  - `summarizeOptionalFields()`, `src/tasks.js:2433-2446` — surface `orphanedByRestart`
  - `loadPersistedTasks()` / `loadPersistedTask()`, `src/tasks.js:2329-2370` — replace the blanket flatten with a liveness check; `loadPersistedTasks` now returns resumption candidates
  - new helper `isTaskProcessAlive(task, ctx)`, placed next to `readProcessStartTime` (Task 1)
- Test: `src/tasks.orphan-resumption.test.js` (same file, new `describe` block)

**Interfaces:**
- Consumes: `readProcessStartTime(pid, ctx)` from Task 1; `ResolvedTaskManagerOptions.killFn`/`readFileFn` from Task 1 and the existing `killFn` option.
- Produces: `isTaskProcessAlive(task: Task, ctx: {killFn, readFileFn}): boolean` — consumed by Task 3's poll loop (which calls it every tick to detect exit).
- Produces: `loadPersistedTasks(ctx): Task[]` — now returns the array of resumption candidates (tasks confirmed alive at load time). Task 3 consumes this return value from `bootstrapManagerContext`.
- Produces: `Task.orphanedByRestart: boolean` (optional field), stamped `true` the moment a task is recognized as a resumption candidate — visible immediately via `mgr.status()`, before the task has even exited.
- Produces: `"daemon_restarted_orphaned"` as a `failureReason` value on a `status: "unknown"` task whose pid was confirmed dead (or reused) at reload — distinct from the untagged `unknown` a task with no recorded pid still gets (unchanged legacy path).

- [ ] **Step 1: Write the failing tests**

Append to `src/tasks.orphan-resumption.test.js`:

```js
describe("liveness classification on reload (Task 2: replaces the blanket flatten-to-unknown)", () => {
  test("a persisted running task whose pid is still alive keeps status \"running\" and is tagged orphanedByRestart", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        id: "t_alive", status: "running", directory: "/tmp", model: "m", variant: null,
        sessionId: null, originSessionId: null, pid: 4242, pidStartedAt: "111",
        startedAt: "2026-08-06T10:00:00.000Z", endedAt: null, exitCode: null, signal: null,
        logPath: path.join(logDir, "t_alive.ndjson"), promptPreview: "p", promptTotalChars: null,
        spawnError: null, cancelRequested: false, internal: false,
      }],
      killFn: () => {}, // signal 0 succeeds -> alive
      readFileFn: () => SAMPLE_STAT.replace("987654321", "111"),
    });
    const s = mgr.status("t_alive");
    assert.equal(s.status, "running");
    assert.equal(s.orphanedByRestart, true);
    assert.equal(s.failureReason, null);
  });

  test("a persisted running task whose pid is dead degrades to \"unknown\" tagged daemon_restarted_orphaned", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        id: "t_dead", status: "running", directory: "/tmp", model: "m", variant: null,
        sessionId: null, originSessionId: null, pid: 9999, pidStartedAt: null,
        startedAt: "2026-08-06T10:00:00.000Z", endedAt: null, exitCode: null, signal: null,
        logPath: path.join(logDir, "t_dead.ndjson"), promptPreview: "p", promptTotalChars: null,
        spawnError: null, cancelRequested: false, internal: false,
      }],
      killFn: () => { const e = new Error("no such process"); e.code = "ESRCH"; throw e; },
    });
    const s = mgr.status("t_dead");
    assert.equal(s.status, "unknown");
    assert.equal(s.failureReason, "daemon_restarted_orphaned");
  });

  test("PID-reuse guard: an alive pid whose start time no longer matches is treated as dead", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        id: "t_reused", status: "running", directory: "/tmp", model: "m", variant: null,
        sessionId: null, originSessionId: null, pid: 4242, pidStartedAt: "111",
        startedAt: "2026-08-06T10:00:00.000Z", endedAt: null, exitCode: null, signal: null,
        logPath: path.join(logDir, "t_reused.ndjson"), promptPreview: "p", promptTotalChars: null,
        spawnError: null, cancelRequested: false, internal: false,
      }],
      killFn: () => {}, // pid 4242 is alive...
      readFileFn: () => SAMPLE_STAT.replace("987654321", "999999"), // ...but recycled: starttime mismatches
    });
    const s = mgr.status("t_reused");
    assert.equal(s.status, "unknown");
    assert.equal(s.failureReason, "daemon_restarted_orphaned");
  });

  test("a legacy record with no pidStartedAt is treated as alive from the liveness signal alone", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        id: "t_legacy", status: "queued", directory: "/tmp", model: "m", variant: null,
        sessionId: null, originSessionId: null, pid: 4242, pidStartedAt: undefined,
        startedAt: "2026-08-06T10:00:00.000Z", endedAt: null, exitCode: null, signal: null,
        logPath: path.join(logDir, "t_legacy.ndjson"), promptPreview: "p", promptTotalChars: null,
        spawnError: null, cancelRequested: false, internal: false,
      }],
      killFn: () => {},
    });
    const s = mgr.status("t_legacy");
    assert.equal(s.status, "queued");
    assert.equal(s.orphanedByRestart, true);
  });

  test("a persisted running task with no pid recorded degrades to \"unknown\" with no liveness check and no new tag (unchanged legacy path)", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        id: "t_nopid", status: "running", directory: "/tmp", model: "m", variant: null,
        sessionId: null, originSessionId: null, pid: null, pidStartedAt: null,
        startedAt: "2026-08-06T10:00:00.000Z", endedAt: null, exitCode: null, signal: null,
        logPath: path.join(logDir, "t_nopid.ndjson"), promptPreview: "p", promptTotalChars: null,
        spawnError: null, cancelRequested: false, internal: false,
      }],
      killFn: () => { throw new Error("must not be called for a task with no pid"); },
    });
    const s = mgr.status("t_nopid");
    assert.equal(s.status, "unknown");
    assert.equal(s.failureReason, null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/tasks.orphan-resumption.test.js`
Expected: FAIL on all five new tests — `loadPersistedTask` still unconditionally sets `status: "unknown"` for every `running`/`queued` record regardless of pid liveness.

- [ ] **Step 3: Add `orphanedByRestart` to the typedefs and `summarizeOptionalFields()`**

`Task` typedef, near `incomplete`/`finalMarker` (around line 52-53):

```js
 * @property {boolean} [incomplete]
 * @property {string|null} [finalMarker]
 * @property {string|null} [finalStatus]
 * @property {boolean} [orphanedByRestart]
```

Same addition to `TaskSummary`. In `summarizeOptionalFields()` (Task 1 already touched this function; add one more line):

```js
    ...(task.orphanedByRestart === true ? { orphanedByRestart: true } : {}),
```

- [ ] **Step 4: Implement `isTaskProcessAlive()`**

Right after `readProcessStartTime()` (Task 1, Step 6):

```js
/**
 * Liveness + PID-reuse check for a persisted task's recorded pid, per
 * .superpowers/specs/2026-08-05-orphan-resumption-design.md section 1.
 * `process.kill(pid, 0)` is the standard Node no-op-signal liveness probe
 * (throws ESRCH if nothing has that pid); that alone isn't sufficient
 * because a pid can be recycled to an unrelated process while the daemon
 * was down, so a live pid whose recorded start time no longer matches the
 * current process at that pid is treated as dead, not alive.
 * @param {Task} task
 * @param {{killFn: (pid: number, signal: NodeJS.Signals|number) => void, readFileFn: (path: string) => string}} ctx
 * @returns {boolean}
 */
function isTaskProcessAlive(task, ctx) {
  if (task.pid == null) return false;
  try {
    ctx.killFn(task.pid, 0);
  } catch {
    return false;
  }
  if (task.pidStartedAt == null) return true; // legacy record predating this field
  return readProcessStartTime(task.pid, ctx) === task.pidStartedAt;
}
```

- [ ] **Step 5: Rewrite `loadPersistedTasks()` / `loadPersistedTask()`**

Replace `src/tasks.js:2329-2370` with:

```js
function loadPersistedTasks(ctx) {
  const resumeCandidates = [];
  try {
    const raw = fs.readFileSync(ctx.TASKS_FILE, "utf8");
    /** @type {Task[]} */
    const persisted = JSON.parse(raw);
    for (const t of persisted) {
      const candidate = loadPersistedTask(ctx, t);
      if (candidate) resumeCandidates.push(candidate);
    }
    fs.chmodSync(ctx.TASKS_FILE, 0o600);
  } catch (err) {
    if (errCode(err) !== "ENOENT") ctx.setStateLoadError(/** @type {Error} */ (err));
  }
  return resumeCandidates;
}

/**
 * Normalizes and registers a single persisted task record. The
 * pre-persistence normalization (realpath the directory, default the
 * executor, backfill legacy tmpRoots) is unchanged from the original
 * `loadPersisted` loop body. `running`/`queued` records no longer flatten
 * unconditionally to `unknown`: a task whose recorded pid is confirmed
 * still alive (and not a reused pid -- see isTaskProcessAlive) keeps its
 * status and is returned as a resumption candidate for the caller to hand
 * to resumeOrphanedTasks(); everything else degrades to `unknown` exactly
 * as before, now tagged with a real reason instead of an unlabeled bucket
 * -- except a record with no pid at all, which keeps today's untagged
 * unknown exactly as is (no liveness check is even possible there).
 * @param {{overlayTmpRoot: string, tasks: Map<string, Task>, taskEvents: {emitState: (task: Task, previousStatus?: string) => void}, killFn: (pid: number, signal: NodeJS.Signals|number) => void, readFileFn: (path: string) => string}} ctx
 * @param {Task} t
 * @returns {Task|null} the task, if it's a resumption candidate; otherwise null
 */
function loadPersistedTask(ctx, t) {
  const previousStatus = t.status;
  if (t.summaryOf) t.internal = true;
  try {
    t.directory = fs.realpathSync(t.directory);
  } catch {
    // A persisted task may outlive a workspace that has since been removed.
  }
  let resumeCandidate = null;
  if (t.status === "running" || t.status === "queued") {
    if (t.pid != null && isTaskProcessAlive(t, ctx)) {
      t.orphanedByRestart = true;
      resumeCandidate = t;
    } else {
      t.status = "unknown";
      if (t.pid != null) t.failureReason = "daemon_restarted_orphaned";
    }
  }
  if (t.executorId === undefined) t.executorId = "opencode";
  // Legacy records predate creation-time tmpRoot persistence. Their overlay
  // actually lives on disk under the *old* default -- plain os.tmpdir() --
  // not today's overlayTmpRoot (now runtimeDir/overlay per taskferry#286).
  // Stamping the current overlayTmpRoot here would point the record's
  // containment root at a directory that never held the overlay, which
  // both releaseOverlay()'s containment guard (changeset.js's
  // cleanupOverlay()) and sweepOrphanedOverlays()'s tmpRoots scan key off
  // of -- silently orphaning the real leftover under os.tmpdir() forever.
  if (t.overlayDirs && t.overlayDirs.tmpRoot === undefined) t.overlayDirs.tmpRoot = os.tmpdir();
  ctx.tasks.set(t.id, t);
  if (t.status !== previousStatus) ctx.taskEvents.emitState(t, previousStatus);
  return resumeCandidate;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test src/tasks.orphan-resumption.test.js`
Expected: PASS (all 7 tests so far — 2 from Task 1, 5 from this task)

- [ ] **Step 7: Run the full test suite to check for regressions**

Run: `node --test src/tasks.persist.test.js src/daemon.test.js`
Expected: PASS — in particular `src/daemon.test.js`'s existing `"rehydrates persisted queued/running tasks as unknown through createTaskManager"` test (line 949) must still pass. Read it first: if its fixture tasks don't set a `pid`, they'll still degrade to plain `unknown` (the "no pid" branch), so this test should need no changes. If it does set a `pid`, either add a `killFn` to that test that throws `ESRCH` (making the intent — "this task is confirmed dead" — explicit) or leave it as-is if the default `killFn` already throws for an unrelated reason; don't weaken the assertion to work around the new behavior.

- [ ] **Step 8: Commit**

```bash
git add src/tasks.js src/tasks.orphan-resumption.test.js
git commit -m "feat(tasks): liveness-poll a persisted task's pid on reload instead of blanket-flattening to unknown"
```

---

### Task 3: Poll-to-exit and settle through the normal completion pipeline

**Files:**
- Modify: `src/tasks.js`
  - `initManagerMaps()`, `src/tasks.js:3192-3208` — add `orphanResumeTimers: new Map()`
  - `resolveTimeoutOptions()`, `src/tasks.js:2850-2867` — add `orphanResumePollMs`
  - new constant `DEFAULT_ORPHAN_RESUME_POLL_MS`, next to `DEFAULT_WATCHDOG_POLL_MS` (`src/tasks.js:1319-1322`)
  - new helpers `cleanUpResumedScratchFiles`, `settleResumedTask`, `pollForResumedExit`, `resumeOrphanedTasks`, placed after `loadPersistedTask` (Task 2)
  - `bootstrapManagerContext()`, `src/tasks.js:3588-3610` — capture `loadPersistedTasks()`'s return value and call `resumeOrphanedTasks()`
- Modify: `src/tasks.test-helpers.js` — add an `orphanResumePollMs` passthrough
- Test: `src/tasks.orphan-resumption.test.js` (same file, new `describe` block)

**Interfaces:**
- Consumes: `isTaskProcessAlive` (Task 2), `Task.orphanedByRestart` (Task 2), the resumption-candidate array `loadPersistedTasks()` now returns (Task 2), `attemptCrashRecovery(task)`, `evaluateOutputCompleteness(task, precomputed)`, `readSessionIdFromLog(logPath)`, `removeFileIfPresent(filePath)` (all pre-existing module functions, unchanged).
- Produces: the daemon actually resumes and settles a live orphan — this is the task that makes Task 1/2's classification work end-to-end observable via `mgr.status()` transitioning from `"running"` to a real terminal status once the underlying process exits.
- Produces: `"orphan_resume_exit_code_unknown"` as a `failureReason` value on a resumed task that settles `"crashed"` — distinct from `"daemon_restarted_orphaned"` (Task 2, stamped at *load* time for a pid that was already dead) since this one is stamped at *settle* time for a pid that was alive at load and later exited without the log ever reaching a genuine completion marker.

- [ ] **Step 1: Write the failing tests**

Append to `src/tasks.orphan-resumption.test.js` (needs `os`, `NOT_REACHED` from the test-helpers import — extend the existing import line):

```js
import { fakeChild, makeManager, NOT_REACHED } from "./tasks.test-helpers.js";
```

```js
function resumableFixture(logDir, overrides = {}) {
  return {
    id: "t_resume", status: "running", directory: "/tmp", model: "m", variant: null,
    sessionId: null, originSessionId: null, pid: 4242, pidStartedAt: "111",
    startedAt: "2026-08-06T10:00:00.000Z", endedAt: null, exitCode: null, signal: null,
    logPath: path.join(logDir, "t_resume.ndjson"), promptPreview: "p", promptTotalChars: null,
    spawnError: null, cancelRequested: false, internal: false,
    ...overrides,
  };
}

describe("resumption poll-to-exit and settlement (Task 3)", () => {
  test("a resumed task settles to \"done\" once its pid exits and the log already reached a genuine stop event", async () => {
    let alive = true;
    const mgr = makeManager({
      tasksFixture: (logDir) => [resumableFixture(logDir, { id: "t_resume_done", logPath: path.join(logDir, "t_resume_done.ndjson") })],
      killFn: () => { if (!alive) { const e = new Error("gone"); e.code = "ESRCH"; throw e; } },
      readFileFn: () => SAMPLE_STAT.replace("987654321", "111"),
      orphanResumePollMs: 5,
      logs: {
        "t_resume_done.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "Verification completed successfully." } }) + "\n"
          + JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }) + "\n",
      },
    });
    assert.equal(mgr.status("t_resume_done").status, "running");
    alive = false;
    await new Promise((r) => setTimeout(r, 30));
    const s = mgr.status("t_resume_done");
    assert.equal(s.status, "done");
    assert.equal(s.orphanedByRestart, true);
    assert.equal(s.failureReason, null);
  });

  test("a resumed task settles to \"crashed\" tagged orphan_resume_exit_code_unknown when the log never reached a stop event", async () => {
    let alive = true;
    const mgr = makeManager({
      tasksFixture: (logDir) => [resumableFixture(logDir, { id: "t_resume_crash", pid: 4243, logPath: path.join(logDir, "t_resume_crash.ndjson") })],
      killFn: () => { if (!alive) { const e = new Error("gone"); e.code = "ESRCH"; throw e; } },
      readFileFn: () => SAMPLE_STAT.replace("987654321", "111"),
      orphanResumePollMs: 5,
      logs: { "t_resume_crash.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "still working" } }) + "\n" },
    });
    alive = false;
    await new Promise((r) => setTimeout(r, 30));
    const s = mgr.status("t_resume_crash");
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, "orphan_resume_exit_code_unknown");
    assert.equal(s.orphanedByRestart, true);
  });

  test("a resumed task occupies a concurrency slot until it settles, deferring a queued dispatch", async () => {
    let alive = true;
    const mgr = makeManager({
      tasksFixture: (logDir) => [resumableFixture(logDir, { id: "t_resume_slot", pid: 4244, logPath: path.join(logDir, "t_resume_slot.ndjson") })],
      killFn: () => { if (!alive) { const e = new Error("gone"); e.code = "ESRCH"; throw e; } },
      readFileFn: () => SAMPLE_STAT.replace("987654321", "111"),
      orphanResumePollMs: 5,
      maxConcurrentTasks: 1,
      spawnFn: () => { throw new Error(NOT_REACHED); },
    });
    const queued = mgr.dispatch({ prompt: "next", directory: os.tmpdir() });
    assert.equal(mgr.status(queued.id).status, "queued", "the concurrency slot is held by the resumed task, not freed until it settles");
    alive = false;
    await new Promise((r) => setTimeout(r, 30));
    assert.notEqual(mgr.status("t_resume_slot").status, "running");
  });

  test("cancel() on a resumed task signals its real pid and the resumption poll settles it as cancelled once it exits", async () => {
    let alive = true;
    const signals = [];
    const mgr = makeManager({
      tasksFixture: (logDir) => [resumableFixture(logDir, { id: "t_resume_cancel", pid: 4245, logPath: path.join(logDir, "t_resume_cancel.ndjson") })],
      killFn: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal !== 0) return; // a real SIGTERM/SIGKILL: accept it, the fake process dies via `alive` below
        if (!alive) { const e = new Error("gone"); e.code = "ESRCH"; throw e; }
      },
      readFileFn: () => SAMPLE_STAT.replace("987654321", "111"),
      orphanResumePollMs: 5,
    });
    mgr.cancel("t_resume_cancel");
    assert.ok(signals.some((s) => s.pid === 4245 && s.signal === "SIGTERM"));
    alive = false;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mgr.status("t_resume_cancel").status, "cancelled");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/tasks.orphan-resumption.test.js`
Expected: FAIL on all four new tests — nothing yet consumes `loadPersistedTasks()`'s resumption candidates, so a resumed task never settles; it stays `"running"` forever and the concurrency slot is never held.

- [ ] **Step 3: Add the poll interval option and map**

In `src/tasks.js`, next to `DEFAULT_WATCHDOG_POLL_MS` (line 1319-1322):

```js
// TASKFERRY_ORPHAN_RESUME_POLL_MS is internal plumbing with no config-file
// equivalent, same reasoning as DEFAULT_WATCHDOG_POLL_MS above.
const DEFAULT_ORPHAN_RESUME_POLL_MS = positiveInteger(
  Number(process.env.TASKFERRY_ORPHAN_RESUME_POLL_MS),
  2000
);
```

In `resolveTimeoutOptions()` (line 2859), add a line next to `watchdogPollMs`:

```js
    watchdogPollMs: rawOptions.watchdogPollMs ?? DEFAULT_WATCHDOG_POLL_MS,
    orphanResumePollMs: rawOptions.orphanResumePollMs ?? DEFAULT_ORPHAN_RESUME_POLL_MS,
```

In `initManagerMaps()` (line 3192-3208), add a line:

```js
    logHasEventCache: new Set(),
    orphanResumeTimers: new Map(),
```

- [ ] **Step 4: Implement `cleanUpResumedScratchFiles()`**

Placed after `isTaskProcessAlive` (Task 2, Step 4):

```js
/**
 * Mirrors resolveStartTaskLaunch()'s cleanUpScratchFiles closure for a
 * resumed task, whose original LaunchSpec/prompt-file path was never
 * persisted (it's launch-time-only data, not part of the Task record) so
 * it has to be reconstructed from the same deterministic naming those
 * paths already use: PROMPT_DIR/<id>.prompt.txt (only ever written if the
 * original prompt exceeded PROMPT_ARGV_SAFE_BYTES -- otherwise this is
 * always a harmless no-op unlink) and, for a summary task, SUMMARY_DIR/<id>.json.
 * @param {{PROMPT_DIR: string, SUMMARY_DIR: string}} ctx
 * @param {Task} task
 */
function cleanUpResumedScratchFiles(ctx, task) {
  removeFileIfPresent(path.join(ctx.PROMPT_DIR, `${task.id}.prompt.txt`));
  if (task.summaryOf) removeFileIfPresent(path.join(ctx.SUMMARY_DIR, `${task.id}.json`));
}
```

- [ ] **Step 5: Implement `settleResumedTask()`**

```js
/**
 * Settles a resumed task once its pid has been observed to exit. A daemon
 * restart means no real exit code/signal ever survives -- resolveChildExitStatus
 * can't be reused directly -- so this seeds a tentative "crashed" status and
 * reuses attemptCrashRecovery's existing "did the transcript actually reach
 * a genuine stop event" check to flip it to "done" when the log proves the
 * worker actually finished. That's the same mechanism the normal exit path
 * already uses to rescue a real completion from an ambiguous-looking
 * failure (a watchdog-killed process that had already produced a full stop
 * event) -- an exact fit, not an approximation. Only a task still "crashed"
 * after that check gets tagged with the new failureReason; a recovered
 * "done" task stays clean, same as an ordinary successful completion.
 * Everything after that point (session id, output-completeness, changeset
 * extraction, settlement bookkeeping) mirrors onChildExit/finishChildSettlement.
 * @param {Task} task
 * @param {ResumeSettleContext} ctx
 */
function settleResumedTask(task, ctx) {
  task.status = task.cancelRequested ? "cancelled" : "crashed";
  const recoveredState = task.status === "crashed" ? attemptCrashRecovery(task) : null;
  if (task.status === "crashed" && !task.failureReason) task.failureReason = "orphan_resume_exit_code_unknown";
  const parsedSessionId = readSessionIdFromLog(task.logPath);
  if (parsedSessionId) task.sessionId = parsedSessionId;
  task.exitCode = null;
  task.signal = null;
  task.endedAt = new Date().toISOString();
  if (task.status === "done") evaluateOutputCompleteness(task, recoveredState ?? undefined);
  ctx.extractChangesetForTask(task);
  cleanUpResumedScratchFiles(ctx, task);
  try {
    ctx.persistTask(task.id);
  } catch {
    // Same reasoning as finishChildSettlement: a failed best-effort state
    // write must not strand the concurrency slot.
  }
  void ctx.scheduleActivity(task, { force: true }).then(() => ctx.activityCache.evictTask(task.id));
  ctx.logHasEventCache.delete(task.logPath);
  ctx.decRunning();
  ctx.settleWaiters(task.id);
  ctx.launchQueuedTasks();
}
```

Above `settleResumedTask`, add the `ResumeSettleContext` typedef it references:

```js
/**
 * @typedef {object} ResumeSettleContext
 * @property {(pid: number, signal: NodeJS.Signals|number) => void} killFn
 * @property {(path: string) => string} readFileFn
 * @property {string} PROMPT_DIR
 * @property {string} SUMMARY_DIR
 * @property {(taskId: string) => void} persistTask
 * @property {(task: Task, options?: {force?: boolean}) => Promise<unknown>} scheduleActivity
 * @property {{evictTask: (taskId: string) => void, setSummarySessionId: (sourceTaskId: string, sessionId: string) => void, setLastSummarizedWatermark: (sourceTaskId: string, size: number) => void}} activityCache
 * @property {Set<string>} logHasEventCache
 * @property {() => void} decRunning
 * @property {(taskId: string) => void} settleWaiters
 * @property {() => void} launchQueuedTasks
 * @property {(task: Task) => void} extractChangesetForTask
 * @property {Map<string, NodeJS.Timeout>} orphanResumeTimers
 * @property {number} orphanResumePollMs
 */
```

- [ ] **Step 6: Implement `pollForResumedExit()` and `resumeOrphanedTasks()`**

```js
/**
 * Polls a resumption candidate's pid until it exits, then settles it. One
 * interval per candidate, matching startRunningWatcherFor's per-task
 * interval pattern; unref'd so it never keeps the daemon process alive on
 * its own.
 * @param {Task} task
 * @param {ResumeSettleContext} ctx
 */
function pollForResumedExit(task, ctx) {
  const timer = setInterval(() => {
    if (isTaskProcessAlive(task, ctx)) return;
    clearInterval(timer);
    ctx.orphanResumeTimers.delete(task.id);
    settleResumedTask(task, ctx);
  }, ctx.orphanResumePollMs);
  timer.unref();
  ctx.orphanResumeTimers.set(task.id, timer);
}

/**
 * Kicks off resumption for every candidate loadPersistedTasks() found still
 * alive at daemon startup. Runs after the manager's own ctx.api is fully
 * built (called from bootstrapManagerContext after loadPersistedTasks), so
 * every ctx.helpers/ctx.env closure referenced below resolves. Each
 * candidate's concurrency slot is reserved immediately (incRunning) so a
 * fresh dispatch can't over-subscribe the concurrency cap while a resumed
 * task is still actually running under a real, formerly-orphaned process.
 * @param {Task[]} candidates
 * @param {ManagerContext} ctx
 */
function resumeOrphanedTasks(candidates, ctx) {
  if (candidates.length === 0) return;
  /** @type {ResumeSettleContext} */
  const settleCtx = {
    killFn: ctx.opts.killFn,
    readFileFn: ctx.opts.readFileFn,
    PROMPT_DIR: ctx.paths.PROMPT_DIR,
    SUMMARY_DIR: ctx.paths.SUMMARY_DIR,
    persistTask: (taskId) => ctx.helpers.persistTask(taskId),
    scheduleActivity: (task, options) => ctx.helpers.scheduleActivity(task, options),
    activityCache: ctx.activity.cache,
    logHasEventCache: ctx.maps.logHasEventCache,
    decRunning: () => { ctx.state.runningCount--; },
    settleWaiters: (taskId) => ctx.helpers.settleWaiters(taskId),
    launchQueuedTasks: () => ctx.helpers.launchQueuedTasks(),
    extractChangesetForTask: (task) => ctx.env.extractChangesetForTask(task),
    orphanResumeTimers: ctx.maps.orphanResumeTimers,
    orphanResumePollMs: ctx.opts.orphanResumePollMs,
  };
  for (const task of candidates) {
    ctx.state.runningCount++;
    pollForResumedExit(task, settleCtx);
  }
}
```

- [ ] **Step 7: Wire it into `bootstrapManagerContext()`**

In `src/tasks.js:3590-3596`, change:

```js
  loadPersistedTasks({
    TASKS_FILE: ctx.paths.TASKS_FILE,
    overlayTmpRoot: ctx.opts.overlayTmpRoot,
    tasks: ctx.maps.tasks,
    taskEvents: ctx.events.taskEvents,
    setStateLoadError: (err) => { ctx.state.stateLoadError = err; },
  });
```

to:

```js
  const resumeCandidates = loadPersistedTasks({
    TASKS_FILE: ctx.paths.TASKS_FILE,
    overlayTmpRoot: ctx.opts.overlayTmpRoot,
    tasks: ctx.maps.tasks,
    taskEvents: ctx.events.taskEvents,
    setStateLoadError: (err) => { ctx.state.stateLoadError = err; },
    killFn: ctx.opts.killFn,
    readFileFn: ctx.opts.readFileFn,
  });
  resumeOrphanedTasks(resumeCandidates, ctx);
```

- [ ] **Step 8: Add the `orphanResumePollMs` test-helper passthrough**

In `src/tasks.test-helpers.js`'s `buildManagerOptions()`, add:

```js
    ...passthroughIfSet({ orphanResumePollMs: options.orphanResumePollMs }, "orphanResumePollMs", "orphanResumePollMs"),
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test src/tasks.orphan-resumption.test.js`
Expected: PASS (all 11 tests)

- [ ] **Step 10: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS, no regressions elsewhere (in particular `src/tasks.persist.test.js`, `src/tasks.lifecycle.test.js`, `src/tasks.failure.test.js`, `src/daemon.test.js`).

- [ ] **Step 11: Commit**

```bash
git add src/tasks.js src/tasks.test-helpers.js src/tasks.orphan-resumption.test.js
git commit -m "feat(tasks): poll a resumed task's pid to exit and settle it through the normal completion pipeline"
```

- [ ] **Step 12: Real-exercise verification (required — mocked tests above can't prove real OS process/pipe semantics)**

Per the project's "mocked tests aren't proof at a system boundary" rule, this design's entire premise rests on real `process.kill(pid, 0)` semantics against a real process, real `/proc/<pid>/stat` parsing, and a real broken-pipe-on-daemon-death. Run this before considering the feature done. Use an isolated state dir per this repo's own `CLAUDE.md` ("Isolate your own taskferry runs when testing or developing taskferry itself") — never the shared default:

```bash
export TASKFERRY_STATE_DIR=/tmp/orphan-resume-verify
export TASKFERRY_RUNTIME_DIR=/tmp/orphan-resume-verify/run
export TASKFERRY_CACHE_DIR=/tmp/orphan-resume-verify/cache
mkdir -p /tmp/orphan-resume-scratch-repo && cd /tmp/orphan-resume-scratch-repo && git init -q

# 1. Dispatch something that runs long enough to kill the daemon mid-flight.
taskferry dispatch --prompt "sleep 15 && echo done" --directory /tmp/orphan-resume-scratch-repo
# note the printed task id

# 2. Kill the daemon process itself, not the dispatched worker.
pgrep -f "node.*daemon.js.*orphan-resume-verify"   # confirm the daemon pid
kill <daemon-pid>
ps aux | grep opencode   # confirm the worker process is still alive

# 3. A fresh daemon auto-starts on the next command.
taskferry status <task-id>
# expect: status still "running" (not "unknown"), orphanedByRestart: true

# 4. Wait for the sleep to finish, then re-check.
sleep 16
taskferry status <task-id>
# expect: status "done", orphanedByRestart still true, a real changeset extractable
taskferry result <task-id>

# 5. Repeat with a second dispatch, but this time kill the worker process
#    itself (not just the daemon) before the daemon restarts.
taskferry dispatch --prompt "sleep 15 && echo done" --directory /tmp/orphan-resume-scratch-repo
pkill -f "sleep 15"
kill <daemon-pid-2>
taskferry status <second-task-id>
# expect: status "unknown", failureReason "daemon_restarted_orphaned"
```

If any expectation above doesn't hold, treat it as a real bug found by real-exercise verification, not a mocked-test gap — fix it before moving to Task 4.

---

### Task 4: Remove the now-unnecessary idle-gated self-restart, update docs

**Files:**
- Modify: `src/daemon-server.js` — `makeMaybeRestart()`, `src/daemon-server.js:276-295`
- Modify: `src/daemon.js` — the `makeMaybeRestart({...})` call site, `src/daemon.js:456-467`
- Modify: `docs/daemon.md` — `## Self-restart on source change` and `## Recovery` sections, `docs/daemon.md:229-280`
- Modify: `docs/sourcemap.md` — line-count/responsibility text for `src/tasks.js` and `src/daemon-server.js`
- Test: `src/daemon-server.test.js` (new file — no test currently covers `makeMaybeRestart` at all)

**Interfaces:**
- Consumes: nothing from Tasks 1-3 directly — this task removes a gate that resumption (Tasks 1-3) makes unnecessary. Order matters only in that this task should land last, once resumption is proven to actually work (Task 3's real-exercise verification), since removing the gate makes an in-flight task's survival depend entirely on resumption working correctly.

- [ ] **Step 1: Write the failing test**

Create `src/daemon-server.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeMaybeRestart } from "./daemon-server.js";

function makeRestartHarness({ counts = { running: 0, queued: 0 } } = {}) {
  const calls = { closed: 0, spawned: 0, exited: 0 };
  const restart = { pending: false, restarting: false };
  const maybeRestart = makeMaybeRestart({
    manager: { list: () => ({ counts }) },
    sourceDir: "/fake/src",
    sourceSignature: () => 2,
    startupSourceSignature: 1,
    close: async () => { calls.closed++; },
    spawnReplacement: () => { calls.spawned++; },
    daemonEntry: "/fake/daemon.js",
    env: {},
    exitProcess: () => { calls.exited++; },
    restart,
  });
  return { maybeRestart, calls, restart };
}

describe("makeMaybeRestart() (Task 4: the idle-gated wait is gone)", () => {
  test("restarts immediately on a source-signature change even with tasks still running/queued", async () => {
    const { maybeRestart, calls } = makeRestartHarness({ counts: { running: 2, queued: 1 } });
    maybeRestart();
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.closed, 1);
    assert.equal(calls.spawned, 1);
    assert.equal(calls.exited, 1);
  });

  test("does nothing when the source signature hasn't changed", async () => {
    const calls = { closed: 0, spawned: 0, exited: 0 };
    const restart = { pending: false, restarting: false };
    const maybeRestart = makeMaybeRestart({
      manager: { list: () => ({ counts: { running: 0, queued: 0 } }) },
      sourceDir: "/fake/src",
      sourceSignature: () => 1,
      startupSourceSignature: 1,
      close: async () => { calls.closed++; },
      spawnReplacement: () => { calls.spawned++; },
      daemonEntry: "/fake/daemon.js",
      env: {},
      exitProcess: () => { calls.exited++; },
      restart,
    });
    maybeRestart();
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.closed, 0);
  });

  test("a second call while a restart is already in flight is a no-op", async () => {
    const { maybeRestart, calls } = makeRestartHarness();
    maybeRestart();
    maybeRestart();
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.closed, 1);
    assert.equal(calls.spawned, 1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/daemon-server.test.js`
Expected: FAIL on the first test — `counts: { running: 2, queued: 1 }` currently makes `maybeRestart()` return early without calling `close`/`spawnReplacement`/`exitProcess`.

- [ ] **Step 3: Remove the idle gate**

In `src/daemon-server.js`, replace lines 276-294 (the `makeMaybeRestart` export and its preceding comment):

```js
// Deferred-until-idle restart: a source change is detected any time after
// startup, but the actual restart waits for zero running/queued tasks so an
// in-flight opencode child is never orphaned mid-task by the daemon
// swapping itself out from under it.
export function makeMaybeRestart({ manager, sourceDir, sourceSignature, startupSourceSignature, close, spawnReplacement, daemonEntry, env, exitProcess, restart }) {
  return function maybeRestart() {
    if (restart.restarting) return;
    if (!restart.pending && sourceSignature(sourceDir) !== startupSourceSignature) restart.pending = true;
    if (!restart.pending) return;
    const { counts } = manager.list();
    if (counts.running > 0 || counts.queued > 0) return;
    restart.restarting = true;
    void (async () => {
      await close();
      spawnReplacement({ daemonEntry, env });
      exitProcess();
    })();
  };
}
```

with:

```js
// Immediate restart on source change: a source change is detected any time
// after startup and the restart fires right away. This used to wait for
// zero running/queued tasks so an in-flight opencode child was never
// orphaned mid-task by the daemon swapping itself out from under it -- that
// protection is now handled by resumption (loadPersistedTask's liveness
// check + resumeOrphanedTasks polling the pid to exit, see tasks.js), so
// waiting for a fleet-wide idle window a busy shared daemon may never hit
// is no longer necessary.
export function makeMaybeRestart({ sourceDir, sourceSignature, startupSourceSignature, close, spawnReplacement, daemonEntry, env, exitProcess, restart }) {
  return function maybeRestart() {
    if (restart.restarting) return;
    if (!restart.pending && sourceSignature(sourceDir) !== startupSourceSignature) restart.pending = true;
    if (!restart.pending) return;
    restart.restarting = true;
    void (async () => {
      await close();
      spawnReplacement({ daemonEntry, env });
      exitProcess();
    })();
  };
}
```

- [ ] **Step 4: Drop the now-unused `manager` argument at the call site**

In `src/daemon.js:456-467`, remove the `manager,` line from the `makeMaybeRestart({...})` call:

```js
  maybeRestartRef.current = makeMaybeRestart({
    sourceDir,
    sourceSignature,
    startupSourceSignature,
    close,
    spawnReplacement,
    daemonEntry,
    env,
    exitProcess,
    restart,
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test src/daemon-server.test.js src/daemon.test.js`
Expected: PASS

- [ ] **Step 6: Update `docs/daemon.md`**

Replace the `## Self-restart on source change` section (`docs/daemon.md:229-251`) with:

```markdown
## Self-restart on source change

The daemon records the newest mtime across the `.js` files in its own source
directory at startup. After serving each request, it recomputes that value;
if it has moved forward (a merge or `git pull` landed while the daemon was
running), a restart fires immediately: the daemon closes its socket and
server, spawns a fresh `daemon.js` process with the same environment, and
exits; the replacement binds a new socket the same way any auto-started
daemon does.

This used to wait for `manager.list().counts` to show zero `running` and
zero `queued` tasks before restarting, to avoid orphaning an in-flight
worker child mid-task. That's no longer necessary — see
[Recovery](#recovery) below: every `running`/`queued` task's pid is
liveness-checked on the new process's startup, and a task whose worker
process actually survived the restart is resumed and settled normally
instead of being abandoned.

Existing `watch` subscribers are dropped when the old process exits, same as
any other daemon restart; a client reconnects and resubscribes on its next
call. There is no special handoff for in-progress requests — a concurrent
non-task request (e.g. another client's `list` or `status` call) can still
be executing at the exact moment the restart fires.
```

Replace the `## Recovery` section (`docs/daemon.md:253-279`) with:

```markdown
## Recovery

A `running`/`queued` task survives a daemon restart if its underlying worker
process does. On startup, the new daemon process checks each such task's
recorded pid: `process.kill(pid, 0)` (the standard no-op-signal liveness
probe) confirms whether anything with that pid still exists, and a
`/proc/<pid>/stat`-derived process start-time comparison guards against a
pid having been recycled to an unrelated process while the daemon was down.

- **Pid confirmed alive (and not reused):** the task keeps its `running`/
  `queued` status, is tagged `orphanedByRestart: true`, and the daemon polls
  the pid until it actually exits. Once it does, the task is run through
  the same settlement pipeline a normal exit uses — changeset extraction,
  output-completeness, everything — with one difference: the real exit
  code never survives a daemon restart (only the process that called
  `spawn()` can `waitpid()` it), so the task is tentatively marked
  `"crashed"` and only recovered to `"done"` if its log actually reached a
  genuine completion marker; otherwise it settles `"crashed"` tagged
  `orphan_resume_exit_code_unknown`.
- **Pid confirmed dead, or reused by an unrelated process:** the task is
  relabeled `"unknown"`, tagged `failureReason: "daemon_restarted_orphaned"`.
- **No pid recorded at all** (a legacy record predating this field, or a
  task that crashed before a pid was ever assigned): relabeled `"unknown"`
  with no liveness check attempted and no new tag — unchanged from before.

The underlying worker process's log has the same stdout/stderr survival
split regardless of which of the above applies: stderr is duplicated
directly into the log file descriptor at spawn time, independent of the
parent process, so it keeps writing after a restart. stdout is a pipe only
the daemon process that spawned the child reads and normalizes into the
log — once that process exits, nothing is left reading that pipe, and any
narration the worker would have written after the exact moment of the
daemon's death is not recoverable by any daemon-side fix. This is why a
resumed task that reached real completion just before the crash settles
`"done"` reliably (the completion marker made it to disk in time), while
one whose completion landed *after* the crash can settle `"crashed"` tagged
`orphan_resume_exit_code_unknown` even though the worker's own work may
have genuinely finished — inspect the log file directly, or for an
`opencode`-executor task, run `opencode session list`, to check.

No log rotation or cleanup: `logs/` grows unbounded. Fine for interactive
use; long-lived automation wants an external retention policy.
```

- [ ] **Step 7: Update `docs/sourcemap.md`**

Run `wc -l src/tasks.js src/daemon-server.js` and update the line-count figures in `docs/sourcemap.md` (currently `src/tasks.js` (5294 lines)` and the `daemon-server.js` row) to match. Update the `daemon-server.js` row's description of `makeMaybeRestart` to drop any "idle-gated"/"waits for zero running/queued" framing (search the file for `makeMaybeRestart` to find every mention) and note the new resumption behavior in the `tasks.js` row's responsibility text, alongside the existing `loadPersistedTask` mention if one exists.

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/daemon-server.js src/daemon.js src/daemon-server.test.js docs/daemon.md docs/sourcemap.md
git commit -m "feat(daemon): drop the idle-gated self-restart now that orphan resumption exists"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (liveness-poll + PID-reuse guard) → Task 2. §2 (poll-to-exit, settle through normal pipeline) → Task 3. §3 (why `evaluateOutputCompleteness` needs no change, but its result needs a tag) → the `orphanedByRestart` stamping threaded through Tasks 2-3; explicitly called out as a Global Constraint that `evaluateOutputCompleteness` itself stays untouched. §4 (idle gate removal) → Task 4. The error-handling summary table's five rows are each their own test in Task 2/3. Testing section's three bullets → Task 1-3's unit tests (mocked liveness/PID-reuse), Task 3 Step 12 (real exercise), and Task 2's PID-reuse tests (targeted unit coverage per the doc's own accepted-gap note, since a real PID recycle can't be forced on demand). Non-goals are respected: no `evaluateOutputCompleteness` change, no new CLI subcommand, no cross-platform (`/proc`) fallback.
- **Placeholder scan:** no TBD/TODO, no "add appropriate error handling," no bare prose steps without real code.
- **Type consistency:** `isTaskProcessAlive`, `readProcessStartTime`, `pollForResumedExit`, `settleResumedTask`, `resumeOrphanedTasks`, `cleanUpResumedScratchFiles` are named identically across every task that references them; the `ResumeSettleContext` typedef's fields match exactly what `settleResumedTask`/`pollForResumedExit`/`cleanUpResumedScratchFiles` read from `ctx` in Task 3.
