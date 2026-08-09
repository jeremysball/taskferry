# Per-Provider Concurrency & Dispatch-Rate Limits — Design

Date: 2026-08-08. Status: approved in brainstorm, pending plan.

Addresses [taskferry#235](https://github.com/jeremysball/taskferry/issues/235).
Informed by the fleet-management work in
[taskferry#336](https://github.com/jeremysball/taskferry/issues/336).

## Background

taskferry's launch scheduler (`src/tasks.js`, roughly lines 2723-2796 and the
`createTaskManager` option-resolution block around 3236-3261) enforces two
limits, both workspace-global:

- `concurrencyLimit` (`maxConcurrentTasks` / `TASKFERRY_MAX_CONCURRENT_TASKS`,
  default 4): how many tasks run at once.
- `dispatchLimit`/`dispatchWindow` (`maxDispatchesPerWindow` /
  `TASKFERRY_MAX_DISPATCHES_PER_WINDOW`, default 2 per `dispatchWindowMs`,
  default 5000ms): how many launches happen inside a rolling time window.

One shared scheduler state (`launchQueue: string[]`, `launchTimes: number[]`,
`runningCount: number`) tracks both, and `drainLaunchQueue()` drains it
strictly FIFO. Neither limit reads `task.model` (a `"provider/model"` string,
e.g. `"minimax/MiniMax-M3"`), so the scheduler has no notion of which
provider a queued task targets.

Individual providers enforce their own concurrency and rate ceilings,
independent of taskferry's settings. `choosing-a-model`'s `working-report.md`
confirms several: minimax's Token Plan route caps around 3-4 in-flight
requests; Ollama Cloud caps at 3 agents in flight per account; Xiaomi Token
Plan publishes 100 RPM / 10M TPM per model; Alibaba Token Plan publishes 600
RPM / 1M TPM. Enforcing any of this today falls to a human or agent
remembering not to over-dispatch to a given provider. taskferry has no way to
know or enforce it itself. At the moment this spec was written, the daemon's
task list showed 16 concurrent `minimax/MiniMax-M3` tasks running against a
documented ~3-4 cap: a live instance of this exact gap.

**Scope for this spec:** concurrency and dispatch-rate (RPM-shaped) limits
only. Token-rate (TPM) enforcement is out of scope. taskferry has no
plumbing that tracks tokens consumed per dispatch (confirmed: no
`usage`/`tokensUsed`/`promptTokens` tracking anywhere in `tasks.js` or
`executor.js`), so enforcing TPM requires a new usage-accounting subsystem.
That work belongs in a future spec.

## Design

### 1. Provider key derivation

A task's provider key is the substring of `task.model` before the first `/`
(e.g. `"minimax/MiniMax-M3"` gives `"minimax"`,
`"ollama/deepseek-v4-flash:0731"` gives `"ollama"`). This matches how caps
are actually published (per-account, provider-wide) and how
`choosing-a-model`'s working report already documents them. No known case
needs per-model granularity within one provider, so this design omits it.

### 2. Scheduler restructure: per-provider queues, plus a retained global ceiling

Replace the single shared scheduler state with:

- `providerQueues: Map<string, ProviderQueue>`, where
  `ProviderQueue = {launchQueue: string[], launchTimes: number[],
  runningCount: number}`. A provider gets its bucket lazily, on first
  enqueue, including providers with no `providerLimits` entry: they still
  need a bucket to track `runningCount`/`launchTimes`, even though their
  effective per-provider limits are `Infinity`.
- The existing global `launchTimes: number[]` and `runningCount: number`
  stay as a real workspace-wide ceiling. A task must clear both its
  provider's own limits (if configured) and the global
  `maxConcurrentTasks`/`maxDispatchesPerWindow` ceiling to launch. The
  implementation may derive global `runningCount` and `launchTimes` by
  summing the per-provider buckets at read time instead of tracking them
  separately; either approach produces the same observable behavior, so
  this is an implementation choice, not a design constraint.
- `lastLaunchAt` and the lowerdir launch stagger stay global and
  unpartitioned by provider, matching the existing doc comment at
  `pruneStaleLaunchTimes`'s call site: `DEFAULT_LOWERDIR_STAGGER_MS` is
  deliberately not scoped per-directory, and provider identity has no more
  bearing on that stagger than directory identity does.

Enqueue (`queueDispatchLaunch`, called from `dispatchTask()` and the
advisor/summary dispatch path) routes a task into
`providerQueues.get(provider).launchQueue`, creating the bucket if absent.
Cancel's current `launchQueue.indexOf(taskId)` / `.splice()` becomes a
lookup into that task's own provider bucket, with the provider re-derived
from `task.model` the same way as at enqueue.

### 3. Drain algorithm: round-robin across provider queues

Each scheduler tick (`runLaunchQueuedTasks`):

1. Prune stale launch timestamps from the global `launchTimes` array and
   every provider bucket's own `launchTimes` array.
2. Round-robin over `providerQueues.entries()` from a rotating cursor
   (advanced by one provider per tick, wrapping), launching one task per
   provider per pass while all of the following hold:
   - Global `runningCount < globalConcurrencyLimit`
   - Global `launchTimes.length < globalDispatchLimit`
   - That provider's `runningCount < providerConcurrencyLimit` (`Infinity`
     when unconfigured)
   - That provider's `launchTimes.length < providerDispatchLimit`
     (`Infinity` when unconfigured)
   - The lowerdir stagger has elapsed since `lastLaunchAt`
