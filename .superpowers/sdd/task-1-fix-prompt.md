Fix the Task 1 review's Important finding only.

Add the brief-required one-line comment at both task-id generation sites in `src/tasks.js` (currently around lines 954 and 1317) explaining that task IDs intentionally retain the literal `oc_` prefix for compatibility and `WorkerExecutor.taskIdPrefix` is not wired in this issue. Keep the comments succinct and consistent.

Do not address Minor findings in this fix. Run the focused affected tests plus lint for the changed file, commit with a Conventional Commit message, and append the exact commands/results and fix summary to `/workspace/taskferry/.superpowers/sdd/task-1-report.md`.

Return status, commit, one-line test summary, concerns, and report path. End with `Status: DONE` or the appropriate alternate status.
