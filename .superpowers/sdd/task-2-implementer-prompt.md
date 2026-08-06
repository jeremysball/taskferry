You are implementing Task 2: piExecutor spawn args, model listing, and sandbox auth.

Read this first; it is your requirements, with exact values unless superseded below:
/workspace/taskferry/.superpowers/sdd/task-2-brief.md

This extends issue #94's new executor module. Task 1 is complete at `fabe2e3`; preserve unrelated worktree changes and follow TDD.

The user approved these corrections to contradictions in the written plan:
1. `pi --list-models` emits a padded table. `listModelsFn` must skip the header and normalize each data row's first two whitespace-delimited columns into newline-separated `provider/model` entries, so existing exact model matching can consume it. Add focused tests by injecting/stubbing command output in the smallest maintainable way.
2. A sandboxed pi process must actually use the bound auth directory. Evolve `sandboxAuthFile`'s return shape to include an executor-specific environment override (prefer a concise `sandboxEnv` object): opencode sets sandbox `XDG_DATA_HOME`; pi sets sandbox `PI_CODING_AGENT_DIR`. Task 7 will consume this field. Update both factory returns and source JSDoc/type contract accordingly. For pi, bind real `$PI_CODING_AGENT_DIR/auth.json` or the verified fallback auth path to `<runtimeDir>/pi-data/auth.json`, then return `sandboxEnv: { PI_CODING_AGENT_DIR: <runtimeDir>/pi-data }`. Do not rely on `XDG_DATA_HOME` for pi.
3. Add the literal `WorkerExecutor` and `SpawnLaunchContext` source typedef declarations if still absent, resolving Task 1's carried Minor finding while evolving their return shape.

Do not implement normalization yet; that is Task 3. Run focused tests and the full unit suite once before committing. Commit with the brief's Conventional Commit message and self-review.

Write the full report to `/workspace/taskferry/.superpowers/sdd/task-2-report.md`, including RED/GREEN evidence, exact tests/results, files changed, self-review, and concerns. Return only status, commit(s), one-line test summary, concerns, and report path, ending with `Status: ...`.
