You are implementing Task 6: resolve requested executors in dispatch/advisor and keep summaries opencode-only.

Read `/workspace/taskferry/.superpowers/sdd/task-6-brief.md` first; it is your requirements.

Tasks 1-5 are complete through `c11912c`. Preserve all unrelated and concurrent uncommitted changes. In particular, intentional worktree edits replace the removed summary model `opencode/hy3-free` with `opencode/mimo-v2.5-free` across source and tests. Integrate around those lines without reverting or staging those unrelated hunks. Do not stash, reset, checkout, clean, or bypass hooks.

Implement optional executor name resolution, executor-specific default models, persisted task.executorId, launch executor objects, explicit opencode summary identity, and advisor forwarding exactly as the brief requires. Unknown executor names must fail fast. Do not change startTask spawning yet; Task 7 owns that.

Use TDD. Run focused tasks tests, executor tests if touched, lint/typecheck, and the full unit suite once. Commit only intended Task 6 hunks normally with the brief's Conventional Commit message and self-review.

Write `/workspace/taskferry/.superpowers/sdd/task-6-report.md` with RED/GREEN evidence, exact commands/results, staged files/hunks, self-review, and concerns. Return only status, commit(s), one-line test summary, concerns, and report path, ending with `Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`.
