### Task 1: Config schema — `tags` and `providers`, replacing `providerLimits`

**Files:**
- Modify: `src/config.js`
- Test: `src/config.test.js`

**Interfaces:**
- Produces: `validateConfigFieldTypes` now accepts top-level `tags: string[]` and `providers: object`, rejects `providerLimits`. New exported helper `validateTagsAndProviders(tags, providers, configPath)` (called from `parseAndValidateConfig`) that later tasks' code can call directly in tests.
- Produces: parsed config's `providers.<name>` shape: `{ maxConcurrentTasks?: number, maxDispatchesPerWindow?: number, priority?: number, tags?: Record<string, string[]> }`.

- [ ] **Step 1: Write failing config-validation tests**

Add to `src/config.test.js`:

```javascript
describe("tags/providers validation", () => {
  test("accepts a valid tags + providers config", () => {
    const configPath = writeConfig(tmpConfigDir(), JSON.stringify({
      tags: ["cheap", "most-capable"],
      providers: {
        ollama: { maxConcurrentTasks: 3, priority: 1, tags: { cheap: ["deepseek-v4-flash:0731"], "most-capable": ["kimi-k3"] } },
        openrouter: { priority: 2, tags: { cheap: ["deepseek/deepseek-v4-flash-0731"] } },
      },
    }));
    const result = loadConfig({ configPath });
    assert.deepEqual(result.tags, ["cheap", "most-capable"]);
    assert.equal(result.providers.ollama.priority, 1);
  });

  test("rejects providerLimits outright, pointing at the replacement", () => {
    const configPath = writeConfig(tmpConfigDir(), JSON.stringify({ providerLimits: { ollama: { maxConcurrentTasks: 3 } } }));
    assert.throws(() => loadConfig({ configPath }), /providerLimits.*providers\.<name>\.maxConcurrentTasks/s);
  });

  test("rejects a provider tags key not in the global tags registry", () => {
    const configPath = writeConfig(tmpConfigDir(), JSON.stringify({
      tags: ["cheap"],
      providers: { ollama: { tags: { chep: ["x"] } } },
    }));
    assert.throws(() => loadConfig({ configPath }), /"chep".*not.*global "tags" registry|unrecognized tag/i);
  });

  test("rejects a model slug listed under two tags on the same provider", () => {
    const configPath = writeConfig(tmpConfigDir(), JSON.stringify({
      tags: ["cheap", "most-capable"],
      providers: { ollama: { tags: { cheap: ["kimi-k3"], "most-capable": ["kimi-k3"] } } },
    }));
    assert.throws(() => loadConfig({ configPath }), /"kimi-k3".*ollama.*two tags|duplicate/i);
  });

  test("rejects a non-array tags list under a provider", () => {
    const configPath = writeConfig(tmpConfigDir(), JSON.stringify({
      tags: ["cheap"],
      providers: { ollama: { tags: { cheap: "kimi-k3" } } },
    }));
    assert.throws(() => loadConfig({ configPath }), /must be an array/);
  });

  test("rejects a non-positive-integer priority", () => {
    const configPath = writeConfig(tmpConfigDir(), JSON.stringify({
      providers: { ollama: { priority: 0 } },
    }));
    assert.throws(() => loadConfig({ configPath }), /priority/);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test src/config.test.js`
Expected: FAIL — `providerLimits` still accepted, `tags`/`providers` rejected as "unrecognized config key".

- [ ] **Step 3: Implement the schema**

In `src/config.js`, remove `providerLimits: "object"` from `CONFIG_FIELD_TYPES` and add:

```javascript
  tags: "object",     // validated as string[] below (typeof [] === "object")
  providers: "object",
```

Add after `PROVIDER_LIMIT_FIELD_TYPES` is removed (delete that const, `warnEmptyProviderLimitEntry`, `validateProviderLimitEntry`, `validateProviderLimits` — superseded by the functions below):

