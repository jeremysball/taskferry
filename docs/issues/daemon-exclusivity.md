# Replace inferred daemon liveness with a kernel-held exclusivity primitive

**Type:** bug + refactor
**Area:** `src/daemon.js`, `src/state-lock.js`, `src/client.js`
**Related:** ADR 0001, the residual-TOCTOU note added in PR #6
**Platform:** Linux only. macOS is best-effort and gets no fallback work.

## Summary

Daemon startup infers whether another daemon is alive from elapsed time --
lock-file mtime against `staleMs`, and a health-check timeout. Inference forces a
reclaim path, the reclaim path is check-then-act, and check-then-act has a
window. Replace the inference with a kernel-held resource whose lifetime is bound
to the process, and the reclaim path disappears.

Two independent changes. Part 1 is a small correctness fix worth landing on its
own. **Do not bundle them.**

## Part 1 -- `socketHealth` must not treat "unknown" as "absent"

The timer does:

```js
const timer = setTimeout(() => finish({ listening: connected, healthy: false }), timeoutMs);
```

If the connect neither succeeded nor errored before the timeout, `connected` is
still `false`, so the result reads as "nothing is listening" and
`removeStaleSocketIfUnchanged` unlinks a possibly-live socket.

This is asymmetric with the error handler, which is already correct: it concludes
`listening: false` only for an enumerated set of errnos and rejects on anything
ambiguous. The timer needs to participate in the same distinction.

Since AF_UNIX connect completes in the kernel and is effectively instantaneous,
reaching the timer without a connect *or* an error means the **booting** process
was too starved to observe its own result -- exactly the scenario in the comment
above `bindDaemonSocket`.

**Fix:** a third state. `{ listening: "unknown" }` on timer expiry with
`connected === false`. Only a proven errno authorizes unlinking. `prepareSocket`
treats unknown as back-off-and-retry, and eventually errors out rather than
deleting anything.

**Test:** a socket file whose connect neither resolves nor errors within the
timeout must survive `prepareSocket`.

## Part 2 -- kernel-held exclusivity, and delete three lock files

### The primitive

Bind a Linux abstract-namespace Unix socket as the exclusivity token:
`\0taskferry-<uid>-<workspace-hash>`. Verified on Node 22 -- first bind succeeds,
second gets EADDRINUSE, name released when the first closes. The kernel releases
it on process death including SIGKILL, so there is no staleness and nothing to
reclaim.

(`flock` on a long-lived fd is the equivalent primitive and more portable, but
Node exposes neither `flock` nor `fcntl`, so it needs a native addon. Since Linux
is the only supported platform, the abstract socket wins on zero dependencies.)

### Boot order -- this is the whole trick

1. Bind the abstract name. EADDRINUSE → `exit(0)` quietly. **Before any side
   effect.**
2. Holding sole-daemon status, any existing socket *file* is definitively an
   orphan. `unlink` unconditionally -- no health check, no dev/ino/ctime
   comparison, no cleanup lock.
3. `listen(socketPath)`, then `chmod 0600`.
4. Signal ready.

### Spawning becomes idempotent, not atomic

`ensureDaemonStarted` currently holds `daemon-start.lock` around
check-ready → spawn → wait-ready, making the *decision to spawn* exclusive. With
exclusivity moved inside the daemon, clients spawn freely: ten clients spawn ten
daemons, nine exit in milliseconds, one wins. Clients keep their existing
connect-with-backoff loop for the window between steps 1 and 3.

### What this deletes

- `daemon-start.lock` and its `withFileLock` usage in `client.js`
- `socket-bind.lock` in `bindDaemonSocket`
- `socket-cleanup.lock` and `removeStaleSocketIfUnchanged` entirely
- the stale-reclamation path in `state-lock.js`, if no callers remain

`enforceDaemonSingleton` stops being load-bearing. Keep the pid record as
diagnostics -- the abstract socket proves *someone* holds the name, not *who*, and
`taskferry doctor` should still name the process.

### Implementation notes, each deserving a code comment

- **Never close the lock server.** The lock is the open fd; the `net.Server`
  object is only the handle keeping it open. Any `close()` on a cleanup or
  teardown path releases the name and admits a second daemon. It will look like
  dead code to a future reader or agent -- say so in the comment.
- **`unref()` it** so the lock does not keep the event loop alive during
  shutdown. The name stays held; it just stops voting on process lifetime.
- **Must not be inherited by children.** A ferry or `bwrap` child that inherited
  the fd and outlived the daemon would pin the name forever. Node sets
  close-on-exec by default, so this is correct today -- but it is the classic way
  lock-holding fds get pinned. Regression test: spawn a child, SIGKILL the
  daemon, assert a new daemon boots.
- **Keep the data socket on the filesystem at 0600.** Abstract sockets have no
  permission bits; anything in the network namespace can connect. The abstract
  socket carries no traffic -- nameplate, not door.
- **Namespace by uid and workspace hash** so concurrent projects and users never
  collide. A hostile local process can squat the name: denial of service on
  startup, not privilege escalation. Say so in the error message so the failure
  is diagnosable.
- **Network-namespace scope.** Abstract names are per netns. If the daemon is
  ever run inside a sandbox with `--unshare-net` it would not see names bound
  outside. Only ferries are sandboxed today; write the constraint down before
  someone sandboxes the daemon.

## Acceptance criteria

- A daemon SIGKILLed mid-run leaves nothing that blocks the next boot, with no
  timeout or staleness threshold anywhere in that path.
- Ten concurrent `ensureDaemonStarted` calls produce exactly one surviving
  daemon, with no client-side lock file.
- A live-but-starved daemon's socket is never unlinked, under any connect
  outcome.
- No lock file is consulted for daemon exclusivity.
- `taskferry doctor` still reports the owning pid.
