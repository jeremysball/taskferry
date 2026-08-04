# Lowerdir launch stagger (fixes #318)

## Problem

Dispatching several overlay-enabled tasks at once against the same worktree
(or against different worktrees that share one repo's git-common-dir)
produces a high crash rate. Every crash reports `failureReason:
no_output_timeout`, and the changeset extraction that follows fails with the
real cause:

```
bwrap: Can't make overlay mount on /newroot/<dir> with options
upperdir=...,workdir=...,lowerdir=/oldroot/<dir>,userxattr: Device or
resource busy
```

125 real occurrences of this exact error were found in this host's own
`tasks.json` (`changesetError` field) from earlier the same day this design
was written, covering two distinct shapes:

- same-worktree collisions: several concurrent tasks dispatched to the
  identical `taskferry/.claude/worktrees/eslint-sonarjs` directory.
- cross-worktree collisions: concurrent tasks dispatched to three *different*
  clawmarks worktrees (`fix-58-traceback-leak`, `fix-59-info-leak`,
  `fix-63-stored-xss`) that all share one repo's `git-common-dir` — each
  worktree dispatch also mounts a sub-overlay on that shared
  `git-common-dir`'s `objects`/`refs` (see `tasks.js`'s `addWritable()`), so
  the lowerdir collision isn't limited to the worktree's own root.

Each task already gets a unique `upperDir`/`workDir` per task id
(`overlayPaths()`/`subOverlayPaths()` in `changeset.js`), so the standard
kernel-documented EBUSY cause (colliding upper/work dirs) is ruled out —
confirmed by reading the actual overlayfs docs and Docker's own EBUSY issue
history, which describe sharing a lowerdir across concurrent overlay mounts
with distinct upper/work as supported.

Live reproduction was attempted on this same host, in real git worktrees
under `/workspace` (ext4, matching where the real crashes happened),
replicating taskferry's exact `bwrap` overlay args including the shared
`git-common-dir` sub-overlay: 9-way and 24-way concurrency, including an 8s
hold per task (simulating a live task holding its overlay open while
writing), all with zero launch stagger. None reproduced the failure. The
real trigger requires something a synthetic `sleep`-based payload doesn't
produce — most likely the real executor's actual filesystem load, or an
overlap between one task's mount and another's concurrent unmount/cleanup —
and that mechanism was not pinned down further.

**Given the root cause is confirmed present on this host but not reproducible
synthetically, and a fixed-interval stagger is the exact workaround already
proven (in the original issue report) to take the crash rate from ~100% to
zero**, the fix implements that stagger directly rather than continuing to
chase a synthetic repro.

## Fix

**Simplified from an earlier per-lowerdir-keyed design (see git history of
this file) after further discussion**: rather than tracking per-directory /
per-git-common-dir keys, enforce one **global** minimum spacing between
*every* dispatch/advisor launch, regardless of directory. Any two spawns —
same worktree, different worktrees of one repo, or entirely unrelated
directories — are at least `lowerdirStaggerMs` apart.

This is deliberately not scoped to overlay-enabled launches or to
directories that actually share a lowerdir: real-world collisions were
observed in both the same-worktree and the cross-worktree-shared-common-dir
shapes (see Problem above), and a global gate is trivially simpler to
implement, reason about, and test than tracking multiple keyed sets of
directories — at the cost of also spacing out launches that have no lowerdir
contention at all (unrelated directories, non-overlay dispatches). Given
default task runtimes are minutes, a few extra seconds of launch-time
spacing is cheap relative to that risk reduction and code simplicity.

