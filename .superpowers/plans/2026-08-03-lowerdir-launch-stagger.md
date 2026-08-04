# Lowerdir Launch Stagger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Stop concurrent dispatches from crashing with `bwrap: Can't make overlay mount ... Device or resource busy` (taskferry#318) by enforcing a simple global minimum spacing between every launch, instead of full serialization or a worktree-per-variant workaround. Also give any residual occurrence (the stagger reduces but cannot fully guarantee the race is gone) a clear, dedicated `failureReason` instead of today's generic `no_output_timeout`, so a recurrence is diagnosable without digging into `--full`/`changesetError`.

**Architecture:** `tasks.js`'s existing `launchQueuedTasks()` loop already gates launches on a global rate window (`dispatchLimit`/`dispatchWindow`) and a concurrency cap (`concurrencyLimit`) before calling `startTask()`. Add one more condition: track a single `lastLaunchAt` timestamp and refuse to launch the next queued task until `lowerdirStaggerMs` has elapsed since the previous launch — no per-directory tracking, no scoping to overlay-enabled launches. Once a task actually launches, it runs fully concurrently with everything else; only the *launch moment* is spaced out.

**Tech Stack:** Node.js (no new dependencies). All changes live in `src/tasks.js` and `src/config.js`, following patterns already established by `noOutputTimeoutMs`/`watchdogGraceMs`/`summarizerTimeoutMs`.

## Global Constraints

- Full design/root-cause writeup: `.superpowers/specs/2026-08-03-lowerdir-launch-stagger-design.md` — read it before starting; every task below implements a piece of that spec.
- Default stagger: `3000` ms. Configurable via `TASKFERRY_LOWERDIR_STAGGER_MS` env var (highest precedence) and `config.json`'s `lowerdirStaggerMs` field. `0` disables the gate entirely.
- The gate is **global** — it applies to every launch (dispatch, advisor, summary; overlay-enabled or not), not scoped to a directory. This was a deliberate simplification over an earlier per-lowerdir-keyed design; see the spec's "Fix" section for the tradeoff.
- No new background timers or cross-process locking — the daemon is a single long-lived process (confirmed in `docs/sourcemap.md`), so one in-memory variable is sufficient.
- Follow the existing `positiveInteger()`/`nonNegativeInteger()` config-resolution pattern in `tasks.js` exactly — use `nonNegativeInteger()` (not `positiveInteger()`) since `0` is a valid, meaningful value (disables the gate), matching `summarizerTimeoutMs`'s precedent.
- New `failureReason` bucket `overlay_mount_busy`: not executor-prefixed (unlike opencode/pi provider-failure buckets via `bucketFor()`) — this is a taskferry-infra-level failure, not a model/provider one. It always overwrites whatever the exit-path classifier guessed (`no_output_timeout`, `boot_failure`, or unset), since matching the exact bwrap overlay-busy message is a confirmed, specific diagnosis.

---

### Task 1: Add `lowerdirStaggerMs` config plumbing

**Files:**
- Modify: `src/config.js:24-47` (`CONFIG_FIELD_TYPES`)
- Modify: `src/tasks.js:505-521` (constants), `src/tasks.js:522-650` (constructor options), `src/tasks.js:700-713` (computed values)
- Test: `src/config.test.js`, `src/tasks.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `createTaskManager()` accepts a `lowerdirStaggerMs` option (constructor override, same precedence chain as `noOutputTimeoutMs`); the resolved value is available inside the manager closure as `lowerdirStagger` for Task 2 to read.

- [x] **Step 1: Add the config field type**

In `src/config.js`, in `CONFIG_FIELD_TYPES` (currently lines 24-47), add after `watchdogGraceMs: "number",`:

```js
  lowerdirStaggerMs: "number",
```

- [x] **Step 2: Write a failing config test**

In `src/config.test.js`, near the other field-specific tests (e.g. after the `sandboxDenylist` pair around line 147-153), add — first check the exact fixture-writing helper name neighboring tests use (grep this file for the `sandboxDenylist` test pair and match its helper call exactly instead of guessing):

```js
  test("accepts a valid lowerdirStaggerMs value", () => {
    writeConfig({ lowerdirStaggerMs: 3000 });
    assert.deepEqual(loadConfig(), { lowerdirStaggerMs: 3000 });
  });

  test("rejects a wrong-typed lowerdirStaggerMs value", () => {
    writeConfig({ lowerdirStaggerMs: "3000" });
    assert.throws(() => loadConfig(), /error:.*lowerdirStaggerMs/);
  });
