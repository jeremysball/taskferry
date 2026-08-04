# AXI Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two real defects a live AXI audit of `taskferry` surfaced: (1) `context`/home-view/`list` dump an unbounded task history (up to 805 rows, 110KB) with no default cap and no reveal-hint when truncated, and (2) an advisor-role task whose changeset extraction throws gets `changesetStatus: "pending"` regardless of role, so a later `taskferry reject <id>` silently "succeeds" on a task that never had anything to reject.

**Architecture:** Both fixes are small, localized changes to existing pure functions — no new files, no new commands, no new flags. Bug 1 adds a default row cap plus a truncation-reveal hint to three existing output-shaping functions in `src/output.js` (`projectList`, `projectContext`, `homeView`), all of which currently receive the full unsliced task array from the daemon and either slice conditionally (`projectList`, only when `--limit` is passed) or not at all (`projectContext`, `homeView`). Bug 2 is a one-branch fix in the `catch` block of `extractChangesetForTask` in `src/tasks.js`, which currently sets `changesetStatus = "pending"` unconditionally on extraction failure — it needs the same `role === "advisor"` branch the adjacent success-path `if` already has three lines below it.

**Tech Stack:** Node.js (`node:test` + `node:assert/strict` for tests, matching every other file in `src/`), TOON output via `@toon-format/toon`.

## Global Constraints

- Follow Conventional Commits for every commit message (`fix(output): ...`, `fix(tasks): ...`).
- No new CLI flags — this plan closes the gap with defaults and hints, not new surface area.
- Every task ends with `npm run test:unit` passing before its commit.
- Match existing code style: `node:test`'s `describe`/`test`, `assert.equal`/`assert.deepEqual` from `node:assert/strict`, JSDoc-style comments only where the *why* isn't obvious from the code (see existing comments in `src/tasks.js` for the house style).

---

### Task 1: Default row cap + truncation-reveal hint for `taskferry list`

**Files:**
- Modify: `src/output.js:169-178` (`projectList`)
- Test: `src/output.test.js`

**Interfaces:**
- Consumes: nothing new — `projectList(value, { limit } = {})` keeps its existing signature; `value.tasks` is the full unsliced array from the daemon (`value.counts` sums to the true total across all statuses).
- Produces: `projectList` now always returns a bounded `tasks` array (default 30 rows unless the caller passes an explicit `--limit`, or the true total is `<= 30`), plus a new `next` array field containing a single reveal-hint string when the returned rows are fewer than the true total. `src/commands.js`'s `list` case (line ~402-406) is an existing consumer; no change needed there since it already forwards `options.limit` through unchanged — a `--limit` flag still overrides the new default, and `--limit` larger than the total or `--all`-style unlimited access still works because slicing to a length longer than the array is a no-op.

- [ ] **Step 1: Write the failing tests**

Add to `src/output.test.js` (near the top, alongside the other `projectList`-shaped tests — there are none yet, so add a new `describe` block after the existing imports):

```js
import { projectList } from "./output.js";
```

(add `projectList` to the existing named import from `"./output.js"` at the top of the file instead of a second import line)

```js
describe("projectList default row cap", () => {
  function fakeListValue(totalCount) {
    return {
      directory: "/workspace/example",
      counts: { queued: 0, running: 0, done: totalCount, crashed: 0, cancelled: 0, unknown: 0 },
      tasks: Array.from({ length: totalCount }, (_, i) => ({
        id: `task-${i}`,
        status: "done",
        model: "openai/gpt-5.6-sol",
        startedAt: "2026-08-01T00:00:00.000Z",
      })),
    };
  }

  test("caps to 30 rows by default when the total exceeds 30", () => {
    const result = projectList(fakeListValue(805));
    assert.equal(result.tasks.length, 30);
  });

  test("does not cap when the total is at or under 30", () => {
    const result = projectList(fakeListValue(12));
    assert.equal(result.tasks.length, 12);
  });

  test("an explicit --limit still overrides the default", () => {
    const result = projectList(fakeListValue(805), { limit: 5 });
    assert.equal(result.tasks.length, 5);
  });

  test("adds a reveal-hint next[] when rows are truncated", () => {
    const result = projectList(fakeListValue(805));
    assert.deepEqual(result.next, ["Run taskferry list --limit 805 for all 805 tasks"]);
  });

  test("omits next[] when nothing was truncated", () => {
    const result = projectList(fakeListValue(12));
    assert.equal(result.next, undefined);
  });

  test("omits next[] when an explicit --limit already covers the full total", () => {
    const result = projectList(fakeListValue(12), { limit: 100 });
    assert.equal(result.next, undefined);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/output.test.js`
