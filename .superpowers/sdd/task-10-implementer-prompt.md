You are implementing Task 10: a gated end-to-end smoke test against a real pi process.

Read `/workspace/taskferry/.superpowers/sdd/task-10-brief.md` first; it is your requirements.

Tasks 1-9 are complete through `b44c46a`. Preserve all concurrent uncommitted changes. Do not stash/reset/checkout/clean, stage unrelated hunks, or bypass hooks.

Follow the repository's established integration-test placement and gating conventions. The smoke test must exercise real createTaskManager spawn through executor `pi`, confirm a usable final message and opaque session ID, then resume that exact session and confirm the second dispatch settles. It must skip safely by default when pi or the explicit provider env is absent, and must not expose credentials.

Run the gated test once against the real installed pi using an already-working model/provider configuration available on this machine. Do not create a fresh empty PI_CODING_AGENT_DIR that discards existing credentials; use the existing configured directory/environment without printing secrets. Also run the test in default skipped mode, lint/typecheck, and relevant unit verification.

Commit only the smoke test normally with the brief's Conventional Commit message. Write `/workspace/taskferry/.superpowers/sdd/task-10-report.md` with exact commands/results (redacting credentials), staged hunks, self-review, and concerns. Return only status, commit, one-line test summary, concerns, and report path, ending with `Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`.
