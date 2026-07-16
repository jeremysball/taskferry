---
name: taskferry
description: Dispatch and validate background OpenCode work through taskferry's AXI CLI inside subagent-driven-development.
---

# Taskferry Worker Backend

Use Taskferry as the worker backend inside `subagent-driven-development`. The
`subagent-driven-development` lifecycle owns task briefs, worktrees, implementer
and reviewer passes, fixes, and final verification. Taskferry owns external worker
execution. Taskferry is not an alternative lifecycle.

## Worker Contract

- Select the worker model, variant, and optional key slot explicitly when the task
  needs them.
- Start fresh sessions for each separate implementation task and each reviewer.
- Resume only the implementer session for a fix to that same task.
- Keep the task brief and directory explicit so the worker operates in the intended
  worktree.
- Wait for settlement, retrieve the result, handle crashes, and validate the
  worker's deliverables yourself.

## AXI CLI

Dispatch work with a complete prompt and workspace:

```sh
taskferry dispatch --prompt "<task brief>" --directory "<worktree>"
```

Inspect and wait for a task:

```sh
taskferry status <id>
taskferry wait <id> --tail-chars 1000
taskferry tail <id> --chars 2000
```

Read the final result and request an independent review when needed:

```sh
taskferry result <id>
taskferry advisor --prompt "<review question>" --model <provider/model> --directory "<worktree>"
```

Use `taskferry cancel <id>` for work that should stop. Use `taskferry list` or
`taskferry context --format toon` to inspect workspace-scoped state. The CLI emits
structured data, errors, and help as TOON on stdout, keeps diagnostics on stderr,
and uses exit codes to distinguish success, operational failure, and usage errors.

## Codex Installation And Hooks

Install this integration through Codex's native plugin mechanism:

```sh
codex plugin marketplace add .
codex plugin install taskferry@taskferry
```

The plugin injects current workspace context at `SessionStart` and refreshes it at
`UserPromptSubmit`. It does not provide a persistent live monitor surface. Codex
requires you to review and trust plugin hooks through `/hooks` before they run. If
hooks are disabled in your Codex configuration, enable them only when you want this
lifecycle context by setting:

```toml
[features]
hooks = true
```