Expected: FAIL — `projectList` is not exported yet from the test file's import (it already is exported from `output.js`, but the new tests reference behavior — the row cap and `next` field — that don't exist yet), so the cap/no-cap/hint assertions fail while the "explicit --limit" ones may pass by coincidence of existing behavior.

- [ ] **Step 3: Implement the default cap and reveal hint**

Replace `src/output.js:169-178`:

```js
const DEFAULT_LIST_LIMIT = 30;

export function projectList(value, { limit } = {}) {
  const rows = Array.isArray(value.tasks)
    ? (value.tasks.length ? value.tasks.map(listRow) : "none found in this workspace")
    : value.tasks;
  const total = Array.isArray(rows) ? rows.length : 0;
  const effectiveLimit = limit !== undefined ? limit : DEFAULT_LIST_LIMIT;
  const tasks = Array.isArray(rows) ? rows.slice(0, effectiveLimit) : rows;
  const truncated = Array.isArray(tasks) && tasks.length < total;
  return {
    ...(value.directory ? { directory: value.directory } : {}),
    counts: value.counts,
    tasks,
    ...(truncated ? { next: [`Run taskferry list --limit ${total} for all ${total} tasks`] } : {}),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/output.test.js`
Expected: PASS (all `projectList default row cap` tests green, and no regressions in the rest of the file's tests).

- [ ] **Step 5: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS. This will also catch any existing `commands.test.js` assertion that hardcoded the old unbounded `list` behavior — if one fails, update its expected row count/fixture size to account for the new 30-row default rather than removing the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/output.js src/output.test.js
git commit -m "fix(output): cap taskferry list to 30 rows by default with a reveal hint"
```

---

### Task 2: Apply the same cap to `taskferry context` (the SessionStart hook payload)

**Files:**
- Modify: `src/output.js:180-188` (`projectContext`)
- Modify: `src/commands.js:409-413` (the `context` case in `runCommand`)
- Test: `src/output.test.js`

**Interfaces:**
- Consumes: `projectList`'s new `DEFAULT_LIST_LIMIT` is intentionally *not* reused here — `context` runs on every session start (per the `building-agent-clis` skill's "ruthlessly minimize" rule for ambient context), so it gets its own, much smaller constant.
- Produces: `projectContext(value, { limit } = {})` — note the signature gains the same optional `{ limit }` shape as `projectList` for testability, but `src/commands.js`'s `context` case does not expose a new `--limit` flag (out of scope for this plan — see Global Constraints). It always calls `projectContext(context)` with no override, so the default (10) always applies in production; the parameter exists only so the test file can exercise both branches without needing 805-element fixtures for the "not truncated" case.

- [ ] **Step 1: Write the failing tests**

Add `projectContext` to the same `output.js` named import in `src/output.test.js`, and add:

```js
describe("projectContext default row cap (SessionStart hook payload)", () => {
  function fakeContextValue(totalCount) {
    return {
      directory: "/workspace/example",
      counts: { queued: 0, running: 0, done: totalCount, crashed: 0, cancelled: 0, unknown: 0 },
      tasks: Array.from({ length: totalCount }, (_, i) => ({
        id: `task-${i}`,
        status: "done",
        model: "openai/gpt-5.6-sol",
        startedAt: "2026-08-01T00:00:00.000Z",
      })),
    };
  }

  test("caps to 10 rows by default when the total exceeds 10", () => {
    const result = projectContext(fakeContextValue(805));
    assert.equal(result.tasks.length, 10);
  });

  test("does not cap when the total is at or under 10", () => {
    const result = projectContext(fakeContextValue(4));
    assert.equal(result.tasks.length, 4);
  });

  test("adds a reveal-hint next[] when rows are truncated", () => {
    const result = projectContext(fakeContextValue(805));
    assert.deepEqual(result.next, ["Run taskferry list --limit 805 for all 805 tasks"]);
  });

  test("omits next[] when nothing was truncated", () => {
    const result = projectContext(fakeContextValue(4));
    assert.equal(result.next, undefined);
  });

  test("an explicit limit override still works (used only by tests, not by the CLI)", () => {
    const result = projectContext(fakeContextValue(805), { limit: 2 });
    assert.equal(result.tasks.length, 2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/output.test.js`
Expected: FAIL — `projectContext` returns all 805 rows and no `next` field yet.

- [ ] **Step 3: Implement the default cap and reveal hint**

Replace `src/output.js:180-188`:

```js
const DEFAULT_CONTEXT_LIMIT = 10;

export function projectContext(value, { limit } = {}) {
  const rows = Array.isArray(value.tasks)
    ? (value.tasks.length ? value.tasks.map(listRow) : "none found in this workspace")
    : value.tasks;
  const total = Array.isArray(rows) ? rows.length : 0;
  const effectiveLimit = limit !== undefined ? limit : DEFAULT_CONTEXT_LIMIT;
  const tasks = Array.isArray(rows) ? rows.slice(0, effectiveLimit) : rows;
  const truncated = Array.isArray(tasks) && tasks.length < total;
  return {
    directory: value.directory,
    counts: value.counts,
    tasks,
    ...(truncated ? { next: [`Run taskferry list --limit ${total} for all ${total} tasks`] } : {}),
  };
}
```

`src/commands.js:409-413`'s `context` case already calls `projectContext(context)` with a single argument — no change needed there, since the new second parameter is optional and defaults to the 10-row cap.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/output.test.js`
Expected: PASS.

- [ ] **Step 5: Live-verify the real payload size dropped**

Run: `node -e "console.log(1)"` is not enough here — this is exactly the kind of claim the `building-agent-clis` audit procedure requires live evidence for. Run the actual command against this repo's real task history and confirm the byte count:

```bash
taskferry context 2>&1 | wc -c
```

Expected: well under 10KB (down from the pre-fix 109,799 bytes measured during the audit), since it's now capped to 10 rows plus the `next` hint instead of all 805.

- [ ] **Step 6: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/output.js src/output.test.js
git commit -m "fix(output): cap taskferry context (SessionStart hook payload) to 10 rows"
```

---

### Task 3: Apply the same cap to the bare no-args home view

**Files:**
- Modify: `src/output.js:190-207` (`homeView`)
- Test: `src/output.test.js`

**Interfaces:**
- Consumes: reuses `DEFAULT_LIST_LIMIT` from Task 1 (the home view is an explicit, one-off invocation like `list`, not an every-session ambient payload like `context`, so it gets the same 30-row default rather than `context`'s tighter 10).
- Produces: `homeView(value, { executablePath, workspace })` keeps its existing signature (no new parameter — there is no `--limit` flag on the bare no-args command, so there is nothing for a caller to override). The existing `next` field (currently either the empty-state or non-empty-state hint array) gains a third line when rows are truncated, appended to whichever of the two existing arrays applies.

- [ ] **Step 1: Write the failing tests**

Add `homeView` to the `output.js` named import in `src/output.test.js`, and add:

```js
describe("homeView default row cap", () => {
  function fakeHomeValue(totalCount) {
    return {
      counts: { queued: 0, running: 0, done: totalCount, crashed: 0, cancelled: 0, unknown: 0 },
      tasks: Array.from({ length: totalCount }, (_, i) => ({
        id: `task-${i}`,
        status: "done",
        model: "openai/gpt-5.6-sol",
        startedAt: "2026-08-01T00:00:00.000Z",
      })),
    };
  }

  test("caps to 30 rows by default when the total exceeds 30", () => {
    const result = homeView(fakeHomeValue(805), { executablePath: "/bin/taskferry", workspace: "/workspace/example" });
    assert.equal(result.tasks.length, 30);
  });

  test("does not cap when the total is at or under 30", () => {
    const result = homeView(fakeHomeValue(12), { executablePath: "/bin/taskferry", workspace: "/workspace/example" });
    assert.equal(result.tasks.length, 12);
  });

  test("appends a reveal-hint to the existing non-empty next[] when rows are truncated", () => {
    const result = homeView(fakeHomeValue(805), { executablePath: "/bin/taskferry", workspace: "/workspace/example" });
    assert.equal(result.next.length, 4);
    assert.equal(result.next[3], "Run taskferry list --limit 805 for all 805 tasks");
  });

  test("does not append a reveal-hint when nothing was truncated", () => {
    const result = homeView(fakeHomeValue(12), { executablePath: "/bin/taskferry", workspace: "/workspace/example" });
    assert.equal(result.next.length, 3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/output.test.js`
Expected: FAIL — `homeView` currently returns all rows unsliced with a fixed 3-line `next` array (or the 2-line empty-state array), so the row-count and `next.length` assertions fail.

- [ ] **Step 3: Implement the default cap and reveal hint**

Replace `src/output.js:190-207`:

```js
export function homeView(value, { executablePath, workspace }) {
  const home = os.homedir();
  const absolutePath = path.resolve(executablePath || process.argv[1] || process.execPath);
  const displayPath = absolutePath === home || absolutePath.startsWith(`${home}${path.sep}`)
    ? `~${absolutePath.slice(home.length)}`
    : absolutePath;
  const allRows = Array.isArray(value.tasks) ? value.tasks : [];
  const total = allRows.length;
  const rows = allRows.slice(0, DEFAULT_LIST_LIMIT);
  const truncated = rows.length < total;
  const next = rows.length
    ? ["Run taskferry status <id> for activity", "Run taskferry wait <id> to wait for settlement", "Run taskferry result <id> for the final answer"]
    : ["Run taskferry dispatch --prompt \"<text>\" to start a task", "Run taskferry list --all to inspect every workspace"];
  return {
    bin: displayPath,
    description: "Manage background OpenCode tasks in the current workspace.",
    workspace,
    counts: value.counts,
    tasks: rows,
    next: truncated ? [...next, `Run taskferry list --limit ${total} for all ${total} tasks`] : next,
  };
}
```

(`DEFAULT_LIST_LIMIT` is the constant added in Task 1 — both live in the same file, so no new import is needed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/output.test.js`
Expected: PASS.

- [ ] **Step 5: Live-verify against the real repo**

```bash
taskferry 2>&1 | wc -c
```

Expected: well under 10KB (down from the pre-fix ~110,041 bytes measured during the audit).

- [ ] **Step 6: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/output.js src/output.test.js
git commit -m "fix(output): cap the bare no-args home view to 30 rows with a reveal hint"
```

---

### Task 4: Fix advisor-role changesetStatus on a failed extraction (the silent `reject` no-op bug)

**Files:**
- Modify: `src/tasks.js:832-836` (the `catch` block in `extractChangesetForTask`)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `finishedTask.role` (already read three lines below, at `src/tasks.js:840`, in the success-path branch this fix mirrors) and `finishedTask.overlayDirs` (already available; `releaseOverlay` is the existing helper the success-path advisor branch already calls at line 842).
- Produces: no signature change to `extractChangesetForTask` — only its internal behavior changes. After this fix, an advisor-role task whose changeset extraction throws ends up with `changesetStatus: "rejected"` (matching what a *successful* extraction already does for advisor role at line 840-842) instead of `"pending"`. This means a subsequent `taskferry reject <id>` on that task now correctly errors with `"has no pending changeset (changesetStatus: rejected)"` instead of silently returning `exit 0`.

- [ ] **Step 1: Write the failing test**

This mirrors the existing test `"advisor: child.on('error') still auto-rejects and cleans up the overlay so it's not stranded"` (`src/tasks.test.js:459-489`), which forces a *successful* extraction (`runOverlayCommandFn` returning `{ status: 0, ... }`) on the advisor spawn-error path. This new test instead forces extraction itself to fail (`runOverlayCommandFn` returning a non-zero `status`, which `extractGitDiff`/`extractNonGitDiff` in `src/changeset.js:117,240` turn into a thrown `Error`) on an otherwise *normal, successful* run — the exact shape of the bug found live during the AXI audit (the opencode run finished cleanly; a concurrent `git commit` in the target directory made the diff extraction itself fail). Add directly after the test ending at `src/tasks.test.js:489`:

```js
test("advisor: extraction failure settles to 'rejected', not 'pending' (regression: silent reject() no-op on advisor tasks)", async () => {
  // Without this fix, extractChangesetForTask()'s catch block set
  // changesetStatus: "pending" regardless of role whenever extraction threw
  // (e.g. the target directory's HEAD moved mid-dispatch) -- unlike the
  // success path three lines below it, which already special-cases
  // role === "advisor" to "rejected". That left a later `taskferry reject
  // <id>` silently returning exit 0 on an advisor task that never had a
  // real changeset to reject in the first place.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-advisor-extract-fail-"));
  const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-advisor-extract-fail-tmp-"));
  const child = fakeChild();
  const mgr = makeManager({
    spawnFn: () => child,
    sandboxEnabled: true,
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    overlayEnabled: true,
    checkOverlaySupportFn: () => ({ supported: true }),
    platform: "linux",
    overlayTmpRoot,
    runOverlayCommandFn: () => ({ status: 1, stdout: "", stderr: "fatal: HEAD moved", error: undefined }),
  });

  const advisePromise = mgr.advisor({ prompt: "hi", directory, model: "openai/gpt-5.6-sol" });
  child.emit("exit", 0, null);
  const advised = await advisePromise;

  const status = mgr.status(advised.task_id);
  assert.equal(status.status, "done");
  assert.equal(status.changesetStatus, "rejected");
  assert.ok(status.changesetError, "changesetError should still record why extraction failed");

  assert.throws(() => mgr.reject(advised.task_id), /no pending changeset/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/tasks.test.js`
Expected: FAIL — `status.changesetStatus` is currently `"pending"`, not `"rejected"`, so the `changesetStatus` assertion fails, and `mgr.reject(advised.task_id)` currently succeeds (returns `{ changesetStatus: "rejected" }` without throwing) instead of throwing `/no pending changeset/`, so `assert.throws` also fails.

- [ ] **Step 3: Implement the fix**

Replace `src/tasks.js:832-836`:

```js
} catch (err) {
  finishedTask.changesetError = err instanceof Error ? err.message : String(err);
  if (finishedTask.role === "advisor") {
    // An advisor task's changeset was never meant to be applied -- whether
    // extraction succeeds or throws, it settles as "rejected", never
    // "pending". Without this branch, a throw here (e.g. the target
    // directory's HEAD moved mid-dispatch) left changesetStatus: "pending"
    // regardless of role, so a later `taskferry reject <id>` would silently
    // succeed on a task that never had anything to reject.
    finishedTask.changesetStatus = "rejected";
    releaseOverlay(finishedTask);
  } else {
    finishedTask.changesetStatus = "pending";
  }
  persistTask(finishedTask.id);
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/tasks.test.js`
Expected: PASS.

- [ ] **Step 5: Live-verify against a real advisor dispatch**

This is the exact live-execution step the `building-agent-clis` audit procedure requires — don't skip it because the unit test passed. In a scratch git worktree (not the main checkout):

```bash
cd /tmp && git clone /workspace/taskferry axi-verify-clone && cd axi-verify-clone
taskferry advisor --model openai/gpt-5.6-sol --variant low --executor opencode --prompt "Reply with exactly: PONG" --directory /tmp/axi-verify-clone
```

Note the returned task id, then force the same "HEAD moved" extraction failure the original bug was found under:

```bash
git -C /tmp/axi-verify-clone commit --allow-empty -m "force HEAD to move mid-flight for this test"
taskferry result <task-id> --fields changesetStatus,changesetError
```

Expected: `changesetStatus: rejected` (not `pending`), with `changesetError` still populated explaining the HEAD-moved condition. Then confirm `reject` now correctly refuses it:

```bash
taskferry reject <task-id>
```

Expected: `exit 1` with `error: task <task-id> has no pending changeset (changesetStatus: rejected)` — not the pre-fix silent `exit 0`.

- [ ] **Step 6: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "fix(tasks): settle an advisor task as rejected, not pending, when extraction throws"
```

---

### Task 5: Update `docs/sourcemap.md`

**Files:**
- Modify: `docs/sourcemap.md`

**Interfaces:**
- Consumes: the four commits from Tasks 1-4.
- Produces: an up-to-date sourcemap per this repo's own `CLAUDE.md` rule ("After any commit that changes `src/` ... update `docs/sourcemap.md` in the same PR").

- [ ] **Step 1: Update the `src/output.js` and `src/tasks.js` rows**

Read the current `docs/sourcemap.md` entries for `src/output.js` and `src/tasks.js` first (their line counts and responsibility text will have drifted after Tasks 1-4's edits), then update:
- `src/output.js`'s line count and responsibility text to mention the default row caps on `projectList`/`projectContext`/`homeView` and the truncation reveal-hint, since this is now a "gotcha" worth flagging (a future reader modifying default limits should know all three functions share the pattern).
- `src/tasks.js`'s line count, and add a one-line gotcha note next to `extractChangesetForTask` describing why the `catch` block branches on `role === "advisor"` (mirrors the adjacent success-path branch three lines below it — easy to miss and re-break if someone "simplifies" the catch block later).

- [ ] **Step 2: Commit**

```bash
git add docs/sourcemap.md
git commit -m "docs(sourcemap): reflect output.js default row caps and tasks.js advisor-catch fix"
```
