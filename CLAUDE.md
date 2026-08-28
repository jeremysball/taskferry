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

## Ferries that dispatch ferries (controllers) — sandbox and limits

`using-taskferry` is for the **dispatcher**, not the leaf. A controller that
orchestrates `3` parallel leaves via `taskferry dispatch --prompt - --directory
/tmp/<leaf> ... <<'INNER_EOF'` must run the dispatch commands via the `bash`
tool, then `for id in "${ids[@]}"; do taskferry wait "$id" --timeout 30m; done`
and `taskferry result --fields diff` with `applied:true`. Leaf prompts stay
short; only the controller carries `fd`/`rg`, `Conventional Commits`,
`mise`/`uv`, `fail-fast`, `path:line` quoting.

Sandbox: the ferry sandbox does `bwrap --tmpfs /tmp` **before**
`--overlay-src /tmp/<controller> ... /tmp/<controller>`, so host
`/tmp/<other-leaf>` is hidden behind an empty `tmpfs` and only the
controller's own `--directory` is re-mounted. `git worktree add /tmp/<new> HEAD`
inside a sandboxed ferry therefore fails with `Read-only file system` on
`/workspace/taskferry/.git/worktrees` (`/workspace` is `ro-bind`), and
`git worktree add ./wt-* HEAD` inside the controller's overlay is invisible
to the host daemon (`directory does not exist: /tmp/<controller>/wt-*`). For
controllers, either `pre-create host worktrees` (`git worktree add
/tmp/leaf-* HEAD` on the host before dispatch) and dispatch to them directly,
or run the controller itself with `--no-sandbox` so host `/tmp` is fully
visible. `--rw-bind /tmp` is the sandboxed alternative.

Provider limits: a controller and its leaves share the same provider limit
(`providerLimits` in `~/.config/taskferry/config.json`, e.g.
`your-provider: {maxConcurrentTasks: 2}`). `1` controller `running` + `1`
leaf `running` exhausts `2`, leaving `2` leaves `queued` forever while the
controller's `taskferry wait` holds its slot — a deadlock. For `1` controller
+ `3` leaves, raise that provider to `{maxConcurrentTasks: 4}` (or split
providers) for the group.

Daemon `ENOSPC`: overlays live on `tmpfs` `/run/user/<uid>` (often `1-2G`).
With many stale `taskferry-cow-oc_*` overlays the mount fills (`100%`, `ENOSPC:
no space left on device, write`, `connect ENOENT
/run/user/<uid>/taskferry/daemon.sock`), so prune old
`/run/user/<uid>/taskferry/overlay/taskferry-cow-oc_*` and keep only the live
few (`ls -1t | tail -n +10 | xargs rm -rf`).

## Harness env vars and `postOutputNoOutputTimeoutMs` that look like bugs but aren't

The daemon injects `TASKFERRY_STATE_DIR`/`TASKFERRY_RUNTIME_DIR`/
`TASKFERRY_CACHE_DIR`/`TASKFERRY_SOCKET_PATH`/`TASKFERRY_OUTPUT_DIR` (plus
`XDG_*` redirected to `~/.cache/taskferry/...` and `UV_CACHE_DIR`/`UV_TOOL_DIR`)
into every sandbox — see `src/paths.js:resolveStateDir`. `npm run check` in
this repo only strips `TASKFERRY_CHILD` (`package.json: env -u
TASKFERRY_CHILD node --test`), so `src/tasks.sandbox.test.js:473` and the
`bwrap` sandbox tests can fail inside a ferry even with no code change (e.g.
`9` pre-existing failures, `1397/1406` pass). Re-running with `env -u
TASKFERRY_* -u XDG_* -u UV_*` gives a clean pass. Don't trim this from a
generic skill — it is taskferry-repo-specific; note it in `docs/daemon.md`
instead if needed.

`postOutputNoOutputTimeoutMs: 900000` (`15m`, `~/.config/taskferry/config.json`)
is the daemon's `no_output_timeout_stalled` — a task with no `tool_use` for
`900s` is marked `crashed` (`failureReason: no_output_timeout_stalled`).
That is the intended keepalive, not a dispatch bug.

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

## Commit skill changes as `fix`/`feat`, not `docs`

Skills in this repo are executable documentation — `skill-guidance.test.js`
runs their recipes — so a change that alters how a skill behaves is a
behavior change, not a prose edit. Commit it with a `fix(skills)` or
`feat(skills)` prefix, never `docs(skills)`. Reserve `docs(skills)` for pure
prose that changes no behavior.

The reason is release-please: its default changelog excludes `docs`/`chore`/
`ci`/`refactor` commits, so a `docs(skills)` change silently vanishes from
the release notes even when it changes how the shipped skill is consumed
(e.g. splitting `using-taskferry` into SKILL.md plus resources, or flagging
that bare `--timeout` values are milliseconds). A `fix(skills)`/`feat(skills)`
commit surfaces in the changelog automatically and needs no hand-add at
release time.

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
