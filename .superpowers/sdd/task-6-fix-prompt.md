Fix Task 6's sole Important finding.

Narrow `WorkerExecutor.id` in `src/executor.js` to `"opencode"|"pi"`, then restore both `Task.executorId` and `TaskSummary.executorId` in `src/tasks.js` to the same union. This preserves the plan's closed persisted-data contract and should allow `executorId: executor.id` to typecheck without casts.

Run executor tests, Task 6 focused tasks tests, lint, and typecheck. Commit only these intended type-contract hunks normally; do not bypass hooks.

Preserve every concurrent uncommitted summary-model/test/report change exactly. Do not stash, reset, checkout, clean, revert, or stage unrelated hunks.

Append fix details and exact verification results to `/workspace/taskferry/.superpowers/sdd/task-6-report.md`. Return status, commit, one-line test summary, concerns, and report path, ending with `Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`.
