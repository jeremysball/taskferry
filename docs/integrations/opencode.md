# OpenCode integration

Native OpenCode plugin (`src/opencode-plugin.js`), exported from the
`taskferry` package's `exports` field. Unlike the Claude Code and Codex
integrations, this one has no separate hooks/marketplace manifest — it's a
single JS module OpenCode loads directly through its own plugin config.

## Install

From a fresh checkout, run:

```bash
node src/cli.js setup
```

`taskferry setup` creates (or refreshes) a single file symlink at
`$XDG_CONFIG_HOME/opencode/plugins/taskferry.js` (default
`~/.config/opencode/plugins/taskferry.js`) that resolves to the
checkout's `src/opencode-plugin.js`. OpenCode auto-loads any module at
that path on startup, so the plugin symlink itself needs no `opencode.json`
edit. `setup` also patches `opencode.json` in a separate step: if a
non-isolated `mcp.playwright.command` entry is already present, it appends
`--isolated` to that command array. A `.jsonc`-only config is left
untouched, since that step only reads/writes `opencode.json`.

The symlink is self-managed: `taskferry setup` only replaces the file
at that path when the existing symlink's target is one it created (a
`src/opencode-plugin.js` inside a checkout whose `package.json` is
`taskferry`). An unrelated symlink, a regular file, or a directory at
that path is left alone and `setup` exits with `refusing to replace
unmanaged path: <path>`. The same command also creates the CLI
symlink at `~/.local/bin/taskferry` and registers the Claude Code and
Codex integrations when their CLIs are on `PATH` — see the
[Quickstart section in the README](../../README.md#quickstart) for the full
bootstrap.

## Update

After `git pull` (or any other change to the checkout), re-run
`taskferry setup` from inside it. The OpenCode leg of `setup` is
idempotent: when no symlink exists yet, or the existing one resolves to a
file inside *this same* checkout, it's unlinked and recreated pointing at
this checkout's `src/opencode-plugin.js`. A symlink that resolves into a
*different* taskferry checkout is deliberately left alone and rejected as
unmanaged — a scratch or throwaway clone must not be able to steal a
symlink the live checkout owns. A dangling symlink (target no longer
exists) or one pointing at an unrelated file is treated the same way and
rejected with `refusing to replace unmanaged path: <path>` — remove it by
hand and re-run `setup`. If a checkout genuinely moved, remove the stale
symlink by hand before re-running `setup` from the new location. Restart
OpenCode so it reloads the freshly linked module.

## Remove

Delete the integration symlink. This does not remove daemon state or running
tasks:

```bash
rm "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/taskferry.js"
```

This does not stop the daemon or affect other integrations sharing it. See
[daemon.md](../daemon.md#stopping-the-daemon) to stop the daemon separately.

## What it does

When a sandboxed worker reads the user's OpenCode configuration, the config
directory itself must be a safe, non-symlink path. `.gitignore` is skipped.
Individual entries may be symlinks: taskferry resolves each target, checks it,
and binds the target read-only. Dangling or unsafe entries are skipped with a
warning rather than failing the dispatch. This supports dotfiles repositories
without exposing an arbitrary symlink target.

On load, the plugin connects to the taskferry daemon (auto-starting it if
needed) and subscribes to events for the current OpenCode project
directory. It exposes two behaviors, both scoped to that one workspace:

- **Dynamic toasts.** Every `task.state` event fires
  `client.tui.showToast`, titled `Taskferry(<status> · <id>)` with the
  task's current activity as the body and a variant chosen by status
  (`queued`/`running` → info, `done` → success, `crashed` → error,
  `cancelled` → warning). OpenCode's toast title changes per event — the
  closest thing this integration has to a live per-task status surface.
- **System-prompt context.** The `experimental.chat.system.transform` hook
  injects a `Taskferry tasks:` block (up to 5 rows, with a `+N more`
  suffix) listing active tasks and terminal tasks not yet surfaced to a
  model request, immediately before OpenCode sends its system prompt.
  Terminal-status rows are only marked "seen" once they actually enter a
  request sent to a model — an event arriving while OpenCode is idle
  doesn't consume it.

If the daemon connection fails, the plugin logs through `client.app.log`
(`service: "taskferry"`) rather than throwing, so a taskferry outage never
breaks OpenCode itself; it just runs without task context or toasts for the
rest of that plugin instance's lifetime. The connection attempt happens once,
at plugin initialization — there is no retry timer or lazy reconnect, so a
daemon that comes back up after the initial failure isn't picked up until
OpenCode reloads or restarts the plugin.

## `TASKFERRY_CHILD` and nested plugin loads

When OpenCode itself is running as a taskferry-dispatched child
(`TASKFERRY_CHILD=1` is set in that process's environment — see
[security.md](../security.md#taskferry_child)), the plugin factory returns
an empty hook object immediately instead of connecting to the daemon. This
avoids a dispatched task's own nested `opencode` process opening a second,
redundant subscription against the same workspace.

## UI limitations

None beyond what's inherent to toasts: they're transient notifications, not
a persistent list. For the full workspace task list at any point, run
`taskferry list` directly.

## Using taskferry as an external worker backend

This plugin is presentation only — toasts and system-prompt context inside
a live OpenCode session. It plays no part in dispatching *other* OpenCode
work; that's the CLI's job (`taskferry dispatch`), driven by whichever
agent's `subagent-driven-development`-style lifecycle is doing the
dispatching (typically Claude Code or Codex, using the taskferry skill —
see [claude-code.md](claude-code.md) and [codex.md](codex.md)). See
[cli-reference.md](../cli-reference.md) for the full command surface.
