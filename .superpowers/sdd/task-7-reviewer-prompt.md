Review Task 7 as a task-scoped spec and quality gate. Do not modify the checkout.

Read requirements `/workspace/taskferry/.superpowers/sdd/task-7-brief.md`, report `/workspace/taskferry/.superpowers/sdd/task-7-report.md` starting at its WorkerExecutor section around line 50 (the opening stale report section predates this task), and isolated diff `/workspace/taskferry/.superpowers/sdd/review-b03f8f7..621682a.diff`. Base `b03f8f7`, head `621682a`.

Binding requirements:
- startTask uses launch.executor for binaryName, buildSpawnArgs, normalization, sandbox auth, and environment overrides.
- JSON stdout lines normalize once at write time; null events drop. Non-JSON complete lines and a final non-empty trailing fragment are preserved verbatim so pi plain-text failures can be classified. stderr remains direct-to-log.
- sandboxEnv is merged executor-specifically: opencode XDG_DATA_HOME; pi PI_CODING_AGENT_DIR. Bind destination and env directory agree.
- fd lifecycle remains safe through exit/error without broad swallowed errors.
- opencode named failure buckets remain unprefixed for compatibility; pi known buckets receive pi_; structured unknown errors remain executor-prefixed.
- Add end-to-end pi plain-text auth classification, spawn binary/args, sandbox env, normalization, and compatibility tests.
- Downstream log readers remain executor-agnostic.

Concurrent commits `c5b5147`/`b03f8f7` removed summary agent isolation before this Task 7 commit and are outside the isolated diff. Judge integration against that base. Scrutinize the 544-line test-heavy change for fd races, lost output, malformed-line handling, spawn error handling, accidental unrelated edits, and tests that only prove mocks.

Do not rerun broad tests. Return Spec Compliance, Strengths, Issues by Critical/Important/Minor, and Assessment with explicit `Task quality: Approved` or `Needs fixes`, citing file:line evidence.
