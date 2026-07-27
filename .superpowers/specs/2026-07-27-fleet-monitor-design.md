# Git-workspace-scoped fleet monitor

## Goal

Give a Claude session a periodic (not per-event) view of every ferry
dispatched anywhere in its git workspace — including ones dispatched by
other concurrent sessions or from other subdirectories of the same repo —
without dumping a firehose of individual activity events into context.
Delivered via the harness-native `Monitor` tool, auto-armed on a session's
first `taskferry dispatch`.

Replaces the manual, session-scoped grouping concept with automatic,
directory-scoped grouping based on git repo root discovery, for the
commands that browse/observe tasks (`list`, `watch`, `context`, `advisor`,
`home`). **Dispatch's own launch directory is explicitly out of scope and
unchanged** — see "Launch directory vs. grouping scope" below.

Depends on `parseDuration` from `2026-07-27-duration-flags-design.md` for
the new `--flush-interval` flag; otherwise independent of that spec.

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
- **Changing `dispatch`'s launch directory default.** `dispatch --directory`
  (and its cwd fallback) is unchanged by this spec — a worker still runs
  wherever it runs today. Only the *observation* commands' directory
  default changes. See "Launch directory vs. grouping scope."
- Removing or renaming the `originSessionId` protocol field or its
  existing tests (`src/daemon.js:274`, `src/daemon.test.js`). It stays in
  the code, unused by this feature.
- Compound duration strings, decimals, or other `parseDuration` extensions
  beyond what `2026-07-27-duration-flags-design.md` already specifies.

## Launch directory vs. grouping scope

Today, `directory` is not just a workspace tag: `src/tasks.js:1478` sets
`launchDirectory` from the dispatched task's `directory`, `src/executor.js:189`
passes it straight to `opencode run --dir`, and it's the bwrap sandbox root
(`src/tasks.js:1563`). Changing `dispatch`'s directory default would
silently move where a worker actually executes (e.g. a dispatch from
`/repo/packages/foo` would run at `/repo` instead) — a functional
regression, not a monitoring nicety.

