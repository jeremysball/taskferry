# Daemon

The `taskferry` CLI is a thin client. Task processes, state, and event
subscriptions all live in a separate daemon process, reached over a Unix
domain socket. This document covers the daemon's lifecycle, protocol, and
recovery behavior.

## Auto-start

No command ever requires starting the daemon by hand. The CLI's
`connectClient()` tries to open the socket first; if that fails, it takes an
exclusive file lock (`daemon-start.lock` in the runtime directory), checks
again in case another process just started one, and if not, spawns
`src/daemon.js` detached with `stdio: "ignore"` and waits (polling every
25ms, up to 5000ms) for a health check to succeed. The lock means concurrent
`taskferry` invocations racing to start the daemon converge on a single
instance rather than each spawning their own.

The spawned daemon inherits the parent's environment, so any
`TASKFERRY_*` variable set when a command first triggers the auto-start
takes effect for the daemon's entire lifetime — including for other
terminals and processes that connect to the same socket afterward. Changing
an env var (a new key slot, a different `TASKFERRY_MAX_CONCURRENT_TASKS`)
requires the daemon to restart: stop it (see below) and let the next command
start a fresh one.

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

- `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` (default `120000`): a running task that
  writes no parseable log event before this deadline is stopped (`SIGTERM`,
  escalating to `SIGKILL`) and marked `crashed` with `failureReason:
  "no_output_timeout"`.
- `TASKFERRY_WATCHDOG_POLL_MS` (default `2000`): how often the no-output and
  provider-usage-exhaustion checks run against a running task's log.
- A task stopped because its log matched a known provider-usage-exhaustion
  diagnostic (rate limit, quota, `429`, ...) instead gets `failureReason:
  "provider_usage_exhausted"` — distinct from a bare timeout so a caller
  knows to pick another key slot or model rather than just retrying.

## Cancellation

`taskferry cancel` sends `SIGTERM` to the task's process group (the
`opencode` child is spawned with `detached: true`, making it its own
process-group leader), escalating to `SIGKILL` after `--grace-ms` (default
5000) if it hasn't exited. Signaling the group, not just the `opencode`
pid, reaches subprocesses it's mid-way through running (a long bash
command), not just the top-level process.

## Recovery

Queued and running task state survives only for the daemon process's own
lifetime, because the handle a task's `exit` event fires on only exists in
the process that called `spawn()`. If the daemon restarts while a task is
still `queued` or `running`, the new process has no such handle for it and
relabels it `"unknown"` on reload rather than reporting a possibly-stale
status.

The underlying `opencode` process, if still alive, keeps running and
writing its log — inspect the log file directly
(`<state-dir>/logs/<task-id>.ndjson`), or run `opencode session list` — but
the daemon does not re-attach a status watcher to it. There is no periodic
recheck of `unknown` tasks' pids or trailing log events: that would
reintroduce string/heuristic completion detection for exactly the
crash-recovery edge case this architecture avoids elsewhere, so it's left
out rather than done half right.

No log rotation or cleanup: `logs/` grows unbounded. Fine for interactive
use; long-lived automation wants an external retention policy.
