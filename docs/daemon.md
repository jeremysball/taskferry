# Daemon

The `taskferry` CLI is a thin client. Task processes, state, and event
subscriptions all live in a separate daemon process, reached over a Unix
domain socket. This document covers the daemon's lifecycle, protocol, and
recovery behavior.

## Auto-start

No command ever requires starting the daemon by hand. Auto-start is split
between two processes, so a caller that's killed mid-boot never holds
`daemon-start.lock` itself:

- `connectClient()` (in `src/client.js`) tries to open the socket first. On
  failure, it fires a detached, unref'd booter subprocess via
  `startDaemonBooter()` — a re-exec of `src/client.js` itself with
  `detached: true` and `child.unref()`, so the booter outlives the caller
  and isn't tied to its lifetime. `connectClient()` then runs its own
  connect-retry loop against the socket (polling every `retryDelayMs`,
  up to `startupTimeoutMs`); it does not take the lock or wait on the
  booter. Set `TASKFERRY_AUTO_START=0` to skip both the booter and the
  retry loop and fail fast on a missing daemon instead.
- The detached booter (the re-exec'd `src/client.js`) runs
  `ensureDaemonStarted()`: it takes the exclusive file lock
  (`daemon-start.lock` in the runtime directory), re-checks the socket in
  case a racing process just started one, and if not, spawns `src/daemon.js`
  detached with `stdio: "ignore"` and polls every 25ms (up to 5000ms) for a
  health check to succeed. The lock means concurrent `taskferry`
  invocations racing to start the daemon converge on a single instance
  rather than each spawning their own. If the booter itself fails (e.g.
  `loadConfig` throws on a malformed `config.json`), it writes its error
  message to `<runtime-dir>/daemon-boot.err` and exits with a non-zero code.
  An import-time failure can instead write
  `<runtime-dir>/daemon-boot-stderr.log`. The caller checks both files and
  folds the available contents into the `daemon boot failed: ...` detail of
  the timeout error it surfaces.

Because the lock lives entirely in the detached booter rather than in
`connectClient()`, a caller that's killed mid-boot (a short-timeout
statusline poll, an `exec` that races against the booter's health-check
window) no longer orphans `daemon-start.lock` — the booter keeps running
and either starts the daemon successfully or releases the lock when it
gives up. `startDaemonBooter()` also `unlink`s any stale
`daemon-boot.err` from a previous failed boot before firing the new
booter, so a caller that times out sees diagnostics from the boot it
actually waited on, not from an earlier one.

