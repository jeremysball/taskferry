# CoW Sandbox: PR #251 Review Fix Wave

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 13 CONFIRMED bugs (plus fold in the 4 PLAUSIBLE findings
where they land in the same code) found by the `ferrying-code-review` pass
against PR #251 ("feat(sandbox): copy-on-write overlays and diff-gated
writes"), on branch `worktree-cow-sandbox`, before merging. Full finding
list and PR comments: https://github.com/jeremysball/taskferry/pull/251.

**Context:** This branch already implements the CoW overlay design
(`.superpowers/.completed/plans/2026-07-29-cow-sandbox-design.md` once this
lands — currently still at `.superpowers/plans/2026-07-29-cow-sandbox-design.md`,
marked "done" in its own text, which this review found to be inaccurate).
729 unit tests + 3 real-bwrap integration tests currently pass; every task
below must keep them passing and add covering tests for its own fix.

## Global Constraints

- Run `npm test` (`npm run test:unit`) and `npm run lint` before every
  commit; `npm run typecheck` too if the fix touches JSDoc type shapes.
- Every fix needs a regression test that fails before the fix and passes
  after (`node:test`, matching the existing style in each `*.test.js` file).
- Keep each fix scoped to its own bug. Do not refactor unrelated code, and
  do not touch the 4 already-`.superpowers/plans/2026-07-29-cow-sandbox-design.md`-resolved
  findings from the original design review.
- `src/tasks.js` and `src/changeset.js` are large, shared files — read the
  surrounding function fully before editing, since several fixes below touch
  overlapping helper functions (`cleanupOverlay` call sites especially).
- After the final task, update `docs/sourcemap.md`'s gotchas section for
  `tasks.js`/`changeset.js` if any fix changes a behavior worth flagging
  there (the file-by-file line counts already drift task-to-task; true them
  up once at the end, not per-task).

## Task 1: Close the advisor-overlay security bypass

**Finding:** `src/tasks.js:1826` — the advisor auto-reject-and-cleanup path
in the settlement handler only runs when the task actually has
`overlayDirs` set. When sandboxing is disabled, or overlay support is
unsupported on non-Linux, an advisor task never gets `overlayDirs` in the
first place — so its writes land directly on the real target directory,
contradicting ADR 0001's "an advisor has no path to persist a write."
`docs/adr/0001-cow-overlays-and-diff-gated-writes.md` states this guarantee
explicitly; verify the exact wording before writing the fix.

**Fix:** An advisor dispatch must fail closed, not silently degrade to
unsandboxed writes, whenever overlay-gating can't be established for it —
mirror the existing `role === "advisor"` fail-closed check already present
elsewhere in `tasks.js` (search for "advisor dispatch requires
overlay-gated writes" — the same guarantee needs to hold at
dispatch-launch time, not just at settlement). Confirm sandboxing being
force-disabled (`--no-sandbox` / `TASKFERRY_DISABLE_SANDBOX=1`) and overlay
being unsupported both take this path for an advisor role, with a clear
error message (`taskferry dispatch --role advisor` should fail immediately
rather than silently writing through).

**Test:** a unit test dispatching an advisor-role task with sandboxing
disabled (or overlay support mocked unsupported) must assert the dispatch
throws/rejects rather than launching with a writable bind.

## Task 2: Overlay cleanup/leak cluster (tmpRoot recording + dedup)

Four related findings, all rooted in the same defect: `cleanupOverlay()`'s
containment check is always called with the *live* `overlayTmpRoot` config
value, never the value that was actually in effect when the overlay was
created. Fix the root cause once, then the leak and the duplication both
go away.

**Findings:**
- `src/changeset.js:295` — `cleanupOverlay`'s containment check
  (`resolved.startsWith(path.resolve(tmpRoot) + path.sep)`) is checked
  against whatever `tmpRoot` its caller passes *now*, not the root recorded
  at overlay creation. If `TMPDIR`/`overlayTmpRoot` changes across a daemon
  restart, every existing overlay's path no longer starts with the new
  `tmpRoot`, so `cleanupOverlay` always returns `removed: false` for it —
  permanent overlay leak that a restart never clears.
- `src/tasks.js:913` (`sweepOrphanedOverlays`) — only scans
  `fs.readdirSync(overlayTmpRoot)` (the current config value), so any
  overlay created under a prior `overlayTmpRoot` is invisible to the sweep
  too. Compounds the leak above.
- `src/tasks.js:649` (and four more call sites: `~655`, `~926`, `~2293`,
  `~2315`) — `cleanupOverlay({ root: X.overlayDirs.root, tmpRoot:
  overlayTmpRoot, rmFn: rmOverlayTreeFn })` is duplicated verbatim 5 times
  across the settlement handler, `sweepOrphanedOverlays`, `accept()`, and
  `reject()`. `cleanupFailed` tracking around it has already diverged
  between call sites (some assign `finishedTask.overlayDirs = null` only
  from `removal.removed`, others track a `cleanupFailed` return value —
  check each site's actual current behavior before consolidating, so the
  refactor doesn't change any site's externally-visible behavior beyond the
  bug fix itself).