```

- [x] **Step 3: Run the config test to verify it fails**

Run: `npm test -- src/config.test.js --test-name-pattern "lowerdirStaggerMs"`
Expected: FAIL — `lowerdirStaggerMs` not yet a recognized key, so `loadConfig()` throws "unrecognized top-level key" on the *accept* test instead of returning the value.

- [x] **Step 4: Run it again after Step 1's change**

Run: `npm test -- src/config.test.js --test-name-pattern "lowerdirStaggerMs"`
Expected: PASS.

- [x] **Step 5: Add the constant, constructor option, and computed value in `tasks.js`**

In `src/tasks.js`, add a new default constant near the others (currently lines 505-511, after `DEFAULT_NO_OUTPUT_TIMEOUT_MS`/`DEFAULT_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS`):

```js
const DEFAULT_LOWERDIR_STAGGER_MS = 3000;
```

In the JSDoc block above `createTaskManager()` (near `@param {number} [options.noOutputTimeoutMs]` around line 543), add:

```js
 * @param {number} [options.lowerdirStaggerMs]
```

In the destructured options (near `noOutputTimeoutMs = positiveInteger(...)`, currently lines 631-638), add:

```js
  lowerdirStaggerMs = nonNegativeInteger(
    Number(process.env.TASKFERRY_LOWERDIR_STAGGER_MS),
    nonNegativeInteger(/** @type {number} */ (config.lowerdirStaggerMs), DEFAULT_LOWERDIR_STAGGER_MS)
  ),
```

Near the other computed values (currently lines 707-710, `const noOutputTimeout = ...`), add:

```js
  const lowerdirStagger = nonNegativeInteger(lowerdirStaggerMs, DEFAULT_LOWERDIR_STAGGER_MS);
```

- [x] **Step 6: Run `tasks.test.js` to confirm nothing broke**

Run: `npm test -- src/tasks.test.js`
Expected: PASS (this task only adds plumbing; `lowerdirStagger` isn't consumed yet, so no behavior changes).

- [x] **Step 7: Commit**

```bash
git add src/config.js src/config.test.js src/tasks.js
git commit -m "feat(config): add lowerdirStaggerMs option"
```

---

### Task 2: Implement the global launch-stagger gate

**Files:**
- Modify: `src/tasks.js:998-1005` (queue state), `src/tasks.js:1954-1975` (`launchQueuedTasks()`)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `lowerdirStagger: number` (Task 1's computed value).
- Produces: the stagger behavior itself — no new public API. `launchQueuedTasks()` now refuses to launch the next queued task until `lowerdirStagger` ms have elapsed since the previous launch (any launch, any directory).

- [x] **Step 1: Write the failing tests**

Add to `src/tasks.test.js`:

```js
describe("global launch stagger", () => {
  test("two dispatches to the same directory launch at least lowerdirStaggerMs apart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-stagger-same-"));
    const children = [];
    const mgr = makeManager({
      spawnFn: () => { const c = fakeChild(9200 + children.length); children.push(c); return c; },
      lowerdirStaggerMs: 50,
      maxConcurrentTasks: 10,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
    });

    const a = mgr.dispatch({ prompt: "a", directory });
    const b = mgr.dispatch({ prompt: "b", directory });

    assert.equal(mgr.status(a.id).status, "running");
    assert.equal(mgr.status(b.id).status, "queued", "second dispatch should be staggered, not launched immediately");

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(mgr.status(b.id).status, "running", "staggered dispatch should launch once lowerdirStaggerMs has elapsed");
  });

  test("the gate is global: two dispatches to unrelated directories still stagger", async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "axi-stagger-diffA-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "axi-stagger-diffB-"));
    const children = [];
    const mgr = makeManager({
      spawnFn: () => { const c = fakeChild(9300 + children.length); children.push(c); return c; },
      lowerdirStaggerMs: 50,
      maxConcurrentTasks: 10,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
    });

    const a = mgr.dispatch({ prompt: "a", directory: dirA });
    const b = mgr.dispatch({ prompt: "b", directory: dirB });

    assert.equal(mgr.status(a.id).status, "running");
    assert.equal(mgr.status(b.id).status, "queued", "the gate is deliberately global -- unrelated directories still stagger");

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(mgr.status(b.id).status, "running");
  });

  test("three dispatches each launch at least lowerdirStaggerMs after the previous one", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-stagger-three-"));
    const children = [];
    const mgr = makeManager({
      spawnFn: () => { const c = fakeChild(9350 + children.length); children.push(c); return c; },
      lowerdirStaggerMs: 40,
      maxConcurrentTasks: 10,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
    });

    const a = mgr.dispatch({ prompt: "a", directory });
    const b = mgr.dispatch({ prompt: "b", directory });
    const c = mgr.dispatch({ prompt: "c", directory });

    assert.equal(mgr.status(a.id).status, "running");
    assert.equal(mgr.status(b.id).status, "queued");
    assert.equal(mgr.status(c.id).status, "queued");

    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(mgr.status(b.id).status, "running");
    assert.equal(mgr.status(c.id).status, "queued", "the third dispatch must wait for its own full stagger window after b, not launch alongside it");

    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(mgr.status(c.id).status, "running");
  });

  test("lowerdirStaggerMs: 0 disables the gate", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-stagger-disabled-"));
    const children = [];
    const mgr = makeManager({
      spawnFn: () => { const c = fakeChild(9600 + children.length); children.push(c); return c; },
      lowerdirStaggerMs: 0,
      maxConcurrentTasks: 10,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
    });

    const a = mgr.dispatch({ prompt: "a", directory });
    const b = mgr.dispatch({ prompt: "b", directory });

    assert.equal(mgr.status(a.id).status, "running");
    assert.equal(mgr.status(b.id).status, "running", "lowerdirStaggerMs: 0 must disable the gate entirely");
  });
});
```

Note: `makeManager()` defaults `sandboxEnabled: false`/`overlayEnabled: false` (see the helper's definition in `src/tasks.test.js`), so these tests exercise the plain-bind (non-sandboxed) dispatch path — correct here, since the gate is global and must not depend on overlay/sandbox state at all.

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/tasks.test.js --test-name-pattern "global launch stagger"`
Expected: FAIL on the "stagger" and "three dispatches" assertions (all launches happen immediately today). The "disabled" test may already pass by coincidence (nothing today staggers anything) — that's fine, it's a regression guard for after the gate exists.

