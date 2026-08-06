You are implementing Task 7: executor-driven startTask spawning, sandbox auth, stdout normalization, and task-aware failure prefixes.

Read `/workspace/taskferry/.superpowers/sdd/task-7-brief.md` first; it is your requirements, except for the user-approved corrections below.

Tasks 1-6 and prerequisite Task 9 are complete through `56afd33`. Preserve every concurrent uncommitted summary-model/test/report change. Do not stash, reset, checkout, clean, revert, stage unrelated hunks, or bypass hooks.

User-approved corrections that override contradictory plan snippets:
1. Preserve malformed/non-JSON stdout lines verbatim in the canonical log instead of dropping them. This is required because real pi auth failure output is plain text on stdout and exits 0; `classifyProviderFailure` must see it. Preserve complete lines and a final non-empty trailing fragment. JSON events still pass through `executor.normalizeLogEvent`; null normalized events are dropped.
2. Consume the `sandboxEnv` object returned by `executor.sandboxAuthFile` by merging it into spawnEnv. Do not hardcode `XDG_DATA_HOME`; opencode returns that override, while pi returns `PI_CODING_AGENT_DIR`, and each bound auth destination must match its environment directory.
3. Add `binaryName` to WorkerExecutor and both concrete factories as the brief requires.
4. Add the deferred end-to-end classifier test: a pi executor task receiving plain `No API key found for openai.` must settle with `failureReason: "pi_authentication_failed"`.

Implement robust file-descriptor lifecycle and line buffering without swallowing unexpected errors. A closed descriptor during process settlement may be handled narrowly, but do not use broad silent catches for unrelated write/parse problems. Keep stderr writing directly to the log.

Use TDD for write-time normalization, non-JSON preservation, sandboxEnv behavior, spawn binary/args, and pi-prefixed classification. Run focused tasks/executor tests, lint/typecheck, and full unit suite once. Commit only Task 7 hunks normally with the brief's Conventional Commit message.

Write `/workspace/taskferry/.superpowers/sdd/task-7-report.md` with RED/GREEN evidence, exact commands/results, staged hunks, self-review, and concerns. Return only status, commit(s), one-line test summary, concerns, and report path, ending with `Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`.
