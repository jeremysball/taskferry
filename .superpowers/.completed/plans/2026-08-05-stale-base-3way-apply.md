# Stale-Base 3-Way Apply and Honest Terminal Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop aborting changeset extraction on stale-base HEAD drift; instead resolve it with a real (non-`--check`) `git apply --3way` inside a disposable detached worktree, settle the changeset honestly based on that outcome, and make `accept` itself always 3-way so a second drift window (extraction-to-accept) is covered too.

**Architecture:** `changeset.js` gains two small git-subprocess helpers — `detectHeadDrift` (replaces the throwing `assertNoHeadDrift`) and `resolveHeadDrift` (the disposable-worktree probe) — and `extractGitDiff` folds them in after it writes the diff instead of aborting before writing it. `tasks.js`'s settlement code (`extractChangesetForTaskRecord`) reads the new `headDrift` field off the extraction result and routes to `rejected`/`pending` accordingly, stamping audit fields on the task record. `applyGitChangeset` switches unconditionally to `git apply --3way`.

**Tech Stack:** Node.js (`node:child_process` spawnSync via the existing `runCommand` injection pattern), `node:test`, real git subprocesses for integration coverage.

**Reference spec:** `.superpowers/specs/2026-08-05-stale-base-3way-apply-design.md` — read it before starting; this plan implements it section by section and cites section numbers below. Move that spec to `.superpowers/.completed/specs/` in Task 7 once everything lands.

## Global Constraints

- No `--check` mode may be used to decide `recovered`/conflict — only a real, non-`--check` `git apply --3way` plus `git status --porcelain` inspection (spec "A `--check` correction").
- The live `directory` is never written to during drift *evaluation* (extraction-time resolution) — only the disposable scratch worktree is touched, and it is removed afterward regardless of outcome.
- `accept`'s `--3way` switch applies unconditionally (drifted or not) — the no-drift case must remain byte-for-byte behaviorally identical (same args shape plus the new flag, same failure-reason surfacing).
- Non-git targets (`applyNonGitChangeset`, `extractNonGitDiff`) are untouched — this is a git-diff-only mechanic.
- Every new/changed function keeps the existing dependency-injection style (`runCommand`, `sleepFn`, `writeFileFn`, `mkdirFn` defaults overridable) so tests never spawn real processes unless they're explicitly integration tests.

---

## File Structure

- Modify `src/changeset.js`: remove `assertNoHeadDrift`; add `detectHeadDrift` and `resolveHeadDrift`; rewire `extractGitDiff` to call both once, after writing the diff, instead of aborting before writing it; switch `applyGitChangeset` to `git apply --3way`.
- Modify `src/changeset.test.js`: update/replace the "extraction fail-closed on drift" tests (drift no longer throws) with tests for the new non-throwing `headDrift` contract; add `detectHeadDrift`/`resolveHeadDrift` unit-test coverage; update the `applyChangeset` git-target test for the new `--3way` arg.
- Modify `src/changeset.integration.test.js`: add a bwrap-independent describe block exercising `resolveHeadDrift` against three real tiny git repos (no-drift is covered by the existing suite already; add non-conflicting-drift and genuine-conflict-drift), plus one bwrap-gated end-to-end scenario proving `extractGitDiff` surfaces `headDrift.recovered: true` when the directory advances between overlay creation and extraction.
- Modify `src/tasks.js`: extend the `Task`/`TaskSummary`/`ResultDetail` JSDoc typedefs with `headDriftFrom`/`headDriftTo`/`headDriftRecovered`; update `extractChangesetForTaskRecord` to consume `extracted.headDrift`; update `summarizeChangesetFields` and `computeResultDetail` to surface the three new fields when present.
- Modify `src/tasks.changeset.test.js`: add settlement tests for the three `headDrift` outcomes (recovered, conflict, could-not-evaluate) driven through `makeManager`'s mocked `runOverlayCommandFn`.
- Modify `docs/sourcemap.md`: line-count/responsibility refresh for `changeset.js` and `tasks.js` per this repo's CLAUDE.md.

---

## Task 1: `detectHeadDrift` — non-throwing replacement for `assertNoHeadDrift`

**Files:**
- Modify: `src/changeset.js:92-114` (delete `assertNoHeadDrift`, add `detectHeadDrift`)
- Test: `src/changeset.test.js`

**Interfaces:**
- Produces: `export function detectHeadDrift(directory, runCommand, preDispatchHead): {from: string, to: string} | null` — `null` means "no confirmed drift" (HEAD matches, or the check was inconclusive: a git failure or non-git target, matching the old fail-open behavior).

- [ ] **Step 1: Write the failing tests**

Replace the two existing `assertNoHeadDrift`-via-`extractGitDiff` "refuses to extract" tests in `src/changeset.test.js` (the `describe("extraction fail-closed behavior", ...)` block, tests `"extractGitDiff refuses to extract when the directory's HEAD moved since preDispatchHead, without invoking bwrap"` and `"extractGitDiff proceeds normally when the HEAD re-check itself can't resolve (git failure)"`) will be rewritten in Task 2 once `extractGitDiff`'s contract actually changes. For this task, add a standalone `describe("detectHeadDrift()", ...)` block directly testing the new pure function, above the `describe("extractGitDiff()", ...)` block:

```js
import { overlayPaths, subOverlaySlug, extractGitDiff, resolvePreDispatchHead, buildMergedViewBwrapArgs, extractNonGitDiff, applyChangeset, cleanupOverlay, detectHeadDrift, resolveHeadDrift } from "./changeset.js";
```

