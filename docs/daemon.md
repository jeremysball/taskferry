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
  `loadConfig` throws on a malformed `config.json`), it writes
  its error message to `<runtime-dir>/daemon-boot.err` and exits with a
  non-zero code; the caller picks that file up on its next failed
  connect and folds the contents into the `daemon boot failed: ...`
  detail of the timeout error it surfaces.

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
  re-`stat`ing the path under a file lock and confirming the device/inode it
  just health-checked is still the same file at that path. This closes the
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

The daemon caps a single inbound message at 1 MiB and refuses to buffer
more (`REQUEST_TOO_LARGE`), and caps in-flight requests per daemon at 256
(`SERVER_BUSY`) — both are abuse/backpressure limits, not something normal
CLI usage approaches.

## Concurrency, queueing, and rate limiting

- `TASKFERRY_MAX_CONCURRENT_TASKS` (default `4`): maximum tasks the daemon
  allows to be `running` at once. Extra dispatches queue and start FIFO as
  running tasks finish, are cancelled, fail to spawn, or hit the no-output
  watchdog.
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
  persistent log-read error other than `ENOENT` (a rotated or
  not-yet-created log, retried next tick) fails the task explicitly with
  `failureReason: "watchdog_log_read_error"` instead of silently freezing
  the activity clock.
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
directory at startup. After serving each request, it recomputes that value;
if it has moved forward (a merge or `git pull` landed while the daemon was
running), a restart is marked pending.

