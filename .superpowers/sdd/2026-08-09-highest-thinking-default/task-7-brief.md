## Task 7: Daemon warms and daily-refreshes the opencode variants cache

**Files:**
- Modify: `src/tasks.js` (`bootstrapManagerContext`, ~line 4516)
- Test: `src/tasks.persist.test.js` or a new `describe` block in `src/tasks.dispatch.test.js` (whichever existing file already covers `bootstrapManagerContext`-adjacent behavior — check with `rg -n "bootstrapManagerContext|sweepOrphanedOverlays" src/*.test.js` and add alongside it)

**Interfaces:**
- Consumes: `refreshVariantsCache()` (Task 4), `readVariantsCache()` (Task 4), `opencodeExecutor().listModelVariantsFn` (Task 3).
- Produces: every `createTaskManager()` call (daemon or otherwise) kicks off a fire-and-forget cache warm on construction when the cache is stale, plus an `unref()`'d interval that re-checks every hour (cheap stat-only check via `readVariantsCache`; only refreshes when that returns `null`).

- [ ] **Step 1: Write the failing test**

```js
describe("opencode variants cache warm-up", () => {
  test("createTaskManager() triggers a refresh when the cache is stale, using the opencode executor's listModelVariantsFn", async () => {
    let called = 0;
    const { stateDir, defaultCacheDir } = makeTempDirsForTest(); // use whatever this file's existing temp-dir helper is named
    const mgr = trackManager(createTaskManager({
      stateDir,
      cacheDir: defaultCacheDir,
      sandboxEnabled: false,
      overlayEnabled: false,
      lowerdirStaggerMs: 0,
      spawnFn: () => fakeChild(),
      killFn: () => {},
      listModelsFn: async () => "",
      opencodeListModelVariantsFn: async () => { called++; return new Map(); },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(called, 1);
  });
});
```

Adjust the temp-dir setup to match whichever helper the target test file already imports from `tasks.test-helpers.js` (`mkdtempTracked`, or a local equivalent) — do not introduce a second ad hoc temp-dir pattern per the repo's existing `mkdtempTracked()` convention.

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm test -- --test-name-pattern "opencode variants cache warm-up"`
Expected: FAIL — `createTaskManager()` does not accept `opencodeListModelVariantsFn` or trigger any refresh yet.

- [ ] **Step 3: Add the injectable `opencodeListModelVariantsFn` option and the warm-up call**

In `src/tasks.js`'s `resolveCoreOptions()` (same function touched in Task 6 Step 4), add:

```js
    opencodeListModelVariantsFn: rawOptions.opencodeListModelVariantsFn ?? opencodeExecutor().listModelVariantsFn,
```

In `bootstrapManagerContext()` (~line 4516), add a call after the existing crash-recovery sweeps:

```js
function bootstrapManagerContext(ctx) {
  startEnvFileWatch(ctx.opts, ctx.state);
  loadPersistedTasks({ /* ...unchanged... */ });
  ctx.helpers.sweepOrphanedPromptFiles();
  ctx.helpers.sweepOrphanedOverlays();
  ctx.helpers.markInterruptedGates();
  // Opportunistically warm the opencode variants cache in the background.
  // Never awaited: a stale or missing cache only means dispatch()'s
  // resolveOpencodeVariants() sends no --variant flag until the refresh
  // lands, never a blocked or failed dispatch. Skipped entirely when a
  // test has injected opencodeVariantsTable directly (Task 6), since that
  // seam bypasses the cache file altogether.
  if (!ctx.opts.opencodeVariantsTable) {
    warmAndScheduleVariantsCacheRefresh(ctx.opts);
  }
}

/**
 * Refreshes the opencode variants cache once now (if stale) and schedules
 * an hourly, `unref()`'d recheck for as long as the process lives. The
 * hourly tick is cheap when the cache is fresh (a single `statSync` inside
 * `readVariantsCache()`); it only pays for the ~3s `opencode models
 * --verbose` shell-out once every `DEFAULT_VARIANT_CACHE_TTL_MS` (24h).
 * @param {ResolvedTaskManagerOptions} opts
 */
function warmAndScheduleVariantsCacheRefresh(opts) {
  const maybeRefresh = () => {
    if (readVariantsCache({ cacheDir: opts.cacheDir, env: process.env }) !== null) return;
    refreshVariantsCache({ cacheDir: opts.cacheDir, env: process.env, listModelVariantsFn: opts.opencodeListModelVariantsFn })
      .catch((err) => process.stderr.write(`warning: opencode variants cache refresh failed: ${errMessage(err)}\n`));
  };
  maybeRefresh();
  setInterval(maybeRefresh, 60 * 60 * 1000).unref();
}
```

Add `refreshVariantsCache` to the existing `import { readVariantsCache } from "./variants-cache.js";` line from Task 6 (making it `import { readVariantsCache, refreshVariantsCache } from "./variants-cache.js";`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern "opencode variants cache warm-up"`
Expected: PASS

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS. Every other `createTaskManager()`/`makeManager()` call in the suite either passes `opencodeVariantsTable` (short-circuiting this path per Task 6 Step 7) or gets the real `warmAndScheduleVariantsCacheRefresh` with the test's injected `spawnFn`/temp `cacheDir` — confirm no test hangs on process exit from a non-`unref()`'d timer (the `.unref()` call is what prevents that; if any test process hangs, that is the first thing to check).

- [ ] **Step 6: Commit**

```bash
git add src/tasks.js
git commit -m "feat(daemon): warm and daily-refresh the opencode variants cache on startup"
```

---

