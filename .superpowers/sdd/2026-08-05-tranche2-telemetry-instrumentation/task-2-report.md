# Task 2: `finalStatus` — parsed closing Status: marker

## Summary

Implemented `finalStatus`, a new persisted telemetry field that captures the
worker's closing `Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`
line, independent of the existing `--require-final-marker` regex-gate
mechanism.

## Changes

### `src/tasks.js` (+16 lines)

1. **`buildDispatchTask`**: Added `finalStatus: null` to the task object,
   right after `finalMarker`.

2. **`evaluateOutputCompleteness`**: Added a module-level `STATUS_MARKER_RE`
   constant (`/^Status:\s*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)\s*$/m`)
   and parsing logic after the existing `finalMarker` regex-gate block. When
   the final message matches, `task.finalStatus` is set to the captured group.

3. **`summarizeOptionalFields`**: Added `finalStatus` to destructuring and
   the returned spread (surfaced when non-null).

4. **`computeResultDetail`**: Added `finalStatus` to the result detail spread
   so `result --fields finalStatus` works.

5. **JSDoc types**: Added `@property {string|null} [finalStatus]` to the
   `Task`, `TaskSummary`, and `TaskResult` typedefs.

### `src/protocol.js` (+1 line)

Added `"finalStatus"` to the `RESULT_FIELDS` allow-list after `"finalMarker"`.

### `src/tasks.watchdog.test.js` (+14 lines, 7 new tests)

Added `describe("finalStatus: parsed closing Status: marker at settlement")`
with 7 tests:

| Test | Verifies |
|---|---|
| `Status: DONE` persists finalStatus | Basic DONE parsing |
| `DONE_WITH_CONCERNS` captured whole | Not truncated to DONE |
| `BLOCKED` and `NEEDS_CONTEXT` recognized | All 4 values parse |
| No Status: line leaves finalStatus unset | Absent marker omitted from summary |
| Independent of --require-final-marker | Parses even without a gate |
| Survives daemon restart via tasks.json | Persistence round-trip |
| `summarize()` includes finalStatus when non-null | Optional: surfacing in summary output |

### `docs/sourcemap.md` (+3 lines)

Updated line counts for all 3 touched files, added `finalStatus` mention to
`tasks.js` and `tasks.watchdog.test.js` responsibility text, added a
"Where do I look for X?" entry for the closing `Status:` marker parsing.

## Verification

- **Lint**: `npm run lint` — clean
- **TypeScript**: `npm run typecheck` — clean
- **Tests**: `npm test` — see the controller's own real-host run recorded in
  the ledger (`progress.md`) for this fix round; the sandboxed dispatch's
  self-reported run showed 3 pre-existing sandbox-environment-only failures
  in `tasks.sandbox.test.js`/`tasks.env.test.js` (around `TASKFERRY_TASK_ID`,
  `ro-binds auth.json`, `XDG_DATA_HOME`) that do not reproduce on the real,
  non-sandboxed host.

## Commits

Implementation: `3c1e35b`. This fix round (docs/sourcemap.md update +
optional `summarize()` test) is committed separately by the controller after
independent verification — see `progress.md` for the actual resulting hash
rather than any hash self-reported by a sandboxed dispatch, which runs
against its own local git history and cannot predict the controller's real
commit hash.

## Concerns

None. The regex alternation order (`DONE_WITH_CONCERNS` before `DONE`)
ensures the longer match wins, confirmed by the dedicated test.
