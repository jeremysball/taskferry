# Duration-string flags: `parseDuration` and the `--timeout` rename

## Goal

Let `--timeout` on `wait` and `advisor` accept a duration string (`30s`,
`5m`, `1h`) in addition to a bare millisecond integer, via one shared
parser. Independent of, and a prerequisite for, the workspace-scoped fleet
monitor design (see `2026-07-27-fleet-monitor-design.md`) — that spec's
`watch --flush-interval` flag reuses this same parser, but nothing here
depends on that spec.

## Non-goals

- Compound duration strings (`1h30m`). Single-unit-suffix only.
- Extending `cancel --grace-ms` to accept duration strings. It stays
  ms-only — no current use case needs it, and cancel's grace period is
  already almost always left at its 5000ms default in practice. Revisit
  if that changes.
- Removing or changing the internal `timeoutMs` option key used downstream
  in `tasks.js`/the daemon protocol — only the CLI-facing flag name and
  accepted input format change.

## Components

### 1. `parseDuration(value, flag)` — new shared helper, `src/args.js`

Accepts either:
- A bare integer string, `>= 0` (backward-compatible: interpreted as
  milliseconds — **0 is valid**, matching today's `--timeout-ms 0`
  behavior at `src/args.js:356`/`src/protocol.js`'s `nonNegativeInteger`,
  used for an immediate status snapshot via `src/commands.js:120`), or
- `<number><s|m|h>` (e.g. `30s`, `5m`, `1h`) — single unit suffix only, no
  compounding, no decimals, no whitespace, suffix must be lowercase.

Returns milliseconds as a number. Rejects negative values, non-numeric
input, multi-unit strings, and any other malformed input with a
`UsageError` in the same style as the existing `parseNumber` (message +
"Use `--flag` with ..." remediation).

### 2. `--timeout` flag rename (`wait`, `advisor`)

`--timeout-ms` is renamed to `--timeout` on both commands, parsed with
`parseDuration` instead of `parseNumber`. The internal option key stays
`timeoutMs`.

`--timeout-ms` is added to the existing `migrationFlags` table in
`src/args.js` (alongside the current `--timeout_ms` entry), erroring with:
`--timeout-ms was renamed; use --timeout`.

**Full rename blast radius** (all must be updated together, not just the
flag parsing):
- `commandSpecs` help text/options/examples for `wait` and `advisor`
  (`src/args.js:39`, `44`, `55`, `60`) — `usageError`'s "Valid flags"
  remediation is generated from these keys, so stale help text would
  contradict the new migration error.
- The `"--summarize cannot be combined with --timeout-ms"` error string
  (`src/args.js:392-393`) and its test (`src/args.test.js:195`) — becomes
  `--timeout`.
- `docs/cli-reference.md` (`wait`/`advisor` sections, currently showing
  `--timeout-ms`).
- `docs/sourcemap.md` (`--timeout-ms` mentions).
- `skills/using-taskferry/SKILL.md` (the canonical skill file — see the
  fleet-monitor spec's canonical/generated note; this rename touches
  `wait`/`advisor` example invocations there too) — edit the canonical
  file only, then `npm run skill:generate` and verify with
  `npm run skill:check`.

## Error handling

- `parseDuration` rejects negative values, non-numeric input, and
  malformed/multi-unit strings with a `UsageError`.
- Bare `0` remains valid (ms), unchanged from today.

## Testing

- `parseDuration`: unit tests for bare `0`, bare ms, each suffix
  (`s`/`m`/`h`), and rejection cases (negative, non-numeric, compound,
  uppercase suffix, decimal, whitespace) — `src/args.test.js`.
- Update existing `wait`/`advisor` args tests from `--timeout-ms` to
  `--timeout`.
- Add a test asserting `--timeout-ms` now errors with the migration
  message, for both `wait` and `advisor`.
