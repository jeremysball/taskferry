# taskferry

An AXI-style CLI and local daemon for dispatching work to the `opencode`
CLI as background tasks: run `taskferry dispatch`, get a task id back
immediately, check on it or wait for it, then read the result. No MCP
server, no tmux wrappers, no grepping logs for completion markers.

```bash
taskferry dispatch --prompt "Fix the failing tests" --directory /workspace/my-repo
taskferry wait <id>
taskferry result <id>
```

## Why a daemon and a CLI, not an MCP server

Earlier versions of this tool ran as an MCP server registered with `claude
mcp add`. That's gone. A daemon-backed CLI has three advantages an
MCP-only tool doesn't:

1. **Works from any shell, not just an MCP-capable host.** `taskferry
   dispatch` is a normal command; scripts, other CLIs, and any agent that
   can shell out can use it, not only clients that speak MCP.
2. **State outlives any single client.** The daemon holds task state and
   process handles independent of whichever CLI invocation or agent
   session is currently talking to it — dispatch a task from one terminal,
   check on it from another.
3. **No host-imposed call-timeout budget.** An MCP tool call answers inside
   whatever timeout the host enforces; a CLI command just runs.

Each agent gets a *native* integration instead — a Claude Code plugin, an
OpenCode plugin, a Codex plugin — rather than one MCP server shape bent to
fit all three. See [docs/integrations/](docs/integrations/).

## How it works

