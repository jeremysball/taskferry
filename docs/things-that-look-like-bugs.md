# Things that look like bugs but aren't

Behavior in taskferry that a reader would reasonably file as a bug, and that
is working as designed. Every entry says what you will observe, why it is
deliberate, and where the real bug line sits.

Nothing here is derivable from the code: source shows what happens, never
that someone already considered the obvious alternative and rejected it.
Without this file the same surprising behavior gets re-diagnosed from
scratch by every reader who trips on it, and eventually one of them "fixes"
it. Add an entry in the same PR as the change that introduces the behavior,
and delete the entry when a later change restores the obvious behavior.

A real bug belongs in the issue tracker; a shipped feature belongs in the
release notes. Only working-as-designed behavior that reads as broken
belongs here.

- The Claude statusline showing no Taskferry segment on its first poll, or
  lagging a task transition by one poll — expected. `tf-sl` never runs the CLI
  in its foreground render path: it reads a per-workspace snapshot under
  `TASKFERRY_RUNTIME_DIR/statusline` (mirroring `resolveRuntimeDir()`'s own
  fallback chain rather than the cache dir; the snapshot is a few bytes,
  rewritten every couple of seconds, with no reason to survive a reboot) and
  uses an atomic lock to start at most one detached refresh. A cold poll
  therefore renders nothing while the first refresh runs; normal snapshots
  refresh after two seconds and stop rendering after ten seconds if refreshes
  fail. Refresh commands keep `TASKFERRY_AUTO_START=0`, so a statusline poll
  never boots the daemon.
- `tf-sl` printing bare, uncolored pipe-delimited text (`id|status|running|queued`
  plus a summary line and a freshness flag) when run by hand from a terminal —
  expected, not a broken render. `tf-sl` does no width or color rendering of
  its own; it is a data source for a caller's statusline script, which owns
  every presentation decision (mode/width tiers, coloring, id truncation).
- `status: "unknown"` after a daemon restart — expected for `queued` tasks and
   internal summarizers (see `docs/daemon.md#recovery`). `running` tasks are
   handled differently: resumable ones are auto-resumed against a fresh overlay
   (status goes back to `queued` → `running` on the next boot), non-resumable
   ones become `crashed` with `daemon_restarted_session_lost` instead of
   `unknown`. There is no re-attachment to the original orphaned bwrap pid
   itself — resume always uses a fresh overlay and a new spawn with the
   recovered `sessionId`.
- `checkStatus: "interrupted"` on a task after a daemon restart that killed
  the previous daemon mid-gate — expected (Task 7); the only way out is to
  re-run the gate (auto re-run if the overlay survived, or accept with
  `--force` after manual verification if the gate is the wrong gate to
  re-run). The pre-fix alternative was `checkStatus: "running"` forever,
  with no settle path and no error message, and `accept --force` blocked
  by Task 6's gate-supervisor because the gate was technically still
  "running".
- `taskferry wait` returning with `status: "running"` and a `note` about
  timing out — expected when the 15-minute default timeout (or an explicit
  `--timeout`) elapses before the task settles; re-run `taskferry wait`
  to keep polling or pass `--timeout` for a longer cap.
- A `SKILL.md` edit not showing up in `integrations/claude/skills/...` —
  run `npm run skill:generate`; the distributed copies are generated, not
  hand-edited. Commit them alongside the canonical file anyway — they aren't
  build output regenerated at install time, they're the literal content each
  plugin marketplace serves from this repo's git history.
- Editing `~/.claude/skills/using-taskferry/SKILL.md` directly does nothing for
  this repo — it's a separate manual copy for global availability outside
  the plugin (see `docs/integrations/claude-code.md`), not synced from or
  to the canonical `skills/using-taskferry/SKILL.md`. Edit the canonical file,
  run `npm run skill:generate`, then re-copy to `~/.claude/skills/` by hand.
