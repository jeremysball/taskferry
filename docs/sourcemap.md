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

`src/tasks.js` (2606 lines) is the largest file by a wide margin and does
the real work; everything above it is thin. If a bug report doesn't
obviously belong to args parsing or output formatting, start there.

## File-by-file

| File | Lines | Responsibility |
|---|---|---|
| `cli.js` | 152 | Entrypoint. Direct-execution guard (`fs.realpathSync(argv[1]) === import.meta.url`, symlink-safe) so it's importable without side effects. |
| `args.js` | 418 | Per-command flag specs, defaults, validation. Rejects retired MCP-era names (`poll`, `--task-id`, `--timeout_ms`) with a rename hint. |
| `commands.js` | 315 | One function per command; the only place that calls `client.request`/`client.subscribe`. |
| `client.js` | 368 | Daemon connection, auto-spawn-on-first-use, request/response correlation by id, `subscribe()` for events. |
| `daemon.js` | 459 | `net.createServer`, one socket per client, request dispatch loop, `event.subscribe` bookkeeping, stale-socket takeover logic (`prepareSocket`). |
| `tasks.js` | 2606 | `createTaskManager()`: dispatch, cancel, status, poll (`wait`'s RPC target), list, result, tail, summarize, advisor, state persistence (`tasks.json`), the no-output watchdog, queueing/concurrency caps, key-slot env stripping. |
| `protocol.js` | 220 | `PROTOCOL_VERSION`, `RPC_METHODS`, request/response/error envelope encode/decode, method-name-to-manager-function mapping. |
| `events.js` | 57 | Assigns a monotonic sequence number to each emitted event; that's the whole file. |
| `activity.js` | 346 | `activityCacheKey`/cache `refresh()`: bounded head+tail narration snapshot, optional model-summary call, min-interval throttling. |
| `state-lock.js` | 84 | `withFileLock()`: synchronous, `Atomics.wait`-based cross-process exclusive lock; guards the daemon auto-start race and every `persistTask()` write (dispatch/cancel/settlement — the request hot path). |
| `output.js` | 248 | TOON encoding, `leanStatus`/`leanResult`/`projectList`/`homeView`, hint-string MCP-name migration. |
| `opencode-plugin.js` | 174 | OpenCode's native plugin surface: toasts on task state transitions by subscribing to daemon task-state events through `client.js`. |
| `executor.js` | 217 | `WorkerExecutor` abstraction: `opencodeExecutor()`/`piExecutor()` build each CLI's spawn args, summary prompt, log-event normalization, and sandboxed auth-file binding. Both executor objects expose a summary-prompt method, but `tasks.js` currently hardcodes every summary task's `executorId` to `"opencode"` regardless of the originating dispatch's executor — `piExecutor()`'s summary support is unused in practice. |
| `sandbox.js` | 138 | `bwrap` mount layout: read-only root bind, deny-list (`~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.config/gh`, `~/.gnupg`), `allowedDirs` merging, git-common-dir binding for worktrees. |
| `config.js` | 86 | `loadConfig()`: reads/validates `config.json` against `CONFIG_FIELD_TYPES`, rejects unrecognized keys. |
| `mcp-isolation.js` | 107 | Playwright MCP isolation checks for `taskferry doctor`/`setup` (`opencode.jsonc`, Claude Code's Playwright MCP config). |
| `paths.js` | 50 | Resolves `TASKFERRY_STATE_DIR`/`TASKFERRY_RUNTIME_DIR`/`TASKFERRY_CACHE_DIR` and the socket path from XDG defaults + env overrides. |
| `narration-format.js` | 24 | Formats a task's narration/activity text for display. |
| `errors.js` | 20 | Shared error-message helpers. |
| `numbers.js` | 14 | Shared numeric-parsing helpers (`positiveInteger`, `nonNegativeInteger`, etc.). |
| `setup.js` | 268 | `taskferry setup`: npm install, managed symlinks, per-client integration registration (see `.superpowers/.completed/specs/2026-07-16-taskferry-setup-design.md`). |
| `tf-sl.sh` | 109 | `tf-sl` Claude Code statusline segment: reads the statusline JSON from stdin, emits a width-responsive `tf: ...` ANSI segment or nothing. |
| `scripts/generate-skill.js` | — | Regenerates `integrations/*/skills/using-taskferry/SKILL.md` from `skills/using-taskferry/SKILL.md`; `--check` fails on drift. The two generated copies are committed, not gitignored — they're what the Claude Code and Codex plugin marketplaces actually read (`integrations.test.js` pins the plugin `source` to those exact paths), so a missing or stale copy ships wrong skill content to real installs, not just a rebuildable artifact. |

Most `*.js` files above have a co-located `*.test.js` (`node --test`, no
framework) — `mcp-isolation.js`, `paths.js`, `narration-format.js`,
`errors.js`, and `numbers.js` are the current exceptions.
`smoke-test.js`/`cancel-smoke-test.js`/`poll-smoke-test.js` are
integration tests that spawn a real daemon (`npm run test:integration`,
not part of the default `npm test`).

## Where do I look for X?

| Question | Look here |
|---|---|
| What does this CLI flag do? | `docs/cli-reference.md` |
| Why did a task crash / how do I read `failureReason`? | `docs/troubleshooting.md`, `docs/daemon.md#watchdogs` |
| Daemon lifecycle, socket resolution, protocol envelope | `docs/daemon.md` |
| What does the daemon send to a summary model, how to disable it | `docs/security.md` |
| Retired MCP tool names / flags | `docs/migrating-from-mcp.md` |
| Per-agent (Claude Code/Codex/OpenCode) setup | `docs/integrations/*.md` |
| Open design questions, past decisions, what's left to build or deliberately skipped | `.superpowers/specs/*.md`, `.superpowers/plans/*.md` (implemented ones move to `.superpowers/.completed/`) |
| The canonical agent-facing skill (regenerate after any CLI-surface change) | `skills/using-taskferry/SKILL.md`, then `npm run skill:generate` |
| User-tunable options via a JSON config file (as an alternative to env vars) | `docs/config.md` |

## Env vars

All `TASKFERRY_*` vars the daemon or CLI reads, gathered in one place
(individual docs above cover behavior; this is just the index):

Vars marked "config.json" also have a config-file equivalent — see
`docs/config.md` — where the env var, if set, still takes precedence.

| Var | Default | Config file? | Purpose |
|---|---|---|---|
| `TASKFERRY_STATE_DIR` | `$XDG_STATE_HOME/taskferry` or `~/.local/state/taskferry` | no | Task state, logs, summary prompts |
| `TASKFERRY_RUNTIME_DIR` | `$XDG_RUNTIME_DIR/taskferry` or `<state-dir>/run` | no | Socket + lock files |
| `TASKFERRY_SOCKET_PATH` | `<runtime-dir>/daemon.sock` | no | Explicit socket override |
| `TASKFERRY_CACHE_DIR` | `$XDG_CACHE_HOME/taskferry` or `~/.cache/taskferry` | no | Real-disk data home for sandboxed workers (opencode/pi auth + unbounded snapshot caches); see `docs/security.md` |
| `TASKFERRY_AUTO_START` | `1` (auto-start enabled) | no | Set to `0` to stop the CLI from auto-spawning a daemon on first use |
| `TASKFERRY_DISABLE_SANDBOX` | `0` (sandboxed on Linux) | yes (`sandboxEnabled`, inverted) | Set to `1`/`true` to run dispatches without the bwrap filesystem sandbox |
| `TASKFERRY_ALLOWED_DIRS` | — | yes | Extra directories bound read-write inside the sandbox for every dispatch; see `docs/security.md` |
| `TASKFERRY_CANCEL_GRACE_MS` | `5000` | yes | Default SIGTERM→SIGKILL grace period for `cancel`, overridden per-call by `--grace-ms` |
| `TASKFERRY_DEFAULT_EXECUTOR` | `pi` | yes | Default `--executor` (`opencode` or `pi`) when a dispatch/advisor call omits it |
| `TASKFERRY_MAX_CONCURRENT_TASKS` | `4` | yes | Running-task concurrency cap |
| `TASKFERRY_MAX_DISPATCHES_PER_WINDOW` / `TASKFERRY_DISPATCH_WINDOW_MS` | `2` / `5000` | yes | Dispatch burst-rate limit |
| `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` | `256000` (~4.3 min) | yes | Pre-output-seen watchdog deadline |
| `TASKFERRY_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS` | `400000` (~6.7 min) | yes | Watchdog deadline once a task has produced its first log event |
| `TASKFERRY_WATCHDOG_POLL_MS` | `2000` | no | Watchdog check interval |
| `TASKFERRY_WATCHDOG_GRACE_MS` | `5000` | yes | SIGTERM→SIGKILL escalation grace period when the watchdog force-stops a task (same override surface as `cancel`'s `--grace-ms`, but for watchdog-triggered stops) |
| `TASKFERRY_KEY_SLOTS` | — | yes | Named provider-key slot registry; see `docs/security.md` |
| `TASKFERRY_PROVIDER_KEY_ENV` | — | yes | Source env var a key slot copies from |
| `TASKFERRY_SUMMARY_MODEL` | `opencode/mimo-v2.5-free` | yes | Model behind `summary --mode report` |
| `TASKFERRY_SUMMARY_KEY_SLOT` / `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV` | — | yes | Key-slot wiring specific to the summary model |
| `TASKFERRY_ACTIVITY_SUMMARIES` | `true` | yes | Enables `watch --summaries` / activity-style model calls |
| `TASKFERRY_SUMMARIZER_TIMEOUT_MS` | `360000` (6 min) | yes | Throttle between activity-summary model calls |
| `TASKFERRY_ACTIVITY_MAX_WORDS` | `75` | yes | Max words in an activity-style summary |
| `TASKFERRY_ADVISOR_SESSION_TTL_MS` | `1800000` (30 min) | yes | Advisor session idle expiry before auto-reset |
| `TASKFERRY_WAIT_DEFAULT_TIMEOUT_MS` | `900000` (15 min) | yes | Default timeout for `wait` and `summary --wait`; set to `0` to disable |
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
