## Task 5, fix round 1: verification-gate lint errors + amended test scope

Your prior attempt (this same session) correctly implemented Steps 1-5 of
the Task 5 brief and correctly discovered that Step 6 ("run the five test
files, expect PASS") was wrong — the real fallout is far broader than the
brief anticipated. Both things you found are confirmed real (verified
independently by re-running the full suite against your diff: **234 of 1198
tests fail across 14 files**, not the 5 files the brief named). You stopped
before finishing; this round finishes it. Everything below is the complete,
approved design — no more discovery needed, just implement and verify.

### Part A: fix the two lint errors the check gate found

`npm run check` failed at the `eslint` step with 2 errors:

1. `src/tasks.executor.test.js:6` — `LUNA_MODEL` imported from
   `./tasks.test-helpers.js` but no longer used (its only uses were the
   `defaultModel: LUNA_MODEL,` fixture lines you correctly deleted). Remove
   `LUNA_MODEL` from that import's named-import list. Leave every other name
   in that import list untouched — some of them are still used elsewhere in
   the file.
2. `src/tasks.js:2108` — the `variant` destructured parameter of
   `buildDispatchTask` is now unused (`variant: null` replaced the line that
   read it). Rename it to `_variant` in the function's parameter list only
   (matches this project's eslint config, which allows unused args prefixed
   with `_`; the error message itself suggests this exact fix). Do not
   remove it — Task 6 renames it back to `variant` and wires it into
   `resolveVariant()`. Leave the existing
   `// eslint-disable-next-line sonarjs/cyclomatic-complexity -- ...` comment
   above the function as-is; it addresses a different rule.

### Part B: the amended Task 5 scope — a test-only default model

**Root cause of the 234 failures:** dozens of test files across this repo
call `manager.dispatch({...})` as incidental setup for something unrelated
(watchdog timing, sandbox flags, activity/log parsing, changesets, lifecycle,
persistence) and never passed `model` — they relied on the
`executor.defaultModel` fallback your diff correctly removed. The brief's
"Files" list only named the 4 files that needed `defaultModel:` trimmed out
of *executor fixture objects*; it didn't anticipate the ~230 unrelated
`dispatch()` call sites elsewhere in the suite that relied on the same
fallback implicitly.

**Approved fix (confirmed with the human partner — do not redesign this):**
give the shared test-manager plumbing in `src/tasks.test-helpers.js` a
test-only default model that fills in silently when a test doesn't care
which model gets used, so those ~230 call sites need zero edits. Only the
one test that specifically exercises the new "no model, no session ⇒ throw"
behavior opts out.

**Exact implementation:**

1. In `src/tasks.test-helpers.js`, add a new exported constant near the
   other `*_MODEL` constants (e.g. after `MIMO_MODEL`):

   ```js
   // Used only by trackManager()'s auto-fill below -- an arbitrary,
   // obviously-synthetic model string, not a real provider/model. Real
   // dispatches still require --model per Task 5; this exists purely so
   // the ~230 test call sites that don't care which model gets used don't
   // need individual edits.
   export const TEST_DEFAULT_MODEL = "taskferry-test/auto-default";
   ```

2. Change `trackManager()` (currently just pushes to `trackedManagers` and
   returns the manager unchanged) to optionally wrap `.dispatch`:

   ```js
   export function trackManager(manager, { autoModel = true } = {}) {
     trackedManagers.push(manager);
     if (autoModel) {
       const realDispatch = manager.dispatch;
       manager.dispatch = (opts) => {
         if (opts.model == null && opts.sessionId == null) {
           return realDispatch({ ...opts, model: TEST_DEFAULT_MODEL });
         }
         return realDispatch(opts);
       };
     }
     return manager;
   }
   ```

   The `opts.sessionId == null` guard is deliberate: a dispatch that passes
   a `sessionId` (even one that won't resolve) is exercising the
   session-resume path and must reach the real "no task found for session
   id" error unchanged — never auto-fill a model for it.

3. Change `makeManager()` to thread an `autoModel` option through to
   `trackManager()`:

   ```js
   export function makeManager(options = {}) {
     const { stateDir, defaultCacheDir, defaultOverlayTmpRoot } = makeTempDirs();
     seedTestFixtures(stateDir, options.tasksFixture ?? [], options.logs ?? {});
     return trackManager(
       createTaskManager(buildManagerOptions(options, stateDir, defaultCacheDir, defaultOverlayTmpRoot)),
       { autoModel: options.autoModel !== false }
     );
   }
   ```

4. In `src/tasks.dispatch.test.js`, the one test you already added —
   `"dispatch without --model and without a resolvable --session-id
   throws"` — must opt out, since it has neither `model` nor `sessionId`
   and would otherwise get silently auto-filled:

   ```js
   const mgr = makeManager({ spawnFn: () => fakeChild(), autoModel: false });
   ```

   The other new test (`"an unrecognized --session-id with no --model
   throws, naming the session id"`) does **not** need this — it already
   passes `sessionId: "ses_never_seen"`, so step 2's guard already skips
   auto-fill for it. Do not add `autoModel: false` there; it's unnecessary
   and would be confusing (implies the throw depends on it, when it
   doesn't).

   `src/activity.test.js` and `src/opencode-plugin.test.js` construct their
   managers directly (`trackManager(createTaskManager({...}))`, not through
   `makeManager()`) — leave those two call sites untouched. They get
   `autoModel: true` for free from `trackManager`'s new default parameter,
   which is exactly what they need (none of their tests care about model
   selection).

### Verification (this is the actual acceptance bar — run it for real)

```
npm run check
```

This runs lint, typecheck, skill:check, then the full test suite in one
shot — the same gate that failed before. It must exit 0.

If, after the design above, a handful of individual tests still fail
because they assert on the *exact* captured model string in spawn args
(e.g. `assert.deepEqual(captured.slice(...), ["-m", LUNA_MODEL, ...])`) and
happened to omit `model` from their own `dispatch()` call while relying on
the old default equaling a specific constant they assert against — fix
those specific tests by adding an explicit `model: <the constant they
already assert on>` to that one dispatch call. This should be a small
number of cases, not a repeat of the 234-test sweep; if you find more than
a handful, stop and report rather than mass-editing — that would mean the
design above needs revisiting, not brute-forcing around it.

Do not touch `src/tasks.summarize.test.js` beyond what your original diff
already did — it wasn't in the 14 failing files.

### Report and commit

Append your fix-round report to
`.superpowers/sdd/2026-08-09-highest-thinking-default/task-5-report.md`
(create it if your first attempt never did — state that plainly rather than
implying a report already exists). Include: what you changed in Part A and
Part B, the exact `npm run check` command and its final exit code, and how
many individual tests (if any) needed the small explicit-model fix from the
Verification section above, naming each one.

Commit everything (Parts A and B, the report, and the already-produced
Steps 1-5 changes if not already committed) with:

```
git add -A
git commit -m "feat(cli)!: require --model on a fresh dispatch, drop executor.defaultModel

BREAKING CHANGE: dispatching without --model and without a --session-id
that resolves to a prior task now errors with '--model is required'
instead of silently falling back to a hardcoded per-executor default
model. Pass --model explicitly, or resume via --session-id to inherit
a prior task's model. Test-only dispatch calls that don't care which
model is used get a shared TEST_DEFAULT_MODEL from the test-manager
helper instead of needing per-call-site edits."
```

End your reply with a line starting `Status:` — one of `DONE |
DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`.
