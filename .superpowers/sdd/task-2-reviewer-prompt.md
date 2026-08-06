Review Task 2 as a task-scoped spec and quality gate. Do not modify the checkout.

Inputs:
- Requirements: `/workspace/taskferry/.superpowers/sdd/task-2-brief.md`
- Implementer report: `/workspace/taskferry/.superpowers/sdd/task-2-report.md`
- Diff package: `/workspace/taskferry/.superpowers/sdd/review-fabe2e3..0a5843d.diff`
- Base `fabe2e3`, head `0a5843d`

Binding corrections approved by the user:
- Normalize pi's padded `--list-models` table into newline-separated `provider/model` entries by skipping the header and using each row's first two whitespace-delimited columns.
- The sandbox auth contract must carry executor-specific environment overrides: opencode's sandbox uses `XDG_DATA_HOME`; pi's uses `PI_CODING_AGENT_DIR`. The pi auth bind destination and environment directory must agree.
- Literal source typedefs should now exist.
- Do not implement pi event normalization yet; Task 3 owns it.
- Two concrete executor factories only, no registry or abstract base class.

The report labels status PARTIAL because two known `tasks.test.js` sandbox tests remain red until Task 7 integrates the new `sandboxEnv` consumer. Judge whether Task 2's producer-side contract is correct independently; flag any real Task 2 gap as Important. Do not rerun broad tests.

Return Spec Compliance, Strengths, Issues by Critical/Important/Minor, and Assessment with an explicit `Task quality: Approved` or `Needs fixes`, citing file:line evidence.