- `src/tasks.js:538` — the default `rmOverlayTreeFn = (p) => fs.rmSync(p, {
  recursive: true, force: true })` bypasses the EACCES handling that
  `a8c81c3` already added to `changeset.js`'s own default `rmFn` (the
  `spawnSync("rm", ["-rf", p])` with an error thrown on non-zero exit, see
  `cleanupOverlay`'s JSDoc). Because `tasks.js` always passes its *own*
  `rmOverlayTreeFn` as the `rmFn` override, `cleanupOverlay`'s better
  default in `changeset.js` never actually runs in the real dispatch path
  — the EACCES fix landed on dead code. Fix `tasks.js`'s default
  `rmOverlayTreeFn` to match (or delegate to) `changeset.js`'s handled
  version, or drop the `tasks.js`-level override entirely and let
  `cleanupOverlay`'s own default apply.

**Fix:**
1. Record the `overlayTmpRoot` in effect at creation time onto the task —
   add a `tmpRoot` field alongside `root`/`upperDir`/`workDir`/`rwBinds` in
   the `overlayDirs` object built at `src/tasks.js:1896`.
2. Add a single helper (e.g. `releaseOverlay(task)`) in `tasks.js` that
   calls `cleanupOverlay({ root: task.overlayDirs.root, tmpRoot:
   task.overlayDirs.tmpRoot, rmFn: rmOverlayTreeFn })` and applies whatever
   the correct/consolidated `cleanupFailed`-tracking behavior is (per the
   investigation above). Replace all 5 call sites with it.
3. Fix `rmOverlayTreeFn`'s default to handle EACCES the same way
   `changeset.js`'s own default `rmFn` does (real fix, not dead code).
4. `sweepOrphanedOverlays()`: since a task's own recorded `tmpRoot` may
   differ from the live `overlayTmpRoot`, sweep every distinct `tmpRoot`
   that appears on any task with a still-set `overlayDirs`, plus the live
   `overlayTmpRoot`, deduped — not just the live one.

**Test:** a unit test that creates an overlay, changes the effective
`overlayTmpRoot` (simulating a `TMPDIR`-changing restart), and asserts
`releaseOverlay`/`accept`/`reject` still successfully removes it. A second
test asserting `sweepOrphanedOverlays` finds an orphan under a non-live
`tmpRoot` recorded on a stale task entry.

## Task 3: Dispatch/lifecycle correctness

Three independent findings in the spawn/lifecycle code, unrelated to each
other beyond being in the same file — fine to fix in one task since each is
small.

**Findings:**
1. `src/tasks.js:2133` — the `child.on("error", ...)` handler (spawn
   failure) sets `task.status = "crashed"` and calls `finishSettlement()`,
   but never calls `extractChangesetForTask()` the way the normal exit path
   does. A task whose overlay was already created (per role) before the
   spawn failed is stranded: no diff extraction, no cleanup, no
   `changesetStatus` transition.
2. `src/tasks.js:1898` — `resolvePreDispatchHead(launchDirectory)` is
   called directly, bypassing the injected `runOverlayCommandFn` delegate
   that every other git/command invocation in this module goes through
   (used for tests to fake command execution without a real subprocess).
   Check `resolvePreDispatchHead`'s signature in `changeset.js` — it likely
   needs a `runCommand` parameter threaded through, matching how
   `extractGitDiff`/`extractNonGitDiff`/`applyChangeset` already accept one.
3. `src/tasks.js:594` — `requireOverlaySupport()` computes
   `overlaySupport = checkOverlaySupportFn()` once and caches it in a
   closure variable for the daemon's entire lifetime. A negative probe
   (e.g. bwrap version too old, transient environment issue) can never
   self-heal without a full daemon restart, unlike `requireBwrap`'s
   handling elsewhere in the file (check whether an analogous check nearby
   avoids this and mirror it, or add a TTL/invalidation).