- [x] **Step 3: Add the tracking variable next to the other queue state**

In `src/tasks.js`, near the existing queue state (currently lines 998-1005):

```js
  const launchQueue = [];
  ...
  const launchTimes = [];
  ...
  let launchTimer = null;
  let runningCount = 0;
```

Add:

```js
  // Timestamp of the most recent launch, across every directory/role. A
  // simple global minimum spacing between launches -- deliberately not
  // scoped per-directory -- works around a bwrap overlay-mount race
  // (taskferry#318, "Device or resource busy") seen both within one
  // worktree and across different worktrees of one repo; see
  // .superpowers/specs/2026-08-03-lowerdir-launch-stagger-design.md for why
  // a global gate was chosen over a per-directory one.
  let lastLaunchAt = 0;
```

- [x] **Step 4: Wire the gate into `launchQueuedTasks()`**

In `src/tasks.js`, `launchQueuedTasks()` currently reads (lines 1954-1975):

```js
  function launchQueuedTasks() {
    if (launchTimer) {
      clearTimeout(launchTimer);
      launchTimer = null;
    }
    const now = Date.now();
    while (launchTimes.length && launchTimes[0] <= now - dispatchWindow) launchTimes.shift();

    while (launchQueue.length && launchTimes.length < dispatchLimit && runningCount < concurrencyLimit) {
      const id = /** @type {string} */ (launchQueue.shift());
      const task = tasks.get(id);
      if (!task || task.status !== "queued") continue;
      launchTimes.push(Date.now());
      startTask(task);
    }

    if (launchQueue.length && !launchTimer) {
      const rateDelay = launchTimes.length >= dispatchLimit ? launchTimes[0] + dispatchWindow - Date.now() : 0;
      const concurrencyDelay = runningCount >= concurrencyLimit ? 250 : 0;
      launchTimer = setTimeout(launchQueuedTasks, Math.max(1, rateDelay, concurrencyDelay));
    }
  }
```

Replace it with:

```js
  function launchQueuedTasks() {
    if (launchTimer) {
      clearTimeout(launchTimer);
      launchTimer = null;
    }
    const now = Date.now();
    while (launchTimes.length && launchTimes[0] <= now - dispatchWindow) launchTimes.shift();

    while (
      launchQueue.length &&
      launchTimes.length < dispatchLimit &&
      runningCount < concurrencyLimit &&
      Date.now() - lastLaunchAt >= lowerdirStagger
    ) {
      const id = /** @type {string} */ (launchQueue.shift());
      const task = tasks.get(id);
      if (!task || task.status !== "queued") continue;
      const launchedAt = Date.now();
      launchTimes.push(launchedAt);
      lastLaunchAt = launchedAt;
      startTask(task);
    }

    if (launchQueue.length && !launchTimer) {
      const rateDelay = launchTimes.length >= dispatchLimit ? launchTimes[0] + dispatchWindow - Date.now() : 0;
      const concurrencyDelay = runningCount >= concurrencyLimit ? 250 : 0;
      const staggerDelay = Math.max(0, lastLaunchAt + lowerdirStagger - Date.now());
      launchTimer = setTimeout(launchQueuedTasks, Math.max(1, rateDelay, concurrencyDelay, staggerDelay));
    }
  }
```

