# Task 3 Report: `piExecutor().normalizeLogEvent`

## Scope

Implemented Task 3 only. The change normalizes pi's `--mode json` events in `src/executor.js` and adds fixture-driven tests in `src/executor.test.js`. No `tasks.js` wiring was added.

The existing opencode identity normalizer remains unchanged.

## Implementation

`piExecutor().normalizeLogEvent` now maps the verified pi event shapes as follows:

- `session` with a string `id` becomes `{ sessionID }`.
- `message_update` emits only `text_delta` text events. The message key comes from `message.responseId`. `text_start`, thinking events, and `text_end` produce no event.
- `tool_execution_end` emits one `tool_use` event, preserves the pi tool name's lowercase spelling, carries `args` as input, and joins text result content as output. Tool start and update events produce no event.
- `agent_end` scans the final assistant message. A normal stop becomes `step_finish` with `messageID` from `responseId`, usage, and total cost. `stopReason: "error"` becomes the structured `pi_error` event.
- Unknown and unrelated lifecycle events produce no event.

The tests use the exact fixture shapes and canonical outputs from the Task 3 brief.

## TDD evidence

### RED

Command:

```text
node --test src/executor.test.js
```

Result: 28 tests ran, 17 passed, 11 failed. The new normalization cases failed because pi's normalizer still returned each parsed event unchanged. Existing pi executor and opencode executor tests passed.

### GREEN

Command:

```text
node --test src/executor.test.js
```

Result: 28 tests ran, 28 passed, 0 failed, 0 cancelled, 0 skipped.

## Verification commands and results

- `node --test src/executor.test.js`: 28 passed, 0 failed.
- `npm run lint`: exit 0; 0 errors and 35 warnings. The warnings include the new complexity warning for `piNormalizeLogEvent` at `src/executor.js:65`; the repository already reports other complexity, size, and unused-variable warnings.
- `npm run typecheck`: exit 0 with no output.
- `npm test`: 453 tests ran, 451 passed, 2 failed, 0 cancelled, 0 skipped.
- `git diff --check`: clean.

The two full-suite failures are outside this task:

1. `src/tasks.test.js:484`, `ro-binds the real opencode auth.json into the sandboxed XDG_DATA_HOME when it exists, so credentialed providers still resolve`: the expected auth bind was absent.
2. `src/tasks.test.js:522`, `leaves XDG_DATA_HOME untouched when sandboxing is disabled`: the captured environment contained `/run/user/1000/taskferry/opencode-data` instead of `undefined`.

No change was made to those unrelated tests or their implementation.

## Files changed

Task implementation files:

- `src/executor.js`
- `src/executor.test.js`

The pre-existing worktree changes in `package-lock.json` and `.superpowers/plans/2026-07-23-worker-executor-abstraction-plan.md` were preserved and were not staged.

## Self-review

- Confirmed the pi executor references `piNormalizeLogEvent`.
- Confirmed the opencode executor still uses its identity normalizer.
- Confirmed `tasks.js` remains untouched.
- Confirmed `message.responseId`, rather than another message field, supplies `messageID`.
- Confirmed only `text_delta` emits text.
- Confirmed only `tool_execution_end` emits a tool event and lowercase tool names remain unchanged.
- Confirmed `agent_end` selects the last assistant message and maps error stops to `pi_error`.
- Confirmed the target diff passes `git diff --check` and contains no unrelated target-file changes.

## Commit

Created commit `407de9e` with this exact message:

```text
git commit -m "feat(executor): implement piExecutor's normalizeLogEvent against verified pi event shapes"
```

## Concerns

The focused executor suite, lint, and typecheck pass. The full unit suite has the two unrelated sandbox failures listed above. Therefore the overall status is `DONE_WITH_CONCERNS`.

Report path: `/workspace/taskferry/.superpowers/sdd/task-3-report.md`
