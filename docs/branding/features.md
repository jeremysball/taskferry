# Taskferry Feature Packaging

This is the feature list for the README. It distinguishes what the source
implements from what deserves headline space.

## Headline features

### Dispatch work without keeping the caller alive

`dispatch` validates a request, creates a durable task record, queues its
launch, and returns a task summary with a next-step hint. The CLI client can
connect to an auto-started daemon rather than owning the worker process.

Evidence: `src/tasks.js:6710-6746`, `src/client.js:592-632`.

### Hold code changes for inspection

Linux dispatches mount the target as a copy-on-write overlay. When a task
produces changes, taskferry extracts a pending changeset. `result --diff` can
show it; `accept` applies it and `reject` discards it.

Evidence: `src/sandbox.js:285-318`, `src/tasks.js:5572-5595`,
`src/tasks.js:6142-6192`.

### Gate acceptance on a project check

`.taskferry.toml` supports a check command. For an overlaid dispatch on a
supported platform, taskferry runs that command in the overlay and records the
gate status before acceptance. `taskferry init` detects a project ecosystem and
scaffolds a proposed check without silently approving it in a non-interactive
call.

Evidence: `src/tasks.js:5727-5819`, `src/init.js:35-64`,
`src/init.js:67-110`.

### Keep deliverables outside the Git diff

Every dispatch receives a per-task scratch directory exposed as
`TASKFERRY_OUTPUT_DIR`. `taskferry output` lists or reads its files after a
task ends, including a task that was cancelled or ended on a tool call instead
of a final message. File reads reject paths that escape the task directory.

Evidence: `src/tasks.js:6726-6739`, `src/tasks.js:6195-6227`,
`src/output-dir.js:417-491`.

### Keep agent sessions aware of the workspace

Native integrations provide workspace task context without requiring one
shared MCP shape. The OpenCode plugin subscribes to daemon events, renders
task toasts, and injects a bounded task block into the system prompt.

Evidence: `src/opencode-plugin.js:245-318`,
`docs/integrations/claude-code.md:62-76`,
`docs/integrations/codex.md:80-96`.

## Secondary features

These are real and documented, but they support the boundary rather than
define it:

- `watch`, `wait --summarize`, `summary`, and `doctor --stats` provide
  operational visibility.
- `advisor` provides a blocking consultation path with session continuation.
- `--session-id` resumes a worker conversation.
- Provider limits, environment-file loading, environment deny-listing, and
  explicit read-only/read-write binds expose power-user controls.
- `--require-final-marker`, `--class`, and `--parent-task` add completion
  contracts, telemetry grouping, and fix-forward lineage.

Evidence: `src/command-specs.js:2-120`, `src/config.js:27-57`,
`docs/cli-reference.md:87-150`.

## Explicit omissions

- Recursive ferry dispatch is a design document, not a shipped feature.
- Automatic model/provider tag routing is a specification, not a current CLI
  capability.
- No screenshot is included in the README. The existing PNGs are brand-board
  and concept-art assets, not captures from a successful taskferry run.

Evidence: `docs/evolution.md:128-141` and the asset files
`taskferry-brand-board.png` / `taskferry-manual-otters.png`.
