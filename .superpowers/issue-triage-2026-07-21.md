# Open issue triage — taskferry (2026-07-21, 29 open, 2 closed this pass)

## Closed this pass
| # | Title | Resolution |
|---|-------|------------|
| 48 | Watchdog silently lowered from 10min to 6.7min | Won't-fix — current 400000ms value confirmed acceptable, not reverting |
| 40 | Concurrent Playwright MCP dispatches crash with SIGKILL | Fixed — `--isolated` verified present in both opencode.json/.jsonc `playwright` MCP command |

## Open (triaged, no duplicates found)
| # | Title | Category | Priority |
|---|-------|----------|----------|
| 46 | Dispatched opencode workers have no process/host isolation — one killed the production daemon | Reliability | Critical |
| 51 | Activity cache is unbounded — slow memory leak in long-lived daemons | Reliability | High |
| 53 | persistTask failures are silently swallowed in failRunningTask | Bug | High |
| 61 | wait has no default timeout and can block forever | Bug | High |
| 63 | openrouter dispatch crashes with a generic error when the daemon has no API key, instead of reporting the real cause | Bug | High |
| 52 | Daemon self-restart disconnects watch/wait subscribers with no actionable error message | Reliability | Medium |
| 47 | Resuming a dispatch with --session-id doesn't inherit the original task's model | Bug | Medium |
| 55 | persistTask() rewrites the entire tasks.json on every single task state transition | Performance | Medium |
| 56 | logActivity() does synchronous blocking file I/O on every status() poll | Performance | Medium |
| 57 | startRunningWatcher() double-parses newly appended log lines every watchdog tick | Performance | Medium |
| 58 | result() ignores fields filter's read-cost benefit, duplicates extractFinalMessage()'s full-log parse | Performance | Medium |
| 59 | watch --task-id and wait --summarize each spend an extra round-trip solely to fetch directory | Performance | Low |
| 60 | doctor blocks on a synchronous claude plugin list subprocess after already awaiting daemon health RPC | Performance | Low |
| 62 | No composed dispatch+wait convenience — canonical workflow forces 3 commands and manual task-ID copy-paste | Ergonomics | Medium |
| 70 | watch --summaries enablement is a single global toggle, not scoped per subscription/task | Ergonomics | Medium |
| 73 | Manage skill and statusline files ourselves instead of requiring manual /plugin update taskferry | Ergonomics | Medium |
| 67 | Add a prune/gc subcommand for task and log state | Feature | Medium |
| 38 | wait --summarize model override | Feature | Low |
| 37 | result message truncation | Feature | Low |
| 36 | poll/list response trimming | Feature | Low |
| 32 | Agent selection for dispatch | Feature | Low |
| 31 | Tool selection for dispatch | Feature | Low |
| 34 | doctor --full environmental output (Docker tier) | Feature | Low |
| 33 | Admin UI / key management panel (Docker tier) | Feature | Low |
| 54 | Minor robustness items: dispatch TOCTOU, hardcoded watchdog grace period, missing engines field | Tech debt | Low |
| 50 | docs/sourcemap.md mis-describes state-lock.js as not used in the request hot path | Docs | Low |
| 49 | defaultTaskManager is dead code with import-time side effects and a stale comment | Tech debt | Low |
| 45 | Consolidate 5-way narration-indexing duplication in activity.js/tasks.js | Tech debt | Low |
| 30 | Refactor complexity/size hotspots flagged by new ESLint maintainability rules | Tech debt | Low |
