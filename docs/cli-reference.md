# CLI Reference

Every command emits [TOON](https://toonformat.dev/) (Token-Oriented Object
Notation) on stdout by default: roughly 40% fewer tokens than JSON for the
same data, and a tabular form for list-shaped results instead of a repeated
key array. The one exception is `watch --format ndjson`, which emits one
JSON object per line for scripting — see below. Diagnostics go to stderr.
Exit codes distinguish three outcomes:

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
next[3]: Run taskferry status <id> for activity,Run taskferry wait <id> to wait for settlement,Run taskferry result <id> for the final answer
```

With no tasks in the workspace, `tasks` reads `"none found in this
workspace"` and `next` suggests `dispatch` instead.

## `taskferry dispatch --prompt <text> [options]`

Queues a `pi --model <model> --mode json -p <prompt>` invocation (the
built-in default executor), or the equivalent `opencode run --dir
<directory> --auto --format json -m <model> -- <prompt>` when `--executor
opencode` is given, as a background child process and returns a task
summary immediately.

| Flag | Notes |
|---|---|
| `--prompt <text>` | Required. Pass `-` to read the prompt from piped stdin instead (`cat prompt.txt \| taskferry dispatch --prompt -`) — use this for prompts too large to pass as a single command-line argument |
| `--directory <path>` | Defaults to the current workspace; an existing directory (relative paths are resolved against the current working directory) |
| (no flag — always on) | `dispatch`, `advisor`, and `summary` (report mode) forward the calling shell's own environment to the daemon on every call, with no per-call opt-out; see [security.md](security.md#caller-env-forwarding) |
| `--model <id>` | `provider/model`, e.g. `opencode-go/minimax-m3`. Run `opencode models` to list installed models. Defaults to `minimax/MiniMax-M2.7` for the default `pi` executor; `--executor opencode` defaults to `openai/gpt-5.6-luna` instead. When `--session-id` is given without `--model`, the model is instead inherited from the most recent prior task dispatched with that session id |
| `--variant <name>` | Reasoning-effort override, applied only alongside `--model` — omitting `--model` (including on a `--session-id` resume) always forces variant `high`, regardless of any `--variant` passed. Accepted values depend on the executor: pi takes `off`, `minimal`, `low`, `medium`, `high`, `xhigh`; opencode's `--variant` values depend on the model |
| `--executor <opencode\|pi>` | Which worker CLI to spawn. Built-in default `pi`, but an omitted flag actually falls back to the daemon's configured default executor (`TASKFERRY_DEFAULT_EXECUTOR` or `config.json`'s `defaultExecutor`) |
| `--session-id <id>` | Resume an existing session instead of starting fresh (`--continue --session <id>`; both pi and opencode use this syntax). When `--executor` is omitted, inherits whichever executor originally created the session; get session ids from a prior `result` or `status --full` |
| `--allowed-dirs <path,path,...>` | Extra directories bound read-write inside the sandbox for this dispatch, on top of the auto-detected git-common-dir for a worktree and any config-level `allowedDirs`; see [security.md](security.md) |
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
indefinite hangs on stuck tasks. Pass `--timeout` to override the
default cap; the call then returns after that duration elapses, even if
the task is still running. Set `TASKFERRY_WAIT_DEFAULT_TIMEOUT_MS=0` to
disable the default timeout entirely (old behavior).

| Flag | Notes |
|---|---|
| `--timeout <duration>` | Override the default timeout cap — milliseconds or a duration string (30s, 5m, 1h); omit to use the 15-minute default |
| `--tail-chars <number>` | Include this many trailing narration characters if the task is still running when the timeout elapses |
| `--full` | Include directory, model, session id, log path, and prompt preview |
| `--summarize` | Stream periodic live summaries to stdout while waiting; exits and returns the normal result the moment the task settles. Cannot combine with `--timeout` or `--tail-chars`. |

