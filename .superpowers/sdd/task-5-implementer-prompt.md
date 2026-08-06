You are implementing Task 5: add executor identity to task/launch data and default legacy persisted records.

Read `/workspace/taskferry/.superpowers/sdd/task-5-brief.md` first; it is your requirements.

Tasks 1-4 are complete through `12979e3`. Preserve unrelated worktree changes. Add the `defaultExecutor` manager option, update source typedefs, ensure every loaded legacy task missing executorId defaults to opencode at read time, and surface executorId through status/task summaries as required. Do not resolve per-dispatch executor names yet; Task 6 owns that.

Use TDD with a real persisted fixture matching existing test helpers. If helper names differ from the sketch, adapt to established patterns without broad refactoring. Run focused tasks tests, lint/typecheck, and full unit suite once. Commit with the brief's Conventional Commit message and self-review.

Write `/workspace/taskferry/.superpowers/sdd/task-5-report.md` with RED/GREEN evidence, exact commands/results, files changed, self-review, and concerns. Return only status, commit(s), one-line test summary, concerns, and report path, ending with `Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`.
