[![CI](https://github.com/jeremysball/taskferry/actions/workflows/check.yml/badge.svg)](https://github.com/jeremysball/taskferry/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# taskferry

Background agent work with a changeset at the door.

Quick links: [Quickstart](#quickstart) · [Why](#why-taskferry) · [Commands](#commands) · [CLI reference](docs/cli-reference.md) · [Config](docs/config.md) · [Troubleshooting](docs/troubleshooting.md)

## Quickstart

```bash
git clone https://github.com/jeremysball/taskferry.git
cd taskferry
node src/cli.js setup
export PATH="$HOME/.local/bin:$PATH"
taskferry --version
```

Re-run `taskferry setup` after updating the checkout (`git pull && taskferry setup`); it is idempotent and refuses to replace unmanaged paths.

```bash
taskferry dispatch \
  --prompt "Fix the failing tests" \
  --directory /workspace/my-repo \
  --model opencode-go/minimax-m3
taskferry wait <id>
taskferry result <id> --diff
taskferry accept <id>
```

The loop is `dispatch`, `wait`, `result --diff`, inspect, then `accept` or `reject`. Use `taskferry output <id>` for files the worker wrote to its durable per-task scratch directory rather than to the changeset.

On Linux the worker runs sandboxed in a copy-on-write overlay by default; macOS runs without the bubblewrap layer. The daemon owns task state and child processes after the calling terminal is gone, so no MCP server, tmux wrapper, or log-grepped marker is needed.

Worker CLIs ship no credentials: for `pi` run `pi` once and type `/login` (or set the provider API key), for `--executor opencode` run `opencode auth login`. The daemon accepts a task without usable credentials, then the worker fails at its provider; see why with `taskferry status <id> --full`.

## Why taskferry

- **Dispatch is separate from acceptance.** Worker writes land in an overlay; `result --diff` inspects, `accept` applies, `reject` discards.
- **The daemon owns the work.** State and child handles outlive the client terminal.
- **Completion is a process event.** Status follows the child's exit event, not a parsed log string.
- **Failure is queryable.** Watchdogs, provider buckets, cancellation, output, and check-gate state surface via status and result fields.
- **The interface is a normal CLI.** Scripts, CI, and any agent that can shell out use the same lifecycle.

Rationale, guarantees, and limits in full: [docs/overview.md](docs/overview.md).

## Commands

| Command | Purpose |
|---|---|
| `taskferry` | Show live workspace tasks and next actions |
| `taskferry dispatch` | Queue a background model run |
| `taskferry list` | List workspace tasks with counts |
| `taskferry status <id>` | Task status and activity |
| `taskferry wait <id>` | Wait for settlement or a timeout |
| `taskferry result <id>` | Read the final model result |
| `taskferry accept <id>` | Apply a pending changeset |
| `taskferry reject <id>` | Discard a pending changeset |
| `taskferry output <id>` | Read durable per-task scratch output |
| `taskferry tail <id>` | Read recent model text |
| `taskferry cancel <id>` | Cancel queued or running work |
| `taskferry watch` | Stream workspace task events |
| `taskferry context` | Compact context for a session-start hook |
| `taskferry doctor` | Installation and daemon health |
| `taskferry setup` | Install CLI and native integration symlinks |
| `taskferry init` | Scaffold a project verification config |

Full flags, defaults, and TOON examples for every command: [docs/cli-reference.md](docs/cli-reference.md).

## How it works

A private daemon owns task processes and exposes versioned JSON-RPC over a user-scoped Unix-domain socket; the CLI validates input, auto-starts the daemon when needed, and prints TOON. For a git target, worker changes are held as a pending changeset against the pre-dispatch `HEAD`, with an optional `.taskferry.toml` check gate before `accept`. Native integrations exist for Claude Code, OpenCode, Kilo Code, and Codex; the CLI remains the dispatch surface. Full process model: [docs/daemon.md](docs/daemon.md).

## Further reading

- [docs/overview.md](docs/overview.md): relocated rationale, guarantees, limits, versioning, testing
- [docs/cli-reference.md](docs/cli-reference.md): every command, flag, and TOON example
- [docs/daemon.md](docs/daemon.md): process model, socket protocol, recovery
- [docs/config.md](docs/config.md): config file fields and env var precedence
- [docs/troubleshooting.md](docs/troubleshooting.md): `doctor` output and common failures
