Resume Task 7 from the current worktree with this binding compatibility clarification.

Do not rewrite existing opencode failure expectations. Existing named failure buckets (`rate_limited`, `authentication_failed`, `payment_required`, etc.) are shipped behavior and must remain unprefixed for opencode tasks. For pi tasks, known named buckets must receive `pi_` (for example `pi_authentication_failed`) so executor-specific failures are distinguishable. Unknown structured errors continue using the executor prefix as before.

Implement this at the classifier boundary without scattering executor branches: when a known bucket matches, preserve it if `errorBucketPrefix === "opencode"`; otherwise return `${errorBucketPrefix}_${bucket}`. Add focused coverage proving both opencode compatibility and pi prefixing. Revert any in-progress edits that merely changed old opencode test expectations to `opencode_*`; preserve unrelated concurrent changes.

Continue all other Task 7 requirements and the prior user-approved corrections. Do not stash/reset/checkout/clean or bypass hooks. Run the required tests, commit only intended Task 7 hunks, append the complete report to `/workspace/taskferry/.superpowers/sdd/task-7-report.md`, and return the required status contract.
