# Git-workspace-scoped fleet monitor with duration flags

## Goal

Give a Claude session a periodic (not per-event) view of every ferry
dispatched anywhere in its git workspace — including ones dispatched by
other concurrent sessions — without dumping a firehose of individual
activity events into context. Delivered via the harness-native `Monitor`
tool, auto-armed on a session's first `taskferry dispatch`.

Along the way, replace all millisecond-only duration flags with a shared
duration-string parser, and replace the manual, session-scoped
`--origin-session-id` concept with automatic, directory-scoped grouping
based on git repo root discovery.

## Non-goals

- Reviving the old `claude-monitor` plugin hook or `monitors.json` — this
  is a different mechanism (harness `Monitor` tool + `taskferry watch`),
  not a revert.
- Phone push notifications — explicitly rejected; `Monitor` surfaces
  updates into the agent's own context, nothing external.
- Per-ferry-event notifications — cadence is periodic (every flush
  interval), not one push per state transition. A single ferry reaching a
  terminal state remains the dispatching agent's own job via
  `Bash --run_in_background` + `taskferry wait` (see issue #200), not this
  feature's job.
- Removing or renaming the `originSessionId` protocol field, daemon
  subscription filter (`src/daemon.js:274`), or its existing tests. It
  stays in the code, unused by this feature, in case another caller still
  needs strict single-session filtering later.
- Compound duration strings (`1h30m`). Single-unit-suffix only.

## Components

### 1. `parseDuration(value, flag)` — new shared helper, `src/args.js`

Accepts either:
- A bare non-negative integer string (backward-compatible: interpreted as
  milliseconds), or
- `<number><s|m|h>` (e.g. `30s`, `5m`, `1h`) — single unit suffix only, no
  compounding.

Returns milliseconds as a number. Rejects zero, negative, non-numeric, or
multi-unit input with a `UsageError` in the same style as the existing
`parseNumber` (message + "Use `--flag` with ..." remediation).

### 2. `--timeout` flag rename (`wait`, `advisor`)

`--timeout-ms` is renamed to `--timeout` on both commands, parsed with
`parseDuration` instead of `parseNumber`. The internal option key stays
`timeoutMs` (unchanged downstream consumers in `tasks.js`/protocol) — only
the CLI-facing flag name and accepted input format change.

`--timeout-ms` is added to the existing `migrationFlags` table in
`src/args.js` (alongside the current `--timeout_ms` entry), erroring with:
`--timeout-ms was renamed; use --timeout`.

### 3. `resolveWorkspaceRoot(startDir)` — new helper, `src/paths.js`

Walks up from `startDir` toward the filesystem root looking for the
nearest ancestor containing a real `.git` **directory** (checked with
`fs.statSync(...).isDirectory()`, not just existence). A `.git` **file**
(a worktree's pointer to its main repo's git dir) does not count as a stop
point — the walk continues past it, so a worktree resolves to its main
repo's root, and all worktrees of one repo share one linked workspace.

If no ancestor with a `.git/` directory is found before reaching the
filesystem root, write a single warning to stderr
(`no .git repository found above <startDir>; using it directly`) and
return `startDir` unchanged.

### 4. `--directory` default resolution changes (`dispatch`, `list`, `watch`, `context`)

Everywhere `--directory` is optional, the default changes from "literal
cwd" to `resolveWorkspaceRoot(cwd)`. An explicit `--directory <path>`
flag is always used exactly as given — `resolveWorkspaceRoot` is never
consulted when the flag is present, even if that path isn't inside a git
repo at all.

This is the mechanism that replaces `--origin-session-id`: two Claude
sessions (or a session and a manual CLI call) both operating somewhere
under the same repo now resolve to the same directory automatically, so
they see each other's tasks in `list`/`watch` without any explicit
session-id coordination.

### 5. `watch --flush-interval <duration>` and buffered output

New flag on `watch`, parsed with `parseDuration`. Requires `--summaries`
(rejected with a `UsageError` — "`--flush-interval` requires
`--summaries`" — if passed without it; no supported use for buffering raw
non-summary events).

In `streamTaskEvents` (`src/commands.js`), when `flushIntervalMs` is set:
- Incoming `task.activity`/`task.state` events are stored in a
  `Map<taskId, event>` (last-write-wins per task) instead of being written
  to stdout immediately.
- A `setInterval(flushIntervalMs)` timer, on each tick: if the map is
  non-empty, formats every buffered event with the existing
  `formatActivityLine`/`formatWatchEvent` logic as one combined block and
  writes it to stdout, then clears the map. If the map is empty (nothing
  changed since the last tick), the tick is a no-op — no empty output.
- The timer is cleared in the same `signal`-abort cleanup path that
  already tears down the subscription, so no dangling interval survives
  `watch` exiting.

`--flush-interval` is orthogonal to `--task-id`-scoped single-task
watching (which already exits on that task's terminal event) — combining
them is allowed but the flush buffering is moot for a single task, since
each tick's buffer holds at most one entry.

### 6. Agent-side auto-arm convention (documentation only, no taskferry code)

Add to the `using-taskferry` skill (and cross-reference from
`docs/integrations/claude-code.md`): on a session's first
`taskferry dispatch`, background
`taskferry watch --summaries --flush-interval 5m` (no `--directory`
needed — it resolves the workspace root automatically) and register the
process with the harness `Monitor` tool, so periodic fleet updates surface
as notifications into the agent's own context without the agent polling.

This is pure convention for future Claude sessions to follow — the
`Monitor` tool is harness-native and can't be invoked from within
taskferry's own code.

## Data flow

1. Agent runs `taskferry dispatch --prompt ...` with no `--directory` →
   CLI resolves `resolveWorkspaceRoot(cwd)` → dispatch is tagged with that
   resolved directory.
2. First dispatch in a session also backgrounds
   `taskferry watch --summaries --flush-interval 5m` (same resolution, so
   it watches the same root) and registers it with `Monitor`.
3. Every task dispatched into that resolved root — from this session,
   another concurrent Claude session, or a manual CLI invocation — emits
   `task.activity`/`task.state` events the daemon broadcasts to every
   subscriber on that directory (no session filtering).
4. `streamTaskEvents` buffers the latest event per `taskId` instead of
   writing immediately.
5. Every flush interval, the buffer is formatted as one combined block and
   written to stdout; `Monitor` surfaces it as a notification. The buffer
   is cleared after each flush.

## Error handling

- `resolveWorkspaceRoot` finding no `.git/` directory: warn once to
  stderr, fall back to `startDir` (today's existing default) — not a
  fatal error.
- `parseDuration` rejects non-matching strings, zero/negative values, and
  multi-unit input with a `UsageError`.
- `watch --flush-interval` without `--summaries`: rejected with a
  `UsageError`, no silent fallback.
- The flush timer is cleared on `signal` abort, same cleanup path as the
  existing subscription teardown.
- An explicit `--directory` always overrides `resolveWorkspaceRoot`
  outright, even for a path outside any git repo.

## Testing

- `parseDuration`: unit tests for bare ms, each suffix (`s`/`m`/`h`), and
  rejection cases (negative, zero, bad suffix, non-numeric, compound) —
  `src/args.test.js`.
- `resolveWorkspaceRoot`: unit tests using temp directories — nested plain
  dir with `.git/` at some ancestor, a worktree `.git` *file* correctly
  skipped up to the real repo root, and the no-`.git`-anywhere fallback
  (asserting the warning fires) — `src/paths.test.js`.
- `--timeout`/`--timeout-ms` migration: update existing `wait`/`advisor`
  args tests to the new flag name; add a test asserting `--timeout-ms`
  errors with the migration message.
- `watch --flush-interval`: test in `src/commands.test.js` — multiple
  activity events for the same and different `taskId`s within one interval
  collapse into a single flushed block; an empty tick emits nothing.
- Existing `src/daemon.test.js` `originSessionId` tests are left as-is
  (still valid, just unused by this feature).
