# Migrating from the MCP server

Taskferry used to be an MCP server (`src/server.js`, registered with `claude
mcp add`) exposing `taskferry_*` tools. That server is gone: no MCP
dependency, no tool schemas, no `claude mcp` registration. It's replaced by
a plain CLI (`taskferry <command>`) backed by a local daemon, installed
through each agent's native plugin mechanism instead. See
[cli-reference.md](cli-reference.md) for the full command reference and
[integrations/](integrations/) for install instructions per agent.

## Command mapping

| MCP tool | CLI command |
|---|---|
| `taskferry_dispatch` | `taskferry dispatch` |
| `taskferry_cancel` | `taskferry cancel` |
| `taskferry_poll` | `taskferry wait` |
| `taskferry_advisor` | `taskferry advisor` |
| `taskferry_status` | `taskferry status` |
| `taskferry_tail` | `taskferry tail` |
| `taskferry_summary` | `taskferry summary` |
| `taskferry_result` | `taskferry result` |
| `taskferry_list` | `taskferry list` |

`taskferry_poll` becomes `taskferry wait`, not `taskferry poll` — the old
name described its transport (MCP's request/response polling shape), the
new one describes its behavior. Running `taskferry poll` fails immediately
with a rename notice. Every `taskferry_<name>` MCP tool name, if invoked as
a CLI command by habit, fails with exit code `2` and a `help:` line naming
its replacement — the CLI recognizes and explains the old names rather than
just reporting "unknown command." The same applies to renamed flags from
the MCP tool-call era: `--task-id` (now positional: `taskferry status
<id>`), `--timeout_ms`/`--tail_chars`/`--max_words`/`--session_id`
(underscore forms; now `--timeout-ms`/`--tail-chars`/`--max-words`/
`--session-id`).

Argument shapes carry over directly: an MCP call like
`taskferry_dispatch({ prompt: "...", directory: "/repo", model: "..." })`
becomes `taskferry dispatch --prompt "..." --directory "/repo" --model
"..."`. camelCase MCP parameter names map to `--kebab-case` flags
(`session_id` → `--session-id`, `key_slot` → `--key-slot`, `max_words` →
`--max-words`).

`taskferry_list()` took no arguments and always listed every task; `taskferry
list` defaults to the *current workspace* instead (matching every other
workspace-scoped command) — pass `--all` for the old always-everything
behavior.

## Remove the old Claude MCP registration

If you previously ran `claude mcp add taskferry -- node
/path/to/taskferry/src/server.js` (or the older `opencode-cc-tool` name),
remove that registration by hand — nothing here does it for you
automatically, since a script silently rewriting your MCP config is a worse
outcome than a stale entry that errors clearly on first use:

```bash
claude mcp remove taskferry
# or, if you never renamed the earlier registration:
claude mcp remove opencode-cc-tool
```

Then install the native plugin instead — see
[integrations/claude-code.md](integrations/claude-code.md).

## Existing state directory

No data migration needed. The CLI/daemon resolves `TASKFERRY_STATE_DIR`
(then `XDG_STATE_HOME/taskferry`, then `~/.local/state/taskferry`)
exactly as the MCP server did, and reads the same `tasks.json` and
`logs/<task-id>.ndjson` files it always wrote. If your MCP-era server ran
with a custom `TASKFERRY_STATE_DIR` set via `claude mcp add -e`, set the
same value as a regular environment variable (or `TASKFERRY_STATE_DIR` in
your shell profile) — the CLI reads it directly rather than through an MCP
server's `-e` flags. Tasks the old server had already recorded as `done`,
`crashed`, or `cancelled` remain inspectable with `taskferry status`/
`taskferry result` immediately, with no daemon restart or reindex step.

If you're migrating from further back — the pre-rename `opencode-cc-tool`
default state directory (`~/.opencode-cc-tool/`) — that move predates this
CLI and isn't covered here; consult your history for the
`opencode-cc-tool` → `taskferry` MCP-era migration if you skipped it.

## What has no equivalent

- **`taskferry setup`** doesn't exist and never will in this architecture —
  install the native integration for your agent instead of running a setup
  command.
- **Server-side `-e` environment flags** (`claude mcp add -e ...`) have no
  equivalent; set `TASKFERRY_*` variables in the environment the daemon
  auto-starts from instead (see [daemon.md](daemon.md#auto-start)).
- **MCP's per-tool-call 60-second timeout** no longer bounds anything.
  `taskferry wait`/`taskferry advisor` still cap a single call at 45
  seconds internally, but that's now just a deliberate design choice for
  bounded CLI calls, not a constraint inherited from a host's MCP transport.