```js
describe("detectHeadDrift()", () => {
  test("returns null when current HEAD matches preDispatchHead", () => {
    const runCommand = () => ({ status: 0, stdout: "abc123\n", stderr: "", error: null });
    assert.equal(detectHeadDrift(REPO_DIR, runCommand, PRE_DISPATCH_HEAD), null);
  });

  test("returns {from, to} when current HEAD has moved", () => {
    const runCommand = () => ({ status: 0, stdout: "def456\n", stderr: "", error: null });
    assert.deepEqual(detectHeadDrift(REPO_DIR, runCommand, PRE_DISPATCH_HEAD), { from: PRE_DISPATCH_HEAD, to: "def456" });
  });

  test("returns null (fail-open) when the HEAD check itself is inconclusive", () => {
    const runCommand = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository\n", error: null });
    assert.equal(detectHeadDrift(REPO_DIR, runCommand, PRE_DISPATCH_HEAD), null);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "detectHeadDrift"`
Expected: FAIL — `detectHeadDrift` is not exported yet.

- [ ] **Step 3: Implement `detectHeadDrift`, deleting `assertNoHeadDrift`**

In `src/changeset.js`, replace the whole `assertNoHeadDrift` function (lines 92-114) with:

```js
/**
 * Detects whether `directory`'s current HEAD has confirmably moved away from
 * `preDispatchHead`. Returns `null` when there's no confirmed drift — either
 * HEAD still matches, or the check itself was inconclusive (a git failure, a
 * non-git target) — deliberately fail-open on the inconclusive case, same as
 * this replaced `assertNoHeadDrift`'s behavior. Unlike that function, this
 * never throws: taskferry#XXX changed drift from a fatal abort into
 * something `extractGitDiff` resolves via a real 3-way apply instead (see
 * `resolveHeadDrift`).
 * @param {string} directory
 * @param {typeof defaultRunCommand} runCommand
 * @param {string} preDispatchHead
 * @returns {{from: string, to: string} | null}
 */
function detectHeadDrift(directory, runCommand, preDispatchHead) {
  const currentHead = resolvePreDispatchHead(directory, runCommand);
  if (currentHead !== null && currentHead !== preDispatchHead) {
    return { from: preDispatchHead, to: currentHead };
  }
  return null;
}
```

