# taskferry

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

Every tool below returns [TOON](https://toonformat.dev/) (Token-Oriented
Object Notation), not JSON — ~40% fewer tokens for the same data, and the
tabular form (`taskferry_list`) reads as a compact header-plus-rows table
instead of a repeated-keys array. Follows the
[AXI](https://github.com/kunchenguid/axi) design principles for
agent-facing CLIs/tools: minimal per-row schemas, explicit empty states,
`error:`/`help:` pairs on failure, and a `next` hint on responses where the
follow-up call isn't obvious.

### `taskferry_dispatch(prompt, directory, model?, variant?, session_id?)`

Queues `opencode run --dir <directory> --auto --format json -- <prompt>` for
background execution, with stdout and stderr redirected to a private per-task
log file. Returns a task summary immediately. The first two tasks in each
rolling five-second window start immediately; later tasks return
`status: "queued"` until a launch slot opens.

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
  `taskferry_result` or `taskferry_status` response.

#### Launch rate

- `TASKFERRY_MAX_DISPATCHES_PER_WINDOW`: maximum task launches per
  rolling window. Defaults to `2`.
- `TASKFERRY_DISPATCH_WINDOW_MS`: rolling-window duration in
  milliseconds. Defaults to `5000`.

### `taskferry_poll(task_id, timeout_ms?, tail_chars?)`

Blocks until the task's real `exit` event fires, or `timeout_ms` elapses
(capped at 45000 regardless of what's passed, to stay under Claude Code's
own 60s default MCP tool-call timeout), then returns the same status shape
as `taskferry_status`. This is the closest available analog to the built-in
Agent tool's auto-resume behavior: call once, get blocked, get a result,
instead of looping on `taskferry_status` yourself. If it returns with
`status: "queued"` or `"running"`, the task simply outlived the cap; call it again. Pass
`tail_chars` to include the trailing parsed narration from a task that is
still running after the timeout, plus its full character count and whether
the tail was truncated.

### `taskferry_advisor(prompt, directory, model, variant?, session_id?, timeout_ms?)`

A blocking "ask a bigger model" call: dispatches like `taskferry_dispatch`,
then polls internally and returns the answer inline instead of requiring a
separate `taskferry_poll` round-trip. Use it the way a weaker model consults
a stronger one for planning or hard-debugging help mid-task, not for
open-ended background work (use `taskferry_dispatch` for that).

- `model` is required, with no default (unlike `taskferry_dispatch`); the
  caller picks the advisor.
- Capped at 45000ms like `taskferry_poll`. If it times out before the
  advisor answers, the response is `status: "running"` plus `task_id` and
  `session_id`; call `taskferry_poll` or `taskferry_advisor` again (with
  that `session_id`) to continue.
- `session_id` resumes a prior advisor exchange. If that session has gone
  idle past `TASKFERRY_ADVISOR_SESSION_TTL_MS` (default 30 minutes) or is
  unrecognized (e.g. a typo, or from before a server restart), a fresh
  session starts automatically instead of erroring; the response's
  `session_reset` is `true` and `previous_session_id` holds the id that
  wasn't reused. This avoids ever silently resuming a conversation whose
  prompt cache has gone cold.

### `taskferry_cancel(task_id, grace_ms?)`

Stops a running task: sends `SIGTERM` to the task's whole process group
(not just the `opencode` process, so a subprocess it's mid-way through
running, like a long bash command, dies too), escalating to `SIGKILL` after
`grace_ms` (default 5000) if it hasn't exited. Calling it on a task that
already finished is a no-op that returns a `note` instead of an error. The
task's status becomes `"cancelled"` once its exit event lands, distinct
from `"crashed"`.

### `taskferry_status(task_id)`

Returns `{ status: "queued" | "running" | "done" | "crashed" | "cancelled" |
"unknown", exitCode, signal, logPath, ... }`. `status` comes from the child
process's actual exit event (`child.on("exit", ...)`), not from parsing
output. `"unknown"` appears only if the server process restarted while the
task was still running; see Limitations.

### `taskferry_tail(task_id, chars?)`

Returns the final `chars` Unicode code points of the newest parsed `text`
event for a task. It reads the local task log only and never sends content to
a model. `chars` defaults to 1000 and has a maximum of 65536. The response
includes the complete event length and `truncated` so callers know whether the
suffix omitted earlier content.

### `taskferry_summary(task_id, max_words?)`

Captures a bounded snapshot of observed task narration and starts a separate
summary task using `opencode-go/deepseek-v4-flash` by default. The summary is
asynchronous: wait for the returned `summaryTask.id`, then call
`taskferry_result` on that ID.

The snapshot is sent to the configured model provider. Do not summarize logs
containing secrets you do not want to send to that provider. The summary child
uses a private attachment, runs outside the source workspace, disables plugins,
and denies every agent tool. Set `TASKFERRY_SUMMARY_MODEL` to select an
available replacement model. `max_words` is a target between 75 and 300 words;
it defaults to 200.

### `taskferry_result(task_id, full?, fields?)`

Once a task is `done` or `crashed`, parses its log (opencode's own
`--format json` NDJSON event stream, one JSON object per line) into two
fields:

- `message`: the model's final turn only, the `text` events belonging to
  the messageID whose `step_finish` reason was `"stop"`. This is the actual
  answer; narration from earlier steps lives in `narration` instead.
- `narration`: every `text` event across every step, in order, separated by
  blank lines. Useful when a run does several tool calls with commentary in
  between and you want the fuller picture, not just the closing line.

A single-step run (no tool calls) has `message === narration`. Also returns
`sessionId`, `tokens`, and `cost` pulled from the `step_finish` events.
Returns a polite "still running" message instead of a partial result if
called too early.

Pass `fields` to project only the data needed by the caller. For example,
`fields: ["message"]` returns only `taskId`, `status`, and the final assistant
turn. Omit `fields` for the complete backward-compatible result. `full: true`
is valid only when the narration field is requested.

Naively joining every `text` event regardless of step (an earlier version
of this tool did exactly that) glues "I'm about to run `ls`" directly onto
the real answer with no separator, since opencode's steps look like `text`
(narration) → `tool_use` → `step_finish` (`reason: "tool-calls"`) → `text`
(answer) → `step_finish` (`reason: "stop"`). Verified by hand: a prompt
asking opencode to `ls` and report a count produced two `text` events, one
per step; `message` now returns only the second.

### `taskferry_list()`

Lists every task known to this server process, newest first.

## Why polling and waiting, not push notifications

The built-in Agent tool notifies Claude Code when a background subagent
finishes; this server can't replicate that for MCP tools in general,
because the relevant MCP mechanism is either unsupported or explicitly
rejected as of mid-2026:

- Generic server-initiated `notifications/message` pushed into the model's
  context: closed as **not planned** by Anthropic
  ([anthropics/claude-code#36665](https://github.com/anthropics/claude-code/issues/36665)).
  MCP's request-response shape means a server can't interrupt the model
  mid-turn to say "your task finished."
- **Channels** ([code.claude.com/docs/en/channels](https://code.claude.com/docs/en/channels))
  are the real, shipped mechanism for pushing events into a live session,
  but they're a heavier fit than they first look: research preview,
  Anthropic-account auth only, built as a Bun plugin rather than a plain
  stdio MCP server, and only active when the session was launched with
  `claude --channels plugin:<name>@<marketplace>`. Being registered via
  `claude mcp add` (how this server is set up) isn't enough on its own;
  channels are a separate registration path. Worth revisiting if this tool
  needs true async push later, but out of scope for now.

`taskferry_poll` is the practical middle ground: one blocking call that
resolves the moment the task's exit event fires, capped well under Claude
Code's MCP tool-call timeout so it degrades to a clean "still running"
rather than an error. It gets Agent-tool-like ergonomics (dispatch, then
one call that "just returns when it's done") without depending on a
research-preview feature.

## Design notes

- **Why `--format json` instead of the default formatted output.**
  opencode's default text output mixes ANSI banners and step formatting
  into the reply, which is awkward to parse reliably. `--format json` emits
  one JSON event per line (`step_start`, `text`, `step_finish`, ...) with a
  stable schema, including the `sessionID` needed for `--continue`.
  Confirmed by hand: `opencode run --format json -- "Reply with the word
  PONG and nothing else."` produced clean NDJSON on stdout and empty
  stderr on success.
- **State directory.** Defaults to `$XDG_STATE_HOME/taskferry` (or
  `~/.local/state/taskferry` if `XDG_STATE_HOME` is unset), computed via
  `os.homedir()` rather than hardcoded, overridable with
  `TASKFERRY_STATE_DIR`. Holds `tasks.json` (task metadata) and
  `logs/<task_id>.ndjson` (raw opencode output per task).
- **Not tmux, but `detached: true`, for a narrower reason than survival.**
  The server holds a direct reference to the child and listens on its
  `exit` event regardless of `detached`; that part doesn't need detaching.
  `detached: true` matters for `taskferry_cancel`: it makes the child its
  own process group leader (`pgid === pid`), so `taskferry_cancel` can
  signal the whole group with `process.kill(-pid, ...)` and reach a
  subprocess `opencode` spawned (e.g. a bash command it's running), not
  just the `opencode` process itself. Without `detached: true`, the child
  would share this server's own process group, and a group-kill would risk
  taking the server down with it. Isolation from the orchestration layer,
  the actual bug this tool fixes, comes from not launching via tmux at all:
  the child has no session or pane to `tmux list-sessions` its way into,
  independent of the `detached` flag.

## Limitations and follow-ups

- **Queued and running state survive only for the current server process's lifetime.** If the
  MCP server process restarts while a task is still running, the new
  process has no child-process handle to listen for that task's `exit`
  event (that handle exists only in the process that called `spawn`). On
  reload, the server relabels any task still marked `"queued"` or `"running"`
  in `tasks.json` as `"unknown"` instead of reporting a possibly-stale state.
  The underlying `opencode` process, if still alive, keeps
  running and writing its log: inspect the
  log file directly, or run `opencode session list`, but this server won't
  re-attach a status watcher to it. A follow-up could periodically recheck
  `unknown` tasks' PIDs and tail their logs for a trailing `step_finish` as
  a secondary signal, but that reintroduces string/heuristic matching for
  exactly the crash-recovery edge case, so it's left out for now rather
  than done half right.
- No log rotation or cleanup: `logs/` grows unbounded. Fine for interactive
  use; long-lived automation would want a retention policy.

## Setup

```bash
cd /path/to/taskferry
npm install
```

## Register with Claude Code

```bash
claude mcp add taskferry -- node /path/to/taskferry/src/server.js
```

Use `-s user` instead of the default `-s local` scope to make it available
in every project, or `-s project` to check a `.mcp.json` entry into a
specific repo. To override the state directory:

```bash
claude mcp add taskferry -e TASKFERRY_STATE_DIR=/some/path -- node /path/to/taskferry/src/server.js
```

Verify registration:

```bash
claude mcp list
claude mcp get taskferry
```

## Migrating from `opencode-cc-tool`

If you previously registered this server as `opencode-cc-tool`, remove the
old entry first (it pins the old tool names, which the renamed server no
longer exposes), then add the new one:

```bash
claude mcp remove opencode-cc-tool
claude mcp add taskferry -- node /path/to/taskferry/src/server.js
```

To carry over existing task state from the old default location
(`~/.opencode-cc-tool/tasks.json`) to the new one
(`$XDG_STATE_HOME/taskferry/tasks.json`, or
`~/.local/state/taskferry/tasks.json` when `XDG_STATE_HOME` is unset):

```bash
mkdir -p "${XDG_STATE_HOME:-$HOME/.local/state}/taskferry"
mv ~/.opencode-cc-tool/tasks.json "${XDG_STATE_HOME:-$HOME/.local/state}/taskferry/tasks.json"
mv ~/.opencode-cc-tool/logs        "${XDG_STATE_HOME:-$HOME/.local/state}/taskferry/logs"
```

The env var prefix also changed: `OPENCODE_CC_TOOL_STATE_DIR` is now
`TASKFERRY_STATE_DIR`. Update any `-e` flags in your `claude mcp add` line
accordingly.

## Testing

Two layers, deliberately kept separate: unit tests never touch a real
`opencode` process; integration tests only ever touch a real one.

### Unit tests (`npm test` / `npm run test:unit`)

```bash
npm test
```

53 tests across `src/tasks.test.js` and `src/server.test.js`, using Node's built-in
`node:test` (no test framework dependency), covering `src/tasks.js`'s task-lifecycle logic
input validation, the `error:`/`help:` message format shared by every
lookup function, `list()`'s counts and empty state, `result()`'s
message/narration parsing and 2000-char truncation, and the full
dispatch → exit/error → settle lifecycle (`done`, `crashed`, `cancelled`,
spawn `error`) including `cancel()`'s SIGTERM-then-SIGKILL escalation
timer. Runs in well under a second, deterministically, with no network or
subprocess calls.

**How they avoid spawning real processes: dependency injection.**
`tasks.js` exports `createTaskManager({ spawnFn, killFn, stateDir })`, a
factory rather than a module-level singleton. The real server
(`server.js`) imports `defaultTaskManager`, a single instance built with
the real `child_process.spawn` and `process.kill`. Tests instead call
`createTaskManager()` directly with:

- a fake `spawnFn` returning a plain `EventEmitter` (with `.pid` and a
  no-op `.unref()`) that the test drives itself via
  `child.emit("exit", code, signal)` / `child.emit("error", err)` — no
  real subprocess, no timing to race
- a fake `killFn` that records calls instead of sending real OS signals,
  letting tests assert exactly which pid/signal pairs `cancel()` sent
  (including the negative-pid-then-plain-pid ESRCH fallback) without ever
  touching a real process group
- an isolated temp `stateDir` per test, so `tasks.json`/`logs/` never
  collide across tests or with a real server's state

Both fakes default to throwing loudly if called without being explicitly
injected, so a test that forgets to inject one fails immediately instead
of silently spawning something real.

### Integration tests (`npm run test:integration`)

```bash
npm run test:integration
```

Runs all three smoke tests below in sequence, each driving the real
server over stdio via the MCP SDK's `Client`, exactly as Claude Code
would, dispatching real `opencode run` calls (real tokens, real cost, a
minute or so total). Each defaults its working directory to this
package's own root if no argument is given; pass one explicitly to run
against a different directory:

```bash
node src/smoke-test.js          # dispatch, poll status, fetch result; expects PONG
node src/cancel-smoke-test.js   # dispatch a sleep, cancel it, confirm the process group is gone
node src/poll-smoke-test.js     # taskferry_poll resolving early and hitting its cap
```

Each prints a `... SMOKE TEST PASSED` or `FAILED` line and exits
accordingly. These are the only tests that exercise the real `spawn`
call, real signal delivery to a real process group, and TOON encoding
over the actual stdio transport — the things dependency injection
deliberately keeps out of the unit tests above.
