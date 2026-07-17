# Codex integration

Native Codex plugin: hooks only, no MCP server, no persistent monitor
surface. It keeps a Codex session aware of the current workspace's
taskferry tasks by refreshing context at two points in the conversation.

## Prerequisite: `taskferry` on `PATH`

Like the Claude Code integration, both hook commands start with `command -v
taskferry >/dev/null 2>&1` and fall back to a plain-text notice if the
binary isn't found. Running `taskferry setup` once from the taskferry
checkout puts the CLI on `PATH` and registers the Codex marketplace in
the same step — see the [Install section in the README](../README.md#install)
for the full bootstrap.

## Install

From the taskferry checkout, run:

```bash
taskferry setup
```

When the `codex` CLI is on `PATH`, `taskferry setup` adds the checkout
as a Codex marketplace (if it is not already registered) or calls
`codex plugin marketplace upgrade taskferry` if it is. The marketplace
catalog is `.agents/plugins/marketplace.json` at the repository root;
the plugin itself lives under `integrations/codex/`
(`integrations/codex/.codex-plugin/plugin.json`).

Unlike the Claude Code leg, the Codex leg of `setup` cannot install or
upgrade the plugin itself — Codex desktop drives that through its own
UI. `setup` exits with `status: "desktop-install-required"` and prints:

```
next: Open Codex desktop, install Taskferry from its marketplace, then
review and trust its hooks.
```

In Codex desktop:

1. Open the marketplace, find Taskferry, and install it.
2. Open the `/hooks` interface and review the Taskferry hooks before
   trusting them. The hooks run `taskferry context --format codex-hook`
   (see [What it does](#what-it-does)), and the trust decision is yours.

Codex requires reviewing and trusting plugin hooks through `/hooks` before
they run. If hooks are disabled in your Codex configuration, enable them
only when you want this lifecycle context, by setting:

```toml
[features]
hooks = true
```

Don't flip this on globally as a side effect of installing taskferry if
hooks were deliberately off — enable it because you've decided you want
hook-driven context, and trust the taskferry hooks specifically through
`/hooks`.

## Update

After `git pull` (or any other change to the checkout), re-run `taskferry
setup` from inside it. With `codex` on `PATH`, the Codex leg re-adds the
marketplace if it has gone missing or runs `codex plugin marketplace
upgrade taskferry`; the actual plugin install on the Codex desktop side
still has to be refreshed there, and the `/hooks` trust decision does not
need to be redone. Restart Codex so it picks up the refreshed plugin.

## Remove

```bash
codex plugin uninstall taskferry@taskferry
codex plugin marketplace remove taskferry
```

This does not stop the daemon or any running tasks — see
[daemon.md](../daemon.md#stopping-the-daemon) to stop that separately.

## What it does

Both hooks run the same command — `taskferry context --format codex-hook`
— and emit its output as `additionalContext`, wrapped in the plain `{
additionalContext }` envelope Codex expects (no `hookSpecificOutput`
wrapper, unlike Claude Code's hook format):

- **`SessionStart`** (matcher `startup|resume|clear|compact`): loads
  workspace task context when a session begins or resumes.
- **`UserPromptSubmit`**: refreshes that context immediately before each
  user turn, so task state changes mid-conversation (a background dispatch
  finishing) become visible on the next turn without waiting for a new
  session.

If `taskferry context` fails, or the binary isn't on `PATH`, each hook
falls back to a short diagnostic string in `additionalContext` instead of
blocking the turn.

## UI limitations

Codex has no equivalent to Claude Code's monitor surface or OpenCode's
toasts — no persistent, continuously-updating view of task state inside
the UI. The two hooks above are the only mechanism; between a
`UserPromptSubmit` refresh and the next one, task-state changes are
invisible until you run `taskferry status`/`taskferry list` yourself or
send another turn. Do not describe this integration as providing live
monitoring — it doesn't.

## Using taskferry as an external worker backend

The plugin bundles the canonical taskferry skill at
`integrations/codex/skills/taskferry/SKILL.md` (generated from
`skills/taskferry/SKILL.md` via `npm run skill:generate`), so a
Codex-driven `subagent-driven-development` lifecycle can dispatch
implementer, fixer, and reviewer work through `taskferry dispatch` / `wait`
/ `result` the same way Claude Code does. The hooks above only provide
ambient context inside a live session; they play no part in dispatching
work. See [cli-reference.md](../cli-reference.md) for the full command
surface.