Do not export it yet from the module's public surface beyond what's needed — it's consumed internally by `extractGitDiff` (Task 2). Leave it as a plain (non-`export`ed) function for now; Task 2's tests reach it only through `extractGitDiff`. (The `describe("detectHeadDrift()", ...)` block added in Step 1 does need it exported, so mark it `export function detectHeadDrift(...)`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "detectHeadDrift"`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/changeset.js src/changeset.test.js
git commit -m "refactor(changeset): replace throwing assertNoHeadDrift with detectHeadDrift"
```

---

## Task 2: `resolveHeadDrift` — disposable-worktree 3-way probe

**Files:**
- Modify: `src/changeset.js` (add `resolveHeadDrift` plus small helpers, after `detectHeadDrift`)
- Test: `src/changeset.test.js`

**Interfaces:**
- Consumes: `defaultRunCommand` (existing), `detectHeadDrift` (Task 1)
- Produces: `export function resolveHeadDrift({directory, diffPath, currentHead, scratchDir, runCommand}): {recovered: boolean|null, conflictDetail: string|null}` — `recovered: true` = clean 3-way merge; `false` = genuine conflict; `null` = could not evaluate (the `git worktree add` itself failed). `conflictDetail` is `null` only when `recovered: true`.

- [ ] **Step 1: Write the failing tests**

Add to `src/changeset.test.js`, after the `detectHeadDrift()` block:

```js
describe("resolveHeadDrift()", () => {
  const CURRENT_HEAD = "def456";
  const SCRATCH_DIR = "/tmp/taskferry-stale-base-scratch";

  test("recovered: true on a clean 3-way merge (add, apply, status, remove all succeed with no conflict markers)", () => {
    const calls = [];
    const runCommand = (command, args) => {
      calls.push(args.join(" "));
      if (args.includes("add")) return { status: 0, stdout: "", stderr: "", error: null };
      if (args.includes("apply")) return { status: 0, stdout: "", stderr: "", error: null };
      if (args.includes("status")) return { status: 0, stdout: "", stderr: "", error: null };
      if (args.includes("remove")) return { status: 0, stdout: "", stderr: "", error: null };
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };
    const result = resolveHeadDrift({ directory: REPO_DIR, diffPath: DIFF_PATCH, currentHead: CURRENT_HEAD, scratchDir: SCRATCH_DIR, runCommand });
    assert.deepEqual(result, { recovered: true, conflictDetail: null });
    assert.ok(calls.some((c) => c === `worktree add --detach ${SCRATCH_DIR} ${CURRENT_HEAD}`));
    assert.ok(calls.some((c) => c === `apply --3way ${DIFF_PATCH}`));
    assert.ok(calls.some((c) => c === "status --porcelain"));
    assert.ok(calls.some((c) => c === `worktree remove --force ${SCRATCH_DIR}`));
  });

  test("recovered: false on a genuine conflict (apply exits non-zero and status reports UU)", () => {
    const runCommand = (_command, args) => {
      if (args.includes("add")) return { status: 0, stdout: "", stderr: "", error: null };
      if (args.includes("apply")) return { status: 1, stdout: "", stderr: "Applied patch to 'f.txt' with conflicts.\n", error: null };
      if (args.includes("status")) return { status: 0, stdout: "UU f.txt\n", stderr: "", error: null };
      if (args.includes("remove")) return { status: 0, stdout: "", stderr: "", error: null };
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };
    const result = resolveHeadDrift({ directory: REPO_DIR, diffPath: DIFF_PATCH, currentHead: CURRENT_HEAD, scratchDir: SCRATCH_DIR, runCommand });
    assert.equal(result.recovered, false);
    assert.match(result.conflictDetail, /conflicts/);
  });

  test("recovered: false when status reports conflict markers even though apply's own exit code was 0", () => {
    // Defensive: pin the check on git status --porcelain, not solely on
    // apply's exit code, since --3way's exit-code semantics are exactly
    // what the spec's --check correction warns not to trust blindly.
    const runCommand = (_command, args) => {
      if (args.includes("add")) return { status: 0, stdout: "", stderr: "", error: null };
      if (args.includes("apply")) return { status: 0, stdout: "", stderr: "", error: null };
      if (args.includes("status")) return { status: 0, stdout: "AA g.txt\n", stderr: "", error: null };
      if (args.includes("remove")) return { status: 0, stdout: "", stderr: "", error: null };
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };
    const result = resolveHeadDrift({ directory: REPO_DIR, diffPath: DIFF_PATCH, currentHead: CURRENT_HEAD, scratchDir: SCRATCH_DIR, runCommand });
    assert.equal(result.recovered, false);
  });

  test("recovered: null when git worktree add itself fails (no apply attempted, could not evaluate)", () => {
    let applyAttempted = false;
    const runCommand = (_command, args) => {
      if (args.includes("add")) return { status: 128, stdout: "", stderr: "fatal: could not create work tree dir\n", error: null };
      if (args.includes("apply")) applyAttempted = true;
      return { status: 0, stdout: "", stderr: "", error: null };
    };
    const result = resolveHeadDrift({ directory: REPO_DIR, diffPath: DIFF_PATCH, currentHead: CURRENT_HEAD, scratchDir: SCRATCH_DIR, runCommand });
    assert.equal(result.recovered, null);
    assert.match(result.conflictDetail, /could not create work tree dir/);
    assert.equal(applyAttempted, false, "must never attempt the apply once worktree add has failed");
  });

  test("always runs worktree remove, even after a genuine conflict", () => {
    let removeRan = false;
    const runCommand = (_command, args) => {
      if (args.includes("add")) return { status: 0, stdout: "", stderr: "", error: null };
      if (args.includes("apply")) return { status: 1, stdout: "", stderr: "conflict\n", error: null };
      if (args.includes("status")) return { status: 0, stdout: "UU f.txt\n", stderr: "", error: null };
      if (args.includes("remove")) { removeRan = true; return { status: 0, stdout: "", stderr: "", error: null }; }
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };
    resolveHeadDrift({ directory: REPO_DIR, diffPath: DIFF_PATCH, currentHead: CURRENT_HEAD, scratchDir: SCRATCH_DIR, runCommand });
    assert.equal(removeRan, true);
  });

  test("the live directory is only ever read (worktree add's source), never written -- apply/status/remove all target scratchDir, not directory", () => {
    const targets = [];
    const runCommand = (_command, args) => {
      if (args.includes("apply") || args.includes("status")) targets.push(args[1]);
      if (args.includes("add")) return { status: 0, stdout: "", stderr: "", error: null };
      return { status: 0, stdout: "", stderr: "", error: null };
    };
    resolveHeadDrift({ directory: REPO_DIR, diffPath: DIFF_PATCH, currentHead: CURRENT_HEAD, scratchDir: SCRATCH_DIR, runCommand });
    assert.deepEqual(targets, [SCRATCH_DIR, SCRATCH_DIR]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern "resolveHeadDrift"`
Expected: FAIL — `resolveHeadDrift` is not exported yet.

- [ ] **Step 3: Implement `resolveHeadDrift`**

In `src/changeset.js`, add after `detectHeadDrift`:

```js
// Matches a `git status --porcelain` line for any unmerged path (both
// added, both deleted, or one/both sides modified) -- the exact signature
// the spec's --check correction says is the only trustworthy way to detect
// a real conflict, since --3way --check's own exit code can't be trusted
// (see the spec's "A --check correction" section).
const CONFLICT_STATUS_PATTERN = /^(?:UU|AA|DD|AU|UD|UA|DU) /m;

/**
 * Probes whether `diffPath` (already extracted, anchored on the original
 * preDispatchHead) would forward-apply cleanly onto `currentHead` via a real
 * `git apply --3way` -- never `--check`, which cannot distinguish a clean
 * merge from a real conflict (spec "A `--check` correction"). Runs entirely
 * inside a disposable detached worktree created off the live `directory`;
 * `directory` itself is only ever read (as `worktree add`'s source) and is
 * removed unconditionally afterward, whether the merge succeeded or not.
 * @param {object} params
 * @param {string} params.directory - live directory; read-only source for the scratch worktree
 * @param {string} params.diffPath
 * @param {string} params.currentHead
 * @param {string} params.scratchDir
 * @param {typeof defaultRunCommand} [params.runCommand]
 * @returns {{recovered: boolean|null, conflictDetail: string|null}}
 */
export function resolveHeadDrift({ directory, diffPath, currentHead, scratchDir, runCommand = defaultRunCommand }) {
  const add = runCommand("git", ["-C", directory, "worktree", "add", "--detach", scratchDir, currentHead]);
  if (add.error || add.status !== 0) {
    return { recovered: null, conflictDetail: `could not evaluate: ${gitApplyFailureReason(add)}` };
  }
  const apply = runCommand("git", ["-C", scratchDir, "apply", "--3way", diffPath]);
  const statusResult = runCommand("git", ["-C", scratchDir, "status", "--porcelain"]);
  // Unconditional cleanup regardless of outcome; a failed removal doesn't
  // change the merge outcome already computed above (it's a best-effort
  // tidy-up of a throwaway worktree, same class as cleanupOverlay's own
  // best-effort semantics elsewhere in this file).
  runCommand("git", ["-C", directory, "worktree", "remove", "--force", scratchDir]);
  const hasConflictMarkers = CONFLICT_STATUS_PATTERN.test(statusResult.stdout || "");
  if (!apply.error && apply.status === 0 && !hasConflictMarkers) {
    return { recovered: true, conflictDetail: null };
  }
  return { recovered: false, conflictDetail: gitApplyFailureReason(apply) || statusResult.stdout.trim() || null };
}
```

`gitApplyFailureReason` already exists lower in the file (used by `applyGitChangeset`) — no new helper needed for that part. Since `resolveHeadDrift` is defined above `gitApplyFailureReason`'s current position, either move `gitApplyFailureReason` above `resolveHeadDrift` or rely on function hoisting (both are `function` declarations, so hoisting already makes this safe — no reordering required).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "resolveHeadDrift"`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/changeset.js src/changeset.test.js
git commit -m "feat(changeset): add resolveHeadDrift disposable-worktree 3-way probe"
```

---

## Task 3: Wire `detectHeadDrift`/`resolveHeadDrift` into `extractGitDiff`

**Files:**
- Modify: `src/changeset.js:165-209` (`extractGitDiff`)
- Test: `src/changeset.test.js`

**Interfaces:**
- Consumes: `detectHeadDrift` (Task 1), `resolveHeadDrift` (Task 2)
- Produces: `extractGitDiff(...)` now returns `{diffPath, hasChanges, headDrift: null | {from: string, to: string, recovered: boolean|null, conflictDetail: string|null}}` and **never throws on drift** — only on a real bwrap/extraction failure, unchanged from today.

- [ ] **Step 1: Write the failing tests**

In `src/changeset.test.js`, replace the two drift-throwing tests in `describe("extraction fail-closed behavior", ...)`:

Delete:
- `"extractGitDiff refuses to extract when the directory's HEAD moved since preDispatchHead, without invoking bwrap"`
- `"extractGitDiff proceeds normally when the HEAD re-check itself can't resolve (git failure)"`
- `"extractGitDiff re-checks HEAD after the retry loop and refuses to write a diff that drifted mid-backoff"` (taskferry#329 test — the *behavior* it pinned, "don't silently write a diff anchored on a drifted HEAD," no longer applies: drift is now resolved, not silently ignored. Replace it per below.)

Replace with:

```js
  test("extractGitDiff proceeds through bwrap and writes the diff even when HEAD has drifted, reporting headDrift instead of throwing", () => {
    let bwrapCalled = false;
    let written = null;
    const runCommand = (command, args) => {
      if (command === "git") {
        if (args.includes("rev-parse")) return { status: 0, stdout: "def456\n", stderr: "", error: null };
        if (args.includes("worktree") && args.includes("add")) return { status: 0, stdout: "", stderr: "", error: null };
        if (args.includes("apply")) return { status: 0, stdout: "", stderr: "", error: null };
        if (args.includes("status")) return { status: 0, stdout: "", stderr: "", error: null };
        if (args.includes("remove")) return { status: 0, stdout: "", stderr: "", error: null };
        throw new Error(`unexpected git invocation: ${args.join(" ")}`);
      }
      bwrapCalled = true;
      return { status: 0, stdout: SAMPLE_DIFF_X, stderr: "", error: null };
    };
    const result = extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: (p, c) => { written = { p, c }; }, mkdirFn: () => {} });
    assert.equal(bwrapCalled, true, "extraction must still run against a drifted directory, not abort");
    assert.deepEqual(written, { p: DIFF_PATCH, c: SAMPLE_DIFF_X });
    assert.deepEqual(result.headDrift, { from: PRE_DISPATCH_HEAD, to: "def456", recovered: true, conflictDetail: null });
  });

  test("extractGitDiff reports headDrift.recovered: false for a genuine conflicting drift", () => {
    const runCommand = (command, args) => {
      if (command === "git") {
        if (args.includes("rev-parse")) return { status: 0, stdout: "def456\n", stderr: "", error: null };
        if (args.includes("worktree") && args.includes("add")) return { status: 0, stdout: "", stderr: "", error: null };
        if (args.includes("apply")) return { status: 1, stdout: "", stderr: "conflict\n", error: null };
        if (args.includes("status")) return { status: 0, stdout: "UU f.txt\n", stderr: "", error: null };
        if (args.includes("remove")) return { status: 0, stdout: "", stderr: "", error: null };
        throw new Error(`unexpected git invocation: ${args.join(" ")}`);
      }
      return { status: 0, stdout: SAMPLE_DIFF_X, stderr: "", error: null };
    };
    const result = extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: () => {}, mkdirFn: () => {} });
    assert.equal(result.headDrift.recovered, false);
    assert.match(result.headDrift.conflictDetail, /conflict/);
  });

  test("extractGitDiff reports headDrift: null when the HEAD re-check itself can't resolve (git failure)", () => {
    let capturedArgs = null;
    const runCommand = (command, args) => {
      if (command === "git") return { status: 128, stdout: "", stderr: "fatal: not a git repository\n", error: null };
      capturedArgs = args;
      return { status: 0, stdout: SAMPLE_DIFF_X, stderr: "", error: null };
    };
    const result = extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: () => {}, mkdirFn: () => {} });
    assert.ok(capturedArgs, "bwrap must still run when the HEAD re-check is inconclusive");
    assert.equal(result.headDrift, null);
  });

  test("extractGitDiff reports headDrift: null when HEAD has not moved (today's normal path)", () => {
    const runCommand = (command, args) => {
      if (command === "git") return { status: 0, stdout: "abc123\n", stderr: "", error: null };
      return { status: 0, stdout: SAMPLE_DIFF_X, stderr: "", error: null };
    };
    const result = extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: () => {}, mkdirFn: () => {} });
    assert.equal(result.headDrift, null);
  });
