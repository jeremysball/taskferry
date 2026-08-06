Review Task 4 as a task-scoped spec and quality gate. Do not modify the checkout.

Read requirements `/workspace/taskferry/.superpowers/sdd/task-4-brief.md`, report `/workspace/taskferry/.superpowers/sdd/task-4-report.md`, and diff `/workspace/taskferry/.superpowers/sdd/review-407de9e..12979e3.diff`. Base `407de9e`, head `12979e3`.

Binding scope: add the pi plain-text `/no api key/i` authentication pattern; parameterize `classifyProviderFailure(lines, errorBucketPrefix)`; update all current call sites with temporary `"opencode"` literals marked for Task 7. Task 4 must not wire executor selection. The added test should exercise classification behavior through the existing manager/watcher pattern rather than merely asserting a regex. The end-to-end `pi_authentication_failed` prefix test is explicitly deferred until Task 7 can make call sites task-aware.

Do not rerun broad tests. Return Spec Compliance, Strengths, Issues by Critical/Important/Minor, and Assessment with explicit `Task quality: Approved` or `Needs fixes`, citing file:line evidence.
