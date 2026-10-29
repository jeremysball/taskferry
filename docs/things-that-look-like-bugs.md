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

- A sandboxed worker cannot read the host's harness session stores. Observe:
  a worker asked to inspect prior OpenCode/Kilo/Pi sessions, or to clean up
  `~/.local/share/opencode`, finds the directory empty or missing even
  though the files exist on the host. Deliberate: the fixed deny-list
  tmpfs-masks `$XDG_DATA_HOME/opencode`, `$XDG_DATA_HOME/kilo`, `~/.codex`,
  and Pi's `$PI_CODING_AGENT_DIR/sessions`, so one worker can never read
  another session's prompts, transcripts, or tool output; agent logs are
  records, not cleanup targets. The worker's *own* session data lives in the
  per-task sandboxed data home and stays readable. It becomes a real bug if
  a legitimate dispatch needs the host's prior sessions, or if a future
  harness data directory is treated as safe because it is not literally a
  database.
- A dispatch's `XDG_DATA_HOME` does not select its OpenCode or Kilo credential
  file. Both executors read `auth.json` from the daemon's data home and bind it
  read-only into the task's redirected data home. This prevents a dispatch
  from using an automatic credential bind to expose a file in a denied
  directory. Set `XDG_DATA_HOME` when starting the daemon to use a custom
  credential store. It is a bug if that daemon setting is ignored or a
  dispatch override changes the automatically bound credential source.
