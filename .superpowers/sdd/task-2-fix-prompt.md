Fix both Important findings from Task 2 review.

Verified locally against the real CLI with a writable `PI_CODING_AGENT_DIR`: `pi --list-models` exits 0 with stdout length 0 and the padded table on stderr. Update `piExecutor().listModelsFn` to normalize the actual table stream. Prefer stderr when it contains the table, while remaining tolerant if a pi version writes it to stdout. Filter blank rows correctly, skip the header, and return newline-separated `provider/model` values from the first two columns. Update the injected fixture test so it matches the real `{stdout: "", stderr: table}` result and covers a trailing newline/blank row.

Add the brief-required regression test that `resolveExecutor("pi")` resolves to a pi executor.

Run focused tests, lint/typecheck, and the relevant unit suite. Commit with a Conventional Commit message. Append the fix and exact command/results to `/workspace/taskferry/.superpowers/sdd/task-2-report.md`.

Use only the report statuses DONE, DONE_WITH_CONCERNS, BLOCKED, or NEEDS_CONTEXT. Return status, commit, one-line test summary, concerns, and report path, ending with `Status: ...`.
