# ADR 0003: Reject native tool-spec exposure (opencode/kilo); taskferry stays CLI-only

**Status:** Accepted, 2026-08-18.

**Date:** 2026-08-18

## Context

Issue #490 ("P0: Remove Kilo tooling — blowing up context window") reported
sessions burning 12k+ tokens on tool-spec definitions injected every turn,
crowding out actual conversation and code, with observed re-read loops on
top of it.

Root cause, traced during the fix: a local, never-pushed branch
`feat/opencode-tool-integration` (commit `09d2b09`, "feat(plugins): add
native opencode/kilo tools for background dispatch and live status") added
`src/plugin-tools.js`, registering `taskferry_dispatch`, `taskferry_status`,
`taskferry_list`, `taskferry_result`, `taskferry_cancel`, and
`taskferry_output` as native tools on both `src/opencode-plugin.js` and a
new `src/kilo-plugin.js`. `taskferry_dispatch` and `taskferry_status` both
carried a `wait: true` option that polled to terminal status inside the
tool call itself. `~/.config/kilo/plugins/taskferry.js` was symlinked
straight into that worktree, so every live Kilo session picked up the full
tool-spec surface on every turn — that symlink is what actually caused the
observed bloat; `main` never carried this code.

This is not a new question. Taskferry already answered it once:
`docs/migrating-from-mcp.md` documents the deliberate move off an MCP
server exposing `taskferry_*` tools (`src/server.js`, since deleted) to a
plain CLI (`taskferry <command>`) backed by a local daemon, installed
through each agent's native plugin mechanism. `feat/opencode-tool-integration`
re-introduced the exact shape that migration removed, under new names, on
two more hosts.

## Decision

**Taskferry does not expose itself as native agent tools, on any host,
including a stripped-down variant that keeps only a `wait`-style tool.**
CLI commands (`taskferry dispatch`, `wait`, `status`, `list`, `result`,
`cancel`, `output`, ...) are the only invocation surface. Host plugins
(`src/opencode-plugin.js`, and any future `src/kilo-plugin.js`) may keep
doing what `opencode-plugin.js` already does on `main`: subscribe to the
daemon, render toasts, and inject a short `Taskferry tasks: ...` block into
the system prompt via `experimental.chat.system.transform`. They must never
register a callable tool.

The `feat/opencode-tool-integration` branch and its local worktree were
deleted outright, unpushed, no PR. The `wait: true` option it added to
`taskferry_dispatch`/`taskferry_status` is rejected along with the rest —
there is no partial version of this that ships.

## Consequences

Gains:

- Every host sees the same taskferry surface (CLI + AXI), so `choosing-a-model`
  and `deciding-to-dispatch`-style dispatch-lane guidance stays host-agnostic;
  nothing forks into a "this host gets a wait tool, this one doesn't" split.
- No per-host tool-spec token cost. The only per-turn cost a host plugin can
  add is the existing bounded context block (5-row cap, already the pattern
  on `main`).
- Removes a second, drifted reimplementation of dispatch/status/list/wait
  logic (`src/plugin-tools.js` duplicated large parts of `src/executor.js`
  per its own diff) that would otherwise need to be kept in sync by hand.

Costs and hazards:

- A host that only trusts native tool calls (not raw shell/CLI access) has
  no taskferry integration path under this decision. None of the currently
  targeted hosts (Claude Code, Codex, opencode) require this; revisit if one
  does.
- Toast/context-injection plugins (the surface this ADR still allows) are
  easy to grow back toward a tool registration by degrees. Review any new
  `src/*-plugin.js` hook against this ADR before merging, not just against
  its own diff.

## Alternatives considered

- **Keep only a `taskferry_wait` tool, drop the rest.** This was the
  originally proposed middle ground. Rejected: a single tool is still a
  tool-spec injected every turn, still duplicates `taskferry wait`, and
  keeping "just one" leaves the door open to the same regrowth this ADR
  exists to close.
- **Lazy-load tool specs behind a single dispatcher tool** (issue #490's own
  suggested fallback: "a single tool wrapper that dispatches to the right
  backend, instead of 15 separate tool specs"). Rejected: still a
  standing per-turn tool-spec cost, still a second implementation surface
  next to the CLI, for a problem the CLI already solves.
- **Keep the tool surface, gate it behind a flag.** Rejected: an unused flag
  defaulting to off just delays the same regrowth risk to whenever someone
  flips it back on; simpler to not have the code at all.

## Revisit this decision if

- A host taskferry needs to target genuinely cannot invoke a CLI (no shell
  access at all) and can only call declared tools.
- The daemon protocol changes in a way that makes a thin, single, generic
  tool wrapper (not a 15-tool surface) clearly cheaper than shelling out —
  re-litigate against real token measurements, not the estimate that was
  used here.

## Evidence (verified 2026-08-18)

- `git log --oneline -1 feat/opencode-tool-integration` (before deletion):
  `09d2b09 feat(plugins): add native opencode/kilo tools for background
  dispatch and live status`.
- `git diff main feat/opencode-tool-integration --stat` (before deletion)
  showed `src/plugin-tools.js` (296 lines, new) plus edits to
  `src/opencode-plugin.js`, new `src/kilo-plugin.js` (378 lines), and
  matching test files — none of it reachable from `main`.
- `ls -la ~/.config/kilo/plugins/taskferry.js` showed a symlink to
  `/workspace/taskferry/.worktrees/opencode-tool-integration/src/kilo-plugin.js`;
  removed as part of this fix.
- `rg -il "kilo" -g '!node_modules' -g '!.git'` against `main` returns no
  hits at all (`docs/integrations/kilo.md` and `src/kilo-plugin.js` live only
  on the still-open, unmerged `feat/kilo-integration` branch / PR #489 —
  an unrelated, toast/context-only Kilo Code frontend integration, out of
  scope for this decision).