Note the loop condition change: the stagger check moved into the `while` guard itself (not a skip-and-continue inside the body). This is safe here — unlike a per-directory gate, a global timestamp means "blocked" is the same answer for every queued task, so there's nothing to skip past; the loop should simply stop draining for this tick once the gate is closed.

- [x] **Step 5: Run the stagger tests to verify they pass**

Run: `npm test -- src/tasks.test.js --test-name-pattern "global launch stagger"`
Expected: PASS, all four tests.

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. Pay particular attention to any pre-existing test in the "active-task concurrency cap" or "config file precedence" `describe` blocks (both in `src/tasks.test.js`, found around lines 2472-2545) that dispatches multiple tasks via `makeManager()` and asserts they're all immediately `"running"` — `makeManager()`'s default `lowerdirStaggerMs` is unset, which now defaults to `3000`. Since the gate is now global, **every** existing test that dispatches more than one task through the same manager without expecting a queued/staggered wait is a candidate for this. Two ways to fix each such test as you find it, in order of preference:
  1. Pass `lowerdirStaggerMs: 0` explicitly in that test's `makeManager()` call (preserves the test's original intent — it's testing something else, like the concurrency cap or config precedence, not the stagger).
  2. If a large number of existing tests break this way, instead change `makeManager()`'s own default to pass `lowerdirStaggerMs: 0` unless a test explicitly overrides it (mirroring how `sandboxEnabled`/`overlayEnabled` already default to `false` in `makeManager()` precisely so most tests don't have to think about sandboxing). Only take this path if Step 6 turns up broken tests broadly across the suite rather than in the one or two `describe` blocks called out above — check the actual failure count before deciding.