If it returns `status: "queued"` or `"running"`, the timeout elapsed
before the task settled; a `note` field explains the situation. Call `wait`
again to keep polling, or pass `--timeout` for a longer cap. This
command was named `poll` before the AXI CLI; `taskferry poll` now fails
with a rename notice.

```
$ taskferry wait oc_mrn4ipkp_19450105 --timeout 30s
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
| `--directory <path>` | Defaults to the current git workspace root (falls back to the literal current directory outside a git repo) |
| `--variant <name>` | Optional reasoning-effort override |
| `--executor <opencode\|pi>` | Which worker CLI to spawn. Built-in default `pi`, but an omitted flag actually falls back to the daemon's configured default executor (`TASKFERRY_DEFAULT_EXECUTOR` or `config.json`'s `defaultExecutor`) |
| `--session-id <id>` | Resume a prior advisor exchange |
| `--timeout <duration>` | Early-return cap — milliseconds or a duration string (30s, 5m, 1h), same semantics as `wait`; omitting it does not block indefinitely — it falls back to a 45-second internal cap, after which the "still running" response below is returned |

If it times out before the advisor answers, the response is `status:
"running"` plus `task_id` and `session_id`; call `wait` or `advisor` again
(with that `session_id`) to continue. If a resumed `session_id` has gone idle past
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
provider-failure diagnostic — `"rate_limited"`, `"payment_required"`, or
`"authentication_failed"` for the `opencode` executor, the same three
buckets prefixed with the executor name for others (e.g.
`"pi_rate_limited"`), or an executor-prefixed error-class name as a
fallback; see [daemon.md](daemon.md#watchdogs)).
`failureDetail` (also `--full`-only, or via `result --fields
failureDetail`) carries the matched log line or timeout detail behind
whichever `failureReason` fired. `incomplete` is `true` when a `done`
task has an empty final message or one that doesn't match
`--require-final-marker`; `finalMarker` echoes the regex pattern when one
was supplied. Both fields only appear when set, unlike `failureReason`/
`failureDetail`, which are always present (as `null` when unset).

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
| `--max-words <number>` | Target length from 75 through 300; default 200 for `--mode report`, 75 for `--mode activity` |
| `--wait` | Wait for the task to settle before summarizing |

`--mode report` starts a separate, asynchronous summary task using
`opencode/mimo-v2.5-free` by default: wait for the returned
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
| `--full` | Include untruncated narration; only rejected as a usage error when combined with `--fields` that omits `narration` — `--full` alone (no `--fields`) works fine |
| `--fields <comma-list>` | Project only the fields you need: `message`, `narration`, `tokens`, `cost`, `sessionId`, `exitCode`, `signal`, `spawnError`, `failureReason`, `failureDetail`, `logPath`, `incomplete`, `finalMarker`, `diff`, `diffStat`, `changesetError` |
| `--diff` | Print the task's pending changeset (read-only; cannot combine with `--fields` or `--full`) |

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

## `taskferry accept <id>`

Applies the dispatch task's pending changeset to its target directory.
Only meaningful for a task with `changesetStatus: "pending"` (visible on
`taskferry status` / `taskferry wait` without `--full`); a no-op write
that auto-resolved to `accepted` cannot be re-accepted. Inspect the
change with `taskferry result <id> --diff` first — note the diff can
include files the worker never touched: git-target extraction stages the
overlay's whole merged view, so files already untracked in the dispatch
directory at dispatch time appear as new-file entries, and the plain
`git apply` fails outright if they still exist on disk (see the
sourcemap's "Things that look like bugs but aren't"). For a git target, the
apply is `git apply` against the real pre-dispatch `HEAD`; for a non-git
target, it runs an in-sandbox `rsync --delay-updates` that needs the
live overlay, so a non-git changeset left pending across a reboot fails
loudly and can only be rejected, never applied. A successful apply
transitions the task to `changesetStatus: "accepted"` and frees the CoW
overlay. A failed apply leaves the task pending so a retry or reject can
follow. Calling it on a task that already settled (no pending changeset)
is a no-op that returns a `note` instead of an error, exit code `0`. The
advisor role (`taskferry advisor`) has no accept path — its changeset is
auto-rejected right after extraction.

## `taskferry reject <id>`

Discards the task's pending changeset without applying it. Only
meaningful for a task with `changesetStatus: "pending"`; an already
accepted, already rejected, or auto-resolved task is a no-op that
returns a `note` instead of an error, exit code `0`. Frees the CoW
overlay.

## `taskferry list [options]`

Lists tasks scoped to a workspace, newest first, with counts by status.

| Flag | Notes |
|---|---|
| `--directory <path>` | Workspace to inspect, defaults to the current git workspace root (falls back to the literal current directory outside a git repo) |
| `--all` | Include tasks from every workspace; cannot combine with `--directory` |
| `--limit <number>` | Limit displayed rows while preserving the full counts |

## `taskferry watch [options]`

Streams task state events for a workspace until interrupted (`Ctrl-C`,
SIGTERM), then exits cleanly with code `0`.

| Flag | Notes |
|---|---|
| `--directory <path>` | Workspace to watch, defaults to the current git workspace root (falls back to the literal current directory outside a git repo) |
| `--format toon\|ndjson` | Stream format, default `toon` |
| `--summaries` | Request live activity summaries (a secondary model call); see [security.md](security.md) |
| `--flush-interval <duration>` | Batch `--summaries` events and print them together on this interval instead of streaming individually; milliseconds or a duration string (30s, 5m, 1h); requires `--summaries` |
| `--task-id <id>` | Scope the stream to one task; `watch` then exits on its own once that task settles, instead of running until interrupted. This is the one command where `--task-id` is still live — see "Retired names" below. |

Without `--task-id`, `watch` streams every task in the workspace until
interrupted. With it, `--directory` is optional — it's resolved from the
task itself when omitted.

`ndjson` emits one JSON object per line, for scripting.

With `--flush-interval`, `ndjson` emits one `{"type": "watch.flush", "timestamp": ..., "events": [...]}` object per flush tick instead of one object per event; `toon` renders the same buffered events as today's per-event lines, just batched under one tick.

## `taskferry context [options]`

Prints compact current-workspace context for an agent session-start hook:
task counts and rows, nothing else.

| Flag | Notes |
|---|---|
| `--directory <path>` | Workspace to inspect, defaults to the current git workspace root (falls back to the literal current directory outside a git repo) |
| `--format toon\|claude-hook\|codex-hook` | Default `toon`; the two hook formats wrap the TOON payload in the target agent's expected envelope |

## `taskferry doctor [--full]`

Checks daemon health and installation details: connects (auto-starting the
daemon if needed), and reports `{ healthy, pid, version }`. `--full` adds
`cliVersion` and `protocolVersion`.

Also reports `integrations.claude.installed`, checked locally via `claude
plugin list --json` (not a daemon RPC), and
`integrations.playwrightMcpIsolation.{opencode,claudeCode}` — each client's
Playwright MCP browser-profile isolation status. This is a read-only check
(`{checked, path, isolated}`, or `{checked: false, reason}` if there was
nothing to check), a different, non-mutating shape from the `{changed, ...}`
fields `setup` returns for the same two clients — `doctor` never edits a
config file, `setup` does. A conditional `warnings[]` array appears when
Playwright MCP isolation is missing (concurrent dispatches sharing one
browser profile can crash with SIGKILL) or bwrap isn't installed on Linux
(dispatches then fail fast with a `crashed` task and a `spawnError` — there
is no silent unsandboxed fallback; see [security.md](security.md)); a
conditional `info[]` array appears on
non-Linux platforms noting sandboxing is unavailable there. See
[troubleshooting.md](troubleshooting.md).

## `taskferry --version` / `taskferry -V`

Prints `{ name: "taskferry", version, protocolVersion }`.

## `taskferry setup`

The one-time, idempotent bootstrap for a taskferry checkout. Runs `npm
install` in the checkout, then creates (or refreshes) the three managed
symlinks Taskferry needs on disk:

- `~/.local/bin/taskferry` → `<checkout>/src/cli.js`
- `$XDG_CONFIG_HOME/opencode/plugins/taskferry.js` (default
  `~/.config/opencode/plugins/taskferry.js`) → `<checkout>/src/opencode-plugin.js`
- `~/.local/bin/tf-sl` → `<checkout>/src/tf-sl.sh`

After that, it registers or refreshes the native agent integration for
whichever client CLI is on `PATH` (`claude`, `codex`). The command
deliberately does not connect to the daemon, so it is usable to
bootstrap a fresh or repaired install even when the daemon or
dependencies are currently broken.

### Symlink safety

All three symlinks are self-managed: `setup` only replaces a path at the
target location when that path already is a symlink whose target
resolves to a file in a taskferry checkout (a `package.json` named
`taskferry`). Anything else — a regular file, a directory, a symlink
to an unrelated target, a stale file from an older install — is left
alone, and `setup` exits with `error: refusing to replace unmanaged
path: <path>` and `help: fix the reported dependency or filesystem
problem, then rerun node src/cli.js setup` on stderr. Re-running
`setup` on a current install is idempotent — it always re-runs `npm
install` and unlinks/recreates the managed symlinks, but ends in the same
state either way — so you can put it in your post-`git pull` flow without
guarding it.

### Output shape

On success, `setup` prints a single TOON document:

```
cli:
  path: /home/user/.local/bin/taskferry
  source: /workspace/taskferry/src/cli.js
