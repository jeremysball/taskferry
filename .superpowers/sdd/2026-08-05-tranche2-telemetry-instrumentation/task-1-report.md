### Task 1 Report: `--class` task-classification tag

**Initial commit:** `8edbb3b` — `feat(dispatch): add --class task-classification tag`
**Fix commit:** `91e3529` — review corrections (advisor propagation, result field, revert refactoring)

---

#### What was implemented

A freeform, unvalidated `--class` string option on `dispatch` and `advisor` commands. The field is:
- Parsed in `src/args.js` (mirrors `--variant`/`--session-id` — no coercer, plain string)
- Validated at the protocol boundary in `src/protocol.js` (`isNonEmptyString` predicate, same as variant/sessionId)
- Persisted on the task record in `src/tasks.js` (`buildDispatchTask`, `dispatchTask`, `dispatchAdvisorTask`, `runAdvisor`)
- Surfaced in `summarizeOptionalFields()` when non-null
- Surfaced in `computeResultDetail()` when non-null (for `result --fields class`)
- Forwarded through the CLI layer in `src/commands.js` (both `DISPATCH_PASSTHROUGH_KEYS` and `runAdvisor`)
- Documented in `src/command-specs.js` for both dispatch and advisor

#### Files modified (9 source files)

| File | Change |
|---|---|
| `src/args.js` | Added `"--class"` to `FLAGS` table |
| `src/args.test.js` | 2 new tests + updated defaults assertion |
| `src/protocol.js` | Added `["class", isNonEmptyString]` to `task.dispatch` and `task.advisor` optional params; added `"class"` to `RESULT_FIELDS` |
| `src/protocol.test.js` | 3 new tests (accept/reject class values) |
| `src/tasks.js` | Updated `Task` and `TaskSummary` typedefs; updated `buildDispatchTask`, `dispatchTask`, `dispatchAdvisorTask`, `runAdvisor`, `AdvisorContext.dispatch` JSDoc, `summarizeOptionalFields`, and `computeResultDetail` |
| `src/tasks.dispatch.test.js` | 2 new tests (persist+surfacing, omit when unset) |
| `src/commands.js` | Added `"class"` to `DISPATCH_PASSTHROUGH_KEYS`; added class forwarding in `runAdvisor` |
| `src/commands.test.js` | 3 new tests (dispatch forward, dispatch omit, advisor forward) |
| `src/command-specs.js` | Added `--class <name>` option and example for dispatch and advisor |

#### Fix round (review corrections)

Four issues found during review:

1. **Advisor propagation was broken.** `runAdvisor` (the actual `task.advisor` RPC entry point around line 2248) did not destructure `class` from params or forward it to `dispatchAdvisorTask`. The full chain `commands.js runAdvisor` -> `task.advisor` RPC -> `tasks.js runAdvisor` -> `dispatchAdvisorTask` -> `ctx.dispatch` now carries `class` through every hop.

2. **`taskferry result --fields class` returned nothing.** `computeResultDetail` (line ~1482) never included `task.class` in its return object. Added `...(task.class != null ? { class: task.class } : {})` after the `finalMarker` line, matching the existing pattern.

3. **Unrequested refactoring reverted.** The initial commit had changed `||` to `??`, extracted an `isLong` local, and removed the `usingDefaultModel` variable in `buildDispatchTask`. This was reverted to the original logic (`usingDefaultModel`, `||` operators, no `isLong` extraction), keeping only the `class: taskClass == null ? null : taskClass` addition. An `eslint-disable-next-line sonarjs/cyclomatic-complexity` comment is needed because the function was already at the 10-point ceiling before this change.

4. **Report file was missing.** This file.

#### Lint/typecheck

- `npm run lint` — 0 errors
- `npm run typecheck` — 0 errors
- The `eslint-disable-next-line sonarjs/cyclomatic-complexity` on `buildDispatchTask` is required: the function was at complexity 10 (the sonarjs limit) before adding `class`, and the new field's `taskClass == null ? null : taskClass` ternary adds exactly 1 point.

#### Test results

**`npm test`:** 899 tests total, 896 pass, 3 fail

The 3 failures are **pre-existing** and unrelated to `--class`:
- `src/tasks.env.test.js:85` — `TASKFERRY_TASK_ID is absent from summary spawns`
- `src/tasks.sandbox.test.js:319` — `ro-binds the real opencode auth.json`
- `src/tasks.sandbox.test.js:358` — `leaves XDG_DATA_HOME untouched when sandboxing is disabled`

Verified pre-existing by running tests on the original code (same 3 fail).

**Affected test files (all pass):**
- `src/args.test.js` — 52/52 pass
- `src/protocol.test.js` — 43/43 pass
- `src/tasks.dispatch.test.js` — 45/45 pass
- `src/commands.test.js` — 63/63 pass

#### Commit hashes

- `8edbb3b` — initial implementation
- `91e3529` — review fixes (advisor propagation, result field surfacing, reverted refactoring)
