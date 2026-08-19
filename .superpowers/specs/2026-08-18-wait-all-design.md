# wait-all — consolidated multi-task wait

## Goal

Replace the manual sequential `taskferry wait` bash loop documented in
`~/.claude/CLAUDE_md-addendum-for-non-claude-model.md` ("Awaiting ferries
without a Monitor tool") with a single first-class CLI command that:

- Accepts zero or many task ids, or — when no ids are given — a
  directory scope (same semantics as `taskferry list`) and waits for every
  running/queued task in that workspace.
- Blocks until the group settles, with an optional periodic heartbeat
  table (`N/M settled... working`, per-task last-write age, bytes-since-last
  poll) analogous to `wait --summarize`.

No background/detach mode in v1 (opencode/Kilo have no Monitor-style wake
primitive; a detach mode would be a pollable state-file, deferred).

## Scope

### Command

```
taskferry wait-all [<id>...] [options]
  --directory <path>   workspace to scope when no ids given (default: cwd's git root)
  --timeout <duration> per-task timeout (ms or 30s/5m/1h, same parse as wait)
  --summarize          periodic live table while waiting
  --interval <duration> redraw interval for --summarize (default 15s)
  --full               passthrough to per-task status projection (same as wait)
```

Design decisions locked (2026-08-18 brainstorming):

- New subcommand `wait-all`, not an overloaded `wait` positional. Keeps
  `wait <id>`'s single-id contract intact for scripts.
- Directory-scoped mode is the common case: `taskferry wait-all` with no
  ids means "wait for everything running/queued here." Enabled by reusing
  `runList`'s directory resolution (`normalizeDirectory(resolveWorkspaceRoot(cwd))`)
  and filtering `task.list` results to `status in (running, queued)`.
- `--directory` and positional ids are mutually exclusive — rejected at parse
  time, same pattern as `list`/`watch`'s `--all` vs `--directory` check.
- Empty group (`0 running/queued` in scope, or caller passed no ids and none
  exist) succeeds immediately as `0/0 settled`, not an error.
- Snapshot semantics: ids are resolved once at call time; tasks dispatched
  after `wait-all` starts are not picked up.
- Concurrent waiting: one `client.request("task.wait", {taskId, timeoutMs})`
  per id, fanned out with `Promise.allSettled`. Server-side `pollTask`
  (`src/tasks.js:6227`) resolves on timeout with `{...summary, timedOut:true}`,
  never rejects — so no throw-based control flow is needed.
- Exit code: 0 only if every waited task settled with a terminal success
  shape (`status: done`); any `timedOut`, non-done status, or RPC rejection
  makes the command exit non-zero (caller can still inspect per-task lines).

### Output

Plain mode (default): silent while blocking, then a final TOON block per id
(same `leanStatus` projection `wait` uses) plus a `N/M settled` tally line.
Matches `taskferry wait`'s quiet-by-default convention.

`--summarize` mode: reuse `src/activity.js`'s existing byte-offset tracking
(`readActivitySnapshot`/`readDeltaNarration`) — the same mechanism
`wait --summarize` and `watch --summaries` already use — to render:

```
3/10 settled... working
  oc_abc123 done      last write 2s ago   +0 bytes
  oc_def456 running   last write 14s ago  +842 bytes since last poll
  oc_ghi789 queued    last write —        +0 bytes
```

`--interval` defaults to 15s; last-write/bytes columns come straight from
activity snapshots, no new daemon instrumentation.

### Files touched

- `src/command-specs.js` — new `wait-all` entry
- `src/args.js` — `wait-all` in arg parsing: variadic positionals collected
  into `taskIds: string[]`, `--directory`/`--timeout`/`--summarize`/`--interval`
  /`--full` flags, mutual-exclusion validation, `DEFAULT_OPTIONS["wait-all"]`
- `src/commands.js` — `runWaitAll` + `HANDLERS["wait-all"]`; reuses
  `runList` directory logic, `resolveWaitDefaultTimeoutMs`, `leanStatus`
- `src/cli.js` — `normalizeCommandDirectory`/`usesWorkspaceRoot` updated to
  cover `wait-all`'s directory default
- `docs/cli-reference.md` — new `wait-all` section
- Tests: `src/args.test.js`, `src/commands.test.js`, `src/cli.test.js`
  (pattern-follow existing `wait`/`list` tests)

Future (not in v1): `src/activity.js` heartbeat integration for `--summarize`
table, and the CLAUDE.md addendum follow-up replacing the bash loop with
`taskferry wait-all --summarize` (or `wait-all <ids> --summarize` when ids
are explicit). Also note: a config/env triplet for `--interval` per
"Every new config knob ships as flag/config-key/env-var triplet" is
deferred — if introduced, follow taskferry's `waitDefaultTimeoutMs` pattern.

## Verification

- `npm test` (existing suite plus new `wait-all` cases)
- Manual: `taskferry dispatch` × N in a workspace, then
  `taskferry wait-all --summarize` converges to `N/N settled`
- Manual: `taskferry wait-all <id1> <id2> --timeout 5s` correctly reports
  partial `timedOut` and exits non-zero
- Confirm `taskferry wait-all --directory /tmp/foo` rejects when ids also given
- Confirm `taskferry wait-all` with zero running tasks exits `0/0` immediately

## Out of scope

- Background/detach + pollable state file (deferred; no Monitor wake primitive
  on this host to justify it — foreground block covers v1)
- Extending `wait` itself to variadic ids (rejected — would break single-id
  contract)
- New daemon RPC (reuse existing `task.list` + `task.wait`)
- Config/env triplet for `--interval` (defer until need is proven)