A private daemon (`src/daemon.js`) owns task processes and exposes
versioned JSON-RPC over a Unix domain socket, permissioned to the current
user only. The CLI (`taskferry`) is a thin client: it validates input,
auto-starts the daemon on first use if none is running, sends a request,
and prints the result as [TOON](https://toonformat.dev/) — Token-Oriented
Object Notation, roughly 40% fewer tokens than JSON for the same data, with
list-shaped results rendered as a compact table instead of a repeated-key
array.

`taskferry dispatch` spawns `opencode run --dir <directory> --auto --format
json -- <prompt>` directly as a child process, detached so its process
group can be signaled as a whole, with stdout/stderr captured to a private
per-task log. Task completion comes from that child's real `exit` event,
never from string-matching log output. See [docs/daemon.md](docs/daemon.md)
for the full process model.

## Commands

| Command | Purpose |
|---|---|
| `taskferry` | Show live workspace tasks and next actions |
| `taskferry dispatch` | Queue a background OpenCode run |
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
| `taskferry setup` | Install CLI and native integration symlinks (one-time, on a fresh checkout or after `git pull`) |
| `taskferry --version` | Package and protocol versions |

Full flags, defaults, and TOON examples for every command:
[docs/cli-reference.md](docs/cli-reference.md).

Every workspace-scoped command (`dispatch`, `list`, `watch`, `context`,
the bare `taskferry` view) is scoped strictly by the realpath of a
`--directory` (defaulting to the current working directory), never by git
repository identity. Two worktrees of the same repository are distinct
workspaces even though they share history; a task dispatched from one is
invisible to `taskferry list` run from another.

## Install

Taskferry installs itself from a local checkout, not a published npm
package. It requires Unix domain sockets, so it is not supported on
Windows.

```bash
git clone https://github.com/jeremysball/taskferry.git
cd taskferry
node src/cli.js setup
taskferry --version
```

`node src/cli.js setup` is the one-time bootstrap: it runs `npm install`
in the checkout, then creates two managed symlinks — `~/.local/bin/taskferry`
pointing at `src/cli.js`, and
`$XDG_CONFIG_HOME/opencode/plugins/taskferry.js` (default
`~/.config/opencode/plugins/taskferry.js`) pointing at
`src/opencode-plugin.js`. It also registers the native agent integration
for whichever client is on `PATH` (Claude Code, Codex). If `~/.local/bin`
is not yet on your `PATH`, the result tells you to add it:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Updating an existing checkout

```bash
git pull
taskferry setup
```

`taskferry setup` re-runs `npm install` and refreshes both symlinks, so
`taskferry` keeps resolving to the current `src/cli.js` after each
update. It is idempotent: re-running it on an already-current install is
safe and reports the same state.

The `setup` command never replaces a symlink at either location unless it
can prove the existing one is one it created (a self-managed target whose
underlying file is part of the taskferry checkout). An unrelated
symlink, a regular file, or a directory at that path is left alone, and
`setup` exits with `refusing to replace unmanaged path: <path>`.

The native integration each agent uses is documented separately:

- [docs/integrations/claude-code.md](docs/integrations/claude-code.md)
- [docs/integrations/opencode.md](docs/integrations/opencode.md)
- [docs/integrations/codex.md](docs/integrations/codex.md)

Migrating from the old MCP server?
[docs/migrating-from-mcp.md](docs/migrating-from-mcp.md) has the full
`taskferry_*` tool → CLI command mapping and registration cleanup steps.

## As Subagent-Driven Development's worker backend

The `taskferry` Agent Skill (`skills/taskferry/SKILL.md`, bundled into both
native plugins and distributable to `~/.claude/skills/taskferry/`) is
built to be the external-worker execution layer for a
`subagent-driven-development`-style lifecycle: that lifecycle owns task
briefs, worktrees, and the review loop, while taskferry owns model
selection, dispatch, waiting, crash handling, and deliverable retrieval for
each worker it runs. It is not an alternative lifecycle of its own.

## Design notes

- **Why `--format json` instead of `opencode`'s default text output.**
  Default output mixes ANSI banners and step formatting into the reply,
  awkward to parse reliably. `--format json` emits one JSON event per line
  (`step_start`, `text`, `step_finish`, ...) with a stable schema,
  including the `sessionID` needed for `--continue`.
- **`detached: true` is about `cancel`, not survival.** The daemon holds a
  direct reference to each child and listens on its `exit` event regardless
  of `detached`. What `detached: true` buys is a distinct process group:
  `taskferry cancel` signals `-pid` (the whole group), reaching a
  subprocess the task is mid-way through running (a long bash command),
  not just the top-level `opencode` process. Without it, a group-kill would
  risk taking the daemon down with its own children.
- **Workspace scoping is strict realpath equality, deliberately.** No
  repository- or branch-level grouping exists anywhere in the CLI, daemon,
  or integrations, on purpose — worktree isolation falls directly out of
  directory scoping, and adding a grouping concept on top would give a
  model another axis to reason about (and get wrong) for no real benefit.

## Testing

Two layers, deliberately kept separate: unit tests never touch a real
`opencode` process; integration tests only ever touch a real one.

### Unit tests (`npm test` / `npm run test:unit`)

```bash
npm run test:unit
```

Node's built-in `node:test`, no test framework dependency, covering
argument parsing, the daemon's socket protocol and stale-socket recovery,
task-lifecycle logic (dispatch → exit/error → settle, `cancel`'s
SIGTERM-then-SIGKILL escalation), activity-summary caching, and both native
plugin integrations — all through dependency injection (`createTaskManager`
takes a fake `spawnFn`/`killFn` instead of touching real processes or OS
signals), so this layer runs deterministically in well under ten seconds
with no network or subprocess calls.

### Integration tests (`npm run test:integration`)

```bash
npm run test:integration
```

```
node src/smoke-test.js          # dispatch, wait, result, list, watch; expects PONG
node src/cancel-smoke-test.js   # dispatch a sleep, cancel it, confirm the process group is gone
node src/poll-smoke-test.js     # taskferry wait resolving early and hitting its internal cap
```

Each spins up its own isolated daemon (private `TASKFERRY_STATE_DIR`/
`TASKFERRY_RUNTIME_DIR` under a temp directory, torn down afterward) and
drives it entirely through the real CLI binary and real `opencode run`
calls — real tokens, real cost, roughly a minute total. These are the only
tests that exercise the real `spawn` call, real signal delivery to a real
process group, and TOON encoding over the real daemon socket — the things
dependency injection deliberately keeps out of the unit tests above. Each
prints a `... SMOKE TEST PASSED`/`FAILED` line and exits accordingly; pass
a directory argument to run against a workspace other than this package's
own root.

## Further reading

- [docs/cli-reference.md](docs/cli-reference.md) — every command, flag, and TOON example
- [docs/daemon.md](docs/daemon.md) — process model, socket protocol, recovery
- [docs/security.md](docs/security.md) — permissions, key slots, activity-summary privacy
- [docs/troubleshooting.md](docs/troubleshooting.md) — `doctor` output and common failures
- [docs/migrating-from-mcp.md](docs/migrating-from-mcp.md) — command mapping and cleanup
