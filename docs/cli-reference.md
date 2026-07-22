# CLI Reference

Every command emits [TOON](https://toonformat.dev/) (Token-Oriented Object
Notation) on stdout, never JSON: roughly 40% fewer tokens than JSON for the
same data, and a tabular form for list-shaped results instead of a repeated
key array. Diagnostics go to stderr. Exit codes distinguish three outcomes:

| Exit code | Meaning |
|---|---|
| `0` | Success, including idempotent no-ops (e.g. cancelling an already-finished task) |
| `1` | Operational error (daemon unreachable, task not found, spawn failure) |
| `2` | Usage error (bad flags, missing required arguments, unknown command) |

Run `taskferry --help` for the command list, or `taskferry <command> --help`
for a single command's usage, options, and examples as TOON.

## `taskferry` (no arguments)

Shows a live view of the current workspace: task counts by status, the task
list, and contextual next-step suggestions.

```
$ taskferry
bin: ~/.local/bin/taskferry
description: Manage background OpenCode tasks in the current workspace.
workspace: /workspace/my-repo
counts:
  queued: 0
  running: 1
  done: 3
  crashed: 0
  cancelled: 0
  unknown: 0
tasks[4]{id,status,model,startedAt}:
  ...
next[2]: Run taskferry status <id> for activity,Run taskferry wait <id> to wait for settlement
```

With no tasks in the workspace, `tasks` reads `"none found in this
workspace"` and `next` suggests `dispatch` instead.

## `taskferry dispatch --prompt <text> [options]`

Queues `opencode run --dir <directory> --auto --format json -- <prompt>` as
a background child process and returns a task summary immediately.

| Flag | Notes |
|---|---|
| `--prompt <text>` | Required. Pass `-` to read the prompt from piped stdin instead (`cat prompt.txt \| taskferry dispatch --prompt -`) — use this for prompts too large to pass as a single command-line argument |
| `--directory <path>` | Defaults to the current workspace; must be an absolute, existing directory |
| `--model <id>` | `provider/model`, e.g. `opencode-go/minimax-m3`. Run `opencode models` to list installed models. Defaults to `openai/gpt-5.6-luna` at variant `high` |
| `--variant <name>` | Reasoning-effort override (`high`, `max`, `minimal`, ...), applied only alongside `--model` |
| `--session-id <id>` | Resume an existing OpenCode session (`--continue --session <id>`) instead of starting fresh; get session ids from a prior `result` or `status --full` |
| `--key-slot <name>` | Use a configured provider-key slot instead of the daemon's ambient key; see [security.md](security.md) |
| `--require-final-marker <regex>` | Fail the task if the final message doesn't match this pattern (case-sensitive, standard JS RegExp semantics). Sets `incomplete: true` on the settled task when the final message is empty (after trimming) or doesn't match. Patterns that don't compile as a standard JS RegExp reject the dispatch up front with a usage error. Useful for enforcing a report-format contract like `^Status: (DONE\|DONE_WITH_CONCERNS\|BLOCKED\|NEEDS_CONTEXT)$` on the last line of model output. |
| `--no-sandbox` | Run this dispatch without the bwrap filesystem sandbox (default: sandboxed on Linux, no-op on macOS); see [security.md](security.md) |

```
$ taskferry dispatch --prompt "Fix the failing tests" --directory /workspace/my-repo
id: oc_mrn4ipkp_19450105
status: running
directory: /workspace/my-repo
model: openai/gpt-5.6-luna
...
next: Run taskferry wait or taskferry status with task id "oc_mrn4ipkp_19450105" to check progress
```

At most `TASKFERRY_MAX_CONCURRENT_TASKS` tasks (default 4) run at once;
extra dispatches return `status: "queued"` and start FIFO as running tasks
finish, are cancelled, fail to spawn, or hit the no-output watchdog. See
[daemon.md](daemon.md) for queueing, the watchdog, and rate limiting.

## `taskferry wait <id> [options]`

Blocks until the task's real `exit` event fires. A 15-minute default
timeout (configurable via `TASKFERRY_WAIT_DEFAULT_TIMEOUT_MS`) prevents
indefinite hangs on stuck tasks. Pass `--timeout-ms` to override the
default cap; the call then returns after that many milliseconds even if
the task is still running. Set `TASKFERRY_WAIT_DEFAULT_TIMEOUT_MS=0` to
disable the default timeout entirely (old behavior).