```javascript
/** @type {Record<string, string>} */
const PROVIDER_FIELD_TYPES = {
  maxConcurrentTasks: "number",
  maxDispatchesPerWindow: "number",
  priority: "number",
  tags: "object", // validated as Record<string, string[]> below
};

/**
 * @param {unknown} tags
 * @param {string} configPath
 * @returns {string[]}
 */
function validateTagsRegistry(tags, configPath) {
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
    throw new Error(`error: config key "tags" in ${configPath} must be an array of strings\nhelp: e.g. "tags": ["cheap", "most-capable"]`);
  }
  return tags;
}

/**
 * Validates one provider's `tags` object: every key must be in the global
 * registry, and no model slug may appear in two tag arrays under the same
 * provider.
 * @param {string} provider
 * @param {unknown} providerTags
 * @param {string[]} globalTags
 * @param {string} configPath
 */
function validateProviderTags(provider, providerTags, globalTags, configPath) {
  if (!isObject(providerTags)) {
    throw new Error(`error: config key "providers.${provider}.tags" in ${configPath} must be a JSON object\nhelp: use {"<tag>": ["model-slug", ...]}`);
  }
  const seenModels = new Map(); // model slug -> tag it's already in
  for (const [tag, models] of Object.entries(providerTags)) {
    if (!globalTags.includes(tag)) {
      throw new Error(`error: "providers.${provider}.tags.${tag}" in ${configPath} is not in the global "tags" registry\nhelp: add "${tag}" to the top-level "tags" array, or fix the typo`);
    }
    if (!Array.isArray(models) || models.some((m) => typeof m !== "string")) {
      throw new Error(`error: config key "providers.${provider}.tags.${tag}" in ${configPath} must be an array of strings\nhelp: e.g. "${tag}": ["model-slug"]`);
    }
    for (const model of models) {
      const priorTag = seenModels.get(model);
      if (priorTag) {
        throw new Error(`error: model "${model}" appears in two tags ("${priorTag}" and "${tag}") under provider "${provider}" in ${configPath}\nhelp: a model may only carry one tag per provider — remove it from one of the arrays`);
      }
      seenModels.set(model, tag);
    }
  }
}

/**
 * @param {string} provider
 * @param {unknown} entry
 * @param {string[]} globalTags
 * @param {string} configPath
 */
function validateProviderEntry(provider, entry, globalTags, configPath) {
  if (!isObject(entry)) {
    throw new Error(`error: config key "providers.${provider}" in ${configPath} must be a JSON object\nhelp: use {"maxConcurrentTasks": N, "priority": N, "tags": {...}}`);
  }
  for (const key of Object.keys(entry)) {
    if (!Object.hasOwn(PROVIDER_FIELD_TYPES, key)) {
      throw new Error(`error: unrecognized key "providers.${provider}.${key}" in ${configPath}\nhelp: recognized keys are: ${Object.keys(PROVIDER_FIELD_TYPES).join(", ")}`);
    }
  }
  const value = /** @type {Record<string, unknown>} */ (entry);
  for (const key of ["maxConcurrentTasks", "maxDispatchesPerWindow", "priority"]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "number" || !isPositiveInteger(value[key])) {
      throw new Error(`error: config key "providers.${provider}.${key}" in ${configPath} must be a positive integer (got ${JSON.stringify(value[key])})\nhelp: fix the value's type in ${configPath}`);
    }
  }
  if (value.tags !== undefined) validateProviderTags(provider, value.tags, globalTags, configPath);
}

/**
 * Validates `config.json`'s `tags` and `providers` keys together — `tags` is
 * the global registry every provider's `tags` object is checked against.
 * Called from {@link parseAndValidateConfig} in place of the removed
 * `validateProviderLimits` (`providerLimits` is rejected outright by
 * `validateConfigFieldTypes` since it's no longer in `CONFIG_FIELD_TYPES`).
 * @param {unknown} tags
 * @param {unknown} providers
 * @param {string} configPath
 */
function validateTagsAndProviders(tags, providers, configPath) {
  const globalTags = tags === undefined ? [] : validateTagsRegistry(tags, configPath);
  if (providers === undefined) return;
  if (!isObject(providers)) {
    throw new Error(`error: config key "providers" in ${configPath} must be a JSON object\nhelp: use {"<provider>": {"maxConcurrentTasks": N, ...}, ...}`);
  }
  for (const [provider, entry] of Object.entries(providers)) {
    validateProviderEntry(provider, entry, globalTags, configPath);
  }
}
```

Export it (for direct testing and later tasks) by adding `validateTagsAndProviders` to the module's exports alongside `_resetConfigCache`.

In `parseAndValidateConfig`, replace the removed `if (parsed.providerLimits !== undefined) validateProviderLimits(...)` line with:

```javascript
  validateTagsAndProviders(parsed.tags, parsed.providers, configPath);
```

Give the `providerLimits` key a pointed migration error instead of the generic "unrecognized config key" message — add this check right after `validateConfigFieldTypes(parsed, configPath)` in `parseAndValidateConfig`, before the removed key would otherwise 404 through the generic unrecognized-key path (it already does 404 there since `providerLimits` is gone from `CONFIG_FIELD_TYPES`; make the message specific by checking for it explicitly ahead of the generic loop instead):

In `validateConfigFieldTypes`, before the `for (const key of Object.keys(parsed))` loop, add:

```javascript
  if (Object.hasOwn(parsed, "providerLimits")) {
    throw new Error(`error: config key "providerLimits" in ${configPath} is no longer supported\nhelp: move each entry to "providers.<name>.maxConcurrentTasks" / "providers.<name>.maxDispatchesPerWindow"`);
  }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test src/config.test.js`
Expected: PASS, all new and existing cases.

- [ ] **Step 5: Commit**

```bash
git add src/config.js src/config.test.js
git commit -m "feat(config): add tags/providers schema, replace providerLimits"
```

---

