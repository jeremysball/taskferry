# Claude Code integration

Native Claude Code plugin: no MCP server, no `claude mcp add`. It provides a
session-start hook and a monitor entry, both of which shell out to the
`taskferry` binary.

## Prerequisite: `taskferry` on `PATH`

The plugin's hook and monitor commands both start with `command -v taskferry
>/dev/null 2>&1` and degrade to a plain-text notice if that check fails.
Install the CLI first:

```bash
cd /path/to/taskferry
npm install
npm install -g .        # or: npm link
taskferry --version     # confirm it resolves on PATH
```

## Install

Add this repository as a Claude Code plugin marketplace, then install the
plugin from it:

```bash
claude plugin marketplace add /path/to/taskferry
claude plugin install taskferry@taskferry
```

The marketplace catalog is `.claude-plugin/marketplace.json` at the
repository root; the plugin itself lives under `integrations/claude/`
(`integrations/claude/.claude-plugin/plugin.json`). It declares no
`commands`, `agents`, `mcpServers`, or `channels` — only a hook and a
monitor entry.

## Update

Plugins installed from a local marketplace path pick up changes on the
marketplace's next refresh. Re-run `claude plugin marketplace add
/path/to/taskferry` (or update the checkout in place, if you installed from
a git-tracked path) and restart Claude Code.

## Remove

```bash
claude plugin uninstall taskferry@taskferry
claude plugin marketplace remove taskferry
```

Uninstalling removes the hook and monitor registration. It does not touch
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
- **Monitor** (`integrations/claude/monitors/monitors.json`): registers a
  `taskferry` monitor backed by `taskferry watch --directory
  "${CLAUDE_PROJECT_DIR}" --format claude-monitor --summaries`. This is a
  long-lived streaming process Claude Code's UI reads from; each line is a
  static `Taskferry(<status> · <id>): <activity>` string, since Claude
  Code's monitor surface displays a fixed label per update rather than a
  dynamic per-task title (compare with OpenCode's dynamic toasts, below).
  `--summaries` means the activity text can include a real model-generated
  summary, not just local narration — see
  [security.md](../security.md#activity-summaries) for what that costs and
  how to disable it.
- **Skill** (`integrations/claude/skills/taskferry/SKILL.md`): a generated
  copy of the canonical `skills/taskferry/SKILL.md` (`npm run
  skill:generate`; `npm run skill:check` fails the build if it drifts),
  bundled into the plugin so installing it also gives Claude Code the
  taskferry worker-backend skill directly, without a separate manual copy
  into `~/.claude/skills/`.

## UI limitations

Claude Code's monitor surface shows one label at a time, refreshed as new
lines arrive on the watch stream; it has no concept of per-task rows or
history the way `taskferry list` does. For a full task list, run `taskferry
list` or `taskferry` (no arguments) directly, or ask Claude Code to run it
for you.

## Using taskferry as an external worker backend

A `subagent-driven-development` lifecycle dispatches implementer, fixer,
and reviewer work through `taskferry dispatch` / `wait` / `result` instead
of the built-in Agent tool, using the bundled taskferry skill described
above (or a copy in `~/.claude/skills/taskferry/` for global availability
outside this plugin). The skill is what makes taskferry the SDD lifecycle's
worker backend; this plugin's hook and monitor only provide ambient context
and monitoring inside a live Claude Code session. See
[cli-reference.md](../cli-reference.md) for the full command surface either
path relies on.
