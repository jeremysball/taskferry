Fix Task 7's Important review finding: exceptions from `executor.normalizeLogEvent(parsed)` must never escape the stdout EventEmitter callback and crash the daemon.

Handle both complete JSON lines and the trailing JSON fragment through one narrow normalization helper. If normalization throws, write a canonical structured error event to the task log with a stable error name such as `ExecutorNormalizationError` and the thrown message, preserving enough detail for classification and diagnosis. Do not silently swallow the error and do not continue as if the malformed event succeeded. Ensure the task settles through the existing watcher/exit lifecycle with an executor-prefixed structured failure reason. Keep non-JSON preservation unchanged.

Add focused regression coverage with a throwing normalizer proving: emitting stdout does not throw out of the event handler; the structured error reaches the log; and task failure classification is set appropriately after settlement. Cover the trailing-fragment path too if the shared helper does not make it mechanically identical.

Preserve concurrent uncommitted changes; do not stash/reset/checkout/clean, stage unrelated hunks, or bypass hooks. Run focused Task 7 tests, lint/typecheck, and relevant unit verification. Commit only intended fix hunks normally and append exact evidence to `/workspace/taskferry/.superpowers/sdd/task-7-report.md`.

Return status, commit, test summary, concerns, and report path, ending with `Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`.
