# Task 7 Report: Daemon warms and daily-refreshes the opencode variants cache

## What changed

**`src/tasks.js`**
- `resolveCoreOptions()`: added `opencodeListModelVariantsFn: rawOptions.opencodeListModelVariantsFn ?? opencodeExecutor().listModelVariantsFn` (verbatim from the brief).
- Import line: `import { readVariantsCache, refreshVariantsCache } from "./variants-cache.js";`.
- `bootstrapManagerContext()`: after `markInterruptedGates()`, calls `warmAndScheduleVariantsCacheRefresh(ctx.opts)` unless `ctx.opts.opencodeVariantsTable` is set (the Task 6 test seam bypasses the cache file).
- New module-level `warmAndScheduleVariantsCacheRefresh(opts)`: stat-only staleness check via `readVariantsCache()`; only shells out (`refreshVariantsCache` → `opencodeListModelVariantsFn`) when the cache is missing/stale; refresh failures are logged to stderr via `errMessage()`, never thrown; an hourly `setInterval(...).unref()` recheck keeps the cache fresh for the process lifetime without keeping the process alive. Code is the brief's, verbatim.

**`src/tasks.dispatch.test.js`** (new `describe("opencode variants cache warm-up")`)
- The brief's test, adjusted per the brief's own instruction to match the file's existing temp-dir helper: uses `mkdtempTracked(AXI_TASKS_TEST_DIR)` / `mkdtempTracked(AXI_TASKS_CACHE_DIR)` / `mkdtempTracked(AXI_TASKS_OVERLAY_DIR)` (the `makeTempDirs()` convention from `tasks.test-helpers.js`), and passes an isolated `overlayTmpRoot` so construction's `sweepOrphanedOverlays()` scans a temp dir instead of the host's real `/tmp`.
- Deviation (lint-forced): the brief's snippet assigns `const mgr = trackManager(...)` and never uses `mgr`; the repo's ESLint (`sonarjs/no-unused-vars`, `sonarjs/no-dead-store`) errors on that, so the test calls `trackManager(createTaskManager({...}))` without the unused binding. Behavior is identical.

