# Task 2 Report

## RED/GREEN evidence

- RED: initial `node --test src/executor.test.js` failed during module parsing after the first test insertion (`SyntaxError: Unexpected token '}'`); fixed test suite structure.
- RED: focused test then reached the new model-listing test and failed with actual `""` versus expected normalized entries because the newline escape was over-escaped; corrected implementation.
- GREEN: `node --test src/executor.test.js` passed: 16 tests, 16 passed, 0 failed.

## Tests and results

- Focused: `node --test src/executor.test.js` — PASS (16/16).
- Full unit suite: `npm test` — FAIL (453 tests, 451 passed, 2 failed). Existing `src/tasks.test.js` sandbox assertions still expect the pre-Task-2 sandbox contract/consumer behavior: the opencode auth bind assertion does not observe the new executor return field, and the disabled-sandbox assertion observes `sandboxedDataHome` being applied. These are Task 7 consumer integration concerns and were not changed outside the requested files.
- Lint: `npm run lint` — PASS with 34 pre-existing warnings, 0 errors.
- Typecheck: `npm run typecheck` — PASS.

## Files changed

- `src/executor.js`: added `WorkerExecutor` and `SpawnLaunchContext` typedefs, implemented `piExecutor`, injected command execution for focused model-list tests, normalized padded `pi --list-models` output, added pi spawn arguments and sandbox auth binding/environment, added opencode `sandboxEnv`, and resolved `pi`.
- `src/executor.test.js`: added focused pi executor tests and updated opencode sandbox return expectations.

## Self-review

- Preserved unrelated `package-lock.json` and `.superpowers/plans/` worktree changes.
- No comments were added to implementation code.
- Pi uses `PI_CODING_AGENT_DIR` directly rather than `XDG_DATA_HOME`; auth binds to `<runtimeDir>/pi-data/auth.json` and returns the matching `sandboxEnv` override.
- Model listing skips the header and consumes only the first two whitespace-delimited columns.

## Concerns

- Full unit suite remains blocked by two existing consumer tests until Task 7 consumes `sandboxEnv` and updates sandbox behavior expectations.

## Review fix

- Updated `piExecutor().listModelsFn` to normalize the real CLI stream: stderr is preferred when it yields table rows, with stdout retained as a fallback.
- Blank rows are removed before skipping the table header, so trailing newlines do not produce malformed entries.
- Updated the injected fixture to `{ stdout: "", stderr: table }` with a trailing newline and blank row.
- Added the required `resolveExecutor("pi")` regression test.
- RED: `node --test src/executor.test.js` — 17 tests, 16 passed, 1 failed; stderr table produced an empty result.
- GREEN: `node --test src/executor.test.js` — PASS, 17/17.
- `npm run lint && npm run typecheck` — PASS; lint reported 34 pre-existing warnings and 0 errors, typecheck passed.
- `npm test` — 453 tests, 451 passed, 2 failed; the same Task 7 sandbox consumer failures documented above remain.

Report path: `/workspace/taskferry/.superpowers/sdd/task-2-report.md`