The restart itself is deferred until idle: it only fires once
`manager.list().counts` shows zero `running` and zero `queued` tasks, checked
again on every subsequent request until that's true. This avoids reattaching
to an in-flight worker child process — deliberately out of scope, per
[Recovery](#recovery) below — by never tearing the daemon down while one
exists. When the idle check passes, the daemon closes its socket and server,
spawns a fresh `daemon.js` process with the same environment, and exits; the
replacement binds a new socket the same way any auto-started daemon does.

Existing `watch` subscribers are dropped when the old process exits, same as
any other daemon restart; a client reconnects and resubscribes on its next
call. There is no special handoff for in-progress requests beyond the
existing "wait for idle" gate, and that gate only checks task counts, not a
general in-flight-RPC counter — a concurrent non-task request (e.g. another
client's `list` or `status` call) can still be executing at the exact moment
the restart fires; only running/queued *tasks* are guaranteed absent.

## Recovery

Queued and running task state survives only for the daemon process's own
lifetime, because the handle a task's `exit` event fires on only exists in
the process that called `spawn()`. If the daemon restarts while a task is
still `queued` or `running`, the new process has no such handle for it and
relabels it `"unknown"` on reload rather than reporting a possibly-stale
status.

The underlying worker process, if still alive, keeps running, but its log
stops receiving new events the way it did before the restart: stdout is a
pipe the old daemon process owned and normalized into the log itself, so
once that process exits, nothing is left reading that pipe and stdout
events stop landing in `<state-dir>/logs/<task-id>.ndjson`. Only stderr —
duplicated directly into the log file descriptor at spawn time,
independent of the parent process — keeps writing after the restart.
Inspect the log file directly for whatever made it in before the restart,
or, for a task dispatched with the `opencode` executor specifically, run
`opencode session list` — but the daemon does not re-attach a status
watcher to it. There is no periodic
recheck of `unknown` tasks' pids or trailing log events: that would
reintroduce string/heuristic completion detection for exactly the
crash-recovery edge case this architecture avoids elsewhere, so it's left
out rather than done half right.

No log rotation or cleanup: `logs/` grows unbounded. Fine for interactive
use; long-lived automation wants an external retention policy.

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

- The Claude statusline showing no Taskferry segment on its first poll, or
  lagging a task transition by one poll — expected. `tf-sl` never runs the CLI
  in its foreground render path: it reads a per-workspace snapshot under
  `TASKFERRY_RUNTIME_DIR/statusline` (mirroring `resolveRuntimeDir()`'s own
  fallback chain rather than the cache dir; the snapshot is a few bytes,
  rewritten every couple of seconds, with no reason to survive a reboot) and
  uses an atomic lock to start at most one detached refresh. A cold poll
  therefore renders nothing while the first refresh runs; normal snapshots
  refresh after two seconds and stop rendering after ten seconds if refreshes
  fail. Refresh commands keep `TASKFERRY_AUTO_START=0`, so a statusline poll
  never boots the daemon.
- `tf-sl` printing bare, uncolored pipe-delimited text (`id|status|running|queued`
  plus a summary line and a freshness flag) when run by hand from a terminal —
  expected, not a broken render. `tf-sl` does no width or color rendering of
  its own; it is a data source for a caller's statusline script, which owns
  every presentation decision (mode/width tiers, coloring, id truncation).
- `status: "unknown"` after a daemon restart — expected; see
  `docs/daemon.md#recovery`. There is deliberately no re-attachment to
  already-running child processes.
- `checkStatus: "interrupted"` on a task after a daemon restart that killed
  the previous daemon mid-gate — expected (Task 7); the only way out is to
  re-run the gate (auto re-run if the overlay survived, or accept with
  `--force` after manual verification if the gate is the wrong gate to
  re-run). The pre-fix alternative was `checkStatus: "running"` forever,
  with no settle path and no error message, and `accept --force` blocked
  by Task 6's gate-supervisor because the gate was technically still
  "running".
- `taskferry wait` returning with `status: "running"` and a `note` about
  timing out — expected when the 15-minute default timeout (or an explicit
  `--timeout`) elapses before the task settles; re-run `taskferry wait`
  to keep polling or pass `--timeout` for a longer cap.
- A `SKILL.md` edit not showing up in `integrations/claude/skills/...` —
  run `npm run skill:generate`; the distributed copies are generated, not
  hand-edited. Commit them alongside the canonical file anyway — they aren't
  build output regenerated at install time, they're the literal content each
  plugin marketplace serves from this repo's git history.
- Editing `~/.claude/skills/using-taskferry/SKILL.md` directly does nothing for
  this repo — it's a separate manual copy for global availability outside
  the plugin (see `docs/integrations/claude-code.md`), not synced from or
  to the canonical `skills/using-taskferry/SKILL.md`. Edit the canonical file,
  run `npm run skill:generate`, then re-copy to `~/.claude/skills/` by hand.
- The daemon restarting itself with no `taskferry` command involved — expected
  when a source `.js` file's mtime moved forward since startup (a merge
  landed) and no tasks were running/queued; see
  `docs/daemon.md#self-restart-on-source-change`.
- Editing `TASKFERRY_ENV_FILE`'s target file and a spawned worker not seeing
  the new/changed var right away — expected within a short debounce window,
  not a restart. `envFileVars` is loaded once via `env-file.js`'s
  `loadEnvFile()` at `createTaskManager()` construction (daemon startup), then
  kept live by `env-file.js`'s `watchEnvFile()`, which watches the file's
  parent directory (filtered by basename, to survive a mktemp+rename secret
  rotation swapping the file's inode) and re-runs `loadEnvFile()` on a change,
  debounced ~100ms — no daemon restart required. A reload that fails to parse,
  or a torn read caught mid-rewrite, is reported via `onError` (a stderr
  warning, itself EPIPE-guarded) and the previous `envFileVars` is kept
  as-is. Editing the `envFile` config key itself (not the file it points at),
  or the running daemon's own launch environment, still requires a restart —
  those are read once at `createTaskManager()` construction, same as
  `envDenylist` and the other config-file-backed options. This is unlike a
  caller-forwarded key, which does take effect immediately on the very next
  `dispatch`/`advisor`/`summary` call with no restart (see
  `docs/security.md#caller-env-forwarding`) — the three mechanisms (env-file
  hot-reload, config-key restart, caller-forwarded immediacy) solve different
  problems and have different freshness guarantees on purpose.
- A pending changeset listing files the worker never touched — expected when
  the dispatch directory had untracked files at dispatch time. Git-target
  extraction stages the overlay's whole merged view (`git add -A && git diff
  --cached <pre-dispatch HEAD>`, `changeset.js`'s `extractGitDiff`) so
  pre-existing untracked files surface as new-file entries alongside the
  worker's own writes. `accept` runs a plain `git apply`, which fails
  outright when those paths already exist in the working tree — blocking the
  worker's real changes too — so commit or shelve untracked files before
  dispatching against a dirty tree. Non-git targets are unaffected: their
  extraction diffs the directory against the merged view, so untouched files
  never appear.
- A test that has two same-process calls contend on the same
  `withFileLockAsync()`/`withFileLock()` lock path (one holding it across an
  `await`, another trying to acquire it concurrently) hanging or timing out
  at exactly the lock's `timeoutMs` — expected, not a bug in the lock.
  `acquireLock()`'s retry loop blocks the JS thread synchronously via
  `Atomics.wait` with zero yield back to the event loop, so a contending
  same-process caller starves the very continuation that would release the
  lock. Real contention is always cross-process (a separate `taskferry`
  invocation, each with its own event loop), where this doesn't arise —
  see the note in `state-lock.test.js`.
- A pi dispatch's task record shows `variant: "max"` but the actual provider
  ran at, say, `high`. Expected: pi's own `clampThinkingLevel()` clamps a
  requested level to the model's real ceiling at runtime, including on
  extension providers (`ollama/*`, custom pi providers) taskferry cannot see
  the registry for. taskferry records what was requested, not what pi
  clamped it to, because it has no way to observe the clamp.
- A model dispatches with no `--variant` flag even though `defaultVariant`
  is `highest`, until up to 24h after that model first became available
  through opencode. Expected: the opencode variants cache
  (`<cacheDir>/opencode-variants.json`) refreshes once at daemon startup and
  once every 24h afterward, never synchronously on the dispatch path (a
  fresh `opencode models --verbose` shell-out costs ~3-4s, which would
  otherwise block the daemon's single thread on every affected dispatch).
  A model absent from the cache resolves to no variant flag, not an error.
- A CLI connecting to the daemon being torn down hard when the socket hands
  back a `Buffer` instead of a string — expected, not a crash bug. The client
  socket runs in utf8 mode (`setEncoding("utf8")` in `DaemonClient`'s
  constructor, `src/client.js`), so Node delivers strings to the data
  listener; a `Buffer` there means the encoding contract was broken, and
  decoding it per-chunk would silently corrupt multi-byte characters split
  across frames. `onData` therefore fails loudly
  (`protocolFailure` + `socket.destroy`) rather than guessing.
- `taskferry --version` answering instantly with no daemon running — expected.
  `version` is the one command that answers without the daemon, and that is
  an invariant, not a per-handler accident: every other command in the
  `HANDLERS` table calls `client.request(...)` and requires a live daemon
  connection. `version` never touches `client` — its resolved deps carry
  `client: undefined` (see `Deps.client` in `src/commands.js`), and
  `resolveRunCommandDeps` documents that single exception with a field-level
  `@type {Client}` cast on the `client` field instead of widening
  `ResolvedDeps.client` to optional for every handler.
- An error response envelope whose `message` is a single line (detail lines
  collapsed away) or empty — expected, not dropped data. The envelope keeps
  the historical wire shape: `message` is exactly the first `error:` line
  (or the first raw line, which stays `""` when the error text is empty),
  every other line lives in `detail`, and the help fallback is the
  daemon-oriented "Retry the request or inspect the daemon logs", not the
  CLI's "Retry the command or run `taskferry --help`". `responseError()` in
  `src/daemon.js` reuses the same `errorValue()` the CLI renders with, but
  overrides its CLI-oriented defaults (`foldDetailLines: false`,
  `messageFallback: ""`, its own help fallback); the CLI's richer multi-line
  message is presentation for a terminal, deliberately not shared with the
  protocol.
- A config entry, credential, or session file that passed the lstat symlink
  guard at bind-computation time still resolving through a symlink into the
  sandbox — expected, and tolerated on purpose. The guard's lstat check
  (`isSafeBindSource` in `src/executor.js`) and bwrap's own host-side path
  resolution at spawn time are two separate, non-atomic steps, so a path
  swapped in between them (a classic TOCTOU race) can still bind whatever
  the new symlink points at. This is a deliberate race, not a bug to fix:
  exploiting it requires write access to the config dir or the path's parent
  at dispatch time, which is the same attacker capability the guard already
  assumes (a plugin that can plant a symlink there can also rewrite the
  config files the symlink points at — so racing back buys nothing).
  "Fixing" it by pre-resolving every path with `fs.realpathSync` would also
  break legitimate symlinked config trees (dotfiles repos symlink
  `~/.config/opencode` and its entries into the checkout), so the guard
  stays a best-effort check against the static attack, not a lock against a
  race that requires the attacker to already hold the keys.
- A legitimate symlinked config entry (`opencode.jsonc` symlinked into a
  dotfiles repo) silently missing from the sandbox after an upgrade —
  expected, and now diagnosed: the guard deliberately refuses to bind
  symlinked entries (bwrap would bind the link's *target*, which is the
  whole vulnerability #392 closes), and warns on stderr naming the skipped
  path so the drop is visible rather than silent. The fix is to bind the
  real file (`cp` the config into `~/.config/opencode`), not to weaken the
  guard.
- A dispatch's private gitDir (`<git-common-dir>/worktrees/<name>` for a
  linked worktree) getting a one-time scratch copy instead of a live overlay
  or live bind, even though it's a directory and overlayfs mounts directories
  fine — expected, not a leftover file-vs-directory special case
  (taskferry#304). That directory sits directly inside the `worktrees/` tree
  that `git worktree add` touches/locks for *every* worktree as part of its
  own bookkeeping, not just the one being added — a live mount can therefore
  be perturbed by an unrelated sibling worktree operation and crash an
  in-flight dispatch with "directory is missing". The same snapshot rule is
  used by `--no-overlay`; that flag leaves the target working tree live, but
  does not re-expose the private gitDir. If gitDir cannot be distinguished
  from gitCommonDir (or cannot be resolved), the fallback snapshots the whole
  common dir for the same reason: it may contain the live `worktrees/` tree.
  Snapshotting costs nothing in correctness: like a sandboxed `git commit`,
  writes inside the copied git metadata are discarded at settlement regardless
  of bind mechanism, and only the extracted diff (not git-state mutations)
  ever reaches the real repo. `objects`/`refs`/`logs/refs` stay on the shared
  mechanism because they are common to the main checkout, can be large, and
  must track live upstream state (new commits) during a linked-worktree
  dispatch — the tradeoffs don't apply to private git metadata the same way.
