# Activity summary: rename `--style`, fail fast on summarizer failure

Date: 2026-07-21

## Context

`taskferry summary` currently exposes two request shapes under one flag,
`--style report|activity`:

- `report` spawns a separate async task on the configured summarizer model
  and does a fresh full-transcript read every call; the caller polls
  `taskferry result` for it.
- `activity` runs synchronously against a cache, continuing the same
  opencode session and feeding only the narration delta since the last
  summary — the cheap, incremental shape that powers `watch --summaries`
  and (once finished) `status`'s `summarizedActivity` field.

Both styles read the same underlying model config (`TASKFERRY_SUMMARY_MODEL`
via `activitySummaryModel`); there is only one summarizer model, not two.
`--style` bundles execution mode (async spawn+poll vs. sync cached call),
freshness strategy (fresh full read vs. incremental delta), and a default
length together — not pure output formatting, which the flag name implies.

Separately, both the explicit `activity`-style request path and the live
`watch --summaries` event path currently swallow summarizer failures
(including "model unavailable," which `report`-style already fails fast on
via `summaryModelAvailable()`) and silently substitute local raw narration
(`buildLocalActivity()`) for what should be a real summary, flagging the
failure only via an easy-to-miss `summaryFailed: true` field. For
`watch --summaries` specifically, a `--summaries` subscriber has no way to
tell a real summary from raw narration standing in for a failed one.

## Goals

1. Rename `--style` to `--mode` (values unchanged: `report`, `activity`) so
   the flag name reflects what it actually controls, with a retired-flag
   rename hint for bare `--style`.
2. `taskferry summary --mode activity` fails fast on summarizer failure
   (model unavailable, spawn error, empty output) — throws to the CLI
   caller, matching `--mode report`'s existing behavior. Drop the
   fallback-text-plus-`summaryFailed`-flag masking for this path.
3. `watch --summaries` fails fast at two points:
   - **Upfront**: `event.subscribe` with `summaries: true` validates the
     configured model is available before the subscription is accepted;
     rejects the subscribe request immediately if not.
   - **Per-tick**: `scheduleActivity()` never substitutes local narration
     for a failed summarize call. Every failed tick emits a `task.activity`
     event with an explicit failure marker instead — every time, no
     smoothing or tolerance for transient failures. The failure must
     surface as event fields, not an uncaught exception — task lifecycle
     and watchdog polling stay independent of summarizer health.

## Non-goals

- `watch` **without** `--summaries` is unchanged: raw local narration via
  `buildLocalActivity()` remains the correct, intentional default for that
  path.
- `status()`'s `summarizedActivity` field is unchanged: already correct in
  the in-flight WIP (stays absent until a real summary lands, never carries
  fallback text).
- **Per-subscription summary scoping is out of scope.** `--summaries`
  enablement is currently one global toggle
  (`activitySummarySubscriptions > 0`) shared by every watch subscriber on
  the daemon — one client requesting `--summaries` turns on real
  summarization for every running task's activity events, including ones a
  different, non-`--summaries` client is watching. Fixing that requires
  scoping the activity cache's summarization per subscription/task rather
  than process-global, which is a larger change. Tracked as a follow-up
  GitHub issue instead.

## Design

### 1. Flag rename: `--style` → `--mode`

- `args.js`: rename the `summary` command's `--style` flag spec to
  `--mode`; add a retired-flag rename hint entry for `--style` (same
  pattern as the existing `--max_words` → `--max-words` hint) pointing at
  `--mode`.
- `commands.js`, any internal `options.style`/`style: "..."` references:
  rename to `options.mode`/`mode: "..."`.
- `tasks.js`: `summarizeRequest(taskId, options)` reads `options.mode`
  instead of `options.style`.
- Docs: `docs/cli-reference.md` (`taskferry summary` section),
  `docs/security.md` (references `--style activity`), canonical
  `skills/using-taskferry/SKILL.md` and its generated copies under
  `integrations/claude/` and `integrations/codex/` (regenerate via
  `npm run skill:generate` after editing the canonical file, verify with
  `npm run skill:check`).
