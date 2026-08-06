Review Task 3 as a task-scoped spec and quality gate. Do not modify the checkout.

Read:
- Requirements `/workspace/taskferry/.superpowers/sdd/task-3-brief.md`
- Report `/workspace/taskferry/.superpowers/sdd/task-3-report.md`
- Diff `/workspace/taskferry/.superpowers/sdd/review-319bc6e..407de9e.diff`
- Base `319bc6e`, head `407de9e`

Binding constraints: normalization occurs at the executor boundary; Task 3 only implements the pure pi event mapper and tests, not tasks.js wiring. `message.responseId` is the text/final message key; only text_delta emits text; only tool_execution_end emits one tool_use; tool names stay lowercase; agent_end selects the last assistant message and maps normal stop to step_finish or error stop to structured pi_error; unrelated lifecycle events return null. Opencode remains identity normalization.

Do not rerun broad tests. Judge fixture assertions and edge-case handling from the diff and report. Return Spec Compliance, Strengths, Issues by Critical/Important/Minor, and Assessment with explicit `Task quality: Approved` or `Needs fixes`, citing file:line evidence.
