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
                          call behind --style activity / watch --summaries)
        -> state-lock.js cross-process file lock (daemon auto-start race,
                          not used in the request hot path)
  -> output.js     TOON formatting, lean field projection, MCP-era hint
                    migration (taskferry_dispatch -> taskferry dispatch)
opencode-plugin.js  native OpenCode plugin: calls client.js directly,
                     not through cli.js
```

`src/tasks.js` (1722 lines) is the largest file by a wide margin and does
the real work; everything above it is thin. If a bug report doesn't
obviously belong to args parsing or output formatting, start there.

## File-by-file

| File | Lines | Responsibility |
|---|---|---|
| `cli.js` | 121 | Entrypoint. Direct-execution guard (`fs.realpathSync(argv[1]) === import.meta.url`, symlink-safe) so it's importable without side effects. |
| `args.js` | 398 | Per-command flag specs, defaults, validation. Rejects retired MCP-era names (`poll`, `--task-id`, `--timeout_ms`) with a rename hint. |
| `commands.js` | 159 | One function per command; the only place that calls `client.request`/`client.subscribe`. |
| `client.js` | 301 | Daemon connection, auto-spawn-on-first-use, request/response correlation by id, `subscribe()` for events. |
| `daemon.js` | 395 | `net.createServer`, one socket per client, request dispatch loop, `event.subscribe` bookkeeping, stale-socket takeover logic (`prepareSocket`). |
| `tasks.js` | 1722 | `createTaskManager()`: dispatch, cancel, status, poll (`wait`'s RPC target), list, result, tail, summarize, advisor, state persistence (`tasks.json`), the no-output watchdog, queueing/concurrency caps, key-slot env stripping. |
| `protocol.js` | 208 | `PROTOCOL_VERSION`, `RPC_METHODS`, request/response/error envelope encode/decode, method-name-to-manager-function mapping. |
| `events.js` | 55 | Assigns a monotonic sequence number to each emitted event; that's the whole file. |
| `activity.js` | 212 | `activityCacheKey`/cache `refresh()`: bounded head+tail narration snapshot, optional model-summary call, min-interval throttling. |
| `state-lock.js` | 91 | `withFileLock()`: synchronous, `Atomics.wait`-based cross-process exclusive lock, used only for the daemon auto-start race. |
| `output.js` | 174 | TOON encoding, `leanStatus`/`leanResult`/`projectList`/`homeView`, hint-string MCP-name migration. |
| `opencode-plugin.js` | 174 | OpenCode's native plugin surface: toasts on task state transitions by polling `client.js` directly. |
| `setup.js` | 210 | `taskferry setup`: npm install, managed symlinks, per-client integration registration (see `docs/superpowers/specs/2026-07-16-taskferry-setup-design.md`). |
| `scripts/generate-skill.js` | — | Regenerates `integrations/*/skills/taskferry/SKILL.md` from `skills/taskferry/SKILL.md`; `--check` fails on drift. |

Every `*.js` above has a co-located `*.test.js` (`node --test`, no
framework); `smoke-test.js`/`cancel-smoke-test.js`/`poll-smoke-test.js` are
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
| Open design questions, past decisions | `docs/superpowers/specs/*.md`, `docs/superpowers/plans/*.md` |
| What's left to build, what's blocked, what's deliberately skipped | `todo.txt` (repo root) |
| The canonical agent-facing skill (regenerate after any CLI-surface change) | `skills/taskferry/SKILL.md`, then `npm run skill:generate` |

## Env vars

All `TASKFERRY_*` vars the daemon or CLI reads, gathered in one place
(individual docs above cover behavior; this is just the index):

| Var | Default | Purpose |
|---|---|---|
| `TASKFERRY_STATE_DIR` | `$XDG_STATE_HOME/taskferry` or `~/.local/state/taskferry` | Task state, logs, summary prompts |
| `TASKFERRY_RUNTIME_DIR` | `$XDG_RUNTIME_DIR/taskferry` or `<state-dir>/run` | Socket + lock files |
| `TASKFERRY_SOCKET_PATH` | `<runtime-dir>/daemon.sock` | Explicit socket override |
| `TASKFERRY_MAX_CONCURRENT_TASKS` | `4` | Running-task concurrency cap |
| `TASKFERRY_MAX_DISPATCHES_PER_WINDOW` / `TASKFERRY_DISPATCH_WINDOW_MS` | `2` / `5000` | Dispatch burst-rate limit |
| `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` | `120000` | Pre-output-seen watchdog deadline |
| `TASKFERRY_WATCHDOG_POLL_MS` | `2000` | Watchdog check interval |
| `TASKFERRY_KEY_SLOTS` | — | Named provider-key slot registry; see `docs/security.md` |
| `TASKFERRY_PROVIDER_KEY_ENV` | — | Source env var a key slot copies from |
| `TASKFERRY_SUMMARY_MODEL` | `opencode/hy3-free` | Model behind `summary --style report` |
| `TASKFERRY_SUMMARY_KEY_SLOT` / `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV` | — | Key-slot wiring specific to the summary model |
| `TASKFERRY_ACTIVITY_SUMMARIES` | — | Enables `watch --summaries` / activity-style model calls |
| `TASKFERRY_ACTIVITY_MIN_INTERVAL_MS` | `60000` | Throttle between activity-summary model calls |
| `TASKFERRY_ADVISOR_SESSION_TTL_MS` | `1800000` (30 min) | Advisor session idle expiry before auto-reset |
| `TASKFERRY_CHILD` | — | Set on the daemon's own spawned children; see `docs/security.md` |

## Things that look like bugs but aren't

- `status: "unknown"` after a daemon restart — expected; see
  `docs/daemon.md#recovery`. There is deliberately no re-attachment to
  already-running child processes.
- `taskferry wait` blocking forever with no output — expected when
  `--timeout-ms` is omitted (shipped 2026-07-17); it blocks until the
  task's real exit event, not a hidden clamp.
- A `SKILL.md` edit not showing up in `integrations/claude/skills/...` —
  run `npm run skill:generate`; the distributed copies are generated, not
  hand-edited.