3. Re-arm the next tick timer if any provider queue still has work, backing
   off for the longest of: the global rate-window delay, the soonest
   provider-specific rate-window delay among providers still queued, a
   fixed concurrency-poll delay, or the remaining stagger delay. Same
   backoff shape as today's `scheduleNextLaunch`, generalized to take the
   minimum wait across all still-blocked provider queues instead of one
   scheduler's numbers.

This makes queues provider-specific: a saturated provider's tasks get
skipped rather than blocking the whole launch loop, and later providers get
their own top-of-queue task considered on every tick regardless of an
earlier provider's backlog. Starting the round-robin cursor from a rotating
position, rather than always from the first provider in map-insertion
order, keeps one heavy provider's queue from starving a lighter one over
many ticks when the global ceiling is the binding constraint.

### 4. Config surface

New `providerLimits` field in `~/.config/taskferry/config.json`:

```json
{
  "providerLimits": {
    "minimax": { "maxConcurrentTasks": 4, "maxDispatchesPerWindow": 10 },
    "ollama": { "maxConcurrentTasks": 3 }
  }
}
```

Both keys are optional per provider entry: an omitted key means unlimited
for that axis, not zero. A provider absent from `providerLimits` has no
per-provider limit; only the global ceiling applies to it. There is no
per-provider `dispatchWindowMs`: every provider's rate window reuses the
single globally-configured `dispatchWindowMs`, extending the existing
rate-window mechanism rather than adding a second one.

New env var `TASKFERRY_PROVIDER_LIMITS`, matching the existing
comma-separated-list convention used by `allowedDirs`/`envDenylist`:

```
TASKFERRY_PROVIDER_LIMITS="minimax:4:10,ollama:3"
```

Grammar: `provider:maxConcurrentTasks[:maxDispatchesPerWindow]`, entries
comma-separated. The dispatch-window count is optional per entry (a bare
`ollama:3` sets only a concurrency cap). Setting the env var replaces the
config file's entire `providerLimits` map wholesale, the same
env-fully-overrides precedence `docs/config.md` uses everywhere else. A
malformed entry (non-numeric limit, empty provider name, more than two
colon-separated numbers) fails daemon startup with an `error:`/`help:`
message naming the offending entry, matching the config file's existing
no-silent-typo-tolerance posture.

### 5. Persistence, hot-reload, and lifecycle

The daemon reads `providerLimits` (both config-file and env forms) once at
startup, the same as `maxConcurrentTasks`/`maxDispatchesPerWindow` today: no
hot-reload. Changing it requires a daemon restart, matching
`docs/config.md`'s existing "No hot-reload" section for every other
daemon-side numeric field.

### 6. Non-goals

- TPM / token-rate tracking and enforcement (see Scope above; needs a new
  usage-accounting subsystem, left for a future spec).
- Per-model, as opposed to per-provider, limit granularity.
- Hot-reload of `providerLimits`.
- Any change to the lowerdir launch stagger's global (non-per-provider)
  scoping.
- Surfacing per-provider queue depth or limits in `taskferry status`/`doctor`
  output. This spec covers enforcement only; observability is a reasonable
  follow-up, not a requirement for the enforcement mechanism to work.

## Testing

Extends the existing scheduler test coverage in
`src/tasks.dispatch.test.js` (`dispatch queue` FIFO-at-`maxDispatchesPerWindow`,
`active-task concurrency cap`, `config file precedence for maxConcurrentTasks`)
with provider-scoped equivalents:

- A provider-capped queue with global headroom still launches tasks for
  other providers (round-robin skip-ahead behavior).
- A provider at its own concurrency/RPM cap blocks further launches for that
  provider specifically, without affecting other providers' launches.
- Global `maxConcurrentTasks`/`maxDispatchesPerWindow` still caps total
  launches across all providers combined, even when every individual
  provider has headroom under its own (or no) `providerLimits` entry.
- `providerLimits` config-file / env precedence (env wins, config used when
  env unset, no limit when both unset), matching the existing
  `maxConcurrentTasks` precedence test.
- A malformed `TASKFERRY_PROVIDER_LIMITS` entry fails daemon startup with a
  clear error.
- Cancelling a queued task removes it from its own provider's queue, not
  another provider's, and not a now-nonexistent single shared queue.

## Documentation updates required

- `docs/config.md`: a new `providerLimits` row in the fields table, a worked
  example, and a short subsection explaining the per-provider vs.
  global-ceiling interaction, matching the `.taskferry.toml` fields' level
  of detail.
- `docs/sourcemap.md`: update `tasks.js`'s row to describe the
  provider-keyed scheduler once implemented, per this repo's
  keep-the-sourcemap-up-to-date rule.
