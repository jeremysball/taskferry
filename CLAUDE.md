# taskferry

## Record behavior that looks like a bug but isn't

When a change introduces behavior a future reader would reasonably file as a
bug — a deliberate non-obvious default, a race the design tolerates on
purpose, a "why doesn't this take effect immediately" — add it to the
"Things that look like bugs but aren't" section in `docs/daemon.md` in the
same PR. That section exists so the same thing doesn't get re-diagnosed from
scratch every time; it is the one piece of orientation documentation worth
maintaining by hand, because nothing about it can be derived by reading the
code.

Do not reintroduce a file-by-file index of the codebase (line counts,
per-file responsibility summaries). The previous `docs/sourcemap.md` went
stale on essentially every commit that touched `src/`, generated repeated
review findings about its own staleness, and answered questions that `rg`
and `wc -l` answer correctly on demand.

## Isolate your own taskferry runs when testing or developing taskferry itself

`taskferry`'s own daemon, task state (`tasks.json`), file lock, and socket
are resolved purely from env vars (`TASKFERRY_STATE_DIR`,
`TASKFERRY_RUNTIME_DIR`, `TASKFERRY_CACHE_DIR`, `TASKFERRY_SOCKET_PATH`,
falling back to `XDG_STATE_HOME`/`XDG_RUNTIME_DIR`/`XDG_CACHE_HOME`) — see
`src/paths.js`. None of that resolution looks at `cwd`, `--directory`, or
which git worktree you're in, so by default every worktree of this repo
(and every concurrent session working in one) shares one daemon process,
one `tasks.json`, and one lock file. This includes the "stale lock"
reclaim logic in `state-lock.js` — it is not worktree-scoped either, it
reclaims a lock in that one shared file regardless of which worktree wrote
it.

Whenever a session is testing or developing `taskferry` itself (dispatching
ferries to exercise its own dispatch/daemon/overlay code, not just using it
as a tool to work on something else), export a unique
`TASKFERRY_STATE_DIR`/`TASKFERRY_RUNTIME_DIR`/`TASKFERRY_CACHE_DIR` (e.g.
under `/tmp/taskferry-dev-<worktree-or-session-slug>`) before dispatching,
so your own dev/test daemon and task state are fully separate from the
daemon and in-flight ferries any other concurrent session (or your own
regular non-dev usage) is relying on. Never let a taskferry-testing session
dispatch against the shared default state dir — a crash, a stale-lock
reclaim, or a daemon restart triggered by your own test run can otherwise
kill or corrupt another session's live ferries with no indication of what
happened from that other session's point of view.

## Check GitHub issues after merging a PR

After merging a PR in this repo, check open GitHub issues (`gh-axi issue list
--state open`) for any the merge resolves, and close each with `gh-axi issue
close <number> --reason completed --comment "<why>"`. Don't assume a merge
closes nothing just because the PR body didn't say "Closes #N" — cross-check
the actual diff against open issue descriptions.

## Credit external contributors in the changelog

When merging an external contributor's PR, credit them by name/handle and
link their commit/PR in the changelog entry for that change (release-please
notes or a hand-written CHANGELOG, whichever this repo uses). Don't let a
squash-merge or a release-please rollup silently absorb their contribution
under a generic entry with no attribution.

## Always filter, then process

When code needs to act on a subset of a larger collection (tasks, rows,
files), narrow to that subset first, then run the expensive per-item work
only on what's left — never run the expensive work across the whole
collection and discard results afterward. The daemon already follows this
for task lookups: `filteredTaskDetails()` filters the cheap in-memory rows
by directory before calling `manager.status()` per task, specifically
because `status()` does per-task log I/O and calling it for every task ever
recorded (instead of just the ones in scope) turns a routine poll into
O(all-time task count) synchronous I/O on the daemon's single thread
(taskferry#287). Apply the same ordering anywhere a filter and an expensive
per-item operation combine, not just in that one function.

## Maintain a healthy `good first issue` list

Keep a standing set of open issues labeled `good first issue` — small,
self-contained, well-scoped work a new contributor could pick up without
deep context. When triaging or filing issues, actively tag qualifying ones
rather than leaving the label to accumulate by accident, and periodically
sweep open issues for ones that now qualify (scope narrowed, blocker
resolved) or no longer do (scope grew, now depends on unmerged work).