The spawned daemon inherits the booter's environment, which in turn
inherits the original caller's environment. Any `TASKFERRY_*` variable
set when a command first triggers the auto-start takes effect for the
daemon's entire lifetime — including for other terminals and processes
that connect to the same socket afterward. Changing a daemon-level env
var (a different `TASKFERRY_MAX_CONCURRENT_TASKS`, `TASKFERRY_ENV_DENYLIST`,
`TASKFERRY_PROVIDER_LIMITS`, etc.) requires the daemon to restart: stop it
(see below) and let the next
command start a fresh one. A provider credential is different: `dispatch`/
`advisor`/`summary` (report mode) forward the *calling* shell's own
environment on every call, so exporting a fresh key before dispatching
takes effect immediately, with no restart — see
[security.md](security.md#caller-env-forwarding).

## Stopping the daemon

There is no `taskferry stop` command. Find the pid with `taskferry doctor
--full` and send it `SIGTERM` or `SIGINT`; either triggers a clean shutdown
that closes all client sockets, closes the server, and removes the socket
file. The next `taskferry` invocation auto-starts a replacement.

Stopping the daemon does not stop tasks it has already dispatched — see
[Recovery](#recovery).

## Socket path and permissions

Resolution order, same for state and runtime directories:

1. `TASKFERRY_SOCKET_PATH` (socket only), `TASKFERRY_STATE_DIR`,
   `TASKFERRY_RUNTIME_DIR` — explicit overrides.
2. `XDG_STATE_HOME`/`taskferry` for state; `XDG_RUNTIME_DIR`/`taskferry` for
   the runtime directory.
3. For the runtime directory only, if `XDG_RUNTIME_DIR` isn't exported but
   `/run/user/<uid>` genuinely exists (the login session set it up, this
   process just didn't inherit the export — a cron job, a stripped-env
   subshell, an orphaned daemon booter), resolve to
   `/run/user/<uid>/taskferry` anyway rather than treating the missing
   export as "no XDG runtime dir." Two callers on the same machine that
   disagreed only on whether they happened to export this var used to boot
   two independent, mutually invisible daemons at two different socket
   paths — this step exists to make that convergent instead.
4. `~/.local/state/taskferry` for state; the state directory's `run/`
   subdirectory for runtime, only if neither `XDG_RUNTIME_DIR` nor a real
   `/run/user/<uid>` is available.

The socket is `<runtime-dir>/daemon.sock`. The runtime directory is created
with mode `0700`; the socket file is `chmod`ed to `0600` right after
`listen()` succeeds. Both restrict access to the owning user — nothing here
is designed to be shared across users on a multi-user host.

## Startup races and stale sockets

`prepareSocket()` runs before the daemon binds: if a socket file already
exists at the target path, it sends that address a `system.health` probe
(250ms timeout by default). Three outcomes:

- **Another live taskferry daemon answers** → the new daemon refuses to
  start (`error: taskferry daemon is already listening on <path>`); reuse
  the existing one.
- **Something else answers, or answers unhealthily** → the new daemon
  refuses to start with a different message, since taking over an unknown
  listener's socket path could route two unrelated services onto the same
  file.
- **Nothing answers** (a stale socket file left by a daemon that crashed or
  was killed without cleanup) → the daemon removes it, but only after
  re-`stat`ing the path under a file lock and confirming the device, inode,
  and ctime it just health-checked are still the same file at that path. This closes the
  race where a second daemon starts between the health check and the
  unlink: whichever one wins the lock removes the stale file it actually
  checked, not whatever now happens to live at that path.

## Protocol

Line-delimited JSON over the Unix socket, one request or event per line,
newline-terminated. Every message carries `version: 1`
(`PROTOCOL_VERSION`, in `src/protocol.js`); a client that receives a
different version treats the connection as broken and fails closed rather
than guessing at a schema it doesn't recognize.

Requests: `{ version, id, method, params }`. Responses: `{ version, id, ok:
true, result }` or `{ version, id, ok: false, error: { code, message, help,
detail } }`. A single connection can have many requests in flight at once, matched
back to callers by `id` (a random UUID per request).

Events use a separate envelope, `{ version, type: "event", subscriptionId,
event }`, pushed to a socket asynchronously after `event.subscribe`
returns a `subscriptionId`. Requests and events interleave freely on the
same connection.

The daemon caps each connection's accumulated inbound buffer at 1 MiB and
refuses to buffer more (`REQUEST_TOO_LARGE`), and caps in-flight requests per daemon at 256
(`SERVER_BUSY`) — both are abuse/backpressure limits, not something normal
CLI usage approaches.

## Concurrency, queueing, and rate limiting

- `TASKFERRY_MAX_CONCURRENT_TASKS` (default `4`): maximum tasks the daemon
  allows to be `running` at once. Extra dispatches queue and start FIFO within
  each provider queue. The scheduler selects providers round-robin, subject
  to the global and provider-specific limits below.
- `TASKFERRY_MAX_DISPATCHES_PER_WINDOW` / `TASKFERRY_DISPATCH_WINDOW_MS`
  (defaults `2` per `5000`ms): an independent, optional burst-rate control
  on *launches*, not a concurrency cap.
- `TASKFERRY_PROVIDER_LIMITS`: per-provider ceilings on the same two axes,
  scoped to the substring of a task's `model` before its first `/`. A task
  must clear both its provider's own limit (if configured) and the global
  ceiling above to launch; a provider absent from this map is bound only by
  the global limit. Uses a compact grammar (`provider:maxConcurrentTasks
  [:maxDispatchesPerWindow]`, comma-separated) instead of JSON — see the
  `providerLimits` field in `docs/config.md`.
- `TASKFERRY_LOWERDIR_STAGGER_MS` (default `3000`): minimum delay between
  launches while the scheduler sets up lower directories. Set
  `lowerdirStaggerMs` in config or use `0` to disable it.

## Watchdogs

- `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` (default `256000`): a running task that
  produces no log growth at all before this deadline is stopped (`SIGTERM`,
  escalating to `SIGKILL`) and marked `crashed` with `failureReason:
  "no_output_timeout_dead_spawn"`. The activity clock this deadline is
  measured against resets on **any growth of the raw log file**, not just a
  complete parseable JSON line — an in-progress line, non-JSON stderr
  chatter, or a write straddling two watcher ticks all count as proof the
  process is still alive. A parseable line can't appear without the log
  growing first, so this is a strict superset of the older
  parseable-line-only reset; it exists because a worker that's clearly
  alive (actively appending bytes) was previously still getting killed as a
  false-positive dead spawn.
- `TASKFERRY_PRE_OUTPUT_MAX_MS` (default 4x `TASKFERRY_NO_OUTPUT_TIMEOUT_MS`,
  i.e. `1024000`): an absolute ceiling on the pre-output phase, independent
  of the any-growth reset above. It's measured from when the watcher armed,
  not from `lastActivityMs`, so continued raw log growth cannot push it
  back — without it, a worker producing only non-JSON noise and never a
  single parseable line could ride the any-growth reset forever, holding a
  concurrency slot indefinitely. Firing this ceiling also settles the task
  as `"no_output_timeout_dead_spawn"`, with a `failureDetail` that
  distinguishes it from the ordinary no-output timeout above. It stops
  applying the instant a parseable line lands; from then on the escalated
  post-output budget below is the only silence deadline in effect.
- `TASKFERRY_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS` (default `400000`): once a
  task has produced at least one parseable log event, the deadline for
  further silence (still measured by the same any-growth activity clock)
  switches to this longer value for the rest of the task's
  life — a model that's gone quiet mid-turn (long reasoning, a slow test
  run) gets more room than a task that never started at all. A task killed
  after this deadline settles with `failureReason:
  "no_output_timeout_stalled"` — distinct from
  `"no_output_timeout_dead_spawn"` above so a caller can tell "the worker
  never produced anything" (dead spawn / provider stall) from "it did real
  work, then went silent" (stalled mid-task) without parsing
  `failureDetail`.
- `TASKFERRY_WATCHDOG_POLL_MS` (default `2000`): how often the no-output and
  provider-failure checks run against a running task's log. Each tick reads
  at most `TAIL_READ_BYTES` (1 MiB) of new growth; a single burst larger
  than that is picked up over however many subsequent ticks it takes,
  rather than allocating one unbounded buffer for the whole burst. A
  persistent error while opening or reading the log, other than `ENOENT`
  for a log that does not exist yet, fails the task explicitly with
  `failureReason: "watchdog_log_read_error"` instead of silently freezing
  the activity clock. Metadata-stat errors are retried by the watcher.
- **Known limitation:** a running child's stderr is piped straight to the
  raw log file unfiltered — no JSON parsing, no event normalization — so
  any stderr chatter not causally tied to real task progress (a CLI-level
  spinner or retry-loop print, a Node runtime warning) still counts as "any
  log growth" for the reset above. This is an accepted tradeoff: the
  any-growth reset is deliberately the loosest signal available, and
  narrowing what counts as activity would reintroduce the false-positive
  kills it exists to prevent.
- A task stopped because its log matched a known provider-failure
  diagnostic gets a `failureReason` instead of a bare timeout, so a caller
  knows which corrective action fits. For the `opencode` executor (the
  historical, shipped names — unprefixed, since callers already key off
  these exact strings) it's one of three buckets:
  - `"rate_limited"`: rate limit, usage limit, `429`, too many requests, or
    a bare mention of `quota` with no billing-specific phrase nearby.
    Transient: retry later.
  - `"payment_required"`: `insufficient_quota`, `payment required`,
    `billing`, or a `402` status. The account behind that credential needs
    a billing fix, not a retry.
  - `"authentication_failed"`: `unauthorized`, an invalid API key, or a
    `401` status. The credential is broken and needs rotating — export a
    working one before the next dispatch.
  Other executors (`pi`, future ones) get the same three buckets but
  prefixed with the executor name (`pi_rate_limited`,
  `pi_authentication_failed`, ...) so executor-specific failures stay
  distinguishable. A structured error event that matches none of the three
  buckets still gets a reason rather than `null`: the executor's own error
  class name, lowercased and prefixed (e.g. `opencode_unknownerror`,
  `pi_error`).
  Each crash also carries `failureDetail`: the matched log line or
  provider error text (capped at 500 characters), or for the
  `no_output_timeout_*` buckets, which timeout value fired and whether it
  was before or after the task's first output.
- A `crashed` task whose log actually reached a genuine `step_finish`
  `"stop"` event with real text is reclassified to `"done"` at
  settlement — this covers a transient mid-run provider error (e.g. a
  context-overflow) that the model recovered from before the process still
  exited non-zero. `failureReason`/`failureDetail` are left in place as a
  record of what happened partway through, so `status: "done"` with a
  non-null `failureReason` means "finished despite a mid-run hiccup," not
  "nothing went wrong." A `no_output_timeout_dead_spawn` crash never reaches
  this path (by definition it went silent before any stop event), but a
  `no_output_timeout_stalled` one can: the transcript reached a genuine stop
  event and the process then hung past the post-output deadline instead of
  exiting (a stuck provider keep-alive, a cleanup step that never returns).
  That still recovers to `"done"` — the generation itself finished, the
  watchdog only ended a process that failed to exit afterward. A cancelled
  task is never reinterpreted as done this way either.
- A child that exits non-zero without ever emitting a parseable event (a
  crash during CLI startup, e.g. a malformed provider extension) settles
  with `"boot_failure"` (`"pi_boot_failure"` for `pi`) and a
  `failureDetail` taken from the last `Error:` line of its captured
  output, or the last non-JSON line when nothing is Error-prefixed. This
  classification runs once at settlement, never on a watcher tick, so raw
  stderr can't kill a running task early: only the curated provider
  patterns above do that. Signal-killed children (external `SIGKILL`,
  OOM) are excluded too; `"boot_failure"` means the child exited itself.

## Cancellation

`taskferry cancel` sends `SIGTERM` to the task's process group (the worker
child — `opencode` or `pi`, whichever executor the task dispatched with —
is spawned with `detached: true`, making it its own process-group leader),
escalating to `SIGKILL` after `--grace-ms` (default 5000) if it hasn't
exited. Signaling the group, not just the worker's own pid, reaches
subprocesses it's mid-way through running (a long bash command), not just
the top-level process.