4. **(PLAUSIBLE, fold in here)** `src/tasks.js:2305` (`reject()`) — no
   lifecycle check equivalent to `accept()`'s `changesetStatus !==
   "pending"` guard against a task whose overlay might already be mid-use
   elsewhere; read `accept()` and `reject()` side by side and decide
   whether `reject()` is missing a check `accept()` has, or whether this is
   a non-issue — if the latter, note that in the task report rather than
   changing code that doesn't need it.

**Test:** one covering test per finding — a spawn-error test asserting
`extractChangesetForTask` still runs (or an equivalent cleanup happens);
a test asserting `resolvePreDispatchHead` is called through the injected
delegate (a fake `runOverlayCommandFn` should be observably invoked); a
test asserting `requireOverlaySupport()` re-probes after some invalidation
trigger you introduce (document the trigger you chose in the task report).

## Task 4: Accept/diff correctness

**Findings:**
1. `src/tasks.js:2253` (`accept()`) — after the `diffPath == null` check,
   there's no check that the diff file at `task.diffPath` still physically
   exists before handing it to `applyChangeset()`/`git apply`. If the diff
   file was deleted or the stateDir was partially cleaned between
   extraction and accept, this should fail with a clear error, not
   whatever raw error `git apply` produces on a missing file.
2. `src/tasks.js:2892` + `:2887` (`computeDiffStat`) — hand-rolls file
   counting by looking only for `diff --git ` header lines. Non-git
   changesets are extracted via `diff -ruN` (`extractNonGitDiff` in
   `changeset.js`), which never emits `diff --git` headers — so
   `computeDiffStat` reports `files: 0` for every non-git changeset
   regardless of how many files actually changed. Root-cause fix per
   finding #13: stop hand-rolling this — shell out to real `git`
   tooling (e.g. `git apply --numstat` reading the diff text from stdin,
   which correctly parses both git-style and plain unified-diff headers)
   instead of re-deriving stat counts by scanning lines. Route it through
   the existing `runCommand`/`runOverlayCommandFn` delegate like every
   other subprocess call in this file, so it stays fake-able in tests.
3. `src/args.js:455` — in `src/commands.js` (`~line 208`), the result
   command builds its request payload with
   `...(options.diff ? { fields: ["diff"] } : options.full ? { full: true
   } : {})` — an `if/else-if` that means `--result --diff --full` together
   silently sends `fields: ["diff"]` to the daemon and drops `full`
   entirely, even though the local `leanResult()` call two lines later
   does still receive `options.full`. Decide (and document in the fix)
   whether `--diff --full` should be rejected as a usage error (matching
   the existing `--diff cannot be combined with --fields` validation in
   `args.js`) or actually honored by sending both to the daemon — check
   what `full` requests server-side that the diff-only payload doesn't,
   to determine whether combining them is meaningful at all before
   picking a fix.
4. **(PLAUSIBLE, fold in here)** `src/tasks.js:2241` (`accept()`) — a crash
   between `applyChangeset()` succeeding and `persistTask()` actually
   writing `changesetStatus = "accepted"` to disk would leave the task
   looking `pending` after a restart even though the patch was already
   applied, risking a double-apply on a subsequent `accept()` retry. Decide
   whether this needs a fix (e.g. persist immediately after
   `changesetStatus` is set, before `cleanupOverlay`) or is an accepted
   narrow race — document the decision in the task report either way.
5. **(PLAUSIBLE, fold in here)** `src/changeset.js:203` — a non-git
   extraction's `diff -ruN` output embeds the ephemeral overlay
   `mergedMountPoint` path in its patch headers (`--- directory` / `+++
   mergedMountPoint/...`), which is meaningless once the overlay is torn
   down — check whether `applyChangeset`'s non-git apply path already
   strips/rewrites this (e.g. via `patch -p` stripping or a `sed`-style
   header rewrite) before deciding this needs a code change versus just
   confirming existing behavior handles it.

**Test:** a test for the missing-diff-file case in `accept()`; a
`computeDiffStat` test asserting a non-git-style diff (no `diff --git`
headers) reports a non-zero file count; an `args.js`/`commands.js` test
for whatever `--diff --full` behavior you pick.

## Task 5: De-duplicate `buildMergedViewBwrapArgs` vs. `sandbox.js`'s `buildBwrapArgs`

**Finding:** `src/changeset.js:158` (`buildMergedViewBwrapArgs`) duplicates
argument-building logic that already exists in `src/sandbox.js`'s
`buildBwrapArgs()` (the `--ro-bind / --proc / --dev / --tmpfs /tmp` /
denylist / `--unshare-all` boilerplate). Read both functions fully first;
extract the genuinely shared boilerplate into one helper both call, keeping
each function's overlay-specific and non-overlay-specific args distinct —
don't force them into one function with a pile of conditionals if the
divergence is substantial.

**(PLAUSIBLE, fold in here)** — the same code comment at
`changeset.js:158` notes that the explicit `directory` bind (ro or rw) is
needed because `--tmpfs /tmp` can shadow `directory` when it's under
`/tmp` — confirm `buildMergedViewBwrapArgs`'s overlay paths themselves
(`overlay.upperDir`, `overlay.workDir`, `mergedMountPoint` — all of which
live under `/tmp` by construction) get the same shadowing protection
`directory` does, or explain in the task report why they don't need it
(e.g. because they're created *after* the tmpfs mount inside the same
bwrap invocation, or because `--overlay-src`/`--overlay` register the
mount point directly rather than relying on a prior bind).

**Test:** existing `sandbox.test.js`/`changeset.test.js` coverage should
still pass; add a test confirming the deduped helper produces
byte-identical `bwrap` arg arrays to what each function produced before the
refactor, for both the overlay and non-overlay cases.
