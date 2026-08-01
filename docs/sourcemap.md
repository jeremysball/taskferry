# Sourcemap

A one-page orientation for anyone (human or agent) new to this codebase —
what each file does and where to look for something, not the full behavior
of any of it. For depth, follow the doc pointers in each section.

## Call chain, front to back

```
cli.js          entrypoint: parses process.argv, dispatches to a command,
                 prints TOON, sets process.exitCode
  -> args.js       flag/argument parsing and validation per command
  -> commands.js   translates parsed options into daemon RPC calls,
                    shapes the response (leanStatus/leanResult/...)
    -> client.js     connects to the daemon socket; auto-spawns the daemon
                      on first use if none is listening
      -> daemon.js     long-lived process: Unix-socket JSON-RPC server,
                        owns one TaskManager, dispatches event.subscribe
        -> tasks.js      the task lifecycle: dispatch/cancel/status/poll/
                          list/result/tail/summarize/advisor, state
                          persistence, watchdogs, queueing
        -> protocol.js   RPC envelope shape, PROTOCOL_VERSION, method list
        -> events.js     per-daemon event sequencing/emission for watch
        -> activity.js   cached narration-to-summary snapshots (the model
                          call behind --mode activity / watch --summaries)
        -> state-lock.js cross-process file lock; also guards
                          persistTask()'s writes, which run on every
                          dispatch/cancel/settlement
  -> output.js     TOON formatting, lean field projection, MCP-era hint
                    migration (taskferry_dispatch -> taskferry dispatch)
opencode-plugin.js  native OpenCode plugin: calls client.js directly,
                     not through cli.js
```

`src/tasks.js` (3450 lines) is the largest file by a wide margin and does
the real work; everything above it is thin. If a bug report doesn't
obviously belong to args parsing or output formatting, start there.

## File-by-file

