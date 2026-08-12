# Task 5 report — `--model` required on a fresh dispatch; delete `executor.defaultModel`

No prior report existed before this one. The original Task 5 attempt and fix
round 1 both produced working-tree changes, but neither wrote a report file,
and both attempts' diffs were lost when the worktree was reset to HEAD
(`7dc7aa0`) between sessions (the reflog shows `reset: moving to HEAD` with no
intervening commit). This report therefore covers the full Task 5 change set
plus both fix rounds, all re-applied and verified in one pass.

## What changed (Task 5, Steps 1-5)

- `src/executor.js`: removed `defaultModel` from the `WorkerExecutor`
  typedef and from both `piExecutor()` and `opencodeExecutor()`.
- `src/executor.test.js`: deleted the `assert.equal(ex.defaultModel, PI_MODEL)`
  assertion from "exposes pi identity and defaults".
- `src/tasks.js`: `buildDispatchTask` no longer falls back to
  `executor.defaultModel` and no longer forces `variant: "high"` on a
  model-less dispatch. It now throws:
  - `error: --model is required\nhelp: ...` when neither `--model` nor a
    resolvable `--session-id` is given;
  - `error: no task found for session id "<id>" to inherit a model from`
    when a `--session-id` is given but resolves to no prior task.
  The session-id error takes precedence over the generic error, per the
  brief's ordering note. The `variant` line is the brief's intentional
  `variant: null` placeholder (Task 6 wires `resolveVariant()` in); the
  destructured parameter is renamed `_variant` to satisfy eslint while Task 6
  renames it back.
- `src/tasks.dispatch.test.js`: replaced the two fallback tests
  ("defaults to openai/gpt-5.6-luna --variant high...", "an unrecognized
  --session-id with no --model still falls back...") with the two throwing
  tests from the brief; trimmed `defaultModel` from the `fakePi` fixture;
  dropped `--variant max` from the argv-assertion test; added explicit
  `model:` to the five session-resume tests that previously relied on the
  fallback (they exercise executor/session resolution, not model fallback,
  and autoModel must not fill a model when a `sessionId` is present).
- `src/tasks.executor.test.js`, `src/tasks.failure.test.js`,
  `src/tasks.summarize.test.js`: trimmed every `defaultModel:` line out of
  fake-executor fixtures (pure trims — no assertions referenced the field).

## Fix round 1 (test-only default model, Parts A+B)

- `src/tasks.test-helpers.js`: added `TEST_DEFAULT_MODEL =
  "taskferry-test/auto-default"`, and gave `trackManager()` an `autoModel`
  wrapper that fills `model: TEST_DEFAULT_MODEL` into any dispatch with
  neither `model` nor `sessionId` (the `sessionId` guard deliberately keeps
  resume-path errors intact). `makeManager()` threads an `autoModel` option
  through (default `true`).
- `src/tasks.dispatch.test.js`: the new "--model is required" test opts out
  with `autoModel: false`; the "--session-id" test does not (its
  `sessionId` already bypasses auto-fill).
- `src/tasks.executor.test.js`: removed the now-unused `LUNA_MODEL` import.
- `src/opencode-plugin.test.js`: this file has its **own local**
  `trackManager()` (it does not import the shared one from
  `tasks.test-helpers.js`), so the round-1 brief's assumption that it gets
  autoModel "for free" did not hold — its one dispatch-based test failed.
  Mirrored the same autoModel wrapper onto the local function (importing
  `TEST_DEFAULT_MODEL` from the helpers).

## Fix round 2 (the 5 check-gate failures)

All 5 were confirmed by running `npm run check` and root-caused:

1. `src/tasks.advisor.test.js` ("dispatches with the given model/variant..."):
   asserted `--variant max` in the built argv. `buildDispatchTask` now sets
   `variant: null` (Task 6 wires the real value later), so no `--variant`
   flag is emitted. Dropped `"--variant", "max"` from the expected tail;
   left the `variant: "max"` dispatch argument in place.
2. `src/tasks.sandbox.test.js` ("wraps the spawn command in bwrap..."):
   same root cause; the `slice(-14)` window artifactually pulled in
   `--share-net`/`--die-with-parent`. Shrunk the window to `slice(-12)` and
   dropped `--variant max` from the expected array.
3. `src/tasks.executor.test.js` ("a pi dispatch spawns the `pi` binary..."):
   asserted the old per-executor default `MINIMAX_MODEL` on a dispatch with
   no `model`; autoModel now fills `TEST_DEFAULT_MODEL` (correct post-Task-5
   behavior). Updated the assertion.
4-5. `src/tasks.executor.test.js` (the two `sandboxAuthFile` session-scoped
   bind tests): both dispatch with a fabricated, unresolvable `sessionId`
   and no `model`, so autoModel skips (sessionId guard) and the new
   "no task found for session id" throw fired. They test `sandboxAuthFile`
   binding, not model inheritance — added explicit `model: MINIMAX_MODEL` to
   those two dispatch calls. `trackManager`'s auto-fill condition was left
   untouched, per the approved design.

## Verification

`npm run check` (git ls-files node --check, eslint, tsc --noEmit,
skill:check, full 1198-test suite):

- First run in this session's environment: **5 failures** — all five
  pre-existing, environment-dependent tests (`tasks.env.test.js:85`,
  `tasks.sandbox.test.js:319/340/386`, `tasks.executor.test.js:167`) that
  also fail on clean HEAD `7dc7aa0` (verified by stashing the diff and
  re-running: identical 5 tests fail there; a 6th, `daemon-client.test.js`,
  is flaky). Root cause: this session runs as a taskferry child with
  `TASKFERRY_TASK_ID`, `XDG_DATA_HOME`, and `XDG_CONFIG_HOME` set in the
  ambient environment, which those tests assert against.
- With the ambient env scrubbed
  (`env -u TASKFERRY_CHILD -u TASKFERRY_TASK_ID -u TASKFERRY_RUNTIME_DIR -u
  TASKFERRY_SOCKET_PATH -u TASKFERRY_STATE_DIR -u XDG_DATA_HOME -u
  XDG_CONFIG_HOME npm run check`): **exit 0, 1198 tests / 187 suites / 1198
  pass / 0 fail**.

The gate therefore passes for this change; the 5 failures it reports in this
session's ambient environment are a pre-existing property of the host
environment, not introduced by this diff (identical failures at clean HEAD).