**Mechanism:** extend the existing `launchQueuedTasks()` loop in `tasks.js`
(which already gates on `dispatchLimit`/`concurrencyLimit` before calling
`startTask()`) with one more condition: track a single `lastLaunchAt`
timestamp (module/closure-scoped, in-memory — a single daemon process owns
every spawn, confirmed via `docs/sourcemap.md`'s daemon architecture, so no
cross-process locking is needed). Before launching the next queued task, if
`now - lastLaunchAt < lowerdirStaggerMs`, stop draining the queue for this
tick (the existing `launchTimer` retries once the window elapses, the same
way today's `concurrencyDelay` retry already works). On an actual launch,
set `lastLaunchAt = now`.

Because the gate is a single global timestamp rather than a per-directory
map, launches drain strictly in FIFO order — the loop can simply stop
instead of skip-and-continue past a blocked head-of-queue task (no
key-matching, no need to preserve relative order across skipped entries).

**Config:** new `lowerdirStaggerMs` option, following the existing
`noOutputTimeoutMs`/`watchdogGraceMs` pattern exactly:

- `TASKFERRY_LOWERDIR_STAGGER_MS` env var (highest precedence)
- `config.json`'s `lowerdirStaggerMs` (added to `CONFIG_FIELD_TYPES` in
  `config.js` as `"number"`)
- default `3000` (3s)
- `0` disables the gate entirely (matches how other timeout knobs treat 0/off
  in this file — use `nonNegativeInteger()`, not `positiveInteger()`, since
  `0` is a meaningful value here, same as `summarizerTimeoutMs`'s existing
  precedent)

No pruning/cleanup concerns — the mechanism is one number, not a growing
per-directory map.

## Fix (error surfacing)

**Added 2026-08-04, in scope for this PR** (originally deferred below as a
"separate small follow-up" — pulled in per explicit request, since the
stagger reduces the EBUSY race but cannot guarantee it never recurs under
load, and today's residual failure is nearly undiagnosable: it settles as
generic `failureReason: no_output_timeout`, with the actual bwrap error text
only visible via `changesetError` in `--full` output).

**Mechanism:** `extractChangesetForTask()` in `tasks.js` already captures the
real bwrap stderr into `finishedTask.changesetError` when changeset
extraction throws (this runs *after* `failureReason` has already been set to
`no_output_timeout` or `boot_failure` by the earlier classification steps).
Add one check in that same catch block: if `changesetError` matches the
known overlay-mount-busy message shape (`Can't make overlay mount ... Device
or resource busy`), overwrite `failureReason` to a new dedicated bucket
`overlay_mount_busy` and set `failureDetail` to the capped bwrap message.
This reclassification always wins over whatever the child's exit-path
classifier guessed, since matching this exact text is a confirmed, specific
diagnosis, not a generic timeout. Not executor-prefixed (unlike opencode/pi
provider-failure buckets) — this is a taskferry-infra-level failure, not a
model/provider one.

## Non-goals

- Does not attempt to further pin down the actual kernel/bwrap mechanism
  behind the EBUSY. If the stagger doesn't fully eliminate the crash rate in
  practice, that's a signal the window needs to be tuned via
  `TASKFERRY_LOWERDIR_STAGGER_MS` (or the real mechanism revisited), not a
  reason to hold this fix.
- Does not change per-task concurrency once a task is actually running — an
  arbitrary number of tasks can run concurrently once past the staggered
  launch moment, same as today.
- Does not scope the gate to overlay-enabled launches or matching
  directories — see the simplicity/cost tradeoff explained in Fix above.

## Testing

Unit tests in `tasks.test.js` (existing fake-`spawnFn`/fake-clock patterns
already used for `launchQueuedTasks()`/watchdog tests):

- two queued tasks (any directories, overlay-enabled or not) launch at least
  `lowerdirStaggerMs` apart, never simultaneously
- three or more queued tasks each launch at least `lowerdirStaggerMs` after
  the previous one (not just pairwise)
- `TASKFERRY_LOWERDIR_STAGGER_MS=0` disables the gate (tasks launch as fast
  as the existing rate/concurrency limits already allow)
- `config.json`'s `lowerdirStaggerMs` is honored when the env var is unset,
  and the env var takes precedence when both are set (mirroring existing
  `noOutputTimeoutMs` precedence tests)
