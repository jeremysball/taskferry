[![CI](https://github.com/jeremysball/taskferry/actions/workflows/check.yml/badge.svg)](https://github.com/jeremysball/taskferry/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# taskferry

Dispatch background coding tasks to cheap worker models, so your main
agent keeps its context for planning and review instead of grunt work.

taskferry is a daemon-backed CLI that runs those tasks as `pi` or
`opencode` worker processes. Claude Code is the first-class frontend;
OpenCode and Codex get native integrations too, and anything that can
shell out can dispatch. You send work, get an id back immediately, and
read the result whenever you're ready, from any terminal.

```
$ taskferry dispatch --prompt "Fix the failing tests" --directory /workspace/my-repo
id: oc_mrn4ipkp_19450105
status: running
directory: /workspace/my-repo
model: minimax/MiniMax-M2.7
next: Run taskferry wait or taskferry status with task id "oc_mrn4ipkp_19450105" to check progress

$ taskferry wait oc_mrn4ipkp_19450105
id: oc_mrn4ipkp_19450105
status: done
exitCode: 0

$ taskferry result oc_mrn4ipkp_19450105
message: Fixed the three failing tests. The timeout assertion in src/tasks.test.js raced the retry loop; it now waits on the loop's exit.
tokens: 14208
cost: 0.011
```

No MCP server, no tmux wrappers, no grepping logs for completion markers.
Task completion comes from the child process's real `exit` event, and task
state lives in a daemon that outlives any client session.

## Why not a tmux wrapper

Terminal-multiplexer agent runners tie each worker to a live pane and
check for completion by watching text scroll by. taskferry owns each
worker as a child process of a private daemon instead:

- **Completion is a kernel exit event, not parsed screen text.** Nothing
  to screen-scrape, nothing to babysit, no pane to keep alive.
- **State outlives any client.** Dispatch from one terminal, check from
  another, end the session that dispatched. The daemon holds task state
  and process handles the whole time.
- **Cancel kills the whole process group.** `taskferry cancel` signals
  the task's process group, so a long shell command the worker was
  mid-way through dies with it, not just the top-level process.
- **Works anywhere a shell works.** Scripts, other CLIs, CI, and any
  agent that can shell out, not just a terminal you are staring at.

## Why not an MCP server

Earlier versions of this tool ran as an MCP server registered with
`claude mcp add`. That is gone, for three reasons:

1. **Works from any shell, not just an MCP-capable host.** `taskferry
   dispatch` is a normal command.
2. **State outlives any single client.** The daemon holds task state and
   process handles independent of whichever CLI invocation or agent
   session is currently talking to it.
3. **No host-imposed call-timeout budget.** An MCP tool call has to
   answer inside whatever timeout the host enforces. A CLI command just
   runs.

Each agent gets a *native* integration instead of one MCP server shape
bent to fit all three: [Claude Code](docs/integrations/claude-code.md),
[OpenCode](docs/integrations/opencode.md),
[Codex](docs/integrations/codex.md).

## Quickstart

```bash
git clone https://github.com/jeremysball/taskferry.git
cd taskferry
node src/cli.js setup
export PATH="$HOME/.local/bin:$PATH"
taskferry --version
```

`node src/cli.js setup` is the one-time bootstrap: it runs `npm install`
in the checkout, symlinks `taskferry` into `~/.local/bin`, and registers
native integrations for whichever agents it finds on `PATH` (Claude
Code, OpenCode, Codex). Add the `export PATH` line to your shell rc file
too, so future shells resolve `taskferry` without re-running it.
taskferry needs Unix domain sockets, so it runs on Linux and macOS.

Worker CLIs ship no credentials, so configure one before your first
dispatch. A task dispatched with none is accepted, reports `running`, and
crashes a few seconds later when the worker reaches its provider;
`taskferry status <id> --full` shows the `failureReason` when that
happens.

- **`pi`** (the default executor): run `pi` once and type `/login`, or
  set the provider's API key env var (e.g. `OPENAI_API_KEY`).
- **`opencode`** (`--executor opencode`): run `opencode auth login`.

Then dispatch:

```bash
taskferry dispatch --prompt "Fix the failing tests" --directory /workspace/my-repo
taskferry wait <id>
taskferry result <id>
```

That is the whole loop. Bare `taskferry` shows the live workspace: task
counts by status, the task list, and the suggested next action.

## What you get

- **Dispatch returns an id immediately.** `wait`, `status`, `result`,
  `tail`, `cancel`, and `watch` cover checking on it, whenever you get
  around to it.
- **A queue with a concurrency cap.** At most 4 tasks run at once by
  default; extra dispatches queue and start FIFO as running tasks
  finish, instead of erroring.
- **Sandboxed by default on Linux.** Each task runs under `bwrap` with a
  restricted filesystem; `--no-sandbox` opts a dispatch out, and macOS
  runs without the sandbox. See [docs/security.md](docs/security.md) for
  the layout.
- **TOON output by default.** Token-Oriented Object Notation, roughly
  40% fewer tokens than JSON for the same data, list-shaped results
  rendered as compact tables. Built for agents to consume.
- **Workspace scoping by git root.** Two unrelated repos are two distinct
  workspaces; a worktree of a repo shares the parent repo's workspace, so
  a `--directory` pointed at the main checkout also sees tasks dispatched
  into any linked worktree of that repo.
- **`advisor` for consultations, `summary` for reports.** `advisor` is a
  blocking ask-a-bigger-model call; `summary` produces a bounded report
  or activity snapshot for a finished task.
- **Session resume.** `--session-id` continues a worker's conversation in
  a follow-up task instead of starting fresh.
- **Exit codes that mean something.** `0` success, `1` operational
  error, `2` usage error, plus `taskferry doctor` when something looks
  off.

## Commands

| Command | Purpose |
|---|---|
| `taskferry` | Show live workspace tasks and next actions |
| `taskferry dispatch` | Queue a background model run |
| `taskferry list` | List workspace tasks with counts |
| `taskferry status <id>` | Task status and activity |
| `taskferry wait <id>` | Wait for settlement or a timeout |
| `taskferry result <id>` | Read the final model result |
| `taskferry tail <id>` | Read recent model text |
| `taskferry summary <id>` | Produce a report or activity summary |
| `taskferry advisor` | Dispatch and wait for a model consultation |
| `taskferry cancel <id>` | Cancel queued or running work |
| `taskferry watch` | Stream workspace task events |
| `taskferry context` | Compact context for a session-start hook |
| `taskferry doctor` | Installation and daemon health |
| `taskferry setup` | Install CLI and native integration symlinks |

Full flags, defaults, and TOON examples for every command:
[docs/cli-reference.md](docs/cli-reference.md).

## How it works

A private daemon (`src/daemon.js`) owns task processes and exposes
versioned JSON-RPC over a Unix domain socket, restricted to the current
user. The CLI is a thin client: it validates input, auto-starts the
daemon on first use if none is running, sends a request, and prints the
result as TOON.

`taskferry dispatch` spawns `pi --provider <provider> --model <model>
--mode json -p <prompt>` by default (or the equivalent `opencode run
--dir <directory> --auto --format json -m <model> -- <prompt>` with
`--executor opencode`) as a detached child process, with stdout/stderr
captured to a private per-task log. On Linux with sandboxing enabled (the
default), the direct child is `bwrap` with that command nested inside its
arguments. See [docs/daemon.md](docs/daemon.md) for the full process
model.

## Configuration

taskferry reads options from
`$XDG_CONFIG_HOME/taskferry/config.json` (default
`~/.config/taskferry/config.json`), below `TASKFERRY_*` env vars and
above built-in defaults in precedence. Both are optional; a fresh install
runs on defaults alone. Field list and precedence rules:
[docs/config.md](docs/config.md).

Updating an existing checkout is `git pull && taskferry setup`. `setup`
is idempotent and never replaces a symlink it cannot prove it created.

## As a subagent-driven-development worker backend

The bundled `using-taskferry` skill (shipped inside the Claude Code and
OpenCode plugins, or copyable to `~/.claude/skills/`) makes taskferry the
external-worker execution layer for a
`subagent-driven-development`-style lifecycle: that lifecycle owns task
briefs, worktrees, and the review loop, while taskferry owns model
selection, dispatch, waiting, crash handling, and deliverable retrieval
for each worker. It is not an alternative lifecycle of its own.

## Versioning

[release-please](https://github.com/googleapis/release-please) drives
both the `package.json` version and `taskferry --version`: it scans
merges to `main` for Conventional Commits and keeps a standing PR that
bumps the version and CHANGELOG, and merging that PR is the release.
`PROTOCOL_VERSION` in `src/protocol.js` changes only when the daemon/CLI
RPC contract breaks.

## Testing

Two layers, kept deliberately separate. Unit tests (`npm run test:unit`)
use Node's built-in `node:test` with dependency injection, never touching
a real worker process, network, or subprocess. Integration tests
(`npm run test:integration`) spin up an isolated daemon and drive it
through the real CLI and real `opencode run` calls: real tokens, real
cost, roughly a minute. They are the only tests that exercise the real
`spawn` call, real signal delivery, and TOON over the real socket.

## Further reading

- [docs/cli-reference.md](docs/cli-reference.md): every command, flag, and TOON example
- [docs/daemon.md](docs/daemon.md): process model, socket protocol, recovery
- [docs/config.md](docs/config.md): config file fields and env var precedence
- [docs/security.md](docs/security.md): permissions, caller-env forwarding, activity-summary privacy
- [docs/troubleshooting.md](docs/troubleshooting.md): `doctor` output and common failures
- [docs/migrating-from-mcp.md](docs/migrating-from-mcp.md): command mapping and cleanup