- The daemon restarting itself with no `taskferry` command involved — expected
   when a source `.js` file's mtime moved forward since startup (a merge
   landed); see `docs/daemon.md#self-restart-on-source-change`. By default
   it restarts immediately even with `running`/`queued` tasks in flight
   (those tasks are auto-resumed when a resumable session exists, otherwise
   classified with `daemon_restarted_session_lost` — see
   `docs/daemon.md#recovery`). The old "wait until idle" behavior is an
   explicit opt-in (`restartWaitForIdle: true` in `config.json` /
   `TASKFERRY_RESTART_WAIT_FOR_IDLE=1`).
- A `running` task becoming `crashed` with
   `failureReason: "daemon_restarted_session_lost"` after a daemon restart —
   expected when the daemon died mid-task and no resumable session could be
   recovered (no `sessionId` in the log, log unreadable, or directory gone).
   The previous daemon's bwrap sandbox is gone and there is no session to
   continue; the classification replaces the former opaque
   `bwrap: Can't find source path .../upper/main` spawn error. When a
   `sessionId` is present the task is instead auto-resumed against a fresh
   overlay — see `docs/daemon.md#recovery`. `queued` tasks and internal
   summarizers still degrade to `unknown` as before; only `running` dispatch
   tasks are eligible for resume.
- An orphaned child from a restarted daemon not being signalled — expected
   when its pid is still alive but its `/proc/<pid>/stat` start time no
   longer matches the one captured at spawn. The pid was reused by some
   unrelated process while the daemon was down; signalling it would kill a
   stranger. The identity check uses the start time (not a liveness probe,
   which cannot detect reuse) and passes open for legacy records with no
   recorded start time, which are signalled anyway. See
   `docs/daemon.md#recovery`.
