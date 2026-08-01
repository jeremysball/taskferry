# taskferry

Read `docs/sourcemap.md` at the start of any session in this repo before
exploring the codebase further. It orients on the call chain, file-by-file
responsibilities, env vars, and the gotchas that look like bugs but aren't.

## Keep the sourcemap up to date

After any commit that changes `src/` — a new file, a new exported function,
a behavior change worth flagging as a gotcha, or just a line count drifting
noticeably — update `docs/sourcemap.md` in the same PR: the file-by-file
line counts, the affected row's responsibility text, and the "Where do I
look for X" table if the change adds a new thing worth pointing at. Don't
let it go stale until someone notices a description no longer matches the
code.

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

## Maintain a healthy `good first issue` list

Keep a standing set of open issues labeled `good first issue` — small,
self-contained, well-scoped work a new contributor could pick up without
deep context. When triaging or filing issues, actively tag qualifying ones
rather than leaving the label to accumulate by accident, and periodically
sweep open issues for ones that now qualify (scope narrowed, blocker
resolved) or no longer do (scope grew, now depends on unmerged work).