```

Also update the still-passing `"remounts the overlay and runs a stage-diff-reset script..."` and `"reports hasChanges: false for an empty diff"` tests (both mock `command === "git"` to return `{stdout: "abc123\n"}` for every git call) — no change needed there since `detectHeadDrift`'s single call also returns `"abc123\n"`, matching `preDispatchHead` (no drift). Confirm by reading them; if any test's `runCommand` distinguishes git calls by call count assuming exactly one `git rev-parse` invocation (the old pre-retry check), that assumption is now correct on its own — Task 3 only ever issues *one* `git rev-parse` call (this task removes the pre-retry check).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern "extractGitDiff"`
Expected: FAIL — old drift tests removed/replaced don't match current throwing behavior yet; new tests fail because `headDrift` isn't returned yet.

- [ ] **Step 3: Rewire `extractGitDiff`**

In `src/changeset.js`, add `import os from "node:os";` to the top-of-file imports (alongside the existing `crypto`/`fs`/`path` imports).

Replace the body of `extractGitDiff` (lines 165-209) with:

```js
export function extractGitDiff({
  directory,
  overlay,
  overlayRwBinds,
  overlayRwFileBinds = [],
  preDispatchHead,
  stateDir,
  runtimeDir,
  homeDir,
  denyList,
  diffPath,
  runCommand = defaultRunCommand,
  writeFileFn = (filePath, content) => fs.writeFileSync(filePath, content, { mode: 0o600 }),
  mkdirFn = (dirPath) => fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 }),
  sleepFn = sleepSync,
  scratchDirFn = () => path.join(os.tmpdir(), `taskferry-stale-base-${crypto.randomUUID()}`),
}) {
  const bwrapArgs = buildBwrapArgs({ directory, stateDir, runtimeDir, homeDir, denyList, overlay, overlayRwBinds, overlayRwFileBinds });
  // The final `exit $rc` propagates the diff's own status: the previous
  // `; git reset` tail made the whole script exit with reset's status, so a
  // failed diff still reported success. reset runs first regardless (undo
  // the transient staging -- the upper already captured everything), then
  // the shell exits with the diff's code.
  const script = `git -C ${shQuote(directory)} add -A && { git -C ${shQuote(directory)} diff --cached ${shQuote(preDispatchHead)}; rc=$?; git -C ${shQuote(directory)} reset > /dev/null 2>&1; exit $rc; }`;
  const result = runExtractionBwrap(runCommand, [...bwrapArgs, "--", "sh", "-c", script], sleepFn);
  if (result.error || result.status !== 0) {
    throw new Error(`error: git diff extraction failed for ${directory} (exit ${result.status ?? "null"}): ${(result.stderr || result.error?.message || "unknown error").trim()}`);
  }
  mkdirFn(pathDirname(diffPath));
  writeFileFn(diffPath, result.stdout);
  // Extraction always completes and the diff is always written -- nothing
  // about the diff's content depends on live HEAD (see the module-level
  // "key insight" comment below `resolveHeadDrift`). A drift, if any, is
  // resolved here rather than aborting: a stale-base diff is still valid
  // content, `git apply --3way` exists precisely to forward-apply it.
  const drift = detectHeadDrift(directory, runCommand, preDispatchHead);
  let headDrift = null;
  if (drift) {
    const { recovered, conflictDetail } = resolveHeadDrift({ directory, diffPath, currentHead: drift.to, scratchDir: scratchDirFn(), runCommand });
    headDrift = { from: drift.from, to: drift.to, recovered, conflictDetail };
  }
  return { diffPath, hasChanges: result.stdout.trim().length > 0, headDrift };
}
```