- A fresh dispatch's opencode session/db state not being visible to
   `taskferry dispatch --session-id` on an *earlier* task — expected, by
   design (taskferry#501). Every sandboxed dispatch gets its own
   per-task data home (`<cacheDir>/opencode-data/<taskId>`, a separate
   opencode.sqlite/session store per task) so concurrent dispatches never
   contend on one shared `opencode.db` — which crashed workers with
   `opencode_unknownerror`/`"Failed to execute statement"` under
   concurrent dispatch. The resume surface that actually matters is
   preserved: a task's own later calls (its summary-generation child, a
   daemon-restart auto-resume of the same task, an advisor follow-up
   resuming that same advisor task's session) all reuse the *same* task's
   data home, so `--continue --session <id>` still resolves. Cross-task
   session resumption of a sandboxed session was never a supported
   feature — it only worked as a side effect of the shared data home — so
   only the accidental sharing is gone.
- A resumed worker starting under a different pid than the one recorded for
   the task — expected; resume is a fresh spawn (fresh overlay, fresh pid),
   not a re-attachment to the old orphaned process. The pid persisted on the
   record is replaced by the new spawn's pid.
- Editing `TASKFERRY_ENV_FILE`'s target file and a spawned worker not seeing
  the new/changed var right away — expected within a short debounce window,
  not a restart. `envFileVars` is loaded once via `env-file.js`'s
  `loadEnvFile()` at `createTaskManager()` construction (daemon startup), then
  kept live by `env-file.js`'s `watchEnvFile()`, which watches the file's
  parent directory (filtered by basename, to survive a mktemp+rename secret
  rotation swapping the file's inode) and re-runs `loadEnvFile()` on a change,
  debounced ~100ms — no daemon restart required. A reload that fails to parse,
  or a torn read caught mid-rewrite, is reported via `onError` (a stderr
  warning, itself EPIPE-guarded) and the previous `envFileVars` is kept
  as-is. Editing the `envFile` config key itself (not the file it points at),
  or the running daemon's own launch environment, still requires a restart —
  those are read once at `createTaskManager()` construction, same as
  `envDenylist` and the other config-file-backed options. This is unlike a
  caller-forwarded key, which does take effect immediately on the very next
  `dispatch`/`advisor`/`summary` call with no restart (see
  `docs/security.md#caller-env-forwarding`) — the three mechanisms (env-file
  hot-reload, config-key restart, caller-forwarded immediacy) solve different
  problems and have different freshness guarantees on purpose.
- A pending changeset listing files the worker never touched — expected when
  the dispatch directory had untracked files at dispatch time. Git-target
  extraction stages the overlay's whole merged view (`git add -A && git diff
  --cached <pre-dispatch HEAD>`, `changeset.js`'s `extractGitDiff`) so
  pre-existing untracked files surface as new-file entries alongside the
  worker's own writes. `accept` runs `git apply --3way`, which fails
  outright when those paths already exist in the working tree, blocking the
  worker's real changes too, so commit or shelve untracked files before
  dispatching against a dirty tree. Non-git targets are unaffected: their
  extraction diffs the directory against the merged view, so untouched files
  never appear. The same root cause means a `taskferry result <id>` (or
  `result --diff`) payload can exceed the daemon's 1 MiB response cap on a
  dirty tree even for a one-file task — the CLI fails that case with a clear
  error naming the cause instead of the raw size error, and the workaround
  is the same: clean up the unrelated working-tree changes, or fetch a
  narrower `--fields` set.
- `taskferry accept` exiting nonzero with `applied: false` in the response
  body — not a crash: the RPC succeeded but `git apply --3way` rejected the
  patch, which the daemon can only report as a body field (a failed apply
  deliberately leaves the changeset `pending` so accept can be retried
  after the conflict is resolved). The CLI turns that into a nonzero exit
  (taskferry#414); the `applied` field remains the authoritative
  machine-readable signal.
- A test that has two same-process calls contend on the same
  `withFileLockAsync()`/`withFileLock()` lock path (one holding it across an
  `await`, another trying to acquire it concurrently) hanging or timing out
  at exactly the lock's `timeoutMs` — expected, not a bug in the lock.
  `acquireFileLock()`'s retry loop blocks the JS thread synchronously via
  `Atomics.wait` with zero yield back to the event loop, so a contending
  same-process caller starves the very continuation that would release the
  lock. Real contention is always cross-process (a separate `taskferry`
  invocation, each with its own event loop), where this doesn't arise —
  see the note in `state-lock.test.js`.
- A pi dispatch's task record shows `variant: "max"` but the actual provider
  ran at, say, `high`. Expected: pi's own `clampThinkingLevel()` clamps a
  requested level to the model's real ceiling at runtime, including on
  extension providers (`ollama/*`, custom pi providers) taskferry cannot see
  the registry for. taskferry records what was requested, not what pi
  clamped it to, because it has no way to observe the clamp.
- A model dispatches with no `--variant` flag even though `defaultVariant`
  is `highest`, until up to 24h after that model first became available
  through opencode. Expected: the opencode variants cache
  (`<cacheDir>/opencode-variants.json`) refreshes once at daemon startup and
  once every 24h afterward, never synchronously on the dispatch path (a
  fresh `opencode models --verbose` shell-out costs ~3-4s, which would
  otherwise block the daemon's single thread on every affected dispatch).
  A model absent from the cache resolves to no variant flag, not an error.
- A CLI connecting to the daemon being torn down hard when the socket hands
  back a `Buffer` instead of a string — expected, not a crash bug. The client
  socket runs in utf8 mode (`setEncoding("utf8")` in `DaemonClient`'s
  constructor, `src/client.js`), so Node delivers strings to the data
  listener; a `Buffer` there means the encoding contract was broken, and
  decoding it per-chunk would silently corrupt multi-byte characters split
  across frames. `onData` therefore fails loudly
  (`protocolFailure` + `socket.destroy`) rather than guessing.
- `taskferry --version` answering instantly with no daemon running — expected.
  `version` is the one command that answers without the daemon, and that is
  an invariant, not a per-handler accident: every other command in the
  `HANDLERS` table calls `client.request(...)` and requires a live daemon
  connection. `version` never touches `client` — its resolved deps carry
  `client: undefined` (see `Deps.client` in `src/commands.js`), and
  `resolveRunCommandDeps` documents that single exception with a field-level
  `@type {Client}` cast on the `client` field instead of widening
  `ResolvedDeps.client` to optional for every handler.
- `spawnTaskChild()` calling both `ctx.persistTask(task.id)` *and*
  `ctx.flushPersist()` immediately after `buildSandboxedSpawn()` and before
  `ctx.spawnFn(...)`, on top of the existing post-spawn `persistTask()` call
  a few lines later. This is expected, not redundant (taskferry#477).
  `buildSandboxedSpawn()` (via `assembleBwrapSpawn()`) has already created
  the on-disk overlay and set `task.overlayDirs`/`changesetStatus` in memory
  by the time it returns, but a daemon crash between that point and the
  *old* single post-spawn `persistTask()` call (which spans the spawn
  itself, the single riskiest step in this function) used to leave
  `tasks.json` with no record of the overlay at all. On restart,
  `sweepOverlayEntry()` can only spare an overlay whose owning task is
  loaded with `overlayDirs.root` matching and `changesetStatus: "pending"`
  — an unmatched `taskferry-cow-<taskId>` directory looks indistinguishable
  from a genuine orphan and gets deleted, even though the detached child
  (spawned with `detached: true`, so it can outlive the daemon) may still be
  writing into it. `persistTask()` alone is not enough to close that window:
  it only flips `ctx.state.persistDirty` and arms a 250ms debounce timer
  (`PERSIST_DEBOUNCE_MS`, in `persistTaskRecord()`) rather than writing
  synchronously — and by this point in `spawnTaskChild()`,
  `queueDispatchLaunch()` has typically already called `persistTask()` once
  at dispatch/queue time, so the dirty flag may already be set and a second
  debounced call is a no-op for write timing. `ctx.flushPersist()` (bound to
  `flushPersistRecords()`, the same synchronous `fs.writeFileSync` +
  `fs.renameSync` path the debounce timer eventually calls) is what actually
  forces the write before `ctx.spawnFn(...)` runs. The later, post-spawn
  `persistTask()` call is unchanged and still needed to record
  `status: "running"` and the real `pid`.
- `taskferry list --all` showing at most the 500 most recent rows even when
  the counts line says far more tasks exist — expected, not a truncation bug.
  All-time history grows without bound, and an unfiltered `task.list`
  response used to ship every row ever recorded, eventually exceeding the
  daemon's 1 MiB outbound message cap and killing the connection with no
  error frame ("daemon connection closed", taskferry#342). The daemon now
  caps the shipped rows at the newest `MAX_LIST_ROWS` (500) while keeping
  `counts` computed over the full set (a cheap in-memory tally), so
  `list --all` always answers. To see a scoped slice, narrow with
  `--directory`; `doctor --stats` summarizes the whole history server-side.
  Directory-scoped list and context requests filter the cheap in-memory rows
  before calling per-task status code that reads logs, so a narrow request
  does not perform work across the entire task history.
- An error response envelope whose `message` is a single line (detail lines
  collapsed away) or empty — expected, not dropped data. The envelope keeps
  the historical wire shape: `message` is exactly the first `error:` line
  (or the first raw line, which stays `""` when the error text is empty),
  every other line lives in `detail`, and the help fallback is the
  daemon-oriented "Retry the request or inspect the daemon logs", not the
  CLI's "Retry the command or run `taskferry --help`". `responseError()` in
  `src/daemon.js` reuses the same `errorValue()` the CLI renders with, but
  overrides its CLI-oriented defaults (`foldDetailLines: false`,
  `messageFallback: ""`, its own help fallback); the CLI's richer multi-line
  message is presentation for a terminal, deliberately not shared with the
  protocol.
- A worker that "ended on a tool call" producing no visible final assistant
  message — expected, and not a failure of the dispatch. Workers can settle
  with `crashed`, `cancelled`, or `done` while the last assistant turn is
  still a tool_use whose deliverable the worker wrote to its scratch output
  dir (see `docs/daemon.md#scratch-output-dir-survives-across-every-terminal-status-taskferry423`).
  Read it back with `taskferry output <id>` rather than the log — the log
  captured the *calls*, the scratch dir is where the work actually landed.
  This is the whole reason the per-task scratch dir exists separately from
  the changeset overlay.
- An empty `taskferry output` listing, or a `not_found` file result, after a
  worker replaces its task output directory with a symlink — expected, not
  lost deliverables. Output inspection opens the root without following a
  symlink and reads through a pinned file descriptor; directory permission
  repair likewise refuses a symlink instead of changing the linked target.
- A config entry, credential, or session file that passed the lstat symlink
  guard at bind-computation time still resolving through a symlink into the
  sandbox — expected, and tolerated on purpose. The guard's lstat check
  (`isSafeBindSource` in `src/executor.js`) and bwrap's own host-side path
  resolution at spawn time are two separate, non-atomic steps, so a path
  swapped in between them (a classic TOCTOU race) can still bind whatever
  the new symlink points at. This is a deliberate race, not a bug to fix:
  exploiting it requires write access to the config dir or the path's parent
  at dispatch time, which is the same attacker capability the guard already
  assumes (a plugin that can plant a symlink there can also rewrite the
  config files the symlink points at — so racing back buys nothing).
  "Fixing" it by pre-resolving every path with `fs.realpathSync` would also
  break legitimate symlinked config trees (dotfiles repos symlink
  `~/.config/opencode` and its entries into the checkout), so the guard
  stays a best-effort check against the static attack, not a lock against a
  race that requires the attacker to already hold the keys.
- A legitimate symlinked config entry (`opencode.jsonc` symlinked into a
  dotfiles repo) silently missing from the sandbox after an upgrade —
  expected, and now diagnosed, but the behavior *splits by file kind*.
  OpenCode config entries inside `~/.config/opencode` are resolved to their
  real target via `resolveOpencodeConfigBindSource()` in `src/executor.js`
  and ro-bound as that target. This includes entries such as
  `opencode.json`, `plugins`, and `agents`; `.gitignore` is skipped. The drop
  no longer happens for these entries. All other binds
  (Pi extensions, `auth.json`, a resumed OpenCode session file) still fail
  closed: the guard refuses the symlink (bwrap would bind the link's
  *target*, which is the whole vulnerability #392 closes) and warns on
  stderr naming the skipped path. If you hit the latter, `cp` the file into
  `~/.config/opencode` (or the relevant config dir) rather than weakening
  the guard.
- A dispatch's private gitDir (`<git-common-dir>/worktrees/<name>` for a
  linked worktree) getting a one-time scratch copy instead of a live overlay
  or live bind, even though it's a directory and overlayfs mounts directories
  fine — expected, not a leftover file-vs-directory special case
  (taskferry#304). That directory sits directly inside the `worktrees/` tree
  that `git worktree add` touches/locks for *every* worktree as part of its
  own bookkeeping, not just the one being added — a live mount can therefore
  be perturbed by an unrelated sibling worktree operation and crash an
  in-flight dispatch with "directory is missing". The same snapshot rule is
  used by `--no-overlay`; that flag leaves the target working tree live, but
  does not re-expose the private gitDir. If gitDir cannot be distinguished
  from gitCommonDir (or cannot be resolved), the fallback snapshots the whole
  common dir for the same reason: it may contain the live `worktrees/` tree.
  Snapshotting costs nothing in correctness: like a sandboxed `git commit`,
  writes inside the copied git metadata are discarded at settlement regardless
  of bind mechanism, and only the extracted diff (not git-state mutations)
  ever reaches the real repo. `objects`/`refs`/`logs/refs` stay on the shared
  mechanism because they are common to the main checkout, can be large, and
  must track live upstream state (new commits) during a linked-worktree
  dispatch — the tradeoffs don't apply to private git metadata the same way.
- A user-supplied `--ro-bind` of a deny-listed path (e.g. `~/.ssh`) binding
  read-only with a loud "overrides the sandbox deny-list" warning, while the
  same path in a project's `.taskferry.toml` `read_only_paths` is skipped as
  unsafe — expected, not an inconsistency. The two sources have different
  trust: `--ro-bind` is the user's own explicit command-line choice (same as
  `--rw-bind`, which has always overridden the deny-list), while
  `.taskferry.toml` is project-supplied and daemon-untrusted, so its
  protected-mount check (which includes the deny-list) stays mandatory. The
  structural mounts (`stateDir`, `runtimeDir`, the launch directory) are
  never overridable from either source: a user `--ro-bind` overlapping one of
  those is skipped with a warning even when it also overlaps the deny-list
  (e.g. `stateDir` itself, which is a default deny-list entry).
- A daemon refusing to start with "another taskferry daemon ... is already
  running" even though `daemon.sock` doesn't exist and nothing answers on the
  socket path — expected, not a stale-socket bug (taskferry#515). The
  daemon's boot gate is two-layered: the socket bind wins exclusivity (the
  OS-level authority), and a `<state-dir>/daemon.pid` record — checked under
  the socket-bind lock, *before* the task manager is constructed — refuses
  to reclaim the record of a process that is still genuinely alive (signal-0
  probe plus `/proc/<pid>/stat` start-time identity, so a recycled pid is
  not mistaken for the original daemon). A crashed daemon leaves the record
  behind on purpose; the next boot only reclaims it once the recorded owner
  provably no longer exists. The manager's constructor runs the destructive
  boot-time orphan sweeps, so a second daemon must never reach construction
  while a first one might still be sweeping the same state — refusing to
  boot only defers a start, while deleting a live task's overlay is
  unrecoverable. Clean shutdown (including the source-change restart path)
  unclaims the record; only an unclean death leaves it as a guard.
- An orphan sweep (overlay/prompt/output) at startup leaving a directory or
  file alone that "clearly" has no matching task — expected when the id is
  present in `tasks.json` on disk even though the daemon's in-memory map has
  never seen it (taskferry#515). The sweeps re-read the persisted store at
  boot and refuse to delete an id they find there, because a stale daemon
  booting against a live daemon's state must not tear down the live daemon's
  in-flight overlays/prompts/output dirs. An id unknown in memory *and* on
  disk is still swept as a genuine orphan (crash before the record ever
  persisted), and an id this daemon itself loaded is governed by the
  in-memory record alone (its own restart reconciliation already decided the
  task's fate; the on-disk snapshot may lag by the persist debounce).
- A `daemon.pid` file that briefly survives a clean shutdown — expected if
  a close raced an unlink; the next boot re-checks it and reclaims it once
  its recorded owner is provably dead, so a leftover record can never wedge
  a restart.
- Editing or truncating `tasks.json` by hand and watching the removed tasks
  come back — expected. The daemon loads the whole store into memory at boot
  and rewrites it wholesale on a coalesced flush timer, so any external edit is
  overwritten the next time a task changes state. This is why `taskferry prune`
  is an RPC to the daemon rather than a file rewrite in the CLI. It becomes a
  real bug only if a prune through the daemon fails to survive a subsequent
  flush, which would mean the eviction never reached the in-memory map.
- Task history getting shorter over time, and `taskferry doctor --stats`
  reporting a smaller `overall` sample than it used to — expected once
  `taskRetentionDays` is non-zero. The boot sweep evicts terminal tasks past
  the window so the store cannot grow without bound (a 117 MB, 31k-task
  `tasks.json` is what motivated this: it pushed an unscoped `taskferry
  context` past the daemon's 1 MiB response cap). Nothing is lost, the records
  move to `<stateDir>/archive/tasks-pruned-<stamp>.ndjson`. Set
  `taskRetentionDays` to `0` to keep everything in the hot store. It would be a
  real bug if a `queued` or `running` task were evicted, or if an archive file
  were missing records the store no longer has.
- An evicted task's `<stateDir>/outputs/<id>` directory staying on disk forever
  once retention has pruned the record. Deliberate. The boot orphan sweep
  removes an output dir whose id is absent from `tasks.json`, which is exactly
  what a pruned task looks like, so the sweep would otherwise delete the whole
  archived deliverable history the first time retention ran. It is bounded to
  entries younger than `taskRetentionDays`
  (`sweepOrphanedOutputDirsFor`, `src/tasks.js`): crash debris is by definition
  from the boot that just crashed, so the guard costs nothing real and keeps
  `outputs/` archival. Reclaim that space by hand, deliberately. It would be a
  real bug if a dir created during *this* boot's crashed dispatch survived the
  sweep, or if the guard applied while `taskRetentionDays` is `0`.
