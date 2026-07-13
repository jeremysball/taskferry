# opencode-cc-tool

An MCP server that gives Claude Code a first-class tool for dispatching work
to the `opencode` CLI: launch a background task, get a task handle back
immediately, poll status, and fetch the result. No hand-rolled tmux wrappers,
no grepping logs.

## Why

The `using-opencode` Claude Code skill's documented pattern wraps
`opencode run` in a detached tmux session, then polls with
`until ! tmux has-session ...` and greps the log for completion markers
(`EXIT_CODE=[0-9]`, `exiting loop`, etc). That pattern exists because tmux
was available, not because it's the right tool. It has two real problems.

1. **The dispatched process can see the tmux session managing it.** In
   practice, a dispatched `opencode run` with bash access ran
   `tmux list-sessions`, saw its own wrapping session, mistook it for a
   duplicate run of the same task, and burned several minutes in a
   self-referential polling loop. A retry with an explicit "don't touch
   tmux" instruction succeeded.
2. **Completion detection string-matches raw logs.** Markers like
   `EXIT_CODE=` or `Status: DONE` can appear inside quoted or nested text
   (e.g. a sub-task that echoes another log) and produce false positives.
   The skill documents extensive workarounds for exactly this.

This server sidesteps both. It spawns `opencode run` directly as a child
process, with no tmux and no shared session for it to enumerate, and
determines completion from the child process's real `exit` event, not from
log text.

## Tools

### `opencode_dispatch(prompt, directory, model?, variant?, session_id?)`

Starts `opencode run --dir <directory> --auto --format json -- <prompt>` as
a background child process, with stdout and stderr redirected to a private
per-task log file. Returns a task summary immediately, including `id`,
`status: "running"`, `pid`, and `logPath`.

- `directory` must be an absolute path that exists.
- `model`: any valid `provider/model` string (run `opencode models` to list
  them). Defaults to `openai/gpt-5.6-luna --variant high`, mirroring the
  "recommended" tier in the `using-opencode` skill's Select Model table.
  Pass e.g. `opencode-go/minimax-m3` for the "economy" tier on high-volume,
  lower-stakes work.
- `variant`: reasoning effort override (`high`, `max`, `minimal`, etc.),
  applied only when `model` is also given. The default model always uses
  `high`.
- `session_id`: resume an existing opencode session (`--continue --session
  <id>`) instead of starting fresh. Get session ids from a prior
  `opencode_result` or `opencode_status` response.

### `opencode_status(task_id)`

Returns `{ status: "running" | "done" | "crashed" | "unknown", exitCode,
signal, logPath, ... }`. `status` comes from the child process's actual exit
event (`child.on("exit", ...)`), not from parsing output. `"unknown"`
appears only if the server process restarted while the task was still
running; see Limitations.

### `opencode_result(task_id)`

Once a task is `done` or `crashed`, parses its log (opencode's own
`--format json` NDJSON event stream, one JSON object per line) into two
fields:

- `message`: only the model's final turn, the `text` events belonging to
  the messageID whose `step_finish` reason was `"stop"`. This is the actual
  answer, not narration from earlier steps.
- `narration`: every `text` event across every step, in order, separated by
  blank lines. Useful when a run does several tool calls with commentary in
  between and you want the fuller picture, not just the closing line.

A single-step run (no tool calls) has `message === narration`. Also returns
`sessionId`, `tokens`, and `cost` pulled from the `step_finish` events.
Returns a polite "still running" message instead of a partial result if
called too early.

Naively joining every `text` event regardless of step (an earlier version
of this tool did exactly that) glues "I'm about to run `ls`" directly onto
the real answer with no separator, since opencode's steps look like `text`
(narration) → `tool_use` → `step_finish` (`reason: "tool-calls"`) → `text`
(answer) → `step_finish` (`reason: "stop"`). Verified by hand: a prompt
asking opencode to `ls` and report a count produced two `text` events, one
per step; `message` now returns only the second.

### `opencode_list()`

Lists every task known to this server process, newest first.

## Design notes

- **Why `--format json` instead of the default formatted output.**
  opencode's default text output mixes ANSI banners and step formatting
  into the reply, which is awkward to parse reliably. `--format json` emits
  one JSON event per line (`step_start`, `text`, `step_finish`, ...) with a
  stable schema, including the `sessionID` needed for `--continue`.
  Confirmed by hand: `opencode run --format json -- "Reply with the word
  PONG and nothing else."` produced clean NDJSON on stdout and empty
  stderr on success.
- **State directory.** Defaults to `~/.opencode-cc-tool`, computed via
  `os.homedir()` rather than hardcoded, overridable with
  `OPENCODE_CC_TOOL_STATE_DIR`. Holds `tasks.json` (task metadata) and
  `logs/<task_id>.ndjson` (raw opencode output per task).
- **Not tmux, but not fully detached either.** The child is spawned with
  `detached: false`, so it stays in this server process's process group.
  That's deliberate: the server's whole point is to stay alive and listen
  for the child's real `exit` event, so there's no need to detach for
  survival, and staying attached is what makes `exit`-based status correct
  in the first place. Isolation from the orchestration layer, the actual
  bug this tool fixes, comes from not launching via tmux, not from process
  detachment. The child has no session or pane to `tmux list-sessions` its
  way into.

## Limitations and follow-ups

- **State doesn't survive a server restart faithfully.** If the MCP server
  process restarts while a task is still running, the new process has no
  child-process handle to listen for that task's `exit` event (that handle
  exists only in the process that called `spawn`). On reload, any task that
  was `"running"` in `tasks.json` is relabeled `"unknown"` rather than
  reported as a possibly-stale `"running"`. The underlying `opencode`
  process, if still alive, keeps running and writing its log: inspect the
  log file directly, or run `opencode session list`, but this server won't
  re-attach a status watcher to it. A follow-up could periodically recheck
  `unknown` tasks' PIDs and tail their logs for a trailing `step_finish` as
  a secondary signal, but that reintroduces string/heuristic matching for
  exactly the crash-recovery edge case, so it's left out for now rather
  than done half right.
- No task cancellation tool (`opencode_kill` or similar): not requested,
  not built.
- No log rotation or cleanup: `logs/` grows unbounded. Fine for interactive
  use; long-lived automation would want a retention policy.

## Setup

```bash
cd /workspace/opencode-cc-tool
npm install
```

## Register with Claude Code

```bash
claude mcp add opencode-cc-tool -- node /workspace/opencode-cc-tool/src/server.js
```

Use `-s user` instead of the default `-s local` scope to make it available
in every project, or `-s project` to check a `.mcp.json` entry into a
specific repo. To override the state directory:

```bash
claude mcp add opencode-cc-tool -e OPENCODE_CC_TOOL_STATE_DIR=/some/path -- node /workspace/opencode-cc-tool/src/server.js
```

Verify registration:

```bash
claude mcp list
claude mcp get opencode-cc-tool
```

## Smoke test (standalone, no Claude Code needed)

`src/smoke-test.js` drives the server over stdio using the MCP SDK's
`Client`, exactly as Claude Code would: dispatch a trivial task, poll
status until done, fetch the result, and assert the content.

```bash
node src/smoke-test.js /workspace/opencode-cc-tool
```

Expect `SMOKE TEST PASSED` and a result `message` of `PONG`.
