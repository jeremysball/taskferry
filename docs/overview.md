# taskferry overview

Extended detail relocated from `README.md` during the humanizing-readmes
trim (target ≤120 lines). The README keeps the short version; this file
keeps every load-bearing paragraph so nothing was dropped in the move.
Canonical references (`docs/cli-reference.md`, `docs/daemon.md`,
`docs/config.md`, `docs/troubleshooting.md`) remain the source of truth
where they already covered the same ground.

## Install details

`node src/cli.js setup` runs `npm install` in the checkout, creates the
managed CLI and plugin symlinks, and registers the native integrations
available for the agent CLIs found on `PATH`. Run `taskferry setup` again
after updating the checkout. The command is idempotent and refuses to
replace unmanaged paths.

taskferry uses Unix-domain sockets and runs on Linux and macOS. Linux gets
the default bubblewrap sandbox and copy-on-write overlay. macOS runs without
the Linux bubblewrap layer.

Worker CLIs ship no credentials, so configure one before your first
dispatch. The daemon accepts a task without usable credentials, then the
worker fails when it reaches its provider. `taskferry status <id>
--full` shows the failure reason.

- **`pi`** (the default executor): run `pi` once and type `/login`, or
  set the provider's API key env var (for example, `OPENAI_API_KEY`).
- **`opencode`** (`--executor opencode`): run `opencode auth login`.

Updating an existing checkout is `git pull && taskferry setup`. `setup` is
idempotent and never replaces a symlink it cannot prove it created.

## Why taskferry

Background workers are useful only when their work remains observable and
reversible. taskferry keeps those boundaries explicit:

- **Dispatch is separate from acceptance.** Worker writes land in a
  copy-on-write overlay by default on Linux. `result --diff` inspects them;
  `accept` applies them and `reject` discards them.
- **The daemon owns the work.** Task state and child-process handles outlive
  the client terminal. Query a task from another terminal or after the
  original session ends.
- **Completion is a process event.** Status is tied to the child's exit
  event, not a pane or a string parsed from a scrolling terminal.
- **Failure is queryable.** Watchdogs, provider-failure buckets, cancellation,
  task output, and check-gate state are exposed through task status and result
  fields.
- **The interface is a normal CLI.** Scripts, CI, other CLIs, and any agent
  that can shell out can use the same task lifecycle.

## What you get

- **Queueing:** a global concurrency cap and optional provider limits keep
  excess work queued rather than failing immediately.
- **Observation:** `status`, `wait`, `tail`, `result`, `watch`, and `summary`
  expose task state, narration, diffs, and bounded activity.
- **Guarded writes:** Linux sandboxing, copy-on-write overlays, explicit bind
  controls, changeset extraction, and `accept`/`reject` keep execution apart
  from landing.
- **Project checks:** `.taskferry.toml` supports a settle-time check gate;
  `taskferry init` scaffolds a proposed check for a detected ecosystem.
- **Durable deliverables:** `taskferry output` retrieves files from a
  per-task scratch directory even when a task ends on a tool call or is
  cancelled.
- **Agent context:** native Claude Code, OpenCode, and Codex integrations
  expose workspace task context without requiring an MCP server.
- **Agent-oriented output:** TOON is the default output format, with NDJSON
  available for `watch` scripts.
- **Session continuity:** `--session-id` continues a worker conversation
  instead of reconstructing its context from scratch.

## How it works

A private daemon (`src/daemon.js`) owns task processes and exposes
versioned JSON-RPC over a Unix-domain socket restricted to the current user.
The CLI validates input, auto-starts the daemon on first use when needed,
sends a request, and prints the result as TOON.

`taskferry dispatch` spawns `pi --provider <provider> --model <model>
--mode json -p <prompt>` by default (or the equivalent `opencode run`
invocation with `--executor opencode`; exact argv in
[cli-reference.md](cli-reference.md)) as a detached child process, with stdout and stderr
captured to a private per-task log. On Linux with sandboxing enabled (the
default), the direct child is `bwrap` with that command nested inside its
arguments. See [daemon.md](daemon.md) for the full process model.