Update the function's JSDoc (`@returns`) above it to:

```js
 * @returns {{diffPath: string, hasChanges: boolean, headDrift: null | {from: string, to: string, recovered: boolean|null, conflictDetail: string|null}}}
```

and add `@param {() => string} [params.scratchDirFn]` to the param list.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "extractGitDiff|extraction fail-closed"`
Expected: PASS — all extraction tests, including the overlay-mount-busy retry tests (unaffected: they never reach the drift-detection code because their `runCommand` always returns `"abc123\n"` for git calls, matching `preDispatchHead`).

Run the full changeset unit suite to catch any other regressions:
Run: `npm test -- src/changeset.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/changeset.js src/changeset.test.js
git commit -m "feat(changeset): extractGitDiff resolves HEAD drift via 3-way instead of aborting"
```

---

## Task 4: `accept` always uses `git apply --3way`

**Files:**
- Modify: `src/changeset.js` (`applyGitChangeset`)
- Test: `src/changeset.test.js`

**Interfaces:**
- Produces: `applyGitChangeset` now runs `git -C <directory> apply --3way <diffPath>` unconditionally (drifted or not).

- [ ] **Step 1: Write the failing test**

In `src/changeset.test.js`, update the existing test in `describe("applyChangeset()", ...)`:

```js
  test("git target: runs git apply --3way <diffPath> against directory", () => {
    let capturedCommand = null;
    let capturedArgs = null;
    const runCommand = (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return { status: 0, stdout: "", stderr: "", error: null };
    };
    const result = applyChangeset({
      directory: REPO_DIR,
      diffPath: DIFF_PATCH,
      isGitTarget: true,
      runCommand,
    });
    assert.equal(capturedCommand, GIT_CMD);
    assert.deepEqual(capturedArgs, ["-C", REPO_DIR, "apply", "--3way", DIFF_PATCH]);
    assert.deepEqual(result, { applied: true, reason: null });
  });
```

(Only the test name and the `assert.deepEqual(capturedArgs, ...)` line change — everything else in the block is identical.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern "git target: runs git apply"`
Expected: FAIL — actual args are `["-C", REPO_DIR, "apply", DIFF_PATCH]`, missing `--3way`.

- [ ] **Step 3: Implement the flag switch**

In `src/changeset.js`, in `applyGitChangeset`:

```js
function applyGitChangeset({ directory, diffPath, runCommand }) {
  const result = runCommand("git", ["-C", directory, "apply", "--3way", diffPath]);
  if (result.status !== 0) {
    return { applied: false, reason: gitApplyFailureReason(result) };
  }
  return { applied: true, reason: null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/changeset.test.js`
