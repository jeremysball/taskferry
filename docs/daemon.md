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
that connect to the same socket afterward. Changing an env var (a new
key slot, a different `TASKFERRY_MAX_CONCURRENT_TASKS`) requires the
daemon to restart: stop it (see below) and let the next command start a
fresh one.

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
3. `~/.local/state/taskferry` for state; the state directory's `run/`
   subdirectory for runtime, if `XDG_RUNTIME_DIR` is unset.

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
true, result }` or `{ version, id, ok: false, error: { code, message, help }
}`. A single connection can have many requests in flight at once, matched
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

## Watchdogs

- `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` (default `256000`): a running task that
  writes no parseable log event before this deadline is stopped (`SIGTERM`,
  escalating to `SIGKILL`) and marked `crashed` with `failureReason:
  "no_output_timeout"`.
- `TASKFERRY_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS` (default `400000`): once a
  task has produced at least one parseable log event, the deadline for
  further silence switches to this longer value for the rest of the task's
  life — a model that's gone quiet mid-turn (long reasoning, a slow test
  run) gets more room than a task that never started at all.
- `TASKFERRY_WATCHDOG_POLL_MS` (default `2000`): how often the no-output and
  provider-failure checks run against a running task's log.
- A task stopped because its log matched a known provider-failure
  diagnostic gets a `failureReason` instead of a bare timeout, so a caller
  knows which corrective action fits. For the `opencode` executor (the
  historical, shipped names — unprefixed, since callers already key off
  these exact strings) it's one of three buckets:
  - `"rate_limited"`: rate limit, usage limit, `429`, too many requests, or
    a bare mention of `quota` with no billing-specific phrase nearby.
    Transient: retry later, or switch key slot in the meantime.
  - `"payment_required"`: `insufficient_quota`, `payment required`,
    `billing`, or a `402` status. The account behind that key slot needs a
    billing fix, not a retry.
  - `"authentication_failed"`: `unauthorized`, an invalid API key, or a
    `401` status. The credential in that key slot is broken and needs
    rotating.
  Other executors (`pi`, future ones) get the same three buckets but
  prefixed with the executor name (`pi_rate_limited`,
  `pi_authentication_failed`, ...) so executor-specific failures stay
  distinguishable. A structured error event that matches none of the three
  buckets still gets a reason rather than `null`: the executor's own error
  class name, lowercased and prefixed (e.g. `opencode_unknownerror`,
  `pi_error`).
  Each crash also carries `failureDetail`: the matched log line or
  provider error text (capped at 500 characters), or for
  `no_output_timeout`, which timeout value fired and whether it was before
  or after the task's first output.

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
