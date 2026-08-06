## Task 1 Report: `detectHeadDrift` — non-throwing replacement for `assertNoHeadDrift`

### What changed

**`src/changeset.js`:**
- Deleted the `assertNoHeadDrift` function (lines 92-114) and replaced it with `detectHeadDrift`, a non-throwing function that returns `{from, to}` when drift is confirmed, or `null` when HEAD matches or the check was inconclusive.
- Updated the two call sites inside `extractGitDiff` (pre-retry guard and post-retry re-check) to call `detectHeadDrift` and throw inline with the same error message the old `assertNoHeadDrift` used. This preserves `extractGitDiff`'s existing external contract (still throws on confirmed drift) while introducing the new non-throwing API for `resolveHeadDrift` to consume in Task 3 (the wiring task).

**`src/changeset.test.js`:**
- Added `detectHeadDrift` to the import from `./changeset.js`.
- Added a `describe("detectHeadDrift()", ...)` block with 3 tests above the `describe("extractGitDiff()", ...)` block, directly testing the new pure function:
  - returns null when current HEAD matches preDispatchHead
  - returns `{from, to}` when current HEAD has moved
  - returns null (fail-open) when the HEAD check itself is inconclusive
- Extracted the `"fatal: not a git repository"` / `"fatal: not a git repository\n"` stderr literals to module-scope constants (`GIT_NOT_A_REPO_STDERR`, `GIT_NOT_A_REPO_STDERR_NL`) to satisfy sonarjs/no-duplicate-string (the new test pushed the count of that literal to 3).

### Test commands and output

```
$ node --test --test-name-pattern "detectHeadDrift" src/changeset.test.js
▶ detectHeadDrift()
  ✔ returns null when current HEAD matches preDispatchHead (1.080706ms)
  ✔ returns {from, to} when current HEAD has moved (1.047716ms)
  ✔ returns null (fail-open) when the HEAD check itself is inconclusive (0.257919ms)
✔ detectHeadDrift() (4.143775ms)
ℹ tests 3
ℹ suites 1
ℹ pass 3
ℹ fail 0
```

Full `src/changeset.test.js` suite: 44 tests, 44 pass, 0 fail.

Full repo `npm test`: 978 tests, 974 pass, 4 fail. The 4 failures are pre-existing on the base branch (verified via `git stash` + rerun) in `daemon-client.test.js`, `tasks.env.test.js`, and `tasks.sandbox.test.js` — unrelated to this change.

`npm run lint`: clean (no errors, no warnings).

### Concerns

1. **Deviation from the brief on the `resolveHeadDrift` import**: The brief's import line includes `resolveHeadDrift`, but that function does not exist yet (it is added in Task 2). Including it in the import would have caused a static `SyntaxError: The requested module does not provide an export named 'resolveHeadDrift'` at module load time. I omitted it; it will be added when Task 2 introduces the function.

2. **Call sites still throw**: The brief said "delete `assertNoHeadDrift`, add `detectHeadDrift`" but the existing `extractGitDiff` call sites (lines 187 and 205) still need to throw on drift — the existing `extractGitDiff` tests (to be rewritten in Task 3) assert that throwing behavior. I preserved the external contract by inlining the throw at each call site using `detectHeadDrift`'s return value. Task 3 will rewire these call sites to use `resolveHeadDrift` instead.

### Commit

`de1f9ed refactor(changeset): replace throwing assertNoHeadDrift with detectHeadDrift` (re-applied by the controller as `81a2b81` after a path conflict on the SDD scratch files — see controller note below)

### Controller note (added post-hoc, not by the implementer)

`taskferry accept` failed because the ferry's `git add -A` inside its sandbox picked up this repo's untracked SDD scratch files (`progress.md`, `task-1-brief.md`, this report) as "new files," which already existed on the real worktree disk (created by the controller before dispatch) — a path collision, not a content conflict. The controller applied only the `src/` hunks of the diff directly (`git apply --include='src/*' --3way`), verified the full suite (978/978 passing), and committed as `81a2b81`. Re-ran `npm test` after applying: all green.
