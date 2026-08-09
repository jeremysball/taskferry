## Task 1: `config.js` validates a `providerLimits` field

**Files:**
- Modify: `src/config.js:24-97`
- Test: `src/config.test.js`

**Interfaces:**
- Produces: `providerLimits` becomes a recognized `config.json` key. A config file with `{"providerLimits": {"minimax": {"maxConcurrentTasks": 4, "maxDispatchesPerWindow": 10}}}` passes validation; `loadConfig()` returns it verbatim (still a plain nested object — normalization into the scheduler's `Map` shape happens in Task 3, inside `tasks.js`, not here).

- [ ] **Step 1: Write the failing tests**

Add to `src/config.test.js`, inside the existing `describe("loadConfig()", ...)` block (after the `overlayEnabled` tests, before its closing `});`):

```js
  test("accepts a valid providerLimits value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: { minimax: { maxConcurrentTasks: 4, maxDispatchesPerWindow: 10 }, ollama: { maxConcurrentTasks: 3 } } }));
    assert.deepEqual(loadConfig({ configPath }), { providerLimits: { minimax: { maxConcurrentTasks: 4, maxDispatchesPerWindow: 10 }, ollama: { maxConcurrentTasks: 3 } } });
  });

  test("rejects a providerLimits value that isn't an object", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: "minimax:4" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "providerLimits".*must be a object.*\nhelp:/s);
  });

  test("rejects a providerLimits array", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: [1, 2] }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "providerLimits".*must be a JSON object.*\nhelp:/s);
  });

  test("rejects a providerLimits entry that isn't an object", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: { minimax: 4 } }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "providerLimits\.minimax".*must be a JSON object.*\nhelp:/s);
  });

  test("rejects an unrecognized key inside a providerLimits entry", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: { minimax: { maxRpm: 10 } } }));
    assert.throws(() => loadConfig({ configPath }), /error: unrecognized key "providerLimits\.minimax\.maxRpm".*\nhelp:/s);
  });

  test("rejects a non-positive-integer providerLimits value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: { minimax: { maxConcurrentTasks: 0 } } }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "providerLimits\.minimax\.maxConcurrentTasks".*must be a positive integer.*\nhelp:/s);
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "providerLimits"`
Expected: FAIL — `providerLimits` is not a recognized config key yet, so every test throws the wrong error message (the "unrecognized config key" error instead of the specific ones being asserted).

- [ ] **Step 3: Implement the validator**

In `src/config.js`, add `providerLimits: "object",` to `CONFIG_FIELD_TYPES` (after `profilingEnabled: "boolean",`):

```js
const CONFIG_FIELD_TYPES = {
  maxConcurrentTasks: "number",
  maxDispatchesPerWindow: "number",
  dispatchWindowMs: "number",
  noOutputTimeoutMs: "number",
  postOutputNoOutputTimeoutMs: "number",
  preOutputMaxMs: "number",
  summaryModel: "string",
  activitySummariesEnabled: "boolean",
  summarizerTimeoutMs: "number",
  activityMaxWords: "number",
  advisorSessionTtlMs: "number",
  watchdogGraceMs: "number",
  lowerdirStaggerMs: "number",
  sandboxEnabled: "boolean",
  overlayEnabled: "boolean",
  allowedDirs: "string",
  envDenylist: "string",
  sandboxDenylist: "string",
  waitDefaultTimeoutMs: "number",
  cancelGraceMs: "number",
  defaultExecutor: "string",
  advisorContextChars: "number",
  envFile: "string",
  profilingEnabled: "boolean",
  providerLimits: "object",
};

const PROVIDER_LIMIT_FIELD_TYPES = {
  maxConcurrentTasks: "number",
  maxDispatchesPerWindow: "number",
};

/**
 * Validates `config.json`'s `providerLimits` field: a flat map of provider
 * name -> {maxConcurrentTasks?, maxDispatchesPerWindow?}, both optional
 * positive integers. Mirrors the top-level object/key/type checks in
 * {@link parseAndValidateConfig} one level deeper, since `providerLimits`
 * is the one config field shaped as a nested object rather than a scalar.
 * @param {unknown} providerLimits
 * @param {string} configPath
 */
function validateProviderLimits(providerLimits, configPath) {
  if (providerLimits === null || typeof providerLimits !== "object" || Array.isArray(providerLimits)) {
    throw new Error(`error: config key "providerLimits" in ${configPath} must be a JSON object\nhelp: use {"provider": {"maxConcurrentTasks": N, "maxDispatchesPerWindow": N}, ...}`);
  }
  for (const [provider, limits] of Object.entries(providerLimits)) {
    if (limits === null || typeof limits !== "object" || Array.isArray(limits)) {
      throw new Error(`error: config key "providerLimits.${provider}" in ${configPath} must be a JSON object\nhelp: use {"maxConcurrentTasks": N, "maxDispatchesPerWindow": N}`);
    }
    for (const key of Object.keys(limits)) {
      if (!Object.hasOwn(PROVIDER_LIMIT_FIELD_TYPES, key)) {
        throw new Error(`error: unrecognized key "providerLimits.${provider}.${key}" in ${configPath}\nhelp: recognized keys are: ${Object.keys(PROVIDER_LIMIT_FIELD_TYPES).join(", ")}`);
      }
      const value = /** @type {Record<string, unknown>} */ (limits)[key];
      if (typeof value !== PROVIDER_LIMIT_FIELD_TYPES[key] || !Number.isInteger(value) || /** @type {number} */ (value) <= 0) {
        throw new Error(`error: config key "providerLimits.${provider}.${key}" in ${configPath} must be a positive integer (got ${JSON.stringify(value)})\nhelp: fix the value's type in ${configPath}`);
      }
    }
  }
}
```

Then, in `parseAndValidateConfig()`, right after the existing `defaultExecutor` special-case block (`if (parsed.defaultExecutor !== undefined && ...) { throw ...; }`), add:

```js
  if (parsed.providerLimits !== undefined) validateProviderLimits(parsed.providerLimits, configPath);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "providerLimits"`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full config test file to check for regressions**

Run: `npm test src/config.test.js`
Expected: PASS, all tests (existing + new)

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/config.test.js
git commit -m "feat(config): validate a providerLimits nested-object field"
```

---

