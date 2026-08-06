You are implementing Task 3: piExecutor normalizeLogEvent using verified pi event shapes.

Read this first; it is your exact requirements:
`/workspace/taskferry/.superpowers/sdd/task-3-brief.md`

Tasks 1-2 are complete through `319bc6e`. Preserve unrelated worktree changes. Implement only pi event normalization and its fixture-driven tests; do not wire tasks.js yet. Follow TDD, use the real fixture shapes and exact canonical output in the brief, and keep opencode's identity normalizer unchanged.

Pay particular attention to: `message.responseId` as messageID; only text_delta emits text; only tool_execution_end emits one tool_use event; lowercase tool names stay lowercase; agent_end scans the last assistant message; stopReason error maps to a structured pi_error event.

Run focused tests, lint/typecheck, and the full unit suite once. Commit with the brief's Conventional Commit message and self-review.

Write the full report to `/workspace/taskferry/.superpowers/sdd/task-3-report.md` with RED/GREEN evidence, exact commands/results, files changed, self-review, and concerns. Return only status, commits, one-line test summary, concerns, and report path, ending with `Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`.