- `docs/migrating-from-mcp.md`: check whether it references `--style`; add
  a rename-hint line if the retired-name table there covers CLI flags.

### 2. `activitySummary()` fails fast (explicit `--mode activity` calls)

- `activityCache.refresh()` (`activity.js`): when `resolvedIncludeSummary`
  is true and the `summarize()` call throws or returns unusable/empty text,
  stop catching the error into `summaryFailed = true` plus fallback text.
  Let it propagate. This changes `refresh()`'s contract for callers that
  request `includeSummary: true` — see the per-tick note below for how
  `scheduleActivity()` (which also calls `refresh()`) must not let this
  propagate into an uncaught rejection.
- `tasks.js` `activitySummary()`: no longer wraps a masked result; a
  `refresh()` rejection propagates to the `taskferry summary --mode
  activity` caller as a real error.
- `tasks.js` `summarizeActivity()`: its own `catch` blocks (used for the
  session-continuation retry logic) currently convert `summarizeTask()`
  throws — including `summaryModelAvailable()`'s "model unavailable"
  error — into `{ text: "", sessionId: null }`. The retry-on-stale-session
  logic itself is legitimate and should stay, but a genuine
  `summaryModelAvailable()`/`verifySummaryAgent()` failure must not be
  absorbed by it — re-throw those specifically rather than swallowing them
  into an empty result.

### 3. `watch --summaries` fails fast

**Upfront (daemon.js, `event.subscribe` handling):** before adding a
subscription with `summaries: true` to the `subscriptions` map, call the
task manager's model-availability check (expose
`summaryModelAvailable`/`verifySummaryAgent` — currently private to
`tasks.js` — as a manager method, e.g. `manager.checkSummaryModelReady()`).
If it throws, respond to the `event.subscribe` request with a real RPC
error instead of registering the subscription.

**Per-tick (`scheduleActivity()` in `tasks.js`):** the `refresh()` promise
chain (`void activityCache.refresh(task, { force }).then(...)`) needs a
`.catch()` so a propagated summarizer failure (per goal 2's change) doesn't
become an unhandled rejection. On catch, emit a `task.activity` event with
an explicit failure marker (e.g. omit `activity` and set
`summaryFailed: true`, or a dedicated `activityError` field — pick one
consistent shape) instead of the current best-effort local-narration
substitution, whenever the cache's summaries are enabled
(`resolvedIncludeSummary` true for that call). No retry/backoff smoothing:
every failed tick reports failure.

### 4. Follow-up issue (not implemented now)

File a GitHub issue: "watch --summaries enablement is a single global
toggle, not scoped per subscription/task" — description covers the
`activitySummarySubscriptions` mechanism and the cross-client leak it
causes (one client's `--summaries` request silently summarizes activity
for every other client's watched tasks too).

## Testing

- `activity.test.js`: new/updated cases for `refresh()` propagating a
  `summarize()` failure instead of returning fallback text +
  `summaryFailed: true`, when `includeSummary` is true. Existing test
  "stays null on local fallback narration (summaries disabled)" is
  unaffected — that covers `summariesEnabled: false`, a different path
  (goal/non-goal 1 above), not a failure case.
- `tasks.test.js`: `activitySummary()`/`taskferry summary --mode activity`
  throws on summarizer failure; `summarizeActivity()`'s retry logic still
  handles stale-session retry correctly but re-throws a genuine
  model-unavailable error rather than swallowing it;
  `scheduleActivity()`/live `task.activity` event emits an explicit
  failure marker (not raw narration) on a summarize failure when summaries
  are enabled, and is unaffected when they're not.
- `daemon.test.js` (or wherever `event.subscribe` is tested): subscribing
  with `summaries: true` against an unavailable model is rejected upfront
  with a real error.
- `args.test.js`: `--style` is rejected with a rename hint pointing at
  `--mode`; `--mode report|activity` behaves as `--style` did.
- Full suite (`npm run test:unit`) green; `npm run lint` and
  `npm run typecheck` clean; `npm run skill:check` clean after
  regenerating skill copies.