- The integration smoke tests never touching a real model provider — since
  PR #547 CI dispatches against `src/mock-llm.js`, a local keyless
  OpenAI-compatible endpoint wired in as a `mockllm` provider via
  `OPENCODE_CONFIG_CONTENT`. Deliberate: the leg's subject is taskferry's own
  pipeline (real daemon, real bwrap sandbox, real `opencode` spawn, NDJSON
  parse, settlement, cancel's process-group kill), and a live provider made
  every open PR red on a provider billing-state change with zero code
  regressions (`opencode_apierror: "The requested model was not found."`,
  2026-09-01). Two contracts make the fake behave like a real provider, and
  both fail silently if broken. (1) The delay lives in the model id:
  `mockllm/delay<n>` withholds its reply for n seconds so cancel/poll race a
  genuinely in-flight worker; if a delayed case is dispatched against
  `pong` instead, the task settles instantly and the assertions fail looking
  like cancel regressions. (2) The mock reports deterministic token usage and
  the provider config carries a nonzero cost table, so the usage-parse ->
  step_finish -> `tokens`/`cost` path is exercised end to end --
  `smoke-test.js` asserts nonzero input/output tokens so that can't decay
  back into synthetic zeros. Also non-obvious: the mock runs as its own
  process, not inside the smoke script. The scripts drive the CLI with
  `execFileSync`, which blocks the event loop for exactly as long as a worker
  waits for its reply -- an in-process server would be frozen when the
  response is due, and the task would hang looking like a sandbox bug.
- A daemon with free `maxConcurrentTasks` slots and `queued` ferries can stop
  launching them while `memoryAdmissionPercent` (default `85`) is exceeded.
  Observe: `taskferry status` shows `queued` tasks that never spawn, while
  already-running tasks keep running. Deliberate: the memory gate is a
  separate global admission limit ahead of the existing queue, so launching
  more workers under memory pressure risks the OOM killer taking down the
  daemon and every in-flight ferry. It is a real bug if a running worker is
  stopped by this gate, or if queued work never resumes once memory falls.
  The same gate is deliberately **fail-open** when `/proc/meminfo` or a
  required cgroup file cannot be read: launches are admitted with a warning
  at most once per minute. A broken metric must not strand every queued
  ferry, and the warning (not a silent pass) is what makes the outage
  visible.
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
   data home, so the `--session <id>` resume still resolves. Cross-task
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
  (`<cacheDir>/opencode-variants.json`) starts warming at daemon startup when
  OpenCode is the default executor, or on the first OpenCode variant lookup
  otherwise. It
  checks hourly afterward, refreshing when the cache is older than 24h,
  never synchronously on the dispatch path. Discovery uses `opencode models
  --verbose` on 1.x or `opencode api --standalone GET /api/model` on 2.x.
  A model absent from the cache resolves to no variant flag, not an error.
  A catalog built for a different or not-yet-confirmed CLI major is ignored;
  a cold lookup can therefore omit the override while discovery runs.
  A fresh matching cache that contains the model but still fails to select
  its highest reasoning variant is a bug.
- After upgrading or downgrading opencode, the next few minutes of opencode
  dispatches can still use the old version's argv and crash with
  `boot_failure` on an unknown flag. Expected: the installed major version
  is probed asynchronously with `opencode --version` and memoized for 5 minutes
  (`TASKFERRY_OPENCODE_VERSION_TTL_MS` / `opencodeVersionTtlMs` config, `src/opencode-version.js`),
  warmed at daemon start and re-probed by the next opencode launch once the
  TTL lapses. The probe is async and never blocks the daemon thread. If crashes outlast
  the TTL, the detection is broken.
- An opencode 2.x summary child loads opencode plugins, while a 1.x one
  didn't. Expected: 2.0 removed `--pure`, and there is no replacement flag.
  The child still runs inside the sandbox against its private snapshot.
  Plugins load regardless of `--no-sandbox`; the sandbox only affects
  filesystem isolation, not plugin loading. Every 2.x run, summaries
  included, passes `--auto` so a plugin's permission prompt is approved
  instead of waiting on a terminal nobody is watching. A 2.x summary that
  stalls on a permission prompt is a real bug: it means `--auto` was
  dropped from the argv.
- An opencode dispatch crashes before anything spawns with "opencode CLI
  major version could not be detected" instead of falling back to the 1.x
  argv. Expected: the 1.x and 2.x `run` flags are incompatible, so a wrong
  guess boot-fails anyway, later and with a less useful error. The cause (missing binary,
  timeout, unparseable `opencode --version`) is on the daemon's stderr, and
  failed probes are not cached, so the next dispatch re-probes. It is a
  real bug if `opencode --version` prints a parseable version and
  dispatches still fail this way.
- An opencode 2.x dispatch passes `--standalone`, a flag none of the 1.x
  runs had. Expected: without it, 2.x `run` attaches to a shared background
  opencode service that runs outside the bwrap sandbox and the overlay, so
  the worker's writes would land on the host directly. Dropping the flag is
  the bug, not having it.
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
- Orphaned prompt files, output dirs, overlays, and namespaced per-task uv
  dirs piling up untouched across boots while `tasks.json` is unreadable —
  expected.
  When the store fails to load (`stateLoadError`), the daemon's in-memory
  map and the disk snapshot are both empty, so every entry would read as an
  orphan, including live output dirs and the overlays of pending changesets.
  Every record-guarded boot sweep takes `failClosed` and skips instead
  (`sweepOrphanedPromptFilesFor`, `sweepOrphanedOutputDirsFor`,
  `sweepOrphanedOverlaysFor`, `sweepDeferredCleanupFor`, and the namespaced
  pass of `sweepOrphanedUvDirsFor`). The retention sweep is skipped too.
  The legacy flat uv pass still runs: it never reads task records, only the
  `uvLegacySweepAgeDays` mtime floor, so an unreadable store tells it
  nothing new. Repair `tasks.json` and the next boot sweeps normally. It would be a real
  bug if any of these sweeps removed something on a boot where the store
  failed to load. A *missing* `tasks.json` is a fresh state dir, not a load
  failure, and still sweeps.
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
- A pending ferry's `<cacheDir>/uv-cache/<ns>/<id>` and `<cacheDir>/uv-tools/<ns>/<id>`
  dirs surviving `taskferry accept`/`reject`/auto-accept until the daemon sees
  the actual settlement event (and, for overlayed tasks, *not* at child exit)
  — expected. Per-task uv dirs (`src/deferred-cleanup.js`) are deferred-cleanup
  data, not scratch-cleanup closures: a `pending` changeset still owns a live
  overlay and a re-runnable check gate, and the gate re-runs against the very
  same uv dirs the worker ran with — reaping them at child exit would corrupt
  an in-flight verification run. The drain fires at real settlement
  (`releaseOverlayForTask`, which is invoked on accept, reject, no-changes
  auto-accept, and extraction failure, plus the synthetic-step path used by
  the orphan sweep). A `--no-overlay` dispatch has no overlay, so nothing
  on the accept/reject path ever fires for it; the child-settlement drain
  runs in that case instead (and a synchronous throw from `spawnFn` drains
  too). The list is persisted on the task record, so a daemon killed
  between child exit and the settlement handler resumes the drain on next
  boot via `sweepDeferredCleanupFor`. It would be a real bug if a settled
  (accepted or rejected) task's uv dirs survived a daemon restart, or if a
  `pending` task's dirs disappeared before it settled.
- A flat `<cacheDir>/uv-cache/oc_*` (or `uv-tools/oc_*`) dir from before the
  namespaced layout surviving the boot sweep — expected until the
  `uvLegacySweepAgeDays` age floor elapses, default 7 days. The legacy pass
  has no per-id ownership record on disk (the original daemon did not namespace
  by state dir, so there is nothing on the new layout's `tasks.json` to key
  against), and the namespaced pass does not look at flat entries at all.
  Without an age floor, the sweep would happily reap a still-active
  developer task that just upgraded. 7 days is long enough that an upgrade
  is unaffected, short enough that the existing accumulated dirs are gone
  within a week. Set `uvLegacySweepAgeDays: 0` (or
  `TASKFERRY_UV_LEGACY_SWEEP_AGE_DAYS=0`) to skip the legacy pass entirely;
  the namespaced path is unaffected. It would be a real bug if a flat dir
  younger than the floor were removed, or if the sweep touched another state
  dir's namespace dir or anything under it. Only task-id-shaped `oc_*`
  entries are legacy candidates; an idle daemon's namespace dir ages past
  the floor too, which is why the pass matches by name, not by age alone.
- A boot sweep entry (an orphaned output dir or a legacy flat uv dir) that
  `lstat` cannot read surviving every sweep, with a `failed to stat ...;
  leaving it in place` line on stderr — expected. Both sweeps decide by mtime,
  and an entry with an unreadable mtime has an unknown age, so neither the
  output-dir retention window nor the legacy age floor can clear it
  (`passesRetention`, `src/tasks.js`). Fix the permissions and the next boot
  reaps it. It would be a real bug if an entry the sweep *could* stat were
  kept for this reason, or if a stat failure ever led to a removal.
- A deferred-cleanup path refused with `realpath failed: EACCES ...` and
  dropped from the task's list, leaving the dir on disk — expected.
  Confinement (`confinePath`, `src/deferred-cleanup.js`) proves a path stays
  inside the daemon's uv roots by resolving its symlinks; a path whose
  realpath fails for any reason but ENOENT cannot be proven safe, and lexical
  resolution would not follow a symlink out of the root. Refusing leaks one
  dir; guessing could `rm -rf` outside the cache. A missing path (ENOENT) is
  still checked lexically, because the rm finds nothing there either way. It
  would be a real bug if a path that resolves cleanly inside a root were
  refused, or if a refused path were ever removed.
- `taskferry daemon message exceeds 1048576 bytes` from a CLI call against a
  daemon whose response cap you raised. The daemon and every client resolve
  `maxResponseBytes` separately (flag, env var, config key, default;
  `resolveResponseCapBytes` in `src/options.js`), so the two caps can
  disagree. A client that auto-starts the daemon forwards its own cap, and a
  daemon that restarts itself forwards its own. A daemon started by hand
  with only `--max-response-bytes` is invisible to the client, which keeps
  the 1 MiB default and drops any longer message (`src/client.js:318`). Set
  the env var or config key where the CLI runs. It would be a real bug if a
  client holding a matching cap still refused a response under it, or if a
  daemon the client started sent a response that client could not read.
- Lowering `maxResponseBytes` under 512 KiB shrinks the default
  `taskferry output <id> --path` limit. With the cap below the
  `maxOutputFileBytes` default (`524288`), an unset limit clamps to
  `floor((cap - 4096) / 6)`, the largest file whose worst-case JSON escaping
  still fits one response (`maxSafeResponseBytes` and
  `resolveOutputFileBytesOption` in `src/tasks.js`), rather than failing
  startup. A limit you set yourself above the cap still throws when the task
  manager is built, because clamping it would hide the typo. It would be a
  real bug if an unset limit exceeded the cap, or if an explicit limit above
  the cap were accepted.
- A malformed `TASKFERRY_MAX_RESPONSE_BYTES` stops the daemon at boot and
  fails the CLI, while a malformed `TASKFERRY_MAX_CONCURRENT_TASKS` falls
  back to its default. A cap that silently reverted to 1 MiB would surface
  later as `daemon response for this request exceeds 1048576 bytes`
  (`src/daemon-server.js:104`) with nothing pointing at the typo, so the
  daemon and the client resolve this one variable with `strictEnv` and the
  error names it. A task manager built directly stays lenient. It would be a
  real bug if the error omitted the variable name, or if an empty value (a
  blank `.env` line) were rejected instead of ignored.
- The daemon's inbound request buffer never dropping below its own default
  while `maxResponseBytes` is lowered. Observe: `taskferry daemon --max-response-bytes 512`
  (or a tiny `TASKFERRY_MAX_RESPONSE_BYTES`) makes every request fail as too
  large even though the cap says 512 bytes. Deliberate: the inbound buffer is
  a read bound on an untrusted peer, not the response budget, and shrinking
  it to a tiny outbound test value would reject every request before
  `invoke()` runs; raising the outbound cap does raise the inbound floor so a
  large request can still be answered
  (`src/daemon.js`, `maxBufferBytes: maxOutboundBytes >= MAX_BUFFER_BYTES ? ...`).
  For this to be a real bug, an inbound request would have to be limited by
  the outbound budget by design, or a 512-byte response cap would have to be
  useful with requests larger than 1 MiB.
- The client reading `config.json` before checking for a running daemon.
  Observe: a malformed or unreadable config makes even `taskferry status`
  fail against an already-running daemon that is perfectly healthy.
  Deliberate: connect-time options (receive ceiling, startup defaults) come
  from the same file, so a broken config is reported where the user can fix
  it instead of being silently ignored for commands that happen to need no
  config; auto-start would otherwise boot a daemon with defaults the user
  thought they had overridden. It becomes a real bug if the client ever grows
  an offline/local-only command that must work without a valid config.
- An empty error value when a tool returns a bare `error:` line with no message
  body — expected. `extractErrorParts` in `src/output.js` uses nullish
  coalescing when stripping the `error:`/`help:` prefixes, so a line that is
  exactly `error:` is stored as `""` rather than keeping the raw prefix line.
  Callers treat a blank value as "prefix present, no message body"; if you see
  one in UI or logs after a tool returns only `error:`, check the producer, and
  do not "fix" it by restoring the raw prefix as the message. It would be a
  real bug if an empty body were replaced by the literal string `error:`.
- Two concurrent non-git tasks sharing the literal mount name
  `/tmp/taskferry-merged`. Observe: both extractions and applies report the
  same merged-view path. Deliberate: each bwrap invocation gets its own
  private `--tmpfs /tmp`, so the literal is namespace-local and never a host
  path; the overlay root itself is still per-task. A non-git target or
  runtime dir of exactly `/tmp` is rejected because the later bind of that
  directory would shadow the mount point. It would be a real bug if the
  mount point moved into a shared namespace, or if bwrap stopped creating a
  private `/tmp` for each invocation.
- Non-git extraction throwing on an exit-1 result with empty stdout, even
  when stderr is also empty. Observe: a bwrap/diff ambiguity surfaces as
  `non-git diff extraction failed` instead of `hasChanges: false`.
  Deliberate: GNU diff writes differences to stdout before exiting 1, so an
  exit-1 result with no stdout is a setup failure or a silent bwrap death;
  treating it as "no changes" would discard the worker's edits. It would be
  a real bug if a legitimate diff could exit 1 with an empty stdout.
- `--ro-bind` and `--rw-bind` replacing their global lists instead of adding
  to them. Expected, not an inconsistency. A dispatch's `--ro-bind` or
  `--rw-bind` (or, absent that, the next layer down that sets one; the order
  is in `docs/config.md`) is the whole list, so `--rw-bind /x` on a daemon whose config binds `/a,/b`
  leaves `/a` and `/b` out of that dispatch. A global list can name paths a
  given worker should not see or write by default (a global instructions
  file, a reference tree, a shared scratch directory), and a dispatch has to
  be able to take them away as well as add to them; a union has no way to do
  that, which is why there is no `--ro-unbind` or `--rw-unbind` either.
  Scope: only the global lists are replaced. A project's `.taskferry.toml`
  `roBind`/`read_only_paths` still binds, the settle-time check gate still
  sees the project's mounts, and the binds the sandbox adds on its own (a
  worktree's git directories, the task's output directory, the executor's
  credentials) stay. The two names of the read-write flag (`--rw-bind` and the
  deprecated `--allowed-dirs`) union with each other inside one layer, and
  that combined list is what replaces the global one. It would be a real bug
  if a per-dispatch list dropped a project entry or an automatic bind, or if
  a layer below the first one set still contributed a path.