| Flag | Notes |
|---|---|
| `--timeout-ms <number>` | Override the default timeout cap in milliseconds; omit to use the 15-minute default |
| `--tail-chars <number>` | Include this many trailing narration characters if the task is still running when the timeout elapses |
| `--full` | Include directory, model, session id, log path, and prompt preview |
| `--summarize` | Stream periodic live summaries to stdout while waiting; exits and returns the normal result the moment the task settles. Cannot combine with `--timeout-ms` or `--tail-chars`. |

If it returns `status: "queued"` or `"running"`, the timeout elapsed
before the task settled; a `note` field explains the situation. Call `wait`
again to keep polling, or pass `--timeout-ms` for a longer cap. This
command was named `poll` before the AXI CLI; `taskferry poll` now fails
with a rename notice.

```
$ taskferry wait oc_mrn4ipkp_19450105 --timeout-ms 30000
id: oc_mrn4ipkp_19450105
status: done
startedAt: 2026-07-16T06:24:06.650Z
exitCode: 0
signal: null
next: Run taskferry result with task id "oc_mrn4ipkp_19450105" to see the final message; pass --full here for directory/model/log path details
```

`--summarize` is for a human watching a live terminal, not for scripts or
agents: the periodic lines print as the wait progresses, and the final
line is the same TOON block plain `wait` always returns, so anything
parsing that final output sees no shape change.

## `taskferry advisor --prompt <text> --model <id> [options]`

A blocking "ask a bigger model" call: dispatches like `dispatch`, then waits
internally and returns the answer inline instead of a separate `wait`
round-trip. Use it the way a weaker model consults a stronger one for
planning or hard-debugging help mid-task, not for open-ended background work
(use `dispatch` for that).

| Flag | Notes |
|---|---|
| `--prompt <text>` | Required. Pass `-` to read the prompt from piped stdin instead, same as `dispatch` |
| `--model <id>` | Required, no default; the caller picks the advisor |
| `--directory <path>` | Defaults to the current workspace |
| `--variant <name>` | Optional reasoning-effort override |
| `--session-id <id>` | Resume a prior advisor exchange |
| `--timeout-ms <number>` | Optional early-return cap in milliseconds, same semantics as `wait` — omit to block until the advisor answers |

If it times out before the advisor answers, the response is `status:
"running"` plus `id` and `sessionId`; call `wait` or `advisor` again (with
that `sessionId`) to continue. If a resumed `session_id` has gone idle past
`TASKFERRY_ADVISOR_SESSION_TTL_MS` (default 30 minutes) or is unrecognized
(a typo, or from before a daemon restart), a fresh session starts
automatically instead of erroring; the response's `session_reset` is `true`
and `previous_session_id` holds the id that wasn't reused.

## `taskferry cancel <id> [--grace-ms <number>]`

Stops a running task: sends `SIGTERM` to the task's whole process group
(not just the `opencode` process, so a subprocess it's mid-way through
running, like a long bash command, dies too), escalating to `SIGKILL` after
`--grace-ms` (default 5000) if it hasn't exited. Calling it on a task that
already finished is a no-op that returns a `note` instead of an error, exit
code `0`. The task's status becomes `"cancelled"` once its exit event
lands, distinct from `"crashed"`.

## `taskferry status <id> [--full]`

