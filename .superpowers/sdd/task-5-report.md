# Task 5 Report: Add Activity Summaries And Watch Streams

## Implementation

- Added `src/activity.js` with bounded NDJSON narration snapshots, UTF-8 and code-point safe limits, ANSI/control-character sanitization, local prompt fallback text, cache keys, in-flight request sharing, cache reuse, refresh interval and byte thresholds, and model-summary fallback handling.
- Integrated activity enrichment into task lifecycle events. State transitions remain immediate, and `task.activity` events follow with bounded activity and an output watermark.
- Added `TASKFERRY_ACTIVITY_SUMMARIES=0` fallback-only behavior and `TASKFERRY_ACTIVITY_MIN_INTERVAL_MS`, defaulting to `60000`.
- Added automatic activity summaries through the existing isolated internal summary-task path. Internal summary tasks remain excluded from the public event stream.
- Added `summary --style activity` routing and passed `watch --summaries` through daemon subscriptions.
- Preserved the existing TOON default and Claude monitor line format.

## TDD Evidence

RED was verified before implementation with:

```text
node --test src/activity.test.js src/cli.test.js src/daemon.test.js
```

The run reported 31 passing and 3 failing tests. The failures were the missing `src/activity.js`, the omitted `summaries` subscription parameter, and daemon protocol rejection of that parameter.

GREEN was verified after implementation with the same command. It reported 42 passing and 0 failing tests.

## Verification

- `node --test src/activity.test.js src/cli.test.js src/daemon.test.js`: 42 passed, 0 failed.
- `npm test`: 154 passed, 0 failed.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.

## Files Changed

- `.superpowers/sdd/task-5-report.md`
- `src/activity.js`
- `src/activity.test.js`
- `src/tasks.js`
- `src/commands.js`
- `src/daemon.js`
- `src/protocol.js`

## Self-Review

- Cache keys include task ID, status, output watermark, summary model, and max words.
- Running refreshes require 4096 additional log bytes and respect the minimum interval. Terminal transitions force an enrichment.
- Concurrent requests for the same cache key share one promise.
- Summary failures return sanitized local activity instead of failing the task stream.
- Summary jobs use the existing internal task flag and never publish lifecycle or activity events.
- Event observer failures cannot change task lifecycle behavior.
- Workspace normalization, TOON output, exit-code handling, MCP removal, state/runtime directory conventions, and `TASKFERRY_CHILD=1` ownership were left under their existing task boundaries.

## Concerns And Scope Boundaries

- `src/protocol.js` was changed as a deliberate exception. The existing protocol rejected `event.subscribe` parameters other than `directory`, so `watch --summaries` could not reach the daemon without this minimal validation change. No client protocol implementation was changed because the client already forwards subscription parameters.
- `src/output.js` already provided the required TOON default and Claude monitor formatting, so it needed no behavioral change.
- `src/cli.js`, `src/args.js`, `src/client.js`, and `src/events.js` were left untouched.
- Task 7 child environment handling remains deferred as required.
- Automatic summaries are secondary model-provider calls and remain bounded, cached, opt-in through a summaries subscription, and disableable through `TASKFERRY_ACTIVITY_SUMMARIES=0`.