- `--ro-bind ""` and `--rw-bind ""` (and `--ro-bind=`, `TASKFERRY_RO_BIND=`,
  `TASKFERRY_RW_BIND=`, config `"roBind": ""`, `"rwBind": ""`) being accepted
  as "bind none of the global list", while `--allowed-dirs ""` is still
  rejected with `requires a non-empty value`. Expected. An empty list is the
  only way to say "this dispatch gets none of the global binds" under replace
  semantics, and the deprecated name has no empty form: `--allowed-dirs ""` is
  a usage error, and an empty `TASKFERRY_ALLOWED_DIRS`, config `allowedDirs`,
  or `allowedDirs` array is ignored, so the old name can never empty a list
  the new one set. A lone `,` is rejected for all three. It would be a real
  bug if the empty list were dropped on a resume: `resumeRoBind` and
  `resumeAllowedDirs` persist `[]` for exactly that reason. It would also be a
  real bug if an empty value of the deprecated name emptied the list.
- An OpenCode or kilo worker not seeing the `AGENTS.md` and `CLAUDE.md` that
  sit in `~/.config/opencode` or `~/.config/kilo`, although every other entry
  in that directory is bound. Expected. The executors used to bind the whole
  config directory entry by entry, which handed every ferry the caller's global
  instructions as a side effect (and, through a symlinked `AGENTS.md`, a path
  under the deny-listed `~/.claude`). Those two exact names are now skipped
  (`AGENTS.md.backup` and other lookalikes still bind) and a ferry gets
  global instructions only when `--ro-bind` names the file. The walk also
  skips an entry under any other name whose symlink target is named
  `AGENTS.md` or `CLAUDE.md` (`team.md -> ~/.claude/CLAUDE.md`), since
  binding it would hand over the same file under an alias; a symlink to a
  differently named file still binds. It would be a real bug if an alias to
  an instructions file were bound, or if a symlink to an ordinary file were
  skipped.
