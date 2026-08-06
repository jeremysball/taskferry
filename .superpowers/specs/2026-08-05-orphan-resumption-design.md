# Orphan Resumption on Daemon Restart — Design

Date: 2026-08-05. Status: approved in brainstorm, pending plan.

## Background

`analysis.md`'s fleet-wide catalog flagged 203 tasks stuck in `status:
"unknown"`, 9 of them still holding a `pending` changeset — work that exists
in an overlay on disk and nowhere else. Confirmed live against the current
`tasks.json`, not just the write-up:

```
total tasks: 11588
unknown status: 203
unknown with pending changeset: 9
```

**Why this happens, read from the actual code:**

Workers are spawned `detached: true` and `child.unref()`'d specifically so
they survive the daemon process dying (`tasks.js:1237,1266`, inside
`spawnTaskChild`). That survival is real but only half-used. On daemon
startup, `loadPersistedTask` (`tasks.js:2368`) does this unconditionally, with
no liveness check of any kind:

```js
if (t.status === "running" || t.status === "queued") t.status = "unknown";
```

Every task that was in flight when the old process died — killed manually,
crashed, or replaced by a restart — gets flattened to `unknown`. No check of
whether the recorded `pid` is still alive, no attempt to resume watching its
log, no attempt to pick up its result when the still-running detached child
finishes seconds or minutes later on its own. The child keeps working; the
daemon that will never learn what it produced has already given up on it.

**The self-restart path already half-solves this by refusing to run into
it**, and that refusal is itself a cost worth removing. `sourceSignature()`
(`daemon.js:33`) hashes `src/*.js` mtimes and, when it changes from the value
captured at startup, sets `restart.pending = true` via `makeMaybeRestart`
(`daemon-server.js:227-239`). But the actual close+respawn only fires once
`manager.list().counts` shows **zero running and zero queued, fleet-wide** —
across every repo the one shared daemon serves, not just the worktree that
changed. On a busy shared daemon (this account routinely runs many worktrees
against one daemon per `CLAUDE.md`'s own documented sharing model), that
window may be rare or may never arrive, which is exactly what turned into a
manual, messy daemon restart in the incident `analysis.md`'s Finding 3
describes — a human forcing the swap because the automatic path had nothing
safe to wait for.

**The fix in one sentence:** stop treating "was I the one who spawned this
child" as a precondition for finding out what it did. On startup, poll
whether each `running`/`queued` task's `pid` is still alive; if it is, wait
it out and settle it through the normal pipeline. That removes the need for
the idle gate at all — a restart no longer orphans anything, so it no longer
needs to wait for emptiness first.

## Design

### 1. Startup: liveness-poll instead of blanket flatten

`loadPersistedTask`'s unconditional `status = "unknown"` for
`running`/`queued` tasks is replaced with a liveness check per such task:

- `process.kill(pid, 0)` — throws `ESRCH` if no process with that pid exists,
  succeeds (no-op signal) if it does. Standard Node liveness-check idiom;
  taskferry already uses `sendSignal` (`tasks.js` — passed through
  `ctx.helpers.sendSignal`) for cancellation, so this is the same primitive
  applied to a probe signal instead of a kill signal.
- **PID reuse guard, required, not optional.** A liveness poll running
  arbitrarily long after the original dispatch (daemon down for minutes) can
  find the pid alive but recycled to an unrelated process by the OS. Guard by
  recording the process start time at dispatch (`/proc/<pid>/stat`'s 22nd
  field, or equivalent — same data `ps -o lstart=` reads) and comparing it at
  resumption; a mismatch means "dead, pid reused," not "alive."
- No `pid` recorded at all (a legacy record predating this field, or a task
  that crashed before `spawnTaskChild` reached the `task.pid = child.pid`
  assignment) → cannot be alive by definition, keep today's degrade-to-
  `unknown` path exactly as is.
- Confirmed dead (`ESRCH`, or pid alive but start-time mismatch) → same
  outcome as today, but reclassified. `unknown` was always a dead-end bucket
  with no distinguishing reason attached; give it a real one —
  `daemon_restarted_orphaned` — so `status`/`doctor` can say what actually
  happened instead of an operator having to reconstruct it from timestamps.
- Confirmed alive → **not** flattened to any terminal-looking status. Task
  keeps `status: "running"`/`"queued"` (whichever it was) and is registered
  for resumption per section 2.

### 2. Resumption: wait for exit, then run the normal settlement pipeline

For each task confirmed alive at startup:

- Poll `process.kill(pid, 0)` on an interval until it throws (the same
  approach section 1 uses for the initial check, just repeated) — this is
  the only viable detection method. `child.on('exit')` cannot be used: that
  event only fires for a process's own direct child via Node's `waitpid`
  wrapper, and a brand-new daemon process is not the parent of a pid that was
  running under the *old* daemon. On Linux, an orphaned child gets reparented
  to the nearest subreaper/init, not to whoever restarts — there is no OS
  mechanism to hand a "child exited" notification to an unrelated process
  short of polling.
- Once the poll observes exit, run the task through the **exact same
  post-exit pipeline a normal exit uses today**: `extractChangesetForTask` /
  `extractChangesetForTaskRecord`, then `finishChildSettlement`'s existing
  logic. This is why the resumption path is cheap to build: diff extraction
  already reads the overlay's upperdir via a real git operation
  (`changeset.js:194`) with zero dependency on any daemon-held in-memory
  buffer or live child handle. Whatever the worker actually wrote to the repo
  is sitting on disk in the overlay regardless of which daemon process
  eventually notices the pid exited.
- Stamp `orphanedByRestart: true` on the task record at the moment it's
  recognized as a resumption candidate (section 1's "confirmed alive"
  branch), distinct from a normal completion. See section 3 for why this
  matters even though the settlement logic itself needs no other change.

### 3. Why `evaluateOutputCompleteness` needs no code change, but its result needs a new tag

Read `evaluateOutputCompleteness()` (`tasks.js:3890-3909`) specifically to
check this, rather than assuming: it touches no in-memory buffer at all,
it re-parses `task.logPath` fresh off disk every call
(`extractFinalMessage(task.logPath)`). So the completeness check itself
requires zero changes for the resumption case — it only ever sees what's
physically in the file, which is exactly what makes it safe to reuse
unmodified.

What *does* need attention is what the file might be missing, and why —
traced through `spawnTaskChild`'s two output channels, which have very
different survival properties across a daemon death:

- **stderr survives.** `logFd` (`tasks.js:1226`,
  `fs.openSync(task.logPath, "a", ...)`) is a real OS file descriptor duped
  into the child's own fd table at spawn time (`stdio: [..., logFd]`). The
  child holds an independent reference to the log file from then on — kill
  the daemon and the child keeps writing stderr straight to disk with zero
  daemon involvement.
- **stdout does not survive.** `stdio[1]: "pipe"` is an anonymous OS pipe
  whose read end only the *daemon process* holds. The daemon's own
  `onChildData` handler (wired at `tasks.js:1256`) reads that pipe, runs each
  chunk through `executor.normalizeLogEvent` to turn raw CLI output into
  structured ndjson, then writes the result into `logFd`. That transform is
  in-process daemon logic, not a durable channel. Kill the daemon and the
  child's next stdout write hits a broken pipe; anything the child would have
  narrated after that point is gone, not recoverable by any daemon-side fix,
  because pipes aren't handed off between unrelated processes and the new
  daemon was never that child's parent to begin with.

So the failure mode is entirely about *when* the crash landed relative to the
final-marker line, not about the completeness check's logic:

| when the marker would have been written | result |
|---|---|
| before the daemon died | durably on disk already (stderr, plus whatever normalized stdout made it through pre-crash); resumption settles it exactly like a normal exit, no special case |
| after the daemon died, over the now-broken stdout pipe | never reaches disk, not delayed, not recoverable; `evaluateOutputCompleteness` correctly computes `incomplete: true` — this is the check doing its job with the data it has, not a bug |

The second row is the actual gap: `incomplete: true` today means one thing —
"the worker never said DONE." Resumption introduces a second, structurally
different cause that produces the identical boolean — "the worker probably
said DONE and the broken pipe ate it." One means "trust the diff, this
probably finished fine"; the other means "this may genuinely be broken." A
single undifferentiated boolean can't tell them apart, and this codebase has
already been burned by exactly that kind of conflation once (a correct,
fully-passing changeset silently read as `incomplete` in an unrelated
finding from the same audit). `orphanedByRestart: true`, stamped per section
2, is what lets downstream consumers (status output, doctor, an orchestrator
deciding whether to trust an `incomplete: true` changeset) distinguish the
two without guessing.

### 4. The idle-gated self-restart gate goes away

With resumption in place, `makeMaybeRestart`'s `counts.running > 0 ||
counts.queued > 0` early-return (`daemon-server.js:231`) is no longer
protecting against anything — the thing it exists to prevent (orphaning an
in-flight child by restarting out from under it) is now a handled, recoverable
case rather than a lost one. Remove the gate: a source-signature change sets
`restart.pending = true` and the restart proceeds immediately, running
in-flight tasks through the section 1/2 pipeline the moment the *new* process
boots, instead of the old process waiting for a fleet-wide idle window that a
busy shared daemon may never hit.

## Error handling summary

| situation | behavior |
|---|---|
| persisted `running`/`queued` task, pid alive, start-time matches | resumption: poll to exit, run normal settlement, stamp `orphanedByRestart: true` |
| persisted `running`/`queued` task, pid dead (`ESRCH`) | `status: "unknown"`, tagged `daemon_restarted_orphaned` instead of an unlabeled `unknown` |
| persisted `running`/`queued` task, pid alive but start-time mismatch (reused) | treated as dead — same as above, never misread as still-running |
| persisted `running`/`queued` task, no `pid` recorded (legacy/pre-spawn crash) | unchanged: `status: "unknown"`, no liveness check attempted, nothing to poll |
| marker line lost to the broken-stdout-pipe window | `incomplete: true` (unchanged, correct given the data) but `orphanedByRestart: true` distinguishes it from an ordinary incomplete run |
| self-restart with tasks in flight | proceeds immediately (idle gate removed); each in-flight task resumes independently in the new process per this design, not deferred |

## Testing

- Unit (mocked): the liveness-poll branch of `loadPersistedTask` for all four
  rows of the error-handling table above; the exit-poll loop's termination
  condition; `orphanedByRestart` stamping at the correct point; the
  `daemon_restarted_orphaned` label replacing bare `unknown`;
  `makeMaybeRestart` no longer gating on `counts.running`/`counts.queued`.
- Real exercise (per the "mocked tests aren't proof at a system boundary"
  rule — this design's entire premise rests on real OS process/pipe
  semantics a mock can't represent): dispatch a real long-running ferry
  against a scratch repo, kill the daemon process (not the ferry) mid-run,
  start a fresh daemon process pointed at the same state dir, and confirm (a)
  the task is *not* flattened to plain `unknown`, (b) it settles once the
  real detached child actually exits, (c) its changeset is extractable and
  correct, (d) `orphanedByRestart: true` is set. A second real run should
  kill the ferry itself (not just the daemon) before restart to exercise the
  dead-pid / `daemon_restarted_orphaned` path for real.
- PID-reuse guard: since it's impractical to force a real PID recycle
  on-demand, cover this with a targeted unit test that fakes
  `process.kill`/the `/proc/<pid>/stat` read rather than skipping real-world
  coverage — call this out explicitly as an accepted gap versus the rest of
  the real-exercise requirement above.

## Non-goals

- Recovering lost stdout narration itself (section 3 establishes this is
  physically impossible once the pipe breaks — not attempted).
- Any change to `evaluateOutputCompleteness`'s parsing logic — confirmed
  correct as-is, untouched by this design.
- A user-facing subcommand for manually triggering resumption — this runs
  automatically at startup, no new CLI surface.
- Cross-platform liveness detection beyond Linux's `/proc` — this account's
  daemon runs on Linux; a Windows/macOS equivalent (if ever needed) is a
  separate follow-up.