This spec keeps `dispatch`'s directory resolution **exactly as it is
today**: explicit `--directory` if given, else literal cwd. Anyone who
wants a worker scoped to a specific subdirectory continues to pass
`--directory <path>` explicitly — already the established convention for
worktree-based dispatch (see `using-taskferry`'s "Keep the task brief and
directory explicit" guidance).

Only the **observation** commands (`list`, `watch`, `context`, `advisor`,
`home` — anything that reads/subscribes rather than dispatches) get the
new workspace-root default, so that watching/listing from anywhere in the
repo surfaces everything dispatched anywhere in the repo, without needing
every dispatch to also move to the root.

## Components

### 1. `resolveWorkspaceRoot(startDir, runCommand)` — new helper, `src/paths.js`

Reuses the existing `resolveGitCommonDir` (`src/sandbox.js:89-97`, already
used for worktree dispatch at `src/tasks.js:1555`) rather than a hand-rolled
`.git/`-directory walk-up — it already correctly resolves both nested
(`/repo/.worktrees/x`) and sibling (`git worktree add ../repo-feat`)
worktree layouts via `git rev-parse --git-common-dir`, and treats
submodules as their own repo boundary the same way plain `git` does.

`resolveWorkspaceRoot(startDir)`:
1. Calls `resolveGitCommonDir(startDir)`.
2. If it returns a path, takes its parent directory (the `.git` dir's
   parent is the repo root) and returns that.
3. If it returns `null` (not inside a git repo at all — `git
   rev-parse` failed), writes a single warning to stderr
   (`no git repository found for <startDir>; using it directly`, emitted
   once per process, not once per call) and returns `startDir` unchanged —
   identical to today's existing default behavior.

### 2. `--directory` default resolution changes (`list`, `watch`, `context`, `advisor`, `home`)

Everywhere `--directory` is optional on one of these five commands, the
default changes from "literal cwd" to `resolveWorkspaceRoot(cwd)`. An
explicit `--directory <path>` flag is always used exactly as given —
`resolveWorkspaceRoot` is never consulted when the flag is present, even
for a path outside any git repo.

`dispatch` is **not** in this list (see above).

This is the mechanism that replaces manual session-scoping: two Claude
sessions (or a session and a manual CLI call) both operating somewhere
under the same repo now resolve to the same directory automatically for
observation purposes, so they see each other's tasks in `list`/`watch`
without any explicit coordination. The daemon's directory-match filtering
(`src/daemon.js:156`, `273`) stays exact-string-equality — this works
because dispatch's directory is unchanged (still whatever `directory` was
passed at dispatch time, whether that's a subdirectory or the repo root),
while watch/list now ask for the *root*, which won't exact-match a
dispatch from a subdirectory. **This is a known, accepted limitation, not
a bug**: a dispatch issued from a subdirectory with no explicit
`--directory` is scoped to that subdirectory and won't show up in a
root-scoped `watch`/`list` unless the dispatcher also passed
`--directory <root>` explicitly. Since `dispatch`'s own default is
unchanged (still literal cwd), the common case — dispatching from the repo
root, which is how `subagent-driven-development`/worktree-based dispatch
and this session's own usage already work — is unaffected: root-cwd
dispatches and root-scoped watch/list already match exactly.

**Pre-existing persisted tasks** keep whatever literal directory they were
dispatched with (`src/tasks.js:726` realpath's it on load, doesn't change
its value). After this change ships, a default (no `--directory`)
`watch`/`list` resolves to the workspace root, which may not exact-match
an old task's literal subdirectory tag — those tasks remain visible only
via an explicit `--directory` matching their original value. This is
expected, not a migration bug: no data changes, only the default
resolution for new observation calls.

### 3. `watch --flush-interval <duration>` and buffered output

New flag on `watch`, parsed with `parseDuration` (from the duration-flags
spec). Requires `--summaries` (rejected with a `UsageError` —
"`--flush-interval` requires `--summaries`" — if passed without it).

In `streamTaskEvents` (`src/commands.js`), when `flushIntervalMs` is set:
- Incoming `task.activity`/`task.state` events are stored in a
  `Map<taskId, event>` (last-write-wins per task — a late `task.activity`
  can overwrite an already-buffered terminal `task.state` for the same
  task; acceptable for a periodic digest, since the task's true final
  status is still available via `taskferry status`/`result`) instead of
  being written to stdout immediately.
- A `setInterval(flushIntervalMs)` timer, on each tick: if the map is
  non-empty, formats every buffered event with the existing
  `formatActivityLine`/`formatWatchEvent` logic and writes it, then clears
  the map. An empty tick (nothing changed since the last flush) is a
  no-op — no empty output.
- **`--flush-interval` combined with `--task-id`**: the existing
  `--task-id` early-settle-on-terminal-event behavior
  (`src/commands.js:271-273`) still applies, but the terminal event must
  be flushed immediately (not left buffered) before the command exits —
  otherwise `client.close()` in `watchCommand`'s `finally`
  (`src/commands.js:312-314`) would end the process with the final event
  still sitting unflushed in the map. Concretely: on receiving a terminal
  event for the watched `taskId`, flush the buffer synchronously (write
  and clear) before calling `settle(...)`.
- **`ndjson` format**: each flush tick emits one JSON object per line —
  `{ "type": "watch.flush", "timestamp": "<ISO 8601>", "events": [...] }`
  — where `events` is the array of raw buffered event objects (unchanged
  shape from today's per-event ndjson output), not a re-formatted
  summary. `toon`/plain format renders the same buffered events as today's
  per-event lines, just batched under one flush tick instead of streamed
  individually.
- The timer is created and cleared inside `streamTaskEvents`'s existing
  `finished.finally(...)` block (`src/commands.js:293-295`), the same
  place the `abort` listener is already cleaned up — not tied to
  `watchCommand`'s separate `client.close()` finally, which only runs
  after `streamTaskEvents` has already resolved.

### 4. Agent-side auto-arm convention (documentation only, no taskferry code)

Add to the **canonical** `using-taskferry` skill file
(`skills/using-taskferry/SKILL.md` — not the generated copy at
`integrations/claude/skills/using-taskferry/SKILL.md`, which
`npm run skill:generate` regenerates and `npm run skill:check` verifies;
`taskferry dispatch` itself hard-fails via `checkSkills()`
(`src/commands.js:67-75`) if the generated copy drifts from the canonical
one, so this edit must go through the regen step before anything else in
the branch dispatches), and cross-reference from
`docs/integrations/claude-code.md`: on a session's first
`taskferry dispatch`, background
`taskferry watch --summaries --flush-interval 5m` (no `--directory`
needed — it resolves the workspace root automatically) and register the
process with the harness `Monitor` tool, so periodic fleet updates surface
as notifications into the agent's own context without the agent polling.

This is pure convention for future Claude sessions to follow — the
`Monitor` tool is harness-native and can't be invoked from within
taskferry's own code.

## Data flow

1. Agent runs `taskferry dispatch --prompt ...` — directory resolution
   unchanged (explicit `--directory` or literal cwd). Task is tagged with
   that directory, worker launches there.
2. First dispatch in a session also backgrounds
   `taskferry watch --summaries --flush-interval 5m` (directory defaults
   to `resolveWorkspaceRoot(cwd)`) and registers it with `Monitor`.
3. Every task dispatched with a directory that exact-matches the resolved
   root — from this session, another concurrent Claude session, or a
   manual CLI invocation at the root — emits `task.activity`/`task.state`
   events the daemon broadcasts to every subscriber on that directory.
4. `streamTaskEvents` buffers the latest event per `taskId` instead of
   writing immediately.
5. Every flush interval, the buffer is formatted as one combined block and
   written to stdout; `Monitor` surfaces it as a notification. The buffer
   is cleared after each flush.

## Error handling

- `resolveGitCommonDir` returning `null` (no git repo found): warn once to
  stderr per process, fall back to `startDir` (today's existing default)
  — not a fatal error.
- `parseDuration` errors: see `2026-07-27-duration-flags-design.md`.
- `watch --flush-interval` without `--summaries`: rejected with a
  `UsageError`, no silent fallback.
- `watch --flush-interval --task-id`: terminal event is flushed
  synchronously before exit, never silently dropped.
- The flush timer is cleared in `streamTaskEvents`'s existing cleanup path
  (`finished.finally`), same lifecycle as the abort listener.
- An explicit `--directory` always overrides `resolveWorkspaceRoot`
  outright, even for a path outside any git repo.

## Testing

- `resolveWorkspaceRoot`: unit tests using temp directories and a fake/real
  `runCommand` — nested worktree layout, **sibling worktree layout**
  (the case the original hand-rolled approach failed), a plain non-worktree
  repo, a submodule, and the no-git-repo-found fallback (asserting the
  warning fires once) — new `src/paths.test.js`.
- `--directory` default changes: `list`/`watch`/`context`/`advisor`/`home`
  tests confirming they resolve via `resolveWorkspaceRoot` when
  `--directory` is omitted, and that `dispatch` does **not** (regression
  test pinning the launch-directory behavior as unchanged).
- `watch --flush-interval`: test in `src/commands.test.js` — multiple
  activity events for the same and different `taskId`s within one interval
  collapse into a single flushed block; an empty tick emits nothing; a
  `--task-id`-scoped watch flushes its terminal event before exiting
  rather than dropping it; `ndjson` format emits the `watch.flush` wrapper
  shape.
- Existing `src/daemon.test.js` `originSessionId` tests are left as-is
  (still valid, just unused by this feature).
