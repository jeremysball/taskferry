# OpenCode integration

Native OpenCode plugin (`src/opencode-plugin.js`), exported from the
`taskferry` package's `exports` field. Unlike the Claude Code and Codex
integrations, this one has no separate hooks/marketplace manifest — it's a
single JS module OpenCode loads directly through its own plugin config.

## Install

From the taskferry checkout, run:

```bash
taskferry setup
```

`taskferry setup` creates (or refreshes) a single file symlink at
`$XDG_CONFIG_HOME/opencode/plugins/taskferry.js` (default
`~/.config/opencode/plugins/taskferry.js`) that resolves to the
checkout's `src/opencode-plugin.js`. OpenCode auto-loads any module at
that path on startup, so no edits to `opencode.json` or any other config
are required.

The symlink is self-managed: `taskferry setup` only replaces the file
at that path when the existing symlink's target is one it created (a
`src/opencode-plugin.js` inside a checkout whose `package.json` is
`taskferry`). An unrelated symlink, a regular file, or a directory at
that path is left alone and `setup` exits with `refusing to replace
unmanaged path: <path>`. The same command also creates the CLI
symlink at `~/.local/bin/taskferry` and registers the Claude Code and
Codex integrations when their CLIs are on `PATH` — see the
[Install section in the README](../README.md#install) for the full
bootstrap.

## Update

After `git pull` (or any other change to the checkout), re-run
`taskferry setup` from inside it. The OpenCode leg of `setup` is
idempotent: when the symlink already resolves to the checkout's
`src/opencode-plugin.js`, it is left in place; when it is missing,
stale, or points at a different file, it is replaced. Restart OpenCode
so it reloads the freshly linked module.

## Remove

Delete the symlink (and the daemon's state if you no longer need it):

```bash
rm "$XDG_CONFIG_HOME/opencode/plugins/taskferry.js"
# (or: rm ~/.config/opencode/plugins/taskferry.js)
```

This does not stop the daemon or affect other integrations sharing it —
see [daemon.md](../daemon.md#stopping-the-daemon) to stop that
separately.

## What it does

On load, the plugin connects to the taskferry daemon (auto-starting it if
needed) and subscribes to events for the current OpenCode project
directory. It exposes two behaviors, both scoped to that one workspace:

- **Dynamic toasts.** Every `task.state` event fires
  `client.tui.showToast`, titled `Taskferry(<status> · <id>)` with the
  task's current activity as the body and a variant chosen by status
  (`queued`/`running` → info, `done` → success, `crashed` → error,
  `cancelled` → warning). Unlike Claude Code's monitor, which always shows
  the same fixed-format line, OpenCode's toast title changes per event —
  the closest thing this integration has to a live per-task status
  surface.
- **System-prompt context.** The `experimental.chat.system.transform` hook
  injects a `Taskferry tasks:` block (up to 5 rows, with a `+N more`
  suffix) listing active tasks and terminal tasks not yet surfaced to a
  model request, immediately before OpenCode sends its system prompt.
  Terminal-status rows are only marked "seen" once they actually enter a
  request sent to a model — an event arriving while OpenCode is idle
  doesn't consume it.

If the daemon connection fails, the plugin logs through `client.app.log`
(`service: "taskferry"`) rather than throwing, so a taskferry outage never
breaks OpenCode itself; it just runs without task context or toasts until
the next successful connection attempt.

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