- A `--ro-bind` of a file named `CLAUDE.md` showing up inside the sandbox as
  `.../AGENTS.md`, and a second instructions file in the same list being
  reported and left at its own path. Expected. The mapping is by file name
  (`AGENTS.md` or `CLAUDE.md`, regular files only: a directory, FIFO, or
  socket is never mapped, because the worker's harness would block opening
  it), both land on `AGENTS.md` in the sandboxed config dir (where the old
  auto-bind put the host's `AGENTS.md`), `AGENTS.md` wins a tie, the first
  listed wins between two files of one name, and the file is bound at its
  own path as well. Pi has no such path, so it gets the own-path bind only,
  and summary children map nothing. It would be a real bug if a file with
  any other name were mapped, or if two files were mapped to the same
  destination.
- An instructions file named in a project's `.taskferry.toml`
  `roBind`/`read_only_paths` binding at its own path but not showing up as
  `AGENTS.md`. Expected. The mapping reads only the global or per-dispatch
  list (`roResolved`, passed to `instructionsRoBinds` in `buildBwrapBinds`).
  The mapping is for the caller's own instructions; the project layer is
  controlled by the repo, and mapping it would let a checked-in config file
  replace the worker's instructions. It would be a real bug if a
  project-layer path were mapped without the dispatch or global list naming
  it.
- A mapped instructions file turning writable when the same file is also in
  `--rw-bind`. Expected: read-write wins for a path in both sets, and the
  mapped copy is the same file, so it is promoted too (`--bind` replaces the
  `--ro-bind` pair). It would be a real bug if the own-path copy were
  writable while the mapped copy stayed read-only, or the reverse.
- A relative `--ro-bind` path being taken from the dispatch's `--directory`
  rather than from where the daemon runs. Expected, same as `--rw-bind`: the
  daemon's working directory is not something a caller controls or can see.
  It would be a real bug if two dispatches from different directories
  resolved one relative entry to the same host path.
- `TASKFERRY_RO_BIND=" "` or `TASKFERRY_RW_BIND=" "` (or `","`, or the same in
  config, or an array of only blank entries from the manager option or a
  per-dispatch call) failing with `names no path` while the empty string is
  accepted. Expected. The empty string is the deliberate "bind none of the
  global list"; a non-empty value that names no path is a typo that would
  otherwise parse to an empty list and silently shadow the layers below it.
  The same value passed to a flag is a usage error for the same reason. It
  would be a real bug if a blank value were accepted as an empty list, or if
  the empty string started to throw.
- A task still `running` for up to `stdoutDrainGraceMs` (default 5 seconds)
  after its worker process is gone, a daemon-log line saying stdout was
  still open, and a pipe-holding descendant that dies from `SIGPIPE` at the
  deadline. Expected: settlement waits for the worker's stdout to reach
  end-of-file so the final output is in the log before the exit-time checks
  read it (see `docs/daemon.md#settling-an-exited-child`). The deadline
  closes the pipe, which drops unread bytes and gives a still-writing
  descendant `SIGPIPE`. It would be a real bug if a task stayed `running`
  past the grace, if a late chunk appeared in a different task's log, or if
  the line printed for a task whose worker's stdout closed on its own.
- A task that has already exited keeps its concurrency slot and its
  `taskferry wait` unresolved until settlement. Expected: the drain wait is
  part of settlement, and releasing either early would report a terminal
  state before the final log bytes have been classified. It would be a real
  bug if the slot were not released when the grace expires.
- Cancelling a task whose worker has exited but whose stdout is still
  draining returns "already exited" and settles with the recorded exit
  status instead of `cancelled`. Expected: there is no live process left to
  cancel, and overwriting a clean exit would misreport the result. It would
  be a real bug if the task stayed `running` or its descendants survived
  settlement.
- A `done` task can carry `failureReason: "log_write_failed"`. Expected: the
  process exited cleanly, but the daemon could not write its log (ENOSPC,
  EIO), so the result records the observability failure without changing the
  execution status. It would be a real bug if the log were silently
  truncated with no task-level record.
- A task's `cost` in `tasks.json` is `null`, `0`, or absent, and which one
  it is depends on facts the record itself does not show. Observe: a task
  that clearly ran shows `cost: null`, or the record has no `cost` field at
  all, or a run that was free shows `cost: 0`, and nothing in the record
  tells the reader which state a given task is in. Deliberate: the three are
  different facts. `null` means the daemon knows the run used nothing, `0`
  is a real reading (the provider reported a cost of exactly zero), and a
  missing field means the daemon cannot vouch for the run's usage. The
  policy, and the full list of causes behind a missing field, live in
  `docs/daemon.md` ("Usage accounting in `tasks.json`"); this file records
  only that the three states are deliberately distinct. It would be a real
  bug if a consumer treated a missing field and an explicit `null` as the
  same thing, if a zero cost were coerced into `null`, or if a record the
  daemon could not vouch for reported `null` as though it had.
- A task the daemon restarted on shows `crashed` with
  `failureReason: "daemon_restarted_session_lost"` and no `cost` field,
  even though its transcript holds usage. Observe: the transcript has
  `step_finish` events with a cost, the record says the run used nothing
  knowable, and there is no stamp to compare against. Deliberate: the child
  that wrote that transcript belonged to the previous daemon, so its usage
  totals are not the restarted daemon's to vouch for, and stamping them
  would mean re-reading a transcript the restart path's bounded-read
  discipline rules out. A reader that asks for the result derives the
  totals from the transcript instead. It would be a real bug if the
  restarted daemon claimed a total it had not folded, or if a reader of the
  result got no totals while the transcript still held them.
- A task resumed after a daemon restart carries the whole session's cost, not
  just what its last attempt spent. Observe: the record's `cost` covers usage
  an earlier attempt produced under a previous daemon, so the number does not
  line up with the events the last attempt emitted. Deliberate: the totals
  are the session's, taken from the transcript when the run ends, so the
  record agrees with what a reader parses out of the log (the policy lives in
  `docs/daemon.md`, "Usage accounting in `tasks.json`"). It would be a real
  bug if the record carried one attempt's totals while the transcript held
  the session's, or if the resumed run's own usage were dropped from the
  record altogether.
- `taskferry list` rows carry `cost` but not `tokens`, while
  `taskferry status --full` carries both. Observe: the row's `cost` is
  there but no token counts are, so the two surfaces disagree about how
  much they report. Deliberate: the compact row is a scan surface (what
  did this run cost), the full detail is the accounting surface (what did
  it cost and how many tokens), and a token total is a nested object that
  does not belong in a row a caller reads in bulk. A cost the daemon cannot
  vouch for is left out of the row entirely rather than shown as zero. It
  would be a real bug if the row showed a cost the record did not carry,
  showed zero for a run the daemon could not vouch for, or if the two
  surfaces reported different costs for the same task.
- A task's stored `cost` can disagree with its transcript. Observe:
  `tasks.json` shows one cost and `taskferry result` reports another, with
  the two never reconciling in the record. Deliberate: the transcript on
  disk is the authority for a result, so a transcript that holds usage the
  daemon's own capture never saw (a run whose daemon died before the
  worker's stdout reached the log), or one that grew after the settlement,
  is accounted for when it is read. The record holds the totals the daemon
  vouched for at settlement, which is what remains once the transcript is
  gone (the daemon prunes records, not logs, so a deleted log takes the
  totals with it).
  A read never writes the record, so the record's totals are a snapshot of
  what the daemon knew when the task settled, not a copy of the transcript.
  It would be a real bug if a total were ever added to a stored one instead
  of replacing it (a task's cost could be counted twice), if a read
  reported totals the transcript does not support, if a read rewrote the
  record, or if the record's copy were dropped at the moment the transcript
  is gone.
