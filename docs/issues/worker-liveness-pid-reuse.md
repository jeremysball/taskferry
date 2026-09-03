# Worker-child liveness is not pid-reuse safe outside Linux, and the check is duplicated

**Type:** bug
**Area:** `src/tasks.js:3183-3193`, `src/daemon.js:492-523`

## Problem

Pids are recycled. A recorded pid can later be answered by an unrelated process,
so `process.kill(pid, 0)` alone is not a liveness check. Two failure modes:

1. A dead task never settles, because liveness keeps reporting it as running. The
   watchdog does not fire either -- the process "exists."
2. A SIGTERM/SIGKILL aimed at it hits an unrelated process. Since `tasks.js`
   signals process *groups* via a negative pid, it hits an unrelated **group**.

The mitigation in the codebase is to compare pid *and* kernel start time
(`/proc/<pid>/stat` field 22 -- monotonic, never reused). That exists, but:

- It is implemented **twice**, independently, in `daemon.js` and `tasks.js`.
- Both return `null` on non-Linux, silently degrading to pid-only comparison with
  no signal to the user.

Default `pid_max` on many Linux systems is 32768. A fleet spawning ferries, bwrap
children, and their subprocesses churns through pids quickly, so wraparound over
a long unattended run is not theoretical.

## Note on scope

The daemon-exclusivity work removes the *daemon's* need for this check on Linux.
It does not touch `tasks.js`'s copy, which guards worker-child liveness. That one
survives regardless and is the reason this is a separate issue.

## Fix

1. Deduplicate the two parsers into one helper.
2. Surface the non-Linux degradation in `taskferry doctor` as a named reduced
   guarantee, rather than leaving it inferable only from source. Under the
   Linux-only policy no darwin implementation is owed -- but the weaker guarantee
   should be stated, not hidden.
3. Ensure every path that signals a recorded pid or process group verifies start
   time first where available, and refuses to signal when identity cannot be
   confirmed.

## Acceptance criteria

- One implementation of the start-time read, with tests.
- No code path signals a pid whose identity has not been verified when
  verification is available.
- `taskferry doctor` reports whether pid-reuse-safe liveness is active.
