You are implementing Task 8: CLI/RPC wiring for `--executor` on dispatch and advisor.

Read `/workspace/taskferry/.superpowers/sdd/task-8-brief.md` first; it is your requirements.

Task 7 implementation is committed at `621682a` and its independent review is running in parallel. Your files are intentionally non-overlapping with Task 7 production changes: limit implementation to args.js, commands.js, protocol.js, daemon.js and their direct tests. Preserve all concurrent uncommitted changes. Do not touch tasks.js, executor.js, package-lock.json, reports, or unrelated tests. Do not stash/reset/checkout/clean, stage unrelated hunks, or bypass hooks.

Implement flag parsing/validation, command forwarding, protocol allowlists, and daemon advisor forwarding. Add focused tests for dispatch and advisor across the actual existing test files. Include the advisor unknown-executor/error-forwarding edge if straightforward, since Task 6 review carried it as a Minor.

Use TDD. Run focused module tests, lint/typecheck, and full unit suite once. Commit only Task 8 hunks normally with the brief's Conventional Commit message.

Write `/workspace/taskferry/.superpowers/sdd/task-8-report.md` with RED/GREEN evidence, exact commands/results, staged hunks, self-review, and concerns. Return only status, commit, one-line test summary, concerns, and report path, ending with `Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`.
