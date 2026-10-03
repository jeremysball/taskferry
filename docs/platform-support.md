# Platform support and primitives audit

**Supported: Linux.** macOS is best-effort -- it may work, it is not guaranteed,
and no capability-parity work will be done for it. Windows is unsupported and
rejected at `src/setup.js:406`.

This document records every OS-specific primitive, what it degrades to
elsewhere, and whether that degradation is detected. Audited against
`jeremysball/taskferry` @ `6661b55`.

## Support matrix

| Guarantee | Linux | macOS | Windows |
|---|---|---|---|
| Sandboxed execution (bwrap + overlayfs) | yes | **no** | no |
| Pid-reuse-safe liveness | yes | **no** | no |
| Daemon exclusivity | yes | weaker (lock file) | no |
| Unix-domain-socket IPC | yes | yes | no |
| File-mode access control (0600/0700) | yes | yes | meaningless |
| Process-group signalling | yes | yes | no |

"macOS is supported" and "macOS has no sandbox and weaker liveness detection"
were both true before this decision. Only the second is worth telling users, so
the first is withdrawn.

## Findings

### 1. Sandbox -- Linux only, correctly gated

`src/sandbox.js:10` -- `platformSupportsSandbox()` returns true only for linux.
The CoW-overlay isolation model (ADR 0001) rests on `bwrap` plus overlayfs, and
taskferry fails fast rather than silently running unsandboxed.

macOS gets no sandbox at all, so the accept/reject changeset gate is the only
containment there. Since sandboxed execution is the product's central claim, this
alone justifies the Linux-only position. State it in `docs/security.md`, not only
as a README "known limit."

### 2. Pid-reuse-safe liveness -- the sharpest gap

`src/daemon.js:492-523` and `src/tasks.js:3183-3193` both read field 22 from
`/proc/<pid>/stat` and both return `null` on non-Linux, falling back to bare
`process.kill(pid, 0)`. Tracked separately in
`docs/issues/worker-liveness-pid-reuse.md`.

### 3. fd path resolution -- the model to copy

`src/output-dir.js:357-370` -- `/proc/self/fd/<n>` on Linux, `/dev/fd/<n>` on
Darwin, explicit throw with a readable message otherwise. Named capability, both
implementations, loud failure on the unknown case. Everything else in this
document should look like this.

### 4. Process groups and signals -- unaudited, and now out of scope

`detached: true` spawns plus negative-pid group signalling appear throughout
`tasks.js` (`sendSignalToProcess`, cancel paths, the SIGTERM→SIGKILL grace
window, `checkGatePid`). POSIX process groups do not exist on Windows. Invisible
today because Windows is rejected at setup, and it stays that way; noted only so
nobody mistakes the socket layer for the largest obstacle if Windows is ever
reconsidered.

### 5. File modes -- unguarded, and fine

`chmodSync(..., 0o600)` on the socket and `0o700` on the runtime directory are
load-bearing for the "restricted to the current user" claim, and are no-ops on
Windows. Another reason the Windows rejection is correct and should not be
relaxed casually.

### 6. Abstract-namespace sockets -- Linux only by construction

The daemon-exclusivity proposal uses a primitive that does not exist on macOS or
Windows. Under the Linux-only policy this needs no fallback: macOS keeps whatever
the lock-file path does, with Part 1's correctness fix applied, and carries no
guarantee.

Note the namespace scope -- abstract names are per network namespace, so a daemon
inside a `--unshare-net` sandbox would not see names bound outside it.

## Recommendations

1. **Centralize capability detection.** Replace scattered `process.platform`
   comparisons with a `src/platform.js` exposing named capabilities: `sandbox`,
   `pidStartTime`, `abstractSocket`, `fdPath`, `processGroups`. Call sites ask
   "do we have pid start times?" rather than "are we on Linux?", which makes each
   degradation explicit at its use site.
2. **Make silent degradations loud** in `taskferry doctor` as named reduced
   guarantees.
3. **State the policy in the README and `doctor` output**, in the same words:
   Linux supported, macOS best-effort with no guarantees, Windows unsupported.
