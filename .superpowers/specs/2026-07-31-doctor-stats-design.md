# doctor --stats: analyze historical runs and present aggregate health data

Resolves: [#249](https://github.com/jeremysball/taskferry/issues/249)

## Problem

`taskferry doctor` today checks the environment only (bwrap, Playwright MCP
isolation, Claude plugin registration). It never touches run history, which is
where the signal actually is. Task history (784+ tasks) is persisted in
`tasks.json`, and today the only ways to see the aggregate picture are the
SessionStart hook's raw ~100KB YAML dump or hand-computing against the state
dir.

## Goals

- `taskferry doctor --stats` reports, from persisted task history:
  - Status mix overall, plus 24h and 7d windows.
  - Per-model breakdown: dispatch count, done rate, crash rate, dominant
    failure reason.
  - Failure-reason histogram across all crashed tasks.
  - The unknown backlog as its own capped list.
  - Trend: crash rate this 24h window vs the previous 24h window.
- Recompute from live task history per invocation; no stored aggregates.
- Point-in-time report only. No live monitoring of in-flight tasks, no
  auto-remediation (no reaping unknowns, no blacklisting models).

## Non-goals

- Folding stats into plain `doctor` output (see Command Surface below for
  why they're kept separate).
- The per-model consecutive-failure-streak signal described in issue #234.
  That's a daemon-side dispatch-time decision; this issue is a human-facing
  report. They read the same underlying task history, so the computation
  here is written as a standalone pure function future work can reuse, but
  building that streak-tracking feature itself is out of scope here.

## Command surface

Add a `--stats` flag to the existing `doctor` command rather than a
`doctor stats` subcommand. The CLI's arg parser (`src/args.js`) has no
subcommand concept — only a single positional slot reserved for task IDs on a
fixed per-command allowlist — so a flag fits the existing architecture
without inventing new parsing machinery.

`taskferry doctor --stats` skips the environment checks (bwrap, Playwright MCP
isolation, Claude plugin registration) entirely and returns only the history
report. Plain `taskferry doctor` is unchanged. The two reports are never
mixed in one call, so every existing `doctor` test (which mocks the daemon
client but never stubs `task.list`) keeps passing unmodified.

`--full` remains valid on plain `doctor` only; combining `--full` and
`--stats` is a usage error (mirrors the existing `--diff`/`--full` mutual
exclusion pattern on `result`).

## Data source

No new daemon RPC. `client.request("task.list", {})` (the same call
`taskferry list --all` already makes) returns every task across all
directories and daemon restarts — the daemon loads `tasks.json` into memory
at startup, relabeling any task still "running" as "unknown" — with exactly
the fields needed: `id`, `status`, `model`, `startedAt`, `failureReason`
(`summarizeRow()` in `src/tasks.js`).

`doctor --stats` fetches that list once and computes the report entirely
client-side (in the CLI process, not the daemon).

## Computation module

A new pure function in a new file, `src/doctor-stats.js`:

```js
computeDoctorStats(rows, { now = Date.now() } = {})
```

- `rows`: the array of `{ id, status, model, startedAt, failureReason }`
  objects from `task.list`.
- `now`: injectable clock for deterministic tests.

Kept standalone (no daemon/CLI imports) so it's independently unit-testable
and reusable by future work (e.g. #234) without dragging in daemon or CLI
plumbing.

### Output schema

```
{
  computedAt: "<ISO>",
  statusMix: {
    overall:  { queued, running, done, crashed, cancelled, unknown, total },
    last24h:  { ...same shape, filtered to startedAt >= now - 24h... },
    last7d:   { ...same shape, filtered to startedAt >= now - 7d... }
  },
  byModel: [
    {
      model,
      dispatches,           // raw count, every status, all-time
      done, crashed, cancelled, unknown,
      doneRate,             // done / terminalTotal, or null if terminalTotal === 0
      crashRate,            // crashed / terminalTotal, or null if terminalTotal === 0
      dominantFailureReason // most common failureReason among this model's
                            // crashed tasks, or null if it has none
    }
    // sorted by dispatches desc
  ],
  failureReasons: [
    { reason, count }       // sorted by count desc, crashed tasks only
  ],
  unknownBacklog: {
    total,                  // count of all unknown tasks, uncapped
    tasks: [ { id, model, startedAt } ]  // capped to 20, newest first
  },
  trend: {
    window: "24h",
    current:  { crashRate, terminal },   // now-24h .. now
    previous: { crashRate, terminal },   // now-48h .. now-24h
    direction: "improving" | "worsening" | "flat" | "unknown"
  }
}
```

### Rules

- `terminalTotal` for a scope = `done + crashed + cancelled + unknown` in
  that scope (queued/running excluded — an in-flight task has no outcome
  yet, so it must not dilute a rate).
- `byModel[].dispatches` counts every status (including queued/running),
  matching the issue's own worked example ("82 dispatches, zero done, 77
  crashed" — 82 ≠ 0 + 77, the remainder being non-terminal at write time).
  Only the *rate* fields are terminal-only.
- Any rate with a zero denominator is `null`, never `0` or omitted silently —
  an ambiguous "no data" case must read as unknown, not a misleadingly
  plausible zero.
- `trend.direction` is `"unknown"` whenever either window's `terminal` count
  is 0 (nothing to compare). Otherwise: `"worsening"` if current > previous,
  `"improving"` if current < previous, `"flat"` if equal.
- `unknownBacklog.tasks` is capped at 20 entries, newest (`startedAt` desc)
  first; `unknownBacklog.total` always reports the true uncapped count.

## Wiring

- `src/args.js`: add `--stats` to the `doctor` command spec's `options` and
  an example; default `stats: false` in `defaultOptions()`; reject
  `--stats` combined with `--full` at validation time.
- `src/commands.js`: in `case "doctor"`, branch on `options.stats` before the
  existing `Promise.allSettled` env-check block — if set, call
  `client.request("task.list", {})`, pass the rows through
  `computeDoctorStats`, and return that object directly (no `integrations`/
  `warnings`/`info` wrapper).
- Output rendering is unchanged: `writeToon()` already renders any plain
  object generically, so no new formatter is needed.

## Testing

- `src/doctor-stats.test.js` (new): unit tests against synthetic rows, no
  daemon —
  - status mix math (overall/24h/7d window filtering)
  - per-model dispatch counts, rates, dominant-failure-reason selection,
    and the null-rate case for an all-non-terminal model
  - failure-reason histogram ordering
  - unknown backlog capping (>20 unknowns) and ordering
  - all four trend directions, including the zero-terminal-window
    `"unknown"` case
- `src/commands.test.js`: one new case wiring a mocked
  `client.request("task.list")` through `doctor --stats` end to end, and one
  case asserting `--stats --full` is rejected.
- `src/args.test.js`: parsing coverage for the new flag and its mutual
  exclusion with `--full`.

## Docs

- `docs/sourcemap.md`: new `src/doctor-stats.js` row; update the `doctor`
  case description in `src/commands.js`'s row.
- `docs/cli-reference.md`: document `--stats`.
- `skills/using-taskferry/SKILL.md` (and its Codex/Claude integration
  copies, if they describe `doctor`): mention `--stats`.
