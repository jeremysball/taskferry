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
- Write long prompts with the runtime's file-writing tool before invoking Taskferry.
  Pass the file content through command substitution so the rendered shell command
  stays short. Do not inline a long prompt in `--prompt`.
- Wait for settlement, retrieve the result, handle crashes, and validate the
  worker's deliverables yourself.

## AXI CLI

Store each long prompt under Taskferry's XDG state tree. Create the parent directory,
then use the runtime's file-writing tool to write the prompt itself. Do not use a
shell heredoc, because that puts the full prompt back into the rendered command.

```sh
taskferry_state="${TASKFERRY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/taskferry}"
prompt_file="$taskferry_state/prompts/<short-task-name>.txt"
```

Dispatch work with the prompt file and explicit workspace:

```sh
taskferry dispatch --prompt "$(cat "$prompt_file")" --directory "<worktree>"
```

Inspect and wait for a task:

```sh
taskferry status <id>
taskferry wait <id> --tail-chars 1000
taskferry tail <id> --chars 2000
```

Do not pass `--timeout-ms` to `taskferry wait`. The process exits on its own the
moment the task settles; a timeout only makes the caller re-issue `wait` in a
polling loop for no benefit.

Read the final result and request an independent review when needed:

```sh
taskferry result <id>
taskferry advisor --prompt "$(cat "$prompt_file")" --model <provider/model> --directory "<worktree>"
```

Use a distinct prompt file for each concurrent task. Remove it with the runtime's
file tool after the task settles and its result has been validated.

## `no_output_timeout` Crashes

A worker can crash with `status: crashed, failureReason: no_output_timeout` while
genuinely still working, not actually stuck: high-reasoning-effort models can go
silent for minutes mid-turn (long internal reasoning, or a slow tool call such as
a full test suite), and some models (e.g. `glm-5.2`) stream long stretches of
empty `</think>` thinking-tail events that don't reset the watchdog. Taskferry's
own watchdog kills the process regardless of whether real work is happening
underneath.

Treat every `no_output_timeout` crash as a possible false-positive kill, not proof
the task failed:

- Check `taskferry status <id> --full` for `sessionId`. If it is non-null, real
  work happened before the kill — resume that exact session rather than
  re-dispatching fresh and re-paying for research already done:
  `taskferry dispatch --prompt "Continue exactly where you left off and finish
  the task." --model <same model> --directory "<worktree>" --session-id
  <sessionId>`.
- If `sessionId` is null, nothing was salvageable (the process never got far
  enough to start a session) — dispatching fresh is the only option.
- Inspect the worktree (`git status`, `git diff --stat`, look for the expected
  new/changed files) before deciding whether to resume or restart. A crash can
  land mid-write; verify what actually landed on disk rather than assuming
  either "nothing happened" or "it finished."
- Two or more consecutive `no_output_timeout` crashes on the same
  prompt+model+variant combination, especially with `sessionId: null` every
  time, is a signal to change something rather than retry unchanged: drop to a
  less exhaustive `--variant`, switch model/provider, or shorten the prompt so
  the worker produces its first tool call sooner.

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
