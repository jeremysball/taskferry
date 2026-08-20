# Claude Code integration

Native Claude Code plugin: no MCP server, no `claude mcp add`. It provides a
session-start hook that shells out to the `taskferry` binary.

## Prerequisite: `taskferry` on `PATH`

The plugin's hook command starts with `command -v taskferry
>/dev/null 2>&1` and degrades to a plain-text notice if that check fails.
For a fresh checkout, run `node src/cli.js setup`, then add
`~/.local/bin` to `PATH` with `export PATH="$HOME/.local/bin:$PATH"`.
Once `taskferry` already resolves on `PATH`, rerun `taskferry setup` to
refresh the symlinks and register the marketplace/plugin. See the
[Quickstart section in the README](../../README.md#quickstart) for the full
bootstrap.

## Install

From a fresh checkout, run:

```bash
node src/cli.js setup
```

When the `claude` CLI is on `PATH`, setup adds the checkout
as a Claude Code marketplace (if it is not already registered) and
either installs the `taskferry@taskferry` plugin at user scope or
updates it if it is already installed. When `claude` is not on `PATH`,
the Claude Code leg of `setup` reports `status: "unavailable"` and the
rest of the bootstrap (CLI symlink, OpenCode plugin symlink, Codex
  marketplace if `codex` is present) still runs. Setup also creates
  `~/.local/bin/tf-sl` -> `<checkout>/src/tf-sl.sh`, a statusline data source
  for a Claude Code statusline configuration.

The marketplace catalog is `.claude-plugin/marketplace.json` at the
repository root; the plugin itself lives under `integrations/claude/`
(`integrations/claude/.claude-plugin/plugin.json`). It declares no
`commands`, `agents`, `mcpServers`, or `channels` — only a hook.

## Update

After `git pull` (or any other change to the checkout), re-run `taskferry
setup` from inside it. With `claude` on `PATH`, the Claude Code leg
re-adds the marketplace if it has gone missing, then refreshes the
user-scoped install: it compares the checkout's current git HEAD hash
against the hash recorded at the last install, and if they differ, runs
`claude plugin uninstall taskferry@taskferry --keep-data -y` followed by
`claude plugin install taskferry@taskferry --scope user` (a plain `claude
plugin update taskferry@taskferry` is only the fallback when git isn't
available to compute a hash). Without `claude` on `PATH`, the rest of the
bootstrap still runs but the Claude-specific step is skipped. Restart
Claude Code so it picks up the newly refreshed plugin.

## Remove

```bash
claude plugin uninstall taskferry@taskferry
claude plugin marketplace remove taskferry
```

Uninstalling removes the hook registration. It does not touch
the daemon, its state directory, or any running tasks — those are entirely
separate from the plugin's own lifecycle. Stop the daemon separately if you
want it gone too (see [daemon.md](../daemon.md#stopping-the-daemon)).

## What it does

- **`SessionStart` hook** (`integrations/claude/hooks/hooks.json`, matcher
  `startup|clear|compact`): runs `taskferry context --directory
  "${CLAUDE_PROJECT_DIR}" --format toon` and injects the result as
  `additionalContext` via the standard `hookSpecificOutput.SessionStart`
  envelope. If `taskferry context` itself fails, or the binary isn't on
  `PATH`, the hook injects a short diagnostic line instead of blocking
  session start.
- **Skill** (`integrations/claude/skills/using-taskferry/SKILL.md`): a generated
  copy of the canonical `skills/using-taskferry/SKILL.md` (`npm run
  skill:generate`; `npm run skill:check` fails the build if it drifts),
  bundled into the plugin so installing it also gives Claude Code the
  taskferry worker-backend skill directly, without a separate manual copy
  into `~/.claude/skills/`. `npm run skill:generate` mirrors the canonical
  `SKILL.md` and its `resources/*` tree into the integration copy, and
  `npm run skill:check` validates both.

## Using taskferry as an external worker backend

A `subagent-driven-development` lifecycle dispatches implementer, fixer,
and reviewer work through `taskferry dispatch` / `wait` / `result` instead
of the built-in Agent tool, using the bundled taskferry skill described
above (or a copy in `~/.claude/skills/using-taskferry/` for global availability
outside this plugin). The skill is what makes taskferry the SDD lifecycle's
worker backend; this plugin's hook only provides ambient context
inside a live Claude Code session. See
[cli-reference.md](../cli-reference.md) for the full command surface either
path relies on.

Outside the SDD lifecycle, a live session also benefits from fleet-wide
  visibility into every ferry dispatched with the workspace root or one of
  its linked worktrees as its directory. See
the bundled skill's "Fleet-Wide Monitoring" section for the `watch
--summaries --flush-interval` + `Monitor` auto-arm convention.