opencode:
  path: /home/user/.config/opencode/plugins/taskferry.js
  source: /workspace/taskferry/src/opencode-plugin.js
statusline:
  path: /home/user/.local/bin/tf-sl
  source: /workspace/taskferry/src/tf-sl.sh
dependencies: installed
path: available
integrations:
  claude: {status: installed}
  codex: {status: desktop-install-required,next: "Open Codex desktop, install Taskferry from its marketplace, then review and trust its hooks."}
playwrightMcpIsolation:
  opencode: {changed: false, reason: "no writable opencode.json with a playwright MCP entry found"}
  claudeCode: {changed: false, path: /home/user/.playwright-mcp/config.json}
```

Field-by-field:

| Field | Outcome |
|---|---|
| `cli.path`, `cli.source` | Resolved symlink destination and its target after `setup` ran |
| `opencode.path`, `opencode.source` | Same for the OpenCode plugin symlink |
| `statusline.path`, `statusline.source` | Same for the `tf-sl` statusline symlink |
| `dependencies` | Always `"installed"` on a successful run (the `npm install` step) |
| `path` | `"available"` if `~/.local/bin` is already on `PATH`, otherwise `"missing"` with a sibling `pathInstruction: 'export PATH="$HOME/.local/bin:$PATH"'` field |
| `integrations.claude.status` | `"installed"` (CLI on `PATH` and the user-scoped plugin is registered, possibly already installed and now updated), or `"unavailable"` (no `claude` binary, nothing done for Claude) |
| `integrations.codex.status` | `"desktop-install-required"` with a `next` string telling the user to install the plugin through Codex desktop and trust its hooks via `/hooks`, or `"unavailable"` (no `codex` binary) |
| `playwrightMcpIsolation.opencode`, `.claudeCode` | Best-effort attempt to isolate each client's Playwright MCP browser profile; `{changed: false, reason: "..."}` if there was nothing to touch or writable, `{changed: true, path}` if a config file was updated, `{changed: false, path}` if it was already isolated |

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
exit code `2` and a `help:` line naming the current CLI equivalent —
except `--task-id` on `watch`, which is a real, current flag (see above),
not a retired one. See [migrating-from-mcp.md](migrating-from-mcp.md) for
the full table.