## Self-restart on source change

The daemon records the newest mtime across the `.js` files in its own source
directory at startup. After each request that reaches the normal
dispatch/finally path, it recomputes that value;
if it has moved forward (a merge or `git pull` landed while the daemon was
running), a restart is marked pending.

By default the restart fires immediately on the next request, even with
`running` or `queued` tasks in flight. Running tasks are auto-resumed on the
next boot when a resumable worker session can be recovered (a valid
`sessionId` via `readSessionIdFromLog`); otherwise they are classified with a
clear `failureReason: "daemon_restarted_session_lost"` instead of a raw bwrap
spawn error (see [Recovery](#recovery)). The previous "defer until idle"
behavior — waiting for zero `running` and zero `queued` tasks — is now an
explicit opt-in via `restartWaitForIdle: true` in `config.json`
(`TASKFERRY_RESTART_WAIT_FOR_IDLE=1`, `docs/config.md`), which restores the
old wait-for-idle gate for callers that prefer it.

When the restart fires, the daemon closes its socket and server, spawns a
fresh `daemon.js` process with the same environment, and exits; the
replacement binds a new socket the same way any auto-started daemon does.

Existing `watch` subscribers are dropped when the old process exits, same as
any other daemon restart; a client reconnects and resubscribes on its next
call. With the default immediate restart there is no guarantee that no
`running`/`queued` tasks exist at the exact moment the restart fires — only
with `restartWaitForIdle: true` are they guaranteed absent. In either mode
a concurrent non-task request (e.g. another client's `list` or `status` call)
can still be executing at the exact moment the restart fires; the gate, when
enabled, only checks task counts, not a general in-flight-RPC counter.

## Recovery

Task state other than `queued`/`running` survives a daemon restart by being
reloaded from `tasks.json`. For `queued` and `running` the new daemon
reconciles each persisted task on boot:

- `queued` tasks never started — they degrade to `"unknown"` as before (never
  auto-launched; the original launch spec's caller env / bind dirs are not
  reconstituted). `unknown` is still the historical "the daemon that owned
  this task is gone" marker for this case.
- `running` tasks are checked for a resumable worker session: the daemon
  reads the log for a valid `sessionId` (`readSessionIdFromLog` — a bounded
  tail scan of the last 128 KiB, since real logs stamp `sessionID` on
  essentially every event line; a log whose only session event predates
  that window falls back to a full scan), checks that
  the task directory still exists and that the orphaned sandbox pid (if any)
  is reaped, and where resumable, cleans the stale overlay and re-queues the
  task with the recovered `sessionId` against a fresh overlay. The scheduler
  then respawns it normally — the worker continues the same session rather
  than starting over. The respawn reconstitutes the original launch spec
  from the task record (`resumeEnv`, `resumeAllowedDirs`, `resumeRoBind`,
  `resumeNoSandbox`, `resumeNoOverlay` are persisted at dispatch time), so a
  resumed worker sees the same caller env, sandbox/overlay toggles and
  per-dispatch binds as the original run.
- `running` tasks with no resumable session (no `sessionId` in the log, log
  unreadable, directory gone) are classified as `crashed` with
  `failureReason: "daemon_restarted_session_lost"` and a detail explaining
  why resume was not possible, instead of surfacing a raw
  `bwrap: Can't find source path .../upper/main` spawn error. `failureDetail`
  distinguishes "no sessionId" (log readable) from "log missing or
  unreadable" from "directory missing".

The underlying orphaned sandbox process (`bwrap` with `--die-with-parent`,
when sandboxed) is expected to have already exited when the daemon died; if
it is still alive it is best-effort `SIGTERM`'d before a resume is attempted
so a stale overlay mount does not collide with the fresh one. The signal is
only sent after a `/proc/<pid>/stat` start-time identity check against the
start time captured at spawn and persisted on the task record — a bare
liveness probe could otherwise signal an unrelated process that happened to
reuse the pid. (Legacy records without a start time pass the check open and
are signalled anyway.) After `SIGTERM` the daemon waits up to `cancelGrace`
(polling for exit), escalates to `SIGKILL` if the process still lives, and
polls again briefly before giving up — all synchronously, since boot-time
resume is not async; the stale overlay record is cleared only when removal
actually succeeds, so a busy mount is retried as an orphan on the next boot
rather than silently colliding with the fresh overlay. Log handling
otherwise matches the previous "unknown" path's observation: stdout was a pipe
the old daemon owned and normalized into the log, so after the daemon exits
new stdout events stop landing in `<state-dir>/logs/<task-id>.ndjson` until
the resumed worker (if any) is respawned; stderr was duplicated directly into
the log fd at spawn time and would have kept writing even without a resume.
There is still no periodic recheck of `unknown` tasks' pids — `unknown`
remains the terminal marker for queued tasks and internal summarizers that are
never auto-resumed.

No log rotation or cleanup: `logs/` grows unbounded. Fine for interactive
use; long-lived automation wants an external retention policy.

### Scratch output dir survives across every terminal status (taskferry#423)

Every dispatch reserves a per-task writable directory at
`<stateDir>/outputs/<id>/`, exposed to the worker as
`$TASKFERRY_OUTPUT_DIR`. When bwrap sandboxing is active, taskferry rw-binds
that directory at the same path. Unlike the
git-target overlay (which only exists when a dispatch ran with an overlay
and is consumed by `accept`/`reject`), the scratch dir is per-task state
the worker owns directly: it persists on every terminal status
(`done`, `crashed`, and `cancelled`, including a `done` task whose
`incomplete` flag is true), is never consumed by `accept`/`reject`, and is read
back via `taskferry output <id>` (or the
`task.output` RPC). The CLI is the right surface for retrieving anything
a worker wrote there — including a deliverable the worker produced but
whose final assistant message ended on a tool call rather than a clean
speak turn.

## Request-latency profiling

Opt-in, off by default: set `TASKFERRY_PROFILING_ENABLED=1`, or the
equivalent `profilingEnabled: true` in `config.json` (see
[config.md](config.md); the env var, if set, takes precedence over the
config value, same as every other field there), to have every RPC request
(including `event.subscribe`, `SERVER_BUSY` rejections, oversized/
unterminated buffers, and unparseable lines) timed from the moment the
daemon starts handling it to the moment its response is written, and
appended as one JSONL line to `<state-dir>/perf.log`:

```json
{"method":"task.dispatch","ok":true,"ts":"2026-08-01T12:00:00.000Z","durationMs":4.21}
```

With profiling disabled (the default), no timing happens, nothing is
written, and there's no `slow request` stderr output either — a daemon
nobody has opted into profiling pays none of this cost. Like every other
config field, this is read once at daemon startup — flipping it takes a
daemon restart to take effect (see
[config.md#no-hot-reload](config.md#no-hot-reload)).

`durationMs` is wall-clock time inside the daemon process only — it does not
include time spent in transit on the socket. `ok` reflects whether the
response write was accepted (not skipped because the socket was already
destroyed or the message exceeded `maxOutboundBytes`), not just whether an
exception was thrown — a request whose write was skipped for either of
those reasons records `ok: false` even though the daemon's own handling
succeeded. This is a best-effort signal, not a delivery receipt: a write
Node accepts can still fail to reach the client after the fact (e.g. the
peer resets the connection immediately after). A request whose `durationMs`
meets or exceeds `TASKFERRY_SLOW_REQUEST_MS` (default `500`) also gets an
immediate `slow request: <method> took <ms>ms (>= <threshold>ms threshold)`
line on the daemon's stderr — visible when running the daemon in the
foreground, but not when it's auto-spawned in the background the normal
way (`client.js` spawns it with `stdio: "ignore"`), so `perf.log` is the
reliable place to look for a spike either way.

`perf.log` rotates: once appending the next line would push it past
`TASKFERRY_PERF_LOG_MAX_BYTES` (default `5242880`, 5 MiB), the live file is
renamed to `perf.log.1` (clobbering any previous `perf.log.1`) and a fresh
`perf.log` starts from that line — one backup generation, checked on every
write rather than on a timer, so profiling can be left on indefinitely
without unbounded growth. A non-numeric `TASKFERRY_PERF_LOG_MAX_BYTES`/
`TASKFERRY_SLOW_REQUEST_MS` falls back to the default rather than rotating
on every write. This is independent of `logs/`'s lack of rotation above.

A failure to write `perf.log` itself (e.g. a full disk) is caught and
reported as a `warn:` line on stderr rather than crashing request handling —
profiling is diagnostic, not on the request's critical path.

## Things that look like bugs but aren't

Moved to [things-that-look-like-bugs.md](things-that-look-like-bugs.md).
New entries go there, not here.
