[![CI](https://github.com/jeremysball/taskferry/actions/workflows/check.yml/badge.svg)](https://github.com/jeremysball/taskferry/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# taskferry

**taskferry is the local execution layer for subagent-driven development:** a daemon-backed CLI that runs `pi` or OpenCode workers, preserves durable task state, and holds filesystem changes as a reviewable changeset until you accept or reject them.

You send work, get an id back immediately, and read the result from any terminal. On Linux the worker writes into a copy-on-write overlay; taskferry extracts a diff and keeps it `pending` until you run `accept` or `reject`.

```
$ taskferry dispatch --executor pi --model provider/model-slug --directory /workspace/my-repo --prompt "Fix the failing tests"
id: oc_mrn4ipkp_19450105
status: running
directory: /workspace/my-repo
model: provider/model-slug
next: Run taskferry wait or taskferry status with task id "oc_mrn4ipkp_19450105" to check progress

$ taskferry wait oc_mrn4ipkp_19450105
id: oc_mrn4ipkp_19450105
status: done
exitCode: 0

$ taskferry result oc_mrn4ipkp_19450105
message: Fixed the three failing tests. The timeout assertion in src/tasks.test.js raced the retry loop; it now waits on the loop's exit.
tokens: { total: 14208, input: 12001, output: 2207, cache: { read: 314000 } }
cost: 0.011
```

On Linux the default sandbox requires bubblewrap with overlay support. `taskferry doctor --full` verifies it.

## Quickstart

From a taskferry checkout:

```bash
git clone https://github.com/jeremysball/taskferry.git
cd taskferry
node src/cli.js setup
export PATH="$HOME/.local/bin:$PATH"
taskferry doctor --full
```

`setup` installs dependencies, links the `taskferry` CLI, and refreshes the native integrations it finds. It is safe to run again after `git pull`. Taskferry runs on Linux and macOS.

Authenticate the worker you plan to use before dispatching:

- **pi**, the default executor: use pi's login flow or export the provider key that pi expects.
- **OpenCode**: run `opencode auth login`, then pass `--executor opencode`.

A fresh dispatch requires `--model`. The omitted `--variant` defaults to `highest`. Taskferry asks for the highest reasoning level it can request for that model (pi receives `--thinking max` and clamps to the model's ceiling; OpenCode uses its cached variant table when one exists).

```bash
# Default path: pi
TASKFERRY_MODEL="provider/model-slug"
taskferry dispatch \
  --executor pi \
  --model "$TASKFERRY_MODEL" \
  --directory /workspace/my-repo \
  --prompt "Fix the failing tests"

# Alternate path: OpenCode
opencode auth login
taskferry dispatch \
  --executor opencode \
  --model "$TASKFERRY_MODEL" \
  --directory /workspace/my-repo \
  --prompt "Review the change"
```

Each dispatch returns an id immediately. Use that id to wait and read the final result:

```bash
taskferry wait <id>
taskferry result <id>
```

To inspect or land a worker's filesystem changes, use `taskferry result <id> --diff` and `taskferry accept <id>` or `taskferry reject <id>`.

## What you get

- **A daemon-owned task lifecycle.** `dispatch` returns an id immediately. The daemon owns the worker process, watches its real exit event, persists task state, and lets you wait, inspect, stream, cancel, or retrieve the result from another terminal.
- **A copy-on-write handoff on Linux.** Sandboxed dispatches write into a per-task overlay instead of the live target directory. When the worker settles, taskferry extracts a changeset. An applicable non-empty changeset stays `pending` until you inspect it with `result --diff` and choose `accept` or `reject`. An unrecovered head conflict leaves the changeset rejected during extraction.
- **Durable deliverables.** Every dispatch receives a private `$TASKFERRY_OUTPUT_DIR` at `<stateDir>/outputs/<id>/`. Write reports and other artifacts there, then read them with `taskferry output <id>`. The directory survives `done`, `crashed`, and `cancelled`, including a `done` task whose `incomplete` flag is true, and is never consumed by `accept`/`reject`.
- **Separate read-write and read-only mounts.** Use `--rw-bind` for an extra directory a worker must modify. Use `--ro-bind` for reference repositories a review worker must read without editing. Read-write wins when the same path appears in both sets, with a warning. `--allowed-dirs` is a deprecated alias for `--rw-bind`.
- **Provider-aware queueing.** Global limits remain 4 concurrent and 2 launches per 5 s window. Optional `providerLimits` entries add per-provider caps so a saturated provider does not consume every launch slot. Scheduling is FIFO within each provider queue and round-robin across providers.
- **Completion and verification signals.** Use `--require-final-marker` for a final-message contract, `.taskferry.toml` for a settle-time check gate, and `doctor --stats` plus task `class` tags for fleet-oriented reporting. `defaultVariant` is `highest` unless overridden.
- **Native frontend integrations.** Claude Code, Codex, and OpenCode can receive task context through their native plugin or hook surfaces. The dispatch surface remains the CLI.

> [!WARNING]
> The overlay is the safety boundary. `--no-overlay` is an explicit per-dispatch opt-out that makes writes land directly in the target directory. Advisors require overlay-gated writes on supported Linux hosts.

## How it works

taskferry has a thin CLI and a private daemon. The CLI sends requests over a Unix-domain socket. The daemon queues work, starts the selected `pi` or OpenCode process as a detached child, records stdout/stderr in a private task log, and settles the task from the child's exit event. A terminal session can go away without taking the task with it.

On Linux, a dispatch runs inside bubblewrap by default. The target directory is mounted as a per-task copy-on-write overlay. The worker sees the requested path, but writes and deletes land in the overlay's upper layer. For git targets, taskferry extracts a working-tree-style diff against the pre-dispatch `HEAD` when the worker exits. A worker commit inside the overlay is not replayed as a commit on the host. An applicable diff remains pending until `taskferry accept <id>` applies it or `taskferry reject <id>` discards it.

The changeset overlay and the scratch output directory serve different jobs. The overlay holds candidate filesystem changes for review. `$TASKFERRY_OUTPUT_DIR` holds durable reports and other deliverables, including output from a worker whose final assistant message ended on a tool call. `taskferry output <id>` reads that directory after the task settles.

When a repository declares `check = "..."` in `.taskferry.toml`, taskferry adds the command to the dispatch prompt and runs it in a check sandbox that reuses the task's overlay and persisted overlay binds after diff extraction. The check sandbox does not inherit every worker bind, including executor auth, per-dispatch `--rw-bind` or `--allowed-dirs` entries, and the sandboxed data home. A check that needs one of those mounts can fail even when the worker had access to it. A failed, timed-out, or interrupted gate blocks `accept` unless the caller uses `--force` after manual verification.

## Review and land a worker changeset

```bash
taskferry result <id> --diff      # inspect pending changeset read-only
taskferry accept <id>             # apply: git apply --3way for git targets, rsync for non-git
taskferry reject <id>             # discard overlay and diff
```

An accepted patch lands as a working-tree change, not as a replayed commit. A git changeset's patch is persisted under the state dir and survives a reboot; a non-git `accept` needs the live overlay to rebuild its merged view, so a non-git changeset left pending across a reboot can only be rejected. Cleanup records the tmp root in effect at creation so removal keeps working across daemon restarts even when `TMPDIR` changes.

If the repository has a `.taskferry.toml` check gate, `accept` is blocked while the gate is `running`, `failed`, `timeout`, or `interrupted` unless you pass `--force` after manual verification. See `docs/config.md` for the check lifecycle and `docs/cli-reference.md` for `accept`/`reject` flags.

## As a subagent-driven-development worker backend

The bundled `using-taskferry` skill (shipped inside the Claude Code and OpenCode plugins, or copyable to `~/.claude/skills/`) makes taskferry the external-worker execution layer for a `subagent-driven-development`-style lifecycle: that lifecycle owns task briefs, worktrees, and the review loop, while taskferry owns model selection, dispatch, waiting, crash handling, and deliverable retrieval for each worker. It is not an alternative lifecycle of its own.

## Why not a tmux wrapper

A tmux runner ties a worker to a pane and treats screen text as its status protocol. taskferry starts each worker as a detached child owned by a private daemon. The daemon records stdout and stderr, settles the task from the child's exit event, and keeps the task record after the invoking terminal closes.

Cancellation targets the worker's process group, so a subprocess started by the worker receives the same termination request. The CLI then gives you separate commands for waiting, status, logs, results, cancellation, and changeset handling. The terminal that launched the task does not need to stay open or remain attached to a pane.

## Why not an MCP server

Earlier versions of this tool ran as an MCP server registered with `claude mcp add`. That is gone, for three reasons:

1. **Works from any shell, not just an MCP-capable host.** `taskferry dispatch` is a normal command.
2. **State outlives any single client.** The daemon holds task state and process handles independent of whichever CLI invocation or agent session is currently talking to it.
3. **No host-imposed call-timeout budget.** An MCP tool call has to answer inside whatever timeout the host enforces. A CLI command just runs. `wait` and `advisor` expose their own CLI timeout behavior instead.

Each agent gets a *native* integration instead of one MCP server shape bent to fit all three: [Claude Code](docs/integrations/claude-code.md), [OpenCode](docs/integrations/opencode.md), [Codex](docs/integrations/codex.md).

Taskferry's frontend integrations stay native to their host. Claude Code and Codex use hooks, OpenCode uses toasts plus bounded system-prompt context. Those integrations provide ambient task context. They do not add a callable Taskferry tool-spec surface to every model turn. The dispatch and retrieval contract remains the CLI (ADR 0003).

## Configuration

taskferry reads options from `$XDG_CONFIG_HOME/taskferry/config.json` (default `~/.config/taskferry/config.json`), below `TASKFERRY_*` env vars and above built-in defaults in precedence. Both are optional; a fresh install runs on defaults alone.

Highlights. See [docs/config.md](docs/config.md) for the full field table:

```json
{
  "defaultExecutor": "pi",
  "defaultVariant": "highest",
  "rwBind": "/data/shared",
  "roBind": "/data/reference",
  "providerLimits": { "openai": { "maxConcurrentTasks": 2 } }
}
```

```toml
# .taskferry.toml: settle-time check gate (runs inside the overlay)
check = "npm run check"
read_only_paths = ["/data/reference"]
```

`providerLimits` uses `provider:maxConcurrentTasks[:maxDispatchesPerWindow]` comma-separated grammar (or the JSON object above) to cap a saturated provider without starving others.

Updating an existing checkout is `git pull && taskferry setup`. `setup` is idempotent and never replaces a symlink it cannot prove it created.

## Commands

| Command | Purpose |
|---|---|
| `taskferry` | Show live workspace tasks and next actions |
| `taskferry dispatch` | Queue a background model run |
| `taskferry list` | List workspace tasks with counts (`--all` caps at 500 newest rows) |
| `taskferry status <id>` | Task status and activity |
| `taskferry wait <id>` | Wait for settlement or a timeout |
| `taskferry result <id>` | Read the final model result (`--diff` for pending changeset) |
| `taskferry tail <id>` | Read recent model text |
| `taskferry summary <id>` | Produce a report or activity summary |
| `taskferry advisor` | Dispatch and wait for a model consultation (overlay mandatory, no `--no-overlay`) |
| `taskferry cancel <id>` | Cancel queued or running work |
| `taskferry accept <id>` | Apply a pending changeset (gated by `.taskferry.toml` check) |
| `taskferry reject <id>` | Discard a pending changeset |
| `taskferry output <id>` | Read the task's durable scratch directory (`$TASKFERRY_OUTPUT_DIR`) |
| `taskferry init` | Scaffold `.taskferry.toml` / project config |
| `taskferry watch` | Stream workspace task events |
| `taskferry context` | Compact context for a session-start hook |
| `taskferry doctor` | Installation and daemon health (`--stats` for history) |
| `taskferry setup` | Install CLI and native integration symlinks |

Full flags, defaults, and TOON examples for every command: [docs/cli-reference.md](docs/cli-reference.md).

## Versioning

[release-please](https://github.com/googleapis/release-please) drives both the `package.json` version and `taskferry --version`: it scans merges to `main` for Conventional Commits and keeps a standing PR that bumps the version and CHANGELOG, and merging that PR is the release. `PROTOCOL_VERSION` in `src/protocol.js` changes only when the daemon/CLI RPC contract breaks.

## Testing

Two layers, kept deliberately separate. Unit tests (`npm run test:unit`) use Node's built-in `node:test` with dependency injection, never touching a real worker process or network. They do exercise real `bwrap` overlay and `node` spawn paths where the substrate itself is under test. Integration tests (`npm run test:integration`) spin up an isolated daemon and drive it through the real CLI and real `opencode run` calls: real tokens, real cost, roughly a minute. They are the only tests that exercise the real `spawn` call, real signal delivery, and TOON over the real socket against a live provider.

## Further reading

- **Run it:** [docs/cli-reference.md](docs/cli-reference.md) for every command, flag, and TOON example; [docs/config.md](docs/config.md) for config fields and env precedence; [docs/troubleshooting.md](docs/troubleshooting.md) for `doctor` output and common failures.
- **Understand it:** [docs/daemon.md](docs/daemon.md) for the process model, socket protocol, and recovery; [docs/security.md](docs/security.md) for permissions, caller-env forwarding, and activity-summary privacy; [docs/sandbox-saves.md](docs/sandbox-saves.md) for overlay evidence; [docs/adr/0001-cow-overlays-and-diff-gated-writes.md](docs/adr/0001-cow-overlays-and-diff-gated-writes.md) for the accepted CoW decision and its limits.
- **Integrate it:** [docs/integrations/claude-code.md](docs/integrations/claude-code.md) · [docs/integrations/opencode.md](docs/integrations/opencode.md) · [docs/integrations/codex.md](docs/integrations/codex.md)
- **Migrate or contribute:** [docs/migrating-from-mcp.md](docs/migrating-from-mcp.md) for command mapping and cleanup; [CONTRIBUTING.md](CONTRIBUTING.md) for PR conventions, test file structure, and contributor workflow.
