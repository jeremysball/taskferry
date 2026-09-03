# Kilo Code integration

Native Kilo Code plugin: first-class, with live monitoring. No MCP server, no `kilo mcp add`. It provides a file-symlink plugin, session hooks, and a bundled skill — bringing Kilo to parity with Claude Code and beyond.

Kilo Code is the successor to OpenCode (same lineage, same plugin surface with extensions). This integration replaces and supersedes the plain OpenCode plugin when running inside Kilo: it reuses the same daemon subscription model but adds Kilo-native hooks, a richer toast/status surface, and fleet-wide monitoring.

## Prerequisite: `taskferry` on `PATH`

The plugin's hook commands start with `command -v taskferry >/dev/null 2>&1` and degrade to a plain-text notice if that check fails. Running `taskferry setup` once from the taskferry checkout puts the CLI on `PATH` and registers the Kilo marketplace/plugin in the same step — see the [Quickstart section in the README](../../README.md#quickstart) for the full bootstrap.

## Install

From the taskferry checkout, run:

```bash
taskferry setup
```

`taskferry setup` creates (or refreshes) a symlink at
`$XDG_CONFIG_HOME/kilo/plugins/taskferry.js` (default
`~/.config/kilo/plugins/taskferry.js`) that resolves to the
checkout's `src/kilo-plugin.js`. Kilo auto-loads any module at
that path on startup (OpenCode-compatible discovery), so the plugin symlink itself needs no `kilo.json` edit. The same command also creates the CLI symlink at `~/.local/bin/taskferry`, the OpenCode plugin symlink, and registers the Claude Code marketplace when `claude` is on `PATH` — see the [Quickstart section in the README](../../README.md#quickstart) for the full bootstrap.

The symlink is self-managed: `taskferry setup` only replaces the file at that path when the existing symlink's target is one it created (a `src/kilo-plugin.js` or `src/opencode-plugin.js` inside a checkout whose `package.json` is `taskferry`). An unrelated symlink, a regular file, or a directory at that path is left alone and `setup` exits with `refusing to replace unmanaged path: <path>`.

The `src/kilo-plugin.js` module is also exported from the `taskferry` package's `exports` field as `taskferry/kilo` (and `taskferry/opencode` for the shared base) for direct `import` use.

Additionally, the `integrations/kilo/` directory is a full Kilo plugin distribution:

```
integrations/kilo/
  .kilo-plugin/plugin.json   # plugin manifest
  hooks/hooks.json           # SessionStart + UserPromptSubmit hooks
  skills/using-taskferry/    # generated copy of canonical skill
```

This mirrors `integrations/claude/` and `integrations/codex/` and is kept in sync via `npm run skill:generate` (`npm run skill:check` fails the build if it drifts).

## Update

After `git pull` (or any other change to the checkout), re-run `taskferry setup` from inside it. The Kilo leg is idempotent: when no symlink exists yet, or the existing one resolves to a file inside *this same* checkout, it's unlinked and recreated pointing at this checkout's `src/kilo-plugin.js`. A symlink that resolves into a *different* taskferry checkout is deliberately left alone and rejected as unmanaged. A dangling symlink or one pointing at an unrelated file is treated the same way. If a checkout genuinely moved, remove the stale symlink by hand before re-running `setup` from the new location. Restart Kilo so it reloads the freshly linked module.

The `taskferry/kilo` export is versioned with the package: `PROTOCOL_VERSION` changes only when the daemon/CLI RPC contract breaks.

## Remove

Delete the symlink (and the daemon's state if you no longer need it):

```bash
rm "$XDG_CONFIG_HOME/kilo/plugins/taskferry.js"
# (or: rm ~/.config/kilo/plugins/taskferry.js)
```

This does not stop the daemon or affect other integrations sharing it — see [daemon.md](../daemon.md#stopping-the-daemon) to stop that separately.

## What it does — UI surface and monitoring

On load, the plugin connects to the taskferry daemon (auto-starting it if needed) and subscribes to events for the current Kilo workspace directory. It exposes three behaviors, all scoped to that one workspace:

- **Dynamic toasts (live monitoring).** Every `task.state` event fires `client.tui.showToast`, titled `Taskferry(<status> · <id>)` with the task's current activity as the body and a variant chosen by status (`queued`/`running` → info, `done` → success, `crashed` → error, `cancelled` → warning). Kilo's TUI renders these as transient but timestamped overlays — the closest thing to a live per-task status surface. Activity updates (`task.activity` events) refresh the row's text in-place so the next toast or context injection shows the latest activity without a new state transition.

- **System-prompt context (parity with Claude Code).** The `experimental.chat.system.transform` hook (and its Kilo-native alias `chat.system.transform`) injects a `Taskferry tasks:` block (up to 5 rows, with a `+N more` suffix) listing active tasks and terminal tasks not yet surfaced to a model request, immediately before Kilo sends its system prompt. Terminal-status rows are only marked "seen" once they actually enter a request sent to a model — an event arriving while Kilo is idle doesn't consume it. This is the same contract as the Claude Code `SessionStart` hook and the OpenCode plugin, but triggered on every model turn, not just session start.

- **Statusline / fleet indicator.** The plugin exposes a `kilo.status` hook and a `getTaskferryState()` accessor returning `{ active, unseenTerminal, block }` for hosts that poll the plugin object directly (e.g. TUI status bar widgets). Hosts can render `TF: 1 running, 1 queued` without parsing the system-prompt block. The daemon's `task.context` response already provides `counts` by status for this purpose.

If the daemon connection fails, the plugin logs through `client.app.log` (`service: "taskferry"`) rather than throwing, so a taskferry outage never breaks Kilo itself; it just runs without task context or toasts for the rest of that plugin instance's lifetime. The connection attempt happens once, at plugin initialization — there is no retry timer or lazy reconnect, so a daemon that comes back up after the initial failure isn't picked up until Kilo reloads or restarts the plugin.

### Hooks (SessionStart + UserPromptSubmit)

In addition to the live daemon subscription, the `hooks/hooks.json` manifest registers two shell hooks for hosts that consume the manifest directly:

- **`SessionStart`** (matcher `startup|resume|clear|compact`): runs `taskferry context --format kilo-hook` (falling back to `toon`) and injects the result as `hookSpecificOutput.additionalContext` via the standard `SessionStart` envelope.
- **`UserPromptSubmit`**: refreshes that context immediately before each user turn, so task state changes mid-conversation (a background dispatch finishing) become visible on the next turn without waiting for a new session.

Both hooks degrade gracefully: if `taskferry context` itself fails, or the binary isn't on `PATH`, the hook injects a short diagnostic line instead of blocking the turn.

### Fleet-wide monitoring

Outside the hook/daemon surface, the bundled skill's "Fleet-Wide Monitoring" section covers `taskferry watch --summaries --flush-interval` + Monitor auto-arm convention. Kilo's `tool` permission for shell commands allows the skill to arm a session-scoped `watch` daemon in the background (pid-file guarded, one per session) for fleet-wide visibility across all ferries in the workspace.

## `TASKFERRY_CHILD` and nested plugin loads

When Kilo itself is running as a taskferry-dispatched child (`TASKFERRY_CHILD=1` is set in that process's environment — see [security.md](../security.md#taskferry_child)), the plugin factory returns an empty hook object immediately instead of connecting to the daemon. This avoids a dispatched task's own nested `kilo` process opening a second, redundant subscription against the same workspace.

## UI limitations

Toasts are transient notifications, not a persistent list. The system-prompt block is bounded to 5 rows. For the full workspace task list at any point, run `taskferry list` directly, or use `taskferry watch` for a live stream. The `kilo.status` / `getTaskferryState()` surface is host-dependent: not every Kilo build renders it in the status bar.

## Using taskferry as an external worker backend

This plugin is presentation + lightweight fleet monitoring — toasts, system-prompt context, and the bundled skill's watch convention inside a live Kilo session. Dispatching *other* Kilo work is the CLI's job (`taskferry dispatch`), driven by whichever subagent-driven-development-style lifecycle is doing the dispatching (typically Claude Code, Kilo itself, or Codex, using the taskferry skill — see [claude-code.md](claude-code.md) and [codex.md](codex.md)). See [cli-reference.md](../cli-reference.md) for the full command surface.

The canonical skill is at `skills/using-taskferry/SKILL.md`; the copy at `integrations/kilo/skills/using-taskferry/SKILL.md` is generated via `npm run skill:generate` and is byte-identical. `npm run skill:check` fails the build if they drift.