- [x] **Step 7: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "fix(tasks): stagger launches globally to avoid bwrap overlay EBUSY (#318)"
```

---

### Task 3: Surface a dedicated `overlay_mount_busy` failureReason

**Files:**
- Modify: `src/tasks.js` (near `capDetail()`/`extractBootFailureDetail()`, currently around lines 228-296; and `extractChangesetForTask()`'s catch block, currently around lines 837-838)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: nothing new — reads `finishedTask.changesetError`, already populated by the existing extraction-failure catch block.
- Produces: when `extractChangesetForTask()` catches an extraction error whose message matches the known bwrap overlay-mount-busy shape, it now also overwrites `finishedTask.failureReason` to `"overlay_mount_busy"` and `finishedTask.failureDetail` to the capped message — regardless of what the exit-path classifier had already set (`no_output_timeout`, `boot_failure`, or nothing).

- [x] **Step 1: Write the failing tests**

Add to `src/tasks.test.js`, in the same `describe` block as "records extraction errors and keeps the overlay for recovery" (around line 1731 today):

```js
  test("reclassifies a real no_output_timeout crash as overlay_mount_busy when the bwrap overlay-busy message is the real cause", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-overlay-busy-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-overlay-busy-tmp-"));
    const bwrapMessage =
      "bwrap: Can't make overlay mount on /newroot/workspace with options " +
      "upperdir=/tmp/upper,workdir=/tmp/work,lowerdir=/oldroot/workspace,userxattr: Device or resource busy";
    const child = fakeChild(7200);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      noOutputTimeoutMs: 20,
      watchdogPollMs: 5,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
      runOverlayCommandFn: () => ({ status: null, stdout: "", stderr: "", error: new Error(bwrapMessage) }),
      rmOverlayTreeFn: () => {},
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
  });

  test("an unrelated extraction error does not touch failureReason", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-overlay-unrelated-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-overlay-unrelated-tmp-"));
    let child;
    const mgr = makeManager({
      spawnFn: () => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
      runOverlayCommandFn: () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn bwrap ETIMEDOUT"), { code: "ETIMEDOUT" }) }),
      rmOverlayTreeFn: () => {},
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const status = mgr.status(result.id);
    assert.equal(status.failureReason, null, "an unrelated extraction error must not invent a failureReason");
    assert.match(status.changesetError, /ETIMEDOUT/);
  });
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/tasks.test.js --test-name-pattern "overlay_mount_busy|unrelated extraction error"`
Expected: the first test FAILs (`failureReason` is still whatever the exit path set, or `undefined` — not yet `"overlay_mount_busy"`). The second test may already pass by coincidence — that's fine, it's a regression guard.

- [x] **Step 3: Add the pattern constant and the reclassification check**

In `src/tasks.js`, near `FAILURE_DETAIL_MAX_CHARS`/`capDetail()` (currently lines 228-233), add:

```js
// bwrap's exact wording for the taskferry#318 overlay-mount race (see
// .superpowers/specs/2026-08-03-lowerdir-launch-stagger-design.md). Matched
// against changesetError text, which can span the bwrap error's own
// multi-line wrapping -- "s" flag so "." also matches newlines.
const OVERLAY_MOUNT_BUSY_PATTERN = /overlay mount on .*Device or resource busy/s;
```

In `extractChangesetForTask()`'s catch block (currently lines 837-838), which today reads:

```js
    } catch (err) {
      finishedTask.changesetError = err instanceof Error ? err.message : String(err);
```

change to:

```js
    } catch (err) {
      finishedTask.changesetError = err instanceof Error ? err.message : String(err);
      if (OVERLAY_MOUNT_BUSY_PATTERN.test(finishedTask.changesetError)) {
        // The real cause is now known and specific -- always wins over
        // whatever the exit-path classifier guessed (no_output_timeout,
        // boot_failure, or nothing), since a generic timeout bucket is
        // strictly less useful than "the overlay mount itself failed."
        finishedTask.failureReason = "overlay_mount_busy";
        finishedTask.failureDetail = capDetail(finishedTask.changesetError);
      }
```

- [x] **Step 4: Run the new tests to verify they pass**

Run: `npm test -- src/tasks.test.js --test-name-pattern "overlay_mount_busy|unrelated extraction error"`
Expected: PASS, both tests.

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures.

- [x] **Step 6: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "fix(tasks): surface a dedicated overlay_mount_busy failureReason (#318)"
```

---

### Task 4: Update the sourcemap

Per this repo's `CLAUDE.md`, `docs/sourcemap.md` must stay in sync with any `src/` behavior change.

**Files:**
- Modify: `docs/sourcemap.md`

- [x] **Step 1: Update the `tasks.js` row**

In `docs/sourcemap.md`'s file-by-file table, find the `tasks.js` row (search for `` `tasks.js` ``) and add a sentence describing (a) the new global launch-stagger gate (`lowerdirStaggerMs`/`TASKFERRY_LOWERDIR_STAGGER_MS`, default 3000ms, global minimum spacing between every launch, taskferry#318) and (b) the new `overlay_mount_busy` `failureReason` bucket that `extractChangesetForTask()` stamps when the bwrap overlay-mount-busy message is the confirmed cause, overriding whatever the exit-path classifier had guessed — to its existing description, following the file's established style (dense, one paragraph per file, gotchas called out explicitly — in particular, call out that the stagger is deliberately global, not per-directory, since a future reader will otherwise assume it's scoped and be surprised). Also update the line count for `tasks.js` and `config.js` to their new values:

```bash
wc -l src/tasks.js src/config.js
```

- [x] **Step 2: Update the "Where do I look for X" table if applicable**

If `docs/sourcemap.md` has a row like "Why did a task crash / how do I read `failureReason`?", consider whether it should mention `overlay_mount_busy` explicitly, and whether a new row for "Why does a burst of dispatches queue instead of launching all at once?" pointing at `tasks.js`'s `launchQueuedTasks()`/`lastLaunchAt` is warranted, following the table's existing format.

- [x] **Step 3: Commit**

```bash
git add docs/sourcemap.md
git commit -m "docs(sourcemap): document the global launch stagger and overlay_mount_busy"
```

---

## Final Verification

- [x] Run `npm test` (full suite) and confirm 0 failures.
- [x] Run whatever lint/typecheck command this repo uses (check `package.json` scripts — likely `npm run lint` and/or `npm run typecheck`) and confirm 0 errors.
- [x] Follow `superpowers:finishing-a-development-branch` to open a PR against `main` referencing taskferry#318, then get it reviewed per this repo's `CLAUDE.md` PR-before-merge rule (pick review effort scaled to this diff's size — it's a small, contained change to one loop plus config plumbing, so `low`-`medium` effort is appropriate; it doesn't need `high`/`xhigh` fan-out).