Returns `{ status: "queued" | "running" | "done" | "crashed" | "cancelled" |
"unknown", exitCode, signal, ... }`. `status` comes from the child process's
actual exit event, not from parsing output. `"unknown"` appears only if the
daemon restarted while the task was still running; see
[daemon.md](daemon.md#recovery).

Lean fields by default; pass `--full` for directory, model, session id, log
path, and prompt preview. `failureReason` is `null` unless the task was
stopped by the no-output watchdog (`"no_output_timeout"`) or a
provider-failure diagnostic (`"rate_limited"`, `"payment_required"`, or
`"authentication_failed"`; see [daemon.md](daemon.md#watchdogs)).
`failureDetail` (also `--full`-only, or via `result --fields
failureDetail`) carries the matched log line or timeout detail behind
whichever `failureReason` fired. `keySlot` echoes the `--key-slot` name the
task was dispatched with, or `null`. `incomplete` is `true` when a `done`
task has an empty final message or one that doesn't match
`--require-final-marker`; `finalMarker` echoes the regex pattern when one
was supplied. Both fields only appear when set; otherwise they are
omitted, matching the convention used by `failureReason`.

## `taskferry tail <id> [--chars <number>]`

Returns the final `--chars` Unicode code points of the newest parsed `text`
event for a task, reading the local task log only (never sends content to a
model). Defaults to 1000, maximum 65536. The response includes the complete
event length and `truncated` so callers know whether the suffix omitted
earlier content.

## `taskferry summary <id> [options]`

Produces a bounded report or activity summary for a task.

| Flag | Notes |
|---|---|
| `--mode report\|activity` | Default `report` |
| `--max-words <number>` | Target length from 75 through 300, default 200 |
| `--wait` | Wait for the task to settle before summarizing |

`--mode report` starts a separate, asynchronous summary task using
`opencode/hy3-free` by default: wait for the returned
`summaryTask.id`, then run `taskferry result` on that id. `--mode activity`
returns a synchronous, cached activity snapshot instead (the same mechanism
`taskferry watch --summaries` uses); see [security.md](security.md) for what
gets sent to the summary model and how to disable it.

## `taskferry result <id> [options]`

Once a task is `done` or `crashed`, parses its log (OpenCode's own
`--format json` NDJSON event stream) into `message` (the model's final turn
only) and `narration` (every `text` event across every step, in order).
A single-step run (no tool calls) has `message === narration`. Also returns
`sessionId`, `tokens`, and `cost`. Returns a polite "still running" message
instead of a partial result if called too early.

A task that exits cleanly but whose final message is empty (after
trimming), or that was dispatched with `--require-final-marker` and whose
final message doesn't match the pattern, carries `incomplete: true`. The
status remains `done`: this distinguishes "the child exited cleanly"
(the existing axis) from "the child produced usable output" (the new axis).
`finalMarker` echoes the regex pattern the task was dispatched with, when
one was set, so a downstream caller can tell which side of the check
tripped.

| Flag | Notes |
|---|---|
| `--full` | Include untruncated narration; only valid when `narration` is in `--fields` |
| `--fields <comma-list>` | Project only the fields you need: `message`, `narration`, `tokens`, `cost`, `sessionId`, `exitCode`, `signal`, `spawnError`, `failureReason`, `failureDetail`, `keySlot`, `logPath`, `incomplete`, `finalMarker` |

```
$ taskferry result oc_mrn4ipkp_19450105
taskId: oc_mrn4ipkp_19450105
status: done
exitCode: 0
sessionId: ses_0966726c8ffeMJPzDyL5PxWd9G
tokens: {total: 24853, input: 22916, output: 31, ...}
cost: 0.00702636
message: PONG
next: Run taskferry result --full or --fields narration with task id "oc_mrn4ipkp_19450105" to see intermediate step narration (4 chars total)
```

## `taskferry list [options]`

Lists tasks scoped to a workspace, newest first, with counts by status.

| Flag | Notes |
|---|---|
| `--directory <path>` | Workspace to inspect, defaults to the current workspace |
| `--all` | Include tasks from every workspace; cannot combine with `--directory` |
| `--limit <number>` | Limit displayed rows while preserving the full counts |

## `taskferry watch [options]`

Streams task state events for a workspace until interrupted (`Ctrl-C`,
SIGTERM), then exits cleanly with code `0`.

| Flag | Notes |
|---|---|
| `--directory <path>` | Workspace to watch, defaults to the current workspace |
| `--format toon\|ndjson` | Stream format, default `toon` |
| `--summaries` | Request live activity summaries (a secondary model call); see [security.md](security.md) |
| `--task-id <id>` | Scope the stream to one task; `watch` then exits on its own once that task settles, instead of running until interrupted |

Without `--task-id`, `watch` streams every task in the workspace until
interrupted. With it, `--directory` is optional — it's resolved from the
task itself when omitted.

`ndjson` emits one JSON object per line, for scripting.

## `taskferry context [options]`

Prints compact current-workspace context for an agent session-start hook:
task counts and rows, nothing else.

| Flag | Notes |
|---|---|
| `--directory <path>` | Workspace to inspect, defaults to the current workspace |
| `--format toon\|claude-hook\|codex-hook` | Default `toon`; the two hook formats wrap the TOON payload in the target agent's expected envelope |

## `taskferry doctor [--full]`

Checks daemon health and installation details: connects (auto-starting the
daemon if needed), and reports `{ healthy, pid }`. `--full` adds `version`,
`cliVersion`, and `protocolVersion`.

Also reports `integrations.claude.installed`, checked locally via `claude
plugin list --json` (not a daemon RPC). See [troubleshooting.md](troubleshooting.md).

## `taskferry --version` / `taskferry -V`

Prints `{ name: "taskferry", version, protocolVersion }`.

## `taskferry setup`

The one-time, idempotent bootstrap for a taskferry checkout. Runs `npm
install` in the checkout, then creates (or refreshes) the two managed
symlinks Taskferry needs on disk:

- `~/.local/bin/taskferry` → `<checkout>/src/cli.js`
- `$XDG_CONFIG_HOME/opencode/plugins/taskferry.js` (default
  `~/.config/opencode/plugins/taskferry.js`) → `<checkout>/src/opencode-plugin.js`

After that, it registers or refreshes the native agent integration for
whichever client CLI is on `PATH` (`claude`, `codex`). The command
deliberately does not connect to the daemon, so it is usable to
bootstrap a fresh or repaired install even when the daemon or
dependencies are currently broken.

### Symlink safety

Both symlinks are self-managed: `setup` only replaces a path at the
target location when that path already is a symlink whose target
resolves to a file in a taskferry checkout (a `package.json` named
`taskferry`). Anything else — a regular file, a directory, a symlink
to an unrelated target, a stale file from an older install — is left
alone, and `setup` exits with `error: refusing to replace unmanaged
path: <path>` and `help: fix the reported dependency or filesystem
problem, then rerun node src/cli.js setup` on stderr. Re-running
`setup` on a current install is a no-op; you can put it in your
post-`git pull` flow without guarding it.

### Output shape

On success, `setup` prints a single TOON document:

```
cli:
  path: /home/user/.local/bin/taskferry
  source: /workspace/taskferry/src/cli.js
opencode:
  path: /home/user/.config/opencode/plugins/taskferry.js
  source: /workspace/taskferry/src/opencode-plugin.js
dependencies: installed
path: available
integrations:
  claude: {status: installed}
  codex: {status: desktop-install-required,next: "Open Codex desktop, install Taskferry from its marketplace, then review and trust its hooks."}
```

Field-by-field:

| Field | Outcome |
|---|---|
| `cli.path`, `cli.source` | Resolved symlink destination and its target after `setup` ran |
| `opencode.path`, `opencode.source` | Same for the OpenCode plugin symlink |
| `dependencies` | Always `"installed"` on a successful run (the `npm install` step) |
| `path` | `"available"` if `~/.local/bin` is already on `PATH`, otherwise `"missing"` with a sibling `pathInstruction: 'export PATH="$HOME/.local/bin:$PATH"'` field |
| `integrations.claude.status` | `"installed"` (CLI on `PATH` and the user-scoped plugin is registered, possibly already installed and now updated), or `"unavailable"` (no `claude` binary, nothing done for Claude) |
| `integrations.codex.status` | `"desktop-install-required"` with a `next` string telling the user to install the plugin through Codex desktop and trust its hooks via `/hooks`, or `"unavailable"` (no `codex` binary) |

The Codex leg cannot install or upgrade the plugin itself — Codex
desktop drives that through its own UI — so the `desktop-install-required`
`next` field is the only place the user has to step in after `setup`
finishes. See [integrations/codex.md](integrations/codex.md) for the
manual Codex desktop flow.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Symlinks and any auto-installable integration succeeded; on Windows `setup` is rejected with `error: taskferry setup requires Unix domain sockets and is unavailable on Windows` (exit `1`) |
| `1` | `npm install` failed, a managed symlink could not be created, an integration command failed, or the platform is Windows |

## Retired names

`taskferry_<name>` MCP tool names, `poll`, and underscore/camelCase
flags from the MCP era (e.g. `--task-id`, `--timeout_ms`) fail with
exit code `2` and a `help:` line naming the current CLI equivalent.
See [migrating-from-mcp.md](migrating-from-mcp.md) for the full table.
