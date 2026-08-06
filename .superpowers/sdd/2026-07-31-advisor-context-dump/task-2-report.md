# Task 2 Report: stamp `TASKFERRY_TASK_ID` on every spawned dispatch/advisor child

**Status:** DONE_WITH_CONCERNS (concerns resolved by orchestrator, see below)
**Commit:** `48bc73c feat(tasks): stamp TASKFERRY_TASK_ID on spawned dispatch/advisor children`

## Implementation

Per the brief, in `src/tasks.js`:

- `dispatchEnvironment(env, taskId)` (was `dispatchEnvironment(env)`) now sets
  `result.TASKFERRY_TASK_ID = taskId` in addition to the existing
  `TASKFERRY_CHILD = "1"`.
- The call site at the `startTask()` spawn (`~line 1887`) now passes
  `dispatchLaunch.env, task.id` — `summaryEnvironment()` on the summary
  branch is untouched, so `TASKFERRY_TASK_ID` is dispatch/advisor-only, not
  stamped on summary spawns.

## Deviation from the brief's literal test

The brief's verbatim first test dispatches, then calls `mgr.advisor(...)`
directly against a `makeManager()` fixture with no sandbox config. That
fails independent of this task's change: `advisor()`'s fail-closed gate
(the sandboxing/overlay-availability check that runs before an advisor
child is spawned) rejects the call before `spawnFn` is ever invoked, so
`advisorOpts` stays `null`.

Fixed by mirroring the file's own existing passing advisor test (the one at
`~line 5524`): the fixture now sets `sandboxEnabled: true`, `overlayEnabled:
true`, `checkBwrapAvailableFn: () => ({ checked: true, available: true })`,
`checkOverlaySupportFn: () => ({ supported: true })`, `platform: "linux"`.
The assertions themselves are unchanged from the brief. Verified the fixture
change is adaptation-only, not a scope change, by running the tests: with
it, both new tests pass; without it, the advisor assertion fails on a null
`advisorOpts` regardless of whether `TASKFERRY_TASK_ID` is stamped.

## Test evidence

Orchestrator-verified in the worktree after `taskferry accept` + manual
commit (the implementer's own sandboxed test run couldn't be captured
directly — see "Report file" below):

```
$ node --test src/tasks.test.js
ℹ tests 312
ℹ pass 312
ℹ fail 0
```

Both new tests (`TASKFERRY_TASK_ID is stamped with the spawned task's own
id, for both dispatch and advisor roles`, `TASKFERRY_TASK_ID is absent from
summary spawns`) pass, plus the full existing suite — no environmental
failures observed on this run (unlike Task 1's XDG-related pre-existing
failures, which live in a different describe block not exercised by this
change).

## Files changed

```
M  src/tasks.js
M  src/tasks.test.js
```

## Report file

Same failure mode as Task 1: the implementer's own report write targeted a
path outside the worktree's sandbox-writable tree (the dispatch prompt
mistakenly gave a main-checkout-looking path), so it never landed as part
of the accepted diff. This report was reconstructed by the orchestrator
from the implementer's settled task message plus direct verification of
the diff and a fresh test run in the worktree.

## Concerns

None outstanding. Source diff matches the brief exactly; only the test
fixture required a documented, verified adaptation to make it runnable
against the codebase's actual advisor fail-closed gate.