| File | Lines | Responsibility |
|---|---|---|
| `cli.js` | 178 | Entrypoint. Direct-execution guard (`fs.realpathSync(argv[1]) === import.meta.url`, symlink-safe) so it's importable without side effects. |
| `args.js` | 513 | Per-command flag specs, defaults, validation. Rejects retired MCP-era names (`poll`, `--task-id`, `--timeout_ms`) with a rename hint. `dispatch` exposes `--no-overlay`; `advisor` deliberately does not — overlay is mandatory for the advisor role per ADR 0001, so passing `taskferry advisor --no-overlay` errors with the standard "unknown flag" UsageError at parse time. `advisor` accepts `--summarize-context` (boolean; off by default) which triggers commands.js's throwaway-model condensation of the auto-attached context. `result` exposes `--diff` (mutually exclusive with both `--fields` and `--full` — the latter was the pre-fix silent-drop regression where the if/else-if chain in commands.js picked `fields:["diff"]` and lost `--full`); `doctor` exposes `--stats` (boolean, off by default, mutually exclusive with `--full` at parse time); `accept`/`reject` are no-flag, positional-only commands. |
| `commands.js` | 592 | One function per command; the only place that calls `client.request`/`client.subscribe`. Module-scope advisor-context helpers `resolveAdvisorContextChars()`/`claudeTranscriptPath()`/`readTailChars()` (env → config → 120000 default resolution; Claude Code project-slug transcript path; tail-N-code-points file read with a `UsageError` on unreadable transcripts) are exported for the advisor command to wire in. `summarizeContextText()` (module-scope; not exported) is the best-effort throwaway `task.dispatch`/`task.wait`/`task.result` condensation used when `advisor --summarize-context` is set — returns the input text unchanged on any failure so condensation can never break an otherwise-valid advisor call, and uses `env.TASKFERRY_ADVISOR_SUMMARIZER_MODEL` (fallback `opencode/mimo-v2.5-free`) so the summarizer is env-overridable. The `summary` command omits `env` from the RPC payload when `--mode activity` is set, since the activity path reads the cached task activity and spawns nothing — protocol.js rejects the combination for direct RPC callers as a validation error. `dispatch` forwards `noOverlay`; `advisor` does not (advisor's args.js spec excludes `--no-overlay`, so the field is unreachable from the CLI; protocol.js's `task.advisor` `hasOnly` set also rejects the key for raw RPC callers). `result --diff` selects `fields: ["diff"]` and overrides `--fields`; the `result --diff --full` combination is rejected at parse time by args.js (the if/else-if chain below is now deterministic under that gate). `accept`/`reject` call `task.accept`/`task.reject` and surface `cleanupFailed` as a stderr warning so a leftover overlay isn't invisible until the daemon-restart sweep. `doctor --stats` skips the environment-check `Promise.allSettled` block entirely, calls `task.list` directly, and returns `computeDoctorStats()`'s output unwrapped (no `integrations`/`warnings`/`info`). |
| `client.js` | 368 | Daemon connection, auto-spawn-on-first-use, request/response correlation by id, `subscribe()` for events. |
| `daemon.js` | 462 | `net.createServer`, one socket per client, request dispatch loop, `event.subscribe` bookkeeping, stale-socket takeover logic (`prepareSocket`). `invoke()` forwards the whole validated params object to `manager.dispatch`/`summarize`/`advisor` — task.summary/task.advisor used to rebuild a field list here, which silently dropped newly-added fields (the env-forwarding fix had to be its own commit because of it); matching task.dispatch's pattern means new fields ride through without a daemon.js change. `invoke()` also routes validated `task.accept`/`task.reject` requests to the task manager's `accept()`/`reject()` methods. |
| `tasks.js` | 3470 | `createTaskManager()`: dispatch, cancel, accept/reject, status, poll (`wait`'s RPC target), list, result (including cached diff/diffStat projection -- diffStat routed through `git apply --numstat` via the runOverlayCommandFn delegate so the same parser handles both git and non-git changesets, with a zero-stat fallback on any non-zero git exit status -- `git apply --numstat` exits 0 on success and any non-zero status indicates a failed parse, so partial stdout from a failed invocation is never read; the zero fallback is the documented "stat is uncomputable" path), tail, summarize, advisor, conditional changeset-field summary exposure, state persistence (`tasks.json`), the no-output watchdog, queueing/concurrency caps, caller-env union sanitization (three-layer merge -- `envFileVars` loaded once from `envFilePath` via `env-file.js`'s `loadEnvFile()`, below the daemon's own ambient `process.env`, below the caller's forwarded env) and denylist enforcement, filesystem `sandboxDenylist` merged with `sandbox.js`'s fixed default deny-list at every bwrap call site (dispatch launch, changeset extraction, changeset apply), in-`sanitizedEnvironment` env-key validation (mirrors the RPC-level `isEnvironment` check so programmatic callers can't bypass it), dispatch-time env snapshot (clone of caller env, the b45de81 defence against caller mutations between queue time and spawn -- pinned by a verification-gate test, see BLOCKED in commit history), summary-path env deferred to spawn time (so the spawned summary child sees the daemon's current process.env, matching dispatch's deferred `dispatchEnvironment()`), per-caller-env models cache (`modelsCache` keyed by a fingerprint of model-relevant caller vars (`*_API_KEY`, `*_BASE_URL`, `OPENCODE_CONFIG*`, `OPENCODE_AUTH_CONTENT`, `OPENCODE_MODELS_PATH`/`_URL`, `PI_CODING_AGENT_DIR`), not time alone, so callers with different credentials or catalog/endpoint overrides don't read each other's listings, plus an in-flight `Map` to coalesce concurrent populates for the same key), daemon-startup orphan overlay sweep across both the live tmp root and every creation-time tmp root persisted on a task, centralized overlay release/cleanup-failure tracking, plus overlay-enabled wiring (`overlayEnabled`/`checkOverlaySupportFn`/`overlayTmpRoot`/`rmOverlayTreeFn` options, `requireOverlaySupport()` capability check with a 60s TTL on negative probe results so a transient bwrap failure (PATH mid-update, version-too-old mid-upgrade) can self-heal without a daemon restart -- a positive result is cached forever since no transient issue would flip it back, `noOverlay`/`role` dispatch params, `role`/`changesetStatus`/`diffPath`/`overlayDirs` (including creation-time `tmpRoot`)/`preDispatchHead`/`changesetError` task-record fields), spawn-path overlay construction (CoW overlay on `directory` when `overlayEnabled && checkOverlaySupportFn().supported`, with the per-path git-common-dir sub-overlays persisted on `task.overlayDirs.rwBinds` for extraction to re-mount verbatim -- review finding #1, and writable git-common-dir FILES like `packed-refs` -- which overlayfs can't mount, being directory-only -- routed instead through `subFilePaths()`/`overlayRwFileBinds`: a scratch copy bound rw onto the host path, persisted on `task.overlayDirs.rwFileBinds` for extraction to re-mount the same way), `preDispatchHead` resolved through the injected `runOverlayCommandFn` delegate (not a direct subprocess call) so the same test fakes that cover settlement-time extraction cover the dispatch-time git probe too, the `child.on("error")` (spawn-failure) path AND the synchronous try/catch around the `spawnFn` / overlay-setup / pre-dispatch-HEAD block both run the same `extractChangesetForTask()` the exit path does -- so a task whose overlay was already created before spawn fails (whether asynchronously via `child.emit("error", ...)` or synchronously via a throwing `spawnFn` / `resolvePreDispatchHead`) is never stranded with no extraction and no cleanup (final-review fix: the sync catch was originally missing the extract call, leaving overlayDirs set + changesetStatus === "pending"; the startup sweep deliberately skips pending owners so the overlay sat on the tmpfs indefinitely), advisor-role spawn isolation via `runtimeDirWritable: false` so the daemon's Unix socket inside runtimeDir is unreachable from the sandbox (review finding #6) -- advisor keeps `shareNet` at its default (network shared), since `--unshare-net` blocks all outbound network including the model-provider API calls the advisor role itself depends on, not just the daemon socket (fixed after shipping unshare-net'd advisors that could never reach a provider), advisor fail-closed when overlay-gating can't be established -- at dispatch-launch time a sandbox that is force-disabled (`--no-sandbox`/`TASKFERRY_DISABLE_SANDBOX=1`) or unsupported on the platform crashes with a `spawnError` rather than running unguarded, and inside the sandbox block an advisor with overlay globally disabled crashes likewise (review finding #5), accept() verifies the recorded diff file at `task.diffPath` still exists on disk before handing it to git apply (review finding #1 -- a partial stateDir cleanup or a tampered tasks.json would otherwise surface as a misleading `git apply` "can't open patch" message), and accept()/reject() persist `changesetStatus` to disk before the overlay cleanup so a crash between apply and cleanup can't leave the task reading as "pending" after a restart when the patch was already applied (review finding #4 -- the pre-fix order was persist-after-cleanup, which narrowed the window to a double-apply risk on retry), and on successful cleanup each path persists a second time so the durable task record reflects the cleared `overlayDirs` and doesn't keep claiming an overlay still exists for an overlay that was just removed (review followup #1 -- on cleanup failure the second persist is skipped so the persisted `overlayDirs` survives for the daemon-startup sweep to retry), and settlement-time boot-failure surfacing (`extractBootFailureDetail`/`logHasAnyEvent`: an eventless non-zero exit gets a `boot_failure` bucket whose `failureDetail` is the last captured `Error:` line, plus a `tail()` fallback that shows the raw capture for eventless crashed tasks instead of `none observed yet`). |
| `protocol.js` | 269 | `PROTOCOL_VERSION`, `RPC_METHODS`, request/response/error envelope encode/decode, method-name-to-manager-function mapping, `isEnvironment` env-param predicate, the task.summary `mode: "activity"` ↔ `env` rejection (the activity path reads cached task activity and spawns nothing, so caller env has no process to land in — surfacing the combination as `INVALID_PARAMS` rather than silently dropping it). `task.dispatch`'s `hasOnly` set accepts `noOverlay`; `task.advisor`'s deliberately does NOT (overlay is mandatory for the advisor role per ADR 0001 — the `hasOnly` set is the raw-RPC equivalent of args.js's parse-time rejection). `task.tail`'s `chars` ceiling is 131072 (raised from 65536 to fit advisor's default 120k-char context budget). |
| `events.js` | 57 | Assigns a monotonic sequence number to each emitted event; that's the whole file. |
| `activity.js` | 346 | `activityCacheKey`/cache `refresh()`: bounded head+tail narration snapshot, optional model-summary call, min-interval throttling. |
| `state-lock.js` | 84 | `withFileLock()`: synchronous, `Atomics.wait`-based cross-process exclusive lock; guards the daemon auto-start race and every `persistTask()` write (dispatch/cancel/settlement — the request hot path). |
| `output.js` | 253 | TOON encoding, `leanStatus`/`leanResult`/`projectList`/`homeView`, hint-string MCP-name migration. `leanStatus()` surfaces `changesetStatus: "pending"` (and `changesetError`) on a non-`--full` `status`/`wait` response when the settled task has one, so an `accept`/`reject` next-step is visible without `--full`. |
| `opencode-plugin.js` | 174 | OpenCode's native plugin surface: toasts on task state transitions by subscribing to daemon task-state events through `client.js`. |
| `executor.js` | 217 | `WorkerExecutor` abstraction: `opencodeExecutor()`/`piExecutor()` build each CLI's spawn args, summary prompt, log-event normalization, and sandboxed auth-file binding. Both executor objects expose a summary-prompt method, but `tasks.js` currently hardcodes every summary task's `executorId` to `"opencode"` regardless of the originating dispatch's executor — `piExecutor()`'s summary support is unused in practice. |
| `sandbox.js` | 276 | `bwrap` mount layout: read-only root bind, deny-list (`~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.config/gh`, `~/.gnupg`, `~/.claude`, extendable per-install via `TASKFERRY_SANDBOX_DENYLIST`/`sandboxDenylist`, merged with the fixed defaults in `tasks.js`), `allowedDirs` merging, `resolveGitCommonDir`/`resolveGitDir` for worktree gitdir resolution, `checkOverlaySupport` (bwrap >= 0.8 probe), `buildBwrapBaseArgs()` emits the shared prefix (`--ro-bind / /`, `--proc /proc`, `--dev /dev`, `--tmpfs /tmp`, then one `--tmpfs` per denied path) that both `buildBwrapArgs()` (sandboxed dispatch) and `buildMergedViewBwrapArgs()` in `changeset.js` (changeset extraction/apply) start from, `buildBwrapArgs()` opts in to a copy-on-write overlay on `directory` via the `overlay`/`overlayRwBinds` params (mounted with `--overlay-src`/`--overlay`; bwrap >= 0.8 required), plus `overlayRwFileBinds` for writable files outside `directory` (each bound rw with a plain `--bind` right after the overlay binds, since overlayfs mounts are directory-only), `shareNet` flag (default true; every caller, including advisor, keeps `--share-net` -- the sandboxed worker CLI needs outbound network to reach its model provider, and `--unshare-net` blocked that entirely when advisor briefly passed `shareNet: false`), and `runtimeDirWritable` flag (default true; advisor-role dispatches pass false so the daemon's Unix socket inside runtimeDir is read-only and `connect()` fails). The actual bind-scoping decision (worktree-private gitdir + common dir's shared data only, not the whole common dir) lives in `tasks.js`, not here — see taskferry#224/#227. |
| `changeset.js` | 349 | Overlay path helpers (`subOverlayPaths()` for directory sub-overlays, `subFilePaths()` for the scratch-copy rw bind a writable FILE like a worktree's `packed-refs` needs instead, since overlayfs mounts are directory-only), pre-dispatch HEAD resolution (unborn HEAD anchors on the empty tree), git/non-git diff extraction from the CoW overlay (fail-closed on extraction failure, and on HEAD drift -- `extractGitDiff()` re-resolves `directory`'s current HEAD via `resolvePreDispatchHead()` before extracting, and refuses if it no longer matches `preDispatchHead`, since `directory` is a live bind and a checkout/branch change there since dispatch would otherwise make the diff compare the wrong trees silently -- see taskferry#261), changeset apply (git apply for git targets, in-sandbox rsync --delay-updates for non-git, with required live-overlay inputs validated before a non-git apply), and overlay cleanup (plain removal with a containment guard refusing roots outside the overlay tmp root). Also exports `defaultRunCommand`, the 30s diff/apply runner that's deliberately separate from sandbox.js's 5s version-probe runner. `buildMergedViewBwrapArgs()` mounts the overlay's merged view on a synthetic mountpoint under /tmp so a non-git extraction can `diff -ruN` `directory` against its own merged view; the overlay paths (`upperDir`/`workDir`/`mergedMountPoint`, all under /tmp by construction) need no explicit /tmp-shadowing protection — `upperDir`/`workDir` are host-namespace paths consumed by the kernel's overlay `mount(2)` and bypass the bwrap namespace's mounts, and `mergedMountPoint` is intentionally created under the bwrap tmpfs before being overlay-mounted — shares its scaffolding with `buildBwrapArgs()` via `sandbox.js`'s `buildBwrapBaseArgs()`. |
| `config.js` | 84 | `loadConfig()`: reads/validates `config.json` against `CONFIG_FIELD_TYPES`, rejects unrecognized keys. `advisorContextChars` controls advisor's auto-attached context budget. `envFile` names the path `tasks.js` loads via `env-file.js`'s `loadEnvFile()`. |
| `env-file.js` | 93 | `parseEnvFile()`/`loadEnvFile()`: minimal `.env`-style parser (`NAME=VALUE` per line, `#` comments, optional `export `, matching single/double quotes stripped) for the file named by `TASKFERRY_ENV_FILE`/`envFile`. Throws with a file:line-numbered message on a malformed line or (in `loadEnvFile()`) a missing file — `tasks.js` calls this once at `createTaskManager()` construction, so a bad path or malformed file fails daemon startup loudly rather than silently dispatching without the secrets it was meant to supply. |
| `mcp-isolation.js` | 107 | Playwright MCP isolation checks for `taskferry doctor`/`setup` (`opencode.jsonc`, Claude Code's Playwright MCP config). |
| `doctor-stats.js` | 126 | `computeDoctorStats()`: pure aggregation of `task.list` rows into the `doctor --stats` report shape — status mix (overall/24h/7d), per-model dispatch/rate breakdown, failure-reason histogram, unknown backlog, and 24h crash-rate trend. |
| `paths.js` | 123 | Resolves `TASKFERRY_STATE_DIR`/`TASKFERRY_RUNTIME_DIR`/`TASKFERRY_CACHE_DIR` and the socket path from XDG defaults + env overrides. Exports `TASKFERRY_PLUMBING_ENV_VARS` (frozen array of those four names) so `tasks.js` builds its caller-env exclusion set from the same source of truth — a new plumbing var added here lands in the exclusion set automatically. Also `resolveWorkspaceRoot()`: the git workspace root (handles plain repo/worktree/submodule/bare-repo layouts) that `list`/`watch`/`context`/`home` default `--directory` to — `dispatch`/`advisor` deliberately keep their default on literal cwd instead, since that value doubles as the sandbox root. |
| `narration-format.js` | 24 | Formats a task's narration/activity text for display. |
| `errors.js` | 20 | Shared error-message helpers. |
| `numbers.js` | 14 | Shared numeric-parsing helpers (`positiveInteger`, `nonNegativeInteger`, etc.). |
| `setup.js` | 268 | `taskferry setup`: npm install, managed symlinks, per-client integration registration (see `.superpowers/.completed/specs/2026-07-16-taskferry-setup-design.md`). |
| `tf-sl.sh` | 113 | `tf-sl` Claude Code statusline segment: reads the statusline JSON from stdin, emits a width-responsive `tf: ...` ANSI segment or nothing. Always calls `taskferry` with `TASKFERRY_AUTO_START=0` — a statusline poll must never be the call that boots the daemon, since the daemon inherits its first caller's env for its whole lifetime. |
| `scripts/generate-skill.js` | — | Regenerates `integrations/*/skills/using-taskferry/SKILL.md` from `skills/using-taskferry/SKILL.md`; `--check` fails on drift. The two generated copies are committed, not gitignored — they're what the Claude Code and Codex plugin marketplaces actually read (`integrations.test.js` pins the plugin `source` to those exact paths), so a missing or stale copy ships wrong skill content to real installs, not just a rebuildable artifact. |

Most `*.js` files above have a co-located `*.test.js` (`node --test`, no
framework) — `mcp-isolation.js`, `narration-format.js`,
`errors.js`, and `numbers.js` are the current exceptions.
`smoke-test.js`/`cancel-smoke-test.js`/`poll-smoke-test.js` are
integration tests that spawn a real daemon (`npm run test:integration`,
not part of the default `npm test`).

## Where do I look for X?

| Question | Look here |
|---|---|
| What does this CLI flag do? | `docs/cli-reference.md` |
| Why did a task crash / how do I read `failureReason`? | `docs/troubleshooting.md`, `docs/daemon.md#watchdogs` |
| Where is a pending overlay changeset accepted or rejected? | `daemon.js`'s `invoke()` RPC routing; `tasks.js`'s `accept()`/`reject()`; `changeset.js`'s `applyChangeset()`/`cleanupOverlay()` |
| Daemon lifecycle, socket resolution, protocol envelope | `docs/daemon.md` |
| What does the daemon pass to a worker's environment? | `tasks.js`'s `sanitizedEnvironment()`/`dispatchEnvironment()`/`summaryEnvironment()`; the `envFile`/`TASKFERRY_ENV_FILE` base layer is loaded once via `env-file.js`'s `loadEnvFile()` |
| What does the daemon send to a summary model, how to disable it | `docs/security.md` |
| Retired MCP tool names / flags | `docs/migrating-from-mcp.md` |
| Per-agent (Claude Code/Codex/OpenCode) setup | `docs/integrations/*.md` |
| Open design questions, past decisions, what's left to build or deliberately skipped | `.superpowers/specs/*.md`, `.superpowers/plans/*.md` (implemented ones move to `.superpowers/.completed/`) |
| The canonical agent-facing skill (regenerate after any CLI-surface change) | `skills/using-taskferry/SKILL.md`, then `npm run skill:generate` |
| User-tunable options via a JSON config file (as an alternative to env vars) | `docs/config.md` |
| Why `list`/`watch`/`context`/`home` default to the git workspace root but `dispatch`/`advisor` don't | `docs/cli-reference.md`, `paths.js`'s `resolveWorkspaceRoot()` |
| Advisor's auto-attached context budget / Claude transcript path resolution | `commands.js`'s `resolveAdvisorContextChars()`/`claudeTranscriptPath()`/`readTailChars()` |
| Advisor `--summarize-context` condensation path (throwaway dispatch+wait+result, best-effort) | `commands.js`'s `summarizeContextText()`, gated on `args.js`'s `--summarize-context` boolean |
| `watch --flush-interval` batching, Monitor auto-arm convention | `docs/cli-reference.md` |

## Env vars

All `TASKFERRY_*` vars the daemon or CLI reads, gathered in one place
(individual docs above cover behavior; this is just the index):

Vars marked "config.json" also have a config-file equivalent — see
`docs/config.md` — where the env var, if set, still takes precedence.

| Var | Default | Config file? | Purpose |
|---|---|---|---|
| `TASKFERRY_STATE_DIR` | `$XDG_STATE_HOME/taskferry` or `~/.local/state/taskferry` | no | Task state, logs, summary prompts |
| `TASKFERRY_RUNTIME_DIR` | `$XDG_RUNTIME_DIR/taskferry`, or `/run/user/<uid>/taskferry` if that var is merely unexported but the dir exists, or `<state-dir>/run` | no | Socket + lock files |
| `TASKFERRY_SOCKET_PATH` | `<runtime-dir>/daemon.sock` | no | Explicit socket override |
| `TASKFERRY_CACHE_DIR` | `$XDG_CACHE_HOME/taskferry` or `~/.cache/taskferry` | no | Real-disk data home for sandboxed workers (opencode/pi auth + unbounded snapshot caches); see `docs/security.md` |
| `TASKFERRY_AUTO_START` | `1` (auto-start enabled) | no | Set to `0` to stop the CLI from auto-spawning a daemon on first use |
| `TASKFERRY_DISABLE_SANDBOX` | `0` (sandboxed on Linux) | yes (`sandboxEnabled`, inverted) | Set to `1`/`true` to run dispatches without the bwrap filesystem sandbox |
| `TASKFERRY_DISABLE_OVERLAY` | `0` (overlay enabled) | yes (`overlayEnabled`, inverted) | Set to `1`/`true` to disable the CoW overlay for dispatch writes |
| `TASKFERRY_ALLOWED_DIRS` | — | yes | Extra directories bound read-write inside the sandbox for every dispatch; see `docs/security.md` |
| `TASKFERRY_CANCEL_GRACE_MS` | `5000` | yes | Default SIGTERM→SIGKILL grace period for `cancel`, overridden per-call by `--grace-ms` |
| `TASKFERRY_DEFAULT_EXECUTOR` | `pi` | yes | Default `--executor` (`opencode` or `pi`) when a dispatch/advisor call omits it |
| `TASKFERRY_MAX_CONCURRENT_TASKS` | `4` | yes | Running-task concurrency cap |
| `TASKFERRY_MAX_DISPATCHES_PER_WINDOW` / `TASKFERRY_DISPATCH_WINDOW_MS` | `2` / `5000` | yes | Dispatch burst-rate limit |
| `TASKFERRY_ENV_DENYLIST` | — | yes (`envDenylist`) | Comma-separated environment variable names stripped from spawned children after caller-env forwarding |
| `TASKFERRY_ENV_FILE` | — | yes (`envFile`) | Path to a `.env`-style file loaded once at daemon startup and unioned in as the lowest-priority layer of every spawned child's environment, below the daemon's ambient env and the caller's forwarded env; see `docs/security.md#caller-env-forwarding` |
| `TASKFERRY_SANDBOX_DENYLIST` | — | yes (`sandboxDenylist`) | Comma-separated extra directories tmpfs-masked inside the bwrap sandbox, merged with (not replacing) the fixed default deny-list; see `docs/security.md` |
| `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` | `256000` (~4.3 min) | yes | Pre-output-seen watchdog deadline |
| `TASKFERRY_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS` | `400000` (~6.7 min) | yes | Watchdog deadline once a task has produced its first log event |
| `TASKFERRY_WATCHDOG_POLL_MS` | `2000` | no | Watchdog check interval |
| `TASKFERRY_WATCHDOG_GRACE_MS` | `5000` | yes | SIGTERM→SIGKILL escalation grace period when the watchdog force-stops a task (same override surface as `cancel`'s `--grace-ms`, but for watchdog-triggered stops) |
| `TASKFERRY_SUMMARY_MODEL` | `opencode/mimo-v2.5-free` | yes | Model behind `summary --mode report` |
| `TASKFERRY_ACTIVITY_SUMMARIES` | `true` | yes | Enables `watch --summaries` / activity-style model calls |
| `TASKFERRY_SUMMARIZER_TIMEOUT_MS` | `360000` (6 min) | yes | Throttle between activity-summary model calls |
| `TASKFERRY_ACTIVITY_MAX_WORDS` | `75` | yes | Max words in an activity-style summary |
| `TASKFERRY_ADVISOR_SESSION_TTL_MS` | `1800000` (30 min) | yes | Advisor session idle expiry before auto-reset |
| `TASKFERRY_WAIT_DEFAULT_TIMEOUT_MS` | `900000` (15 min) | yes | Default timeout for `wait` and `summary --wait`; set to `0` to disable |
| `TASKFERRY_ADVISOR_CONTEXT_CHARS` | `120000` | yes | Advisor auto-attached context budget in chars; env var wins over config file's `advisorContextChars` |
| `TASKFERRY_ADVISOR_SUMMARIZER_MODEL` | `opencode/mimo-v2.5-free` | no | Model used by `advisor --summarize-context` to condense the auto-attached context; falls back to the constant in `commands.js` when unset |
| `TASKFERRY_CHILD` | — | no | Set on the daemon's own spawned children; see `docs/security.md` |

## Things that look like bugs but aren't

- `status: "unknown"` after a daemon restart — expected; see
  `docs/daemon.md#recovery`. There is deliberately no re-attachment to
  already-running child processes.
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
  landed) and no tasks were running/queued; see
  `docs/daemon.md#self-restart-on-source-change`.
- Editing `TASKFERRY_ENV_FILE`'s target file (or the `envFile` config key, or
  the running daemon's own launch environment) and a spawned worker still not
  seeing the new/changed var — expected. `envFileVars` is loaded once via
  `env-file.js`'s `loadEnvFile()` at `createTaskManager()` construction (daemon
  startup), same as `envDenylist` and the other config-file-backed options;
  restart the daemon to pick up a changed file or path. This is unlike a
  caller-forwarded key, which does take effect immediately on the very next
  `dispatch`/`advisor`/`summary` call with no restart (see
  `docs/security.md#caller-env-forwarding`) — the two mechanisms solve
  different problems and have different freshness guarantees on purpose.
- A pending changeset listing files the worker never touched — expected when
  the dispatch directory had untracked files at dispatch time. Git-target
  extraction stages the overlay's whole merged view (`git add -A && git diff
  --cached <pre-dispatch HEAD>`, `changeset.js`'s `extractGitDiff`) so
  pre-existing untracked files surface as new-file entries alongside the
  worker's own writes. `accept` runs a plain `git apply`, which fails
  outright when those paths already exist in the working tree — blocking the
  worker's real changes too — so commit or shelve untracked files before
  dispatching against a dirty tree. Non-git targets are unaffected: their
  extraction diffs the directory against the merged view, so untouched files
  never appear.