For a git target, worker changes are compared with the pre-dispatch `HEAD`
and held as a pending changeset. A project check from `.taskferry.toml`, when
configured, runs inside the worker's overlay before `accept` applies the
changeset. A failed or interrupted gate stays visible and refuses acceptance
unless the operator uses the explicit `--force` override.

## Configuration

taskferry reads options from
`$XDG_CONFIG_HOME/taskferry/config.json` (default
`~/.config/taskferry/config.json`), below `TASKFERRY_*` env vars and above
built-in defaults in precedence. Both are optional; a fresh install runs on
defaults alone. Field list and precedence rules:
[config.md](config.md).

## Integrations

Each agent gets a native integration instead of one MCP shape bent to fit
every frontend:

- [Claude Code](integrations/claude-code.md) receives session-start task
  context and the bundled worker-backend skill.
- [OpenCode](integrations/opencode.md) receives task toasts and bounded
  task context in the system prompt.
- [Kilo Code](integrations/kilo.md) receives task toasts, bounded context, and live monitoring (parity with OpenCode, beyond Claude/Codex).
- [Codex](integrations/codex.md) receives task context through its hooks.

These integrations provide context and presentation. The CLI remains the
dispatch surface.

## As a subagent-driven-development worker backend

The bundled `using-taskferry` skill (shipped inside the Claude Code,
OpenCode, Kilo Code, and Codex plugins, or copyable to `~/.claude/skills/`) makes taskferry the
external-worker execution layer for a
`subagent-driven-development`-style lifecycle: that lifecycle owns task
briefs, worktrees, and the review loop, while taskferry owns model selection,
dispatch, waiting, crash handling, and deliverable retrieval for each worker.
It is not an alternative lifecycle of its own.

## Known limits

- Linux sandboxing requires a working `bwrap` installation with overlay
  support; taskferry fails fast rather than silently running unsandboxed.
- macOS does not provide the Linux bubblewrap layer.
- Provider credentials, provider availability, and worker quality remain
  external to taskferry.
- `taskferry summary` and `watch --summaries` make secondary model calls when
  requested. Do not summarize logs that contain secrets you do not want sent
  to that provider.
- A changeset is not proof that the worker produced correct code. Inspect the
  diff and use a project check before accepting it.

## Versioning

[release-please](https://github.com/googleapis/release-please) drives both the
`package.json` version and `taskferry --version`: it scans merges to `main`
for Conventional Commits and keeps a standing PR that bumps the version and
CHANGELOG. Merging that PR is the release.

`PROTOCOL_VERSION` in `src/protocol.js` changes only when the daemon/CLI RPC
contract breaks.

## Testing

Two layers are kept separate. Unit tests (`npm run test:unit`) use Node's
built-in `node:test` with dependency injection and do not touch a real worker
process, network, or subprocess. Integration tests
(`npm run test:integration`) spin up an isolated daemon and drive it through
the real CLI and real `opencode run` calls. They use real tokens and cost and
are the only tests that exercise the real spawn call, signal delivery, and
TOON over the real socket.

## More docs

Pointers that lived in the README's former 12-link "Further reading" list:

- [cli-reference.md](cli-reference.md): every command, flag, and TOON example
- [daemon.md](daemon.md): process model, socket protocol, recovery
- [things-that-look-like-bugs.md](things-that-look-like-bugs.md): deliberate behavior that reads as broken
- [config.md](config.md): config file fields and env var precedence
- [security.md](security.md): permissions, caller-env forwarding, activity-summary privacy
- [branding/positioning.md](branding/positioning.md): positioning, Brand Core, and exclusions
- [branding/features.md](branding/features.md): feature packaging and source evidence
- [branding/palette.md](branding/palette.md): validated visual palette and asset provenance
- [evolution.md](evolution.md): architecture evolution, reusable patterns, and the complete commit ledger
- [troubleshooting.md](troubleshooting.md): `doctor` output and common failures
- [migrating-from-mcp.md](migrating-from-mcp.md): command mapping and cleanup
- [../CONTRIBUTING.md](../CONTRIBUTING.md): PR conventions, test file structure, contributor workflow