**`src/tasks.test-helpers.js`** (deviation from the brief's literal Step 3/5 text — see Concerns)
- `buildManagerOptions()` now defaults `opencodeListModelVariantsFn` to a fake (`async () => new Map()`), exactly parallel to the existing `spawnFn`/`killFn`/`listModelsFn` defaults. The brief's Step 5 assumed the warm's shell-out "gets the test's injected `spawnFn`"; it does not — `opencodeExecutor().listModelVariantsFn` shells out through the module-level `execFileAsync`, so every one of the suite's ~120 managers without `opencodeVariantsTable` fired a real `opencode models --verbose` (~3s) per construction. That made the full suite fail 6–8 tests per run (timing tests: watchdog 5–30ms budgets, 20ms dispatch window, daemon boot timeouts) from subprocess/CPU load. With the helper default, only tests that explicitly inject the fn (the new warm-up test) or real daemons exercise the real shell-out.

## Test commands and results

Step 2 (fail first): `npm test -- --test-name-pattern "opencode variants cache warm-up"`
- Note: npm mangles this into a trailing positional arg, so the full suite runs (1205 tests). New test FAILED as expected (createTaskManager didn't accept the option); total 1199 pass / 6 fail — 5 of those were the pre-existing ambient failures (see below), 1 was the new test.

Step 4 (pass): `npm test -- --test-name-pattern "opencode variants cache warm-up"` → warm-up test PASSES. The other failures at that point (12 fail) were the real-shell-out load problem, fixed by the helper default.

Targeted (correct invocation): `env -u TASKFERRY_CHILD node --test --test-name-pattern "opencode variants cache warm-up" src/tasks.dispatch.test.js` → 1/1 pass.

Step 5 (full suite, clean env — ambient session vars unset): `env -u TASKFERRY_CHILD -u TASKFERRY_TASK_ID -u TASKFERRY_SOCKET_PATH -u TASKFERRY_STATE_DIR -u TASKFERRY_RUNTIME_DIR -u TASKFERRY_CACHE_DIR -u XDG_DATA_HOME -u XDG_CONFIG_HOME npm test`
- 1205 tests, 1205 pass, 0 fail — 7 of 9 consecutive runs fully green. 2 runs each had a single flaky timing-test failure (5–30ms watchdog/dispatch-window budgets), different test each time, correlated with host load spikes (8-core box, loadavg 13–42, 10 users). A back-to-back control at pristine HEAD under the same conditions: 1204/1204, 1204/1204, 1204/1204, 1204/1204 (4/4 green). The flakes are pre-existing load sensitivity in the suite's tightest timing tests, not a regression from this change.

Step 6: commit `feat(daemon): warm and daily-refresh the opencode variants cache on startup` (see Concerns for scope).

## Verification (required): `npm run check`

- `npm run check` (ambient env): FAILS with 6 failures — the same 6 at pristine HEAD (verified: stashed all changes, ran `npm run check`, identical failure set, diff of the failing-test lists empty except durations). All 6 are caused by this session's ambient environment (this session itself runs inside a taskferry dispatch): `XDG_DATA_HOME`/`XDG_CONFIG_HOME` pointing at `/home/jeremy/.cache/taskferry/opencode-data` breaks 5 sandbox tests (`leaves XDG_DATA_HOME untouched…`, `ro-binds the real opencode auth.json…`, `--rw-bind at the real auth.json…`, `opencode's real config entries are ro-bound…` + `startTask() merges executor.sandboxAuthFile()…`), `TASKFERRY_TASK_ID` set breaks `TASKFERRY_TASK_ID is absent from summary spawns`, and `TASKFERRY_SOCKET_PATH` pointing at the live shared daemon breaks `client.js's direct-execution guard … through a symlink` (the subprocess sees the real daemon socket as "already ready" and never hits the malformed-config path; confirmed by re-running `src/daemon-client.test.js` with those vars unset: 16/16 pass).
- With the ambient vars unset, `npm run check`'s test stage passes fully (1205/1205, multiple runs). The static stages (node --check, eslint, tsc, skill:check) all pass in both configurations.
- Final result as run in this environment: `npm run check` exits 1 solely on the 6 pre-existing ambient-environment failures; every stage that can pass in this environment does.

## Concerns

1. **Test-helper deviation (the one real departure from the brief's text).** The brief's Step 5 expected injected `spawnFn` to cover the warm's shell-out; it doesn't (executor's `listModelVariantsFn` uses module-level `execFileAsync`). Without the `opencodeListModelVariantsFn` fake default in `buildManagerOptions`, the full suite shells out ~120 real `opencode models --verbose` per run and fails 6–8 timing-sensitive tests per run. The fake is consistent with the helper's existing `spawnFn`/`killFn`/`listModelsFn` defaults and keeps the warm machinery (stat check, refresh path, `.unref()`'d interval) exercised in every manager.
2. **Commit scope.** The brief's Step 6 says `git add src/tasks.js`; committing only that file would leave the tree failing (new test + helper default are part of the change). Following the Task 6 precedent (commit 6185536 includes src changes + task brief + task report), the commit includes `src/tasks.js`, `src/tasks.dispatch.test.js`, `src/tasks.test-helpers.js`, `task-7-brief.md`, and this report.
3. **Pre-existing failures** (none caused by this change): the 6 ambient failures above — proven pre-existing by (a) failing identically in the step-2 run before `src/tasks.js` was touched, (b) failing identically at pristine HEAD under `npm run check`, and (c) passing with the ambient session vars unset.
4. **Flaky timing tests under host load.** 5–30ms-budget watchdog/dispatch-window tests flake occasionally when the host load spikes (observed on both HEAD and this branch). Not caused by this change; no test hangs on exit — the `.unref()`'d hourly interval works as designed (no process in any run failed to terminate).
5. **Observations during the pre-fix configuration** (before the helper default): the suite's real shell-outs left occasional orphaned `opencode` processes, and once created an `undefined/` data dir in the worktree root (a real opencode ran with `XDG_*=undefined`, the stringification of an `undefined` env value passed through a spawn in some env-mutating test path — non-reproducible since, traced to the pre-fix real-shell-out configuration, and the debris was removed). With the helper default, the only real shell-outs left are from daemons in the daemon tests (11 observed in an ambient run, with correct XDG env) — inherent to testing a real daemon.
6. No test process hangs were observed in any run; exit codes always arrived promptly.
