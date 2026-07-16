# OpenCode integration

Native OpenCode plugin (`src/opencode-plugin.js`), exported from the
`taskferry` package's `exports` field. Unlike the Claude Code and Codex
integrations, this one has no separate hooks/marketplace manifest — it's a
single JS module OpenCode loads directly through its own plugin config.

## Install

```bash
cd /path/to/taskferry
npm install
npm install -g .   # or: npm link — publishes the "taskferry" package name
```

Then add the package name to the OpenCode project or global config's
`plugin` array (`opencode.json` or the equivalent OpenCode config file):

```json
{
  "plugin": ["taskferry"]
}
```

OpenCode resolves `"taskferry"` to the package's declared `exports` entry
(`./src/opencode-plugin.js`), which default-exports the plugin factory.

## Update

Update the installed package (`npm update -g taskferry`, or re-run `npm
install -g .` from a fresh checkout) and restart OpenCode so it reloads the
plugin module.

## Remove

Remove `"taskferry"` from the `plugin` array in your OpenCode config and
restart OpenCode. This does not stop the daemon or affect other
integrations sharing it — see
[daemon.md](../daemon.md#stopping-the-daemon) to stop that separately.

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
