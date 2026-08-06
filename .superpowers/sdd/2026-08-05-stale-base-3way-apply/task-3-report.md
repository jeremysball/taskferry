# Task 3 report — `extractGitDiff` rewiring

**Note on provenance:** this report was reconstructed by the controller
session from the implementer's final dispatch message, not written by the
implementer itself into a report file (it wrote none, unlike Tasks 1-2).
The implementer's own changeset also could not be extracted or accepted
through the normal `taskferry accept` path — this worktree's HEAD had
drifted from `61ade65` (the implementer's dispatch base) to `086f7ee` while
the implementer was in flight (a `docs(sdd): Task 2 review artifacts`
commit landed mid-dispatch, in the prior paused session), which trips
`extractGitDiff`'s pre-Task-3 fail-closed HEAD-drift guard —
`taskferry result --diff` returned `diff: null` with a `changesetError`
citing exactly that drift. Since the drift commit only touched
`.superpowers/sdd/...` diff-artifact files (untouched by this task), there
was no real conflict: the controller copied the three changed files
(`src/changeset.js`, `src/changeset.test.js`, `docs/sourcemap.md`) directly
out of the ferry's overlay `upper/main/` layer, verified the resulting
diff matched the implementer's own description of its changes exactly,
then committed. `taskferry reject` was called on the ferry's own pending
changeset afterward (never `accept` — see the path-collision gotcha).

## What changed

- **`src/changeset.js`** (632 → 611 lines net; the implementer's own count
  was 632 pre-fix, ended at 611)
  - `extractGitDiff()` no longer throws on HEAD drift. The pre-retry
    `detectHeadDrift` guard (which threw before `runExtractionBwrap()`) and
    the post-retry re-check guard (taskferry#329, which threw immediately
    before persisting the diff) are both removed.
  - The diff is now always written unconditionally. `detectHeadDrift()`
    runs exactly once, *after* the diff is persisted. When it reports
    drift, `resolveHeadDrift()` (Task 2's disposable-worktree 3-way probe)
    runs against the diff just written, targeting the drifted `currentHead`.
  - `extractGitDiff()`'s return shape changed from `{diffPath, hasChanges}`
    to `{diffPath, hasChanges, headDrift}`, where `headDrift` is `null` (no
    drift detected) or `{from, to, recovered, conflictDetail}` mirroring
    `resolveHeadDrift()`'s own return shape.
  - New injectable `scratchDirFn` parameter (default
    `() => path.join(os.tmpdir(), \`taskferry-stale-base-${crypto.randomUUID()}\`)`)
    so callers/tests can pin or mock the disposable worktree root passed to
    `resolveHeadDrift()`.
  - New `os` import for `os.tmpdir()`.
- **`src/changeset.test.js`** (+77/-55 net)
  - Updated the existing HEAD-drift tests to match the new non-throwing
    contract (drift no longer throws; asserts on the returned `headDrift`
    shape instead of a thrown error).
  - Added tests for the drift-resolution pipeline: clean 3-way recovery,
    genuine conflict, and the two `resolveHeadDrift` failure branches
    (worktree-add failure, status-inspection failure) as observed through
    `extractGitDiff()`'s own `headDrift` return value rather than only unit
    on `resolveHeadDrift()` directly.
- **`docs/sourcemap.md`**
  - Rewrote the `changeset.js` row's `extractGitDiff()`/HEAD-drift sentence
    to describe the new non-throwing, always-persists-then-resolves
    behavior, dropped the stale taskferry#329 double-check framing (both
    throwing guards it protected are gone), and added the `scratchDirFn`
    injection point. Line count `623 → 611`.

## Known follow-ups (from the implementer's own concerns)

1. `tasks.js:4308` still ignores `extracted.headDrift` entirely — nothing
   yet persists it into `changesetStatus` or routes it through `accept`.
   This is explicitly **Task 5**'s job (settle `headDrift` into
   `changesetStatus` at task-finish time), not a gap in this task.
2. The brief's verbatim test-describe placement produced a 237-line
   `extraction fail-closed behavior` describe block, over the file's
   200-line `sonarjs` cap — the implementer split the new drift-resolution
   tests into a sibling `extractGitDiff() head-drift resolution` describe
   to stay under the cap. Intent preserved, structure diverges from the
   brief's literal block placement.
3. The brief's verbatim object-literal property order for one test fixture
   failed `sonarjs/shorthand-property-grouping` — fixed by reordering keys,
   no behavior change.
4. Parent-shell `TASKFERRY_STATE_DIR`/`RUNTIME_DIR`/`CACHE_DIR`/
   `SOCKET_PATH` env leakage causes 4 unrelated test failures when `npm
   test` runs with those vars set in the ambient shell (as this session's
   own isolated dev daemon setup does) — the implementer suggested adding
   them to `npm test`'s env-unset list as a separate fix. **Not applicable
   here**: the controller's own real host `npm test` run (this report's
   Test commands section) was 986/986 with 0 failures, confirming these 4
   were purely the sandboxed-ferry artifact already flagged in Tasks 1-2's
   reports, not a real gap.

## Test commands and results (controller, real host, not sandboxed)

- `npm test` (full suite): `tests 986, pass 986, fail 0`.
- `npm run lint`: clean.
- `npm run typecheck`: clean.

(The implementer's own in-sandbox run reported `changeset.test.js` 52/52,
`changeset.integration.test.js` 4/4, `tasks.changeset.test.js` 24/24, and a
full-suite 982/986 with 4 sandbox-artifact failures it verified were
present identically with its own changes stashed — consistent with the
controller's clean 986/986 real-host run above.)

## Commits

- `9041d26` (as reported by the implementer, not preserved by the sandbox —
  see Verifying A Worker's Claimed Changeset) —
  `feat(changeset): extractGitDiff resolves HEAD drift via 3-way instead of aborting`
- `630e28d` (same caveat) —
  `docs(sourcemap): extractGitDiff now resolves drift via 3-way, never aborts`

Both are re-created as a single controller commit on top of `086f7ee`
(see the ledger), since the sandboxed commits themselves never land — only
the flattened diff does.

## Concerns

- Everything the implementer raised is listed under "Known follow-ups"
  above rather than repeated here.
- The HEAD-drift-during-dispatch scenario that broke automatic extraction
  for this very task is, ironically, exactly what this plan's Task 3 fixes
  going forward — once this commit lands, a future task's dispatch hitting
  the same drift will resolve automatically via `resolveHeadDrift()` instead
  of requiring this manual recovery.
