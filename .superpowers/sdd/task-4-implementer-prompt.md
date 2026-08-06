You are implementing Task 4: parameterize provider-failure bucket prefixes and recognize pi's plain-text auth failure.

Read `/workspace/taskferry/.superpowers/sdd/task-4-brief.md` first; it is your requirements.

Tasks 1-3 are complete through `407de9e`. Preserve unrelated worktree changes. Follow existing tasks.test.js classification test patterns rather than adding a test that merely asserts a regex matches. If the real integration test cannot be written until executor wiring lands, add the smallest meaningful source-level coverage available and clearly identify the later end-to-end test requirement in your report.

Add `/no api key/i`, change `classifyProviderFailure(lines, errorBucketPrefix)`, and update all current call sites with the temporary literal `"opencode"` exactly as the brief says; Task 7 replaces those literals with task-aware values. Do not wire executor selection now.

Use TDD. Run focused tasks tests, lint/typecheck, and the full unit suite once. Commit with the brief's Conventional Commit message and self-review.

Write `/workspace/taskferry/.superpowers/sdd/task-4-report.md` with RED/GREEN evidence, exact commands/results, files changed, self-review, and concerns. Return only status, commits, one-line test summary, concerns, and report path, ending with `Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`.