Expected: PASS, all tests (including the sibling "surfaces git apply's stderr as the failure reason on conflict" test, unaffected — it doesn't assert on args).

- [ ] **Step 5: Commit**

```bash
git add src/changeset.js src/changeset.test.js
git commit -m "fix(changeset): accept always applies with git apply --3way"
```

---

## Task 5: Settle `headDrift` into `changesetStatus` at task-finish time

**Files:**
- Modify: `src/tasks.js:29-96` (typedefs), `src/tasks.js:1499-1520` (`computeResultDetail`), `src/tasks.js:2445-2450` (`summarizeChangesetFields`), `src/tasks.js:4300-4370` (`extractChangesetForTaskRecord`)
- Test: `src/tasks.changeset.test.js`

**Interfaces:**
- Consumes: `extracted.headDrift` from `extractGitDiff` (Task 3)
- Produces: `task.headDriftFrom`/`task.headDriftTo`/`task.headDriftRecovered` (stamped whenever `headDrift` was non-null), surfaced through `mgr.status()`/`mgr.result()`.

- [ ] **Step 1: Write the failing tests**

Add to `src/tasks.changeset.test.js`, inside `describe("changeset extraction at settlement", ...)`, after the existing `"records extraction errors and keeps the overlay for recovery"` test:

```js
  test("a recovered stale-base drift settles pending (git target) as normal and stamps audit fields", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-drift-recovered-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-drift-recovered-tmp-"));
    let child;
    const mgr = makeManager({
      spawnFn: (_cmd, _args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: (command, args) => {
        if (command === "bwrap") return { status: 0, stdout: DIFF_LINE, stderr: "" };
        if (args.includes("rev-parse")) return { status: 0, stdout: "def456\n", stderr: "" };
        if (args.includes("worktree") && args.includes("add")) return { status: 0, stdout: "", stderr: "" };
        if (args.includes("apply")) return { status: 0, stdout: "", stderr: "" };
        if (args.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (args.includes("worktree") && args.includes("remove")) return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected git invocation: ${args.join(" ")}`);
      },
      overlayTmpRoot,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const status = mgr.status(result.id);
    assert.equal(status.changesetStatus, "pending", "a recovered drift is not a rejection -- it's a normal pending changeset");
    assert.equal(status.headDriftRecovered, true);
    assert.ok(status.headDriftFrom);
    assert.equal(status.headDriftTo, "def456");
  });

  test("an unrecovered (genuinely conflicting) stale-base drift auto-rejects and releases the overlay", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-drift-conflict-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-drift-conflict-tmp-"));
    let cleanedRoot = null;
    let child;
    const mgr = makeManager({
      spawnFn: (_cmd, _args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: (command, args) => {
        if (command === "bwrap") return { status: 0, stdout: DIFF_LINE, stderr: "" };
        if (args.includes("rev-parse")) return { status: 0, stdout: "def456\n", stderr: "" };
        if (args.includes("worktree") && args.includes("add")) return { status: 0, stdout: "", stderr: "" };
        if (args.includes("apply")) return { status: 1, stdout: "", stderr: "Applied patch to 'f.txt' with conflicts.\n" };
        if (args.includes("status")) return { status: 0, stdout: "UU f.txt\n", stderr: "" };
        if (args.includes("worktree") && args.includes("remove")) return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected git invocation: ${args.join(" ")}`);
      },
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
      overlayTmpRoot,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const status = mgr.status(result.id);
    assert.equal(status.changesetStatus, "rejected");
    assert.match(status.changesetError, /conflicts/);
    assert.equal(status.headDriftRecovered, false);
    assert.ok(cleanedRoot, "the overlay must be released -- nothing left to accept on an unrecovered drift");
  });

  test("a drift the scratch-worktree probe could not evaluate (git worktree add failure) settles pending with the infra failure recorded", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-drift-noeval-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-drift-noeval-tmp-"));
    let child;
    const mgr = makeManager({
      spawnFn: (_cmd, _args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: (command, args) => {
        if (command === "bwrap") return { status: 0, stdout: DIFF_LINE, stderr: "" };
        if (args.includes("rev-parse")) return { status: 0, stdout: "def456\n", stderr: "" };
        if (args.includes("worktree") && args.includes("add")) return { status: 128, stdout: "", stderr: "fatal: could not create work tree dir\n" };
        throw new Error(`unexpected git invocation: ${args.join(" ")}`);
      },
      overlayTmpRoot,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const status = mgr.status(result.id);
    assert.equal(status.changesetStatus, "pending", "an inconclusive probe must never be silently assumed clean or auto-rejected");
    assert.match(status.changesetError, /could not evaluate/);
    assert.equal(status.headDriftRecovered, null);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern "stale-base drift|drift the scratch-worktree"`
Expected: FAIL — `headDrift` isn't read by `extractChangesetForTaskRecord` yet, so `changesetStatus`/`headDriftRecovered` won't match.

- [ ] **Step 3: Extend the `Task`/`TaskSummary`/`ResultDetail` typedefs**

In `src/tasks.js`, add these three lines after `@property {string|null} [changesetError]` in **both** the `Task` typedef block (around line 61) and the `TaskSummary` typedef block (around line 95):

```js
 * @property {string|null} [headDriftFrom]
 * @property {string|null} [headDriftTo]
 * @property {boolean|null} [headDriftRecovered]
```

Add the same three lines to the `ResultDetail` typedef (around line 163, after `@property {string|null} [changesetError]`).

- [ ] **Step 4: Update `extractChangesetForTaskRecord`**

In `src/tasks.js`, replace the tail of `extractChangesetForTaskRecord` (from `finishedTask.diffPath = extracted.diffPath;` through the end of the function, currently lines 4359-4370) with:

```js
  finishedTask.diffPath = extracted.diffPath;
  finishedTask.changesetError = null;
  if (extracted.headDrift) {
    finishedTask.headDriftFrom = extracted.headDrift.from;
    finishedTask.headDriftTo = extracted.headDrift.to;
    finishedTask.headDriftRecovered = extracted.headDrift.recovered;
  }
  if (finishedTask.role === "advisor") {
    finishedTask.changesetStatus = "rejected";
    ctx.releaseOverlay(finishedTask);
  } else if (extracted.headDrift?.recovered === false) {
    // A genuine conflict: the 3-way probe already proved this changeset is
    // DOA against the directory's current HEAD -- reject outright rather
    // than leave "pending" and force a human to run accept just to
    // discover the same conflict git apply --3way would report anyway.
    finishedTask.changesetStatus = "rejected";
    finishedTask.changesetError = extracted.headDrift.conflictDetail;
    ctx.releaseOverlay(finishedTask);
  } else if (extracted.headDrift?.recovered === null) {
    // Could not evaluate (the scratch-worktree probe's own git plumbing
    // failed) -- never silently assumed clean. Falls into the same
    // pending + changesetError shape as a real extraction error, which is
    // exactly what taskferry accept already knows how to report.
    finishedTask.changesetStatus = "pending";
    finishedTask.changesetError = extracted.headDrift.conflictDetail;
  } else if (extracted.hasChanges) {
    finishedTask.changesetStatus = "pending";
  } else {
    finishedTask.changesetStatus = "accepted";
    ctx.releaseOverlay(finishedTask);
  }
}
```

(`extracted.headDrift?.recovered === true` and `extracted.headDrift === null` both fall through unchanged to the existing `hasChanges`/no-changes branches, exactly matching the spec's settlement table.)

- [ ] **Step 5: Surface the new fields through `summarize()` and `result()`**

In `src/tasks.js`, update `summarizeChangesetFields` (around line 2445):

```js
function summarizeChangesetFields(task) {
  const { changesetStatus, role, headDriftFrom, headDriftTo, headDriftRecovered } = task;
  const base = changesetStatus != null && (changesetStatus !== "none" || role === "advisor")
    ? { role, changesetStatus }
    : {};
  return headDriftFrom != null ? { ...base, headDriftFrom, headDriftTo, headDriftRecovered } : base;
}
```

In `computeResultDetail` (around line 1508, right after the `changesetError: task.changesetError ?? null,` line), add:

```js
    ...(task.headDriftFrom != null ? { headDriftFrom: task.headDriftFrom, headDriftTo: task.headDriftTo, headDriftRecovered: task.headDriftRecovered } : {}),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "stale-base drift|drift the scratch-worktree"`
Expected: PASS (3 new tests)

Run the full existing changeset-settlement suite to catch regressions from the branch reordering:
Run: `npm test -- src/tasks.changeset.test.js`
Expected: PASS, all tests (including the untouched advisor/zero-change/cancel/extraction-error tests above — none of them produce a `headDrift`, so they fall straight through the new conditions unchanged).

- [ ] **Step 7: Run the full unit test suite**

Run: `npm test`
Expected: PASS, no regressions anywhere else in the suite (typecheck included, if `npm test` runs it — otherwise run `npm run typecheck` separately per this repo's usual verification step).

- [ ] **Step 8: Commit**

```bash
git add src/tasks.js src/tasks.changeset.test.js
git commit -m "feat(tasks): settle recovered/conflicting/inconclusive stale-base drift honestly"
```

---

## Task 6: Real-git integration coverage for the drift scenarios

**Files:**
- Modify: `src/changeset.integration.test.js`

**Interfaces:**
- Consumes: `resolveHeadDrift`, `extractGitDiff` (both now exported from `src/changeset.js`)

- [ ] **Step 1: Write the integration tests**

Add to `src/changeset.integration.test.js`, after the existing `describe("overlay round trips (real bwrap)", ...)` block (before the final `});` closing the file... actually as a new top-level `describe` block, so add it right after that block's closing `});` at the end of the file):

```js
import { resolveHeadDrift } from "./changeset.js";

// resolveHeadDrift needs no bwrap at all (it operates on the live directory
// via plain `git worktree`/`apply`, never a sandbox) -- gate only on git
// being present, so this coverage runs everywhere, not just on hosts with a
// working overlay stack. This is the exact repro that caught the --check
// false-clean bug while grounding the spec (see the spec's "A --check
// correction" section) -- kept here as regression coverage against a future
// git version changing --3way --check semantics again.
describe("resolveHeadDrift() (real git, no bwrap required)", () => {
  function initRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-drift-repo-"));
    spawnSync("git", ["init", "-q", dir]);
    fs.writeFileSync(path.join(dir, "line2.txt"), "line1\nline2\nline3\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "base"]);
    return dir;
  }

  test("non-conflicting drift: target changes a different file, patch merges cleanly", () => {
    const dir = initRepo();
    const base = resolvePreDispatchHead(dir);
    // Simulate the worker's isolated diff: line2.txt's line2 changed, saved
    // as a patch anchored on `base`, computed independently of dir's later
    // history (mirrors what extractGitDiff would have produced).
    spawnSync("git", ["-C", dir, "checkout", "-q", "-b", "worker-sim"]);
    fs.writeFileSync(path.join(dir, "line2.txt"), "line1\nWORKER-CHANGED\nline3\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "worker"]);
    const diff = spawnSync("git", ["-C", dir, "diff", base, "worker-sim"], { encoding: "utf8" }).stdout;
    const diffPath = path.join(dir, "..", "worker.patch");
    fs.writeFileSync(diffPath, diff);
    spawnSync("git", ["-C", dir, "checkout", "-q", "main", "--", "."]);
    spawnSync("git", ["-C", dir, "branch", "-q", "-D", "worker-sim"]);

    // Directory independently advances on a DIFFERENT file.
    fs.writeFileSync(path.join(dir, "other.txt"), "unrelated\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "unrelated"]);
    const currentHead = resolvePreDispatchHead(dir);

    const scratchDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "axi-drift-scratch-")), "wt");
    const result = resolveHeadDrift({ directory: dir, diffPath, currentHead, scratchDir });
    assert.deepEqual(result, { recovered: true, conflictDetail: null });
    assert.equal(fs.existsSync(scratchDir), false, "the scratch worktree must be removed after evaluation");
  });

  test("genuine conflict: target changes the same line the patch touches", () => {
    const dir = initRepo();
    const base = resolvePreDispatchHead(dir);
    spawnSync("git", ["-C", dir, "checkout", "-q", "-b", "worker-sim"]);
    fs.writeFileSync(path.join(dir, "line2.txt"), "line1\nWORKER-CHANGED\nline3\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "worker"]);
    const diff = spawnSync("git", ["-C", dir, "diff", base, "worker-sim"], { encoding: "utf8" }).stdout;
    const diffPath = path.join(dir, "..", "worker-conflict.patch");
    fs.writeFileSync(diffPath, diff);
    spawnSync("git", ["-C", dir, "checkout", "-q", "main", "--", "."]);
    spawnSync("git", ["-C", dir, "branch", "-q", "-D", "worker-sim"]);

    // Directory independently changes the SAME line -- a real conflict.
    fs.writeFileSync(path.join(dir, "line2.txt"), "line1\nTARGET-CHANGED\nline3\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "conflicting"]);
    const currentHead = resolvePreDispatchHead(dir);

    const scratchDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "axi-drift-scratch-")), "wt");
    const result = resolveHeadDrift({ directory: dir, diffPath, currentHead, scratchDir });
    assert.equal(result.recovered, false);
    assert.ok(result.conflictDetail);
    assert.equal(fs.existsSync(scratchDir), false, "the scratch worktree must be removed even after a conflict");
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `npm test -- --test-name-pattern "resolveHeadDrift.*real git"`
Expected: PASS — both scenarios exercise real `git worktree`/`git apply --3way`/`git status --porcelain`, no mocks.

- [ ] **Step 3: Run the full integration suite**

Run: `npm test -- src/changeset.integration.test.js`
Expected: PASS (existing bwrap-gated tests still pass or skip per host capability, unaffected by this addition; the two new tests run unconditionally since they need no bwrap).

- [ ] **Step 4: Commit**

```bash
git add src/changeset.integration.test.js
git commit -m "test(changeset): real-git integration coverage for stale-base 3-way resolution"
```

---

## Task 7: Sourcemap refresh and spec archival

**Files:**
- Modify: `docs/sourcemap.md`
- Move: `.superpowers/specs/2026-08-05-stale-base-3way-apply-design.md` → `.superpowers/.completed/specs/2026-08-05-stale-base-3way-apply-design.md`

- [ ] **Step 1: Update `docs/sourcemap.md`**

Find the `changeset.js` and `tasks.js` rows (by filename, in the file-by-file table). Update:
- Line counts to the post-implementation actuals (run `wc -l src/changeset.js src/tasks.js`).
- `changeset.js`'s responsibility text: append a clause noting `extractGitDiff` now resolves HEAD drift via a real (non-`--check`) `git apply --3way` inside a disposable worktree (`resolveHeadDrift`) instead of throwing, and `accept`'s `applyGitChangeset` always uses `--3way`.
- `tasks.js`'s responsibility text (or the changeset-settlement row if there's a dedicated one): note `extractChangesetForTaskRecord` now settles a recovered/conflicting/inconclusive stale-base drift into `pending`/`rejected` with `headDriftFrom`/`headDriftTo`/`headDriftRecovered` stamped for audit.
- If there's a "gotchas that look like bugs but aren't" section, add an entry: *"A changeset landing `pending` even though the dispatch directory's HEAD moved since dispatch isn't a bug -- taskferry#XXX resolves stale-base drift with a real 3-way merge instead of aborting; check `headDriftRecovered` on the task to see whether that merge happened."*

- [ ] **Step 2: Move the spec into `.completed`**

```bash
git mv .superpowers/specs/2026-08-05-stale-base-3way-apply-design.md .superpowers/.completed/specs/2026-08-05-stale-base-3way-apply-design.md
```

- [ ] **Step 3: Commit**

```bash
git add docs/sourcemap.md
git commit -m "docs: refresh sourcemap and archive the stale-base 3-way apply spec"
```

---

## Non-goals (carried over from the spec)

- Non-git-target changesets (`applyNonGitChangeset`'s rsync path) — no drift-abort exists there today, nothing to fix.
- Auto-accepting a recovered changeset — a human still runs `accept`.
- Rewriting `tf_stale_base.py` (fleet-data validation script, lives outside this repo's `src/`) — flagged in the spec as a followup, not part of this change.
- Any change to the `.taskferry.toml` check-gate design — separate, already-written spec.
- `doctor`/CLI surface work beyond what `mgr.status()`/`mgr.result()` already expose via the fields added in Task 5 — a dedicated `doctor` "survived a base drift" rollup is a reasonable followup issue, not required for this plan's correctness goal.

## Self-Review Notes

- **Spec coverage:** Section 1 (extraction proceeds through drift) → Task 3. Section 2 (disposable-worktree probe) → Task 2. The `--check` correction → Task 2's `CONFLICT_STATUS_PATTERN` check (never trusts apply's exit code alone). Section 3 (settlement table) → Task 5. Section 4 (`accept` always `--3way`) → Task 4. Section 5 (non-git reachability) → explicitly a non-goal, no task touches `applyNonGitChangeset`/`extractNonGitDiff`. Error-handling table rows → Task 2/Task 5 (`recovered: null` path) and Task 5's "could not evaluate" test. Testing section → Tasks 1-6 cover unit + the real-git integration fixture; the fleet-data (`tf_stale_base.py`) revalidation step is out of scope per Non-goals.
- **Placeholder scan:** every step above has literal code, no "TBD"/"similar to Task N" placeholders.
- **Type consistency:** `headDrift` shape (`{from, to, recovered, conflictDetail}`) is identical across `resolveHeadDrift`'s return (Task 2), `extractGitDiff`'s return (Task 3), and what `extractChangesetForTaskRecord` reads (Task 5). `headDriftFrom`/`headDriftTo`/`headDriftRecovered` field names are identical across the `Task`/`TaskSummary`/`ResultDetail` typedefs, `summarizeChangesetFields`, and `computeResultDetail` (Task 5).
