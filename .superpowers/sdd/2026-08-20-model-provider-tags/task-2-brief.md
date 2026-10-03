### Task 2: Rewire provider concurrency limits onto `providers.*`

**Files:**
- Modify: `src/tasks.js:660-709` (`providerLimitsFromConfig`, `resolveProviderLimitsOption`)
- Test: `src/tasks.dispatch.test.js`

**Interfaces:**
- Consumes: `config.providers` shape from Task 1 (`{ maxConcurrentTasks?, maxDispatchesPerWindow?, priority?, tags? }` per provider).
- Produces: `resolveProviderLimitsOption(rawOptions)` returns the same `{ providerLimits: Map<string, {concurrencyLimit, dispatchLimit}> }` shape as before, unchanged for every downstream scheduler consumer (`providerCanLaunch`, `soonestProviderDelay`, `providerQueueDelay`) — no signature changes below this function.

- [ ] **Step 1: Write failing tests**

In `src/tasks.dispatch.test.js`, update the existing `providerLimits`-config-shaped tests (around line 541, 561, 603, 635, 659) to configure via `providers` instead:

```javascript
test("providers.<name>.maxConcurrentTasks caps concurrency for that provider only", () => {
  const mgr = makeManager({
    config: { providers: { "opencode-go": { maxConcurrentTasks: 1 } } },
  });
  // ... existing body, unchanged aside from the config shape above
});
```

Apply the same shape swap (`providerLimits: {...}` → `providers: {...}` with `maxConcurrentTasks`/`maxDispatchesPerWindow` as direct provider entry fields, not nested under a second `providerLimits` key) to each of the five existing call sites listed above. Read each test's current body first — only the `config:` literal passed to `makeManager`/dispatch changes, assertions stay the same.

- [ ] **Step 2: Run to see them fail**

Run: `node --test src/tasks.dispatch.test.js`
Expected: FAIL — `providerLimitsFromConfig` still reads `config.providerLimits`, which is now empty/undefined under the new test config, so no caps apply and concurrency assertions fail.

- [ ] **Step 3: Implement**

In `src/tasks.js`, replace the body of `providerLimitsFromConfig` (~line 671) to read from the `providers` shape:

```javascript
/**
 * Converts `config.json`'s validated `providers` object (Task 1's
 * `validateTagsAndProviders`) into the `Map<string, {concurrencyLimit,
 * dispatchLimit}>` shape the scheduler reads. An omitted per-provider field
 * means unlimited for that axis (`Infinity`), not zero. Ignores each
 * provider's `priority`/`tags` fields — those are `model-routing.js`'s
 * concern, not the scheduler's. Accepts either a plain object or a `Map`
 * (env-var callers already produce a scheduler-shaped `Map`), and always
 * returns a fresh `Map`.
 * @param {Record<string, {maxConcurrentTasks?: number, maxDispatchesPerWindow?: number, concurrencyLimit?: number, dispatchLimit?: number}>|Map<string, {maxConcurrentTasks?: number, maxDispatchesPerWindow?: number, concurrencyLimit?: number, dispatchLimit?: number}>|undefined} configValue
 * @returns {Map<string, {concurrencyLimit: number, dispatchLimit: number}>}
 */
function providerLimitsFromConfig(configValue) {
  const map = new Map();
  if (!configValue) return map;
  const entries = configValue instanceof Map ? configValue.entries() : Object.entries(configValue);
  for (const [provider, limits] of entries) {
    map.set(provider, {
      concurrencyLimit: limits.concurrencyLimit ?? limits.maxConcurrentTasks ?? Infinity,
      dispatchLimit: limits.dispatchLimit ?? limits.maxDispatchesPerWindow ?? Infinity,
    });
  }
  return map;
}
```

(Function body is unchanged — it already tolerates the extra `priority`/`tags` fields on each entry since it only reads `maxConcurrentTasks`/`maxDispatchesPerWindow`. The only change is its doc comment and its caller.)

Update `resolveProviderLimitsOption` (~line 700) to read `config.providers` instead of `config.providerLimits`, keeping the `rawOptions.providerLimits`-override and `TASKFERRY_PROVIDER_LIMITS`-env branches exactly as they are (those stay caller/env-facing knobs, independent of the config-file key rename):

```javascript
function resolveProviderLimitsOption(rawOptions) {
  if (rawOptions.providerLimits !== undefined) {
    return { providerLimits: providerLimitsFromConfig(/** @type {any} */ (rawOptions.providerLimits)) };
  }
  if (process.env.TASKFERRY_PROVIDER_LIMITS !== undefined) {
    return { providerLimits: parseProviderLimitsEnv(process.env.TASKFERRY_PROVIDER_LIMITS) };
  }
  const config = rawOptions.config || {};
  return { providerLimits: providerLimitsFromConfig(/** @type {any} */ (config.providers)) };
}
```

- [ ] **Step 4: Run to see them pass**

Run: `node --test src/tasks.dispatch.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.dispatch.test.js
git commit -m "fix(scheduler): read provider concurrency limits from providers.*"
```

---

