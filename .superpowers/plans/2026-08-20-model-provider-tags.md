# Model/Provider Tags and Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let dispatches route by `--model`, `--model`+`--provider`, `--tag`, or `--provider`+`--tag` instead of always requiring an exact `provider/model` string, backed by a structured `tags`/`providers` config taskferry itself validates and resolves.

**Architecture:** A global `tags` registry and per-provider `providers.<name>.tags` map live in `config.json`, validated at load time in `src/config.js`. A new pure resolution module, `src/model-routing.js`, implements the four dispatch modes against that config plus a caller-supplied in-flight-count lookup. `src/args.js` gains `--provider`/`--tag` CLI flags and the mutual-exclusion/deprecation rules. `src/tasks.js`'s dispatch path calls the resolver before `buildDispatchTask` to turn whatever combination of `--provider`/`--model`/`--tag` was given into the final `provider/model` string. `providerLimits` is removed outright in favor of `providers.<name>.maxConcurrentTasks`/`maxDispatchesPerWindow`. Two new local (no-daemon) CLI commands, `providers list` and `tags list`, expose the resolved config for inspection.

**Tech Stack:** Node.js, `node:test`/`node:assert`, existing taskferry CLI/config/scheduler modules.

**Spec:** `.superpowers/specs/2026-08-19-model-provider-tags-design.md` (issue #499)

## Global Constraints

- No dual-reading of `providerLimits` — `providers.<name>.maxConcurrentTasks`/`maxDispatchesPerWindow` replaces it in the same change; an old `providerLimits` key must error at config-load time.
- `tags` is a global registry; a provider's `tags` object may only use keys drawn from it — unknown key is a config load-time error.
- A model slug may appear in at most one tag array per provider — duplicate is a config load-time error.
- Exclusion is by omission only — no denylist construct anywhere in this plan.
- Mode 1 (`--provider`+`--model` exact) always dispatches, even to an untagged model — it prints a warning, never an error.
- The compound `--model provider/model-slug` CLI form keeps working for one deprecation cycle with a printed notice; the *config key* migration (`providerLimits` → `providers`) gets no such shim.
- Every new error message follows the existing `error: ...\nhelp: ...` two-line convention used throughout `src/config.js` and `src/tasks.js`.

---

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

### Task 3: `src/model-routing.js` — the four-mode resolver

**Files:**
- Create: `src/model-routing.js`
- Test: `src/model-routing.test.js`

**Interfaces:**
- Consumes: `providers` shape from Task 1 (`Record<string, {priority?: number, tags?: Record<string,string[]>}>`), and a caller-supplied `inFlightCountFn: (provider: string) => number`.
- Produces: `export function resolveDispatchModel({ provider, model, tag }, { providers, inFlightCountFn }) → { resolved: string, warning: string|null }`. `resolved` is always a `"provider/model"` string. Throws `Error` (message in the `error: ...\nhelp: ...` convention) for every dispatch-time failure in the spec's error table. Task 5 is the only consumer.

- [ ] **Step 1: Write failing tests**

Create `src/model-routing.test.js`:

```javascript
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveDispatchModel } from "./model-routing.js";

const providers = {
  ollama: { priority: 1, tags: { cheap: ["deepseek-v4-flash:0731"], "most-capable": ["kimi-k3"] } },
  openrouter: { priority: 2, tags: { cheap: ["deepseek/deepseek-v4-flash-0731"] } },
  untagged: {},
};
const zeroLoad = () => 0;

describe("mode 1: --provider + --model (exact)", () => {
  test("dispatches even to an untagged model, with a warning", () => {
    const { resolved, warning } = resolveDispatchModel({ provider: "ollama", model: "some-other-model" }, { providers, inFlightCountFn: zeroLoad });
    assert.equal(resolved, "ollama/some-other-model");
    assert.match(warning, /not tagged.*ollama.*cheap.*most-capable/s);
  });

  test("dispatches a tagged model with no warning", () => {
    const { resolved, warning } = resolveDispatchModel({ provider: "ollama", model: "kimi-k3" }, { providers, inFlightCountFn: zeroLoad });
    assert.equal(resolved, "ollama/kimi-k3");
    assert.equal(warning, null);
  });
});

describe("mode 2: --model only", () => {
  test("single match resolves that provider", () => {
    const { resolved } = resolveDispatchModel({ model: "kimi-k3" }, { providers, inFlightCountFn: zeroLoad });
    assert.equal(resolved, "ollama/kimi-k3");
  });

  test("multiple matches break ties by priority", () => {
    const multi = { a: { priority: 2, tags: { cheap: ["x"] } }, b: { priority: 1, tags: { cheap: ["x"] } } };
    const { resolved } = resolveDispatchModel({ model: "x" }, { providers: multi, inFlightCountFn: zeroLoad });
    assert.equal(resolved, "b/x");
  });

  test("ties on priority break by least-loaded", () => {
    const multi = { a: { priority: 1, tags: { cheap: ["x"] } }, b: { priority: 1, tags: { cheap: ["x"] } } };
    const { resolved } = resolveDispatchModel({ model: "x" }, { providers: multi, inFlightCountFn: (p) => (p === "a" ? 3 : 0) });
    assert.equal(resolved, "b/x");
  });

  test("zero matches is a hard error", () => {
    assert.throws(() => resolveDispatchModel({ model: "nope" }, { providers, inFlightCountFn: zeroLoad }), /"nope" isn't tagged on any provider/);
  });
});

describe("mode 3: --tag only", () => {
  test("picks a provider by priority then the tag's first entry", () => {
    const { resolved } = resolveDispatchModel({ tag: "cheap" }, { providers, inFlightCountFn: zeroLoad });
    assert.equal(resolved, "ollama/deepseek-v4-flash:0731");
  });

  test("unknown tag is a hard error", () => {
    assert.throws(() => resolveDispatchModel({ tag: "nonexistent" }, { providers, inFlightCountFn: zeroLoad }), /"nonexistent".*no provider/);
  });
});

describe("mode 4: --provider + --tag", () => {
  test("resolves the provider's first entry for that tag", () => {
    const { resolved } = resolveDispatchModel({ provider: "openrouter", tag: "cheap" }, { providers, inFlightCountFn: zeroLoad });
    assert.equal(resolved, "openrouter/deepseek/deepseek-v4-flash-0731");
  });

  test("errors when the named provider doesn't declare the tag", () => {
    assert.throws(() => resolveDispatchModel({ provider: "openrouter", tag: "most-capable" }, { providers, inFlightCountFn: zeroLoad }), /"openrouter".*doesn't declare tag "most-capable"/);
  });

  test("errors when the named provider doesn't exist", () => {
    assert.throws(() => resolveDispatchModel({ provider: "nope", tag: "cheap" }, { providers, inFlightCountFn: zeroLoad }), /"nope"/);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test src/model-routing.test.js`
Expected: FAIL — `./model-routing.js` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/model-routing.js`:

```javascript
/**
 * Resolves a `--provider`/`--model`/`--tag` combination into a final
 * "provider/model" dispatch string, per the four modes in
 * `.superpowers/specs/2026-08-19-model-provider-tags-design.md`. Pure
 * function of its arguments — `inFlightCountFn` is the only side-channel,
 * kept as an injected callback so this module doesn't need to know about
 * the scheduler's internal state shape.
 */

/**
 * @param {Record<string, {priority?: number}>} providers
 * @param {string[]} candidateNames
 * @param {(provider: string) => number} inFlightCountFn
 * @returns {string}
 */
function pickByPriorityThenLoad(providers, candidateNames, inFlightCountFn) {
  const ranked = candidateNames
    .map((name) => ({ name, priority: providers[name].priority ?? Infinity, load: inFlightCountFn(name) }))
    .sort((a, b) => (a.priority - b.priority) || (a.load - b.load));
  return ranked[0].name;
}

/**
 * @param {Record<string, {tags?: Record<string, string[]>}>} providers
 * @param {string} tag
 * @returns {string[]}
 */
function providersDeclaringTag(providers, tag) {
  return Object.keys(providers).filter((name) => providers[name].tags && Object.hasOwn(providers[name].tags, tag));
}

/**
 * @param {{provider?: string, model?: string, tag?: string}} args
 * @param {{providers: Record<string, {priority?: number, tags?: Record<string, string[]>}>, inFlightCountFn: (provider: string) => number}} ctx
 * @returns {{resolved: string, warning: string|null}}
 */
export function resolveDispatchModel({ provider, model, tag }, { providers, inFlightCountFn }) {
  // Mode 1: --provider + --model (exact)
  if (provider && model) {
    const entry = providers[provider];
    const declaredTags = entry && entry.tags ? Object.keys(entry.tags) : [];
    const isTagged = entry && entry.tags && Object.values(entry.tags).some((models) => models.includes(model));
    const warning = isTagged
      ? null
      : `warning: "${model}" is not tagged on provider "${provider}"\nhelp: declared tags on "${provider}": ${declaredTags.length ? declaredTags.join(", ") : "(none)"}`;
    return { resolved: `${provider}/${model}`, warning };
  }

  // Mode 4: --provider + --tag
  if (provider && tag) {
    const entry = providers[provider];
    if (!entry) throw new Error(`error: unknown provider "${provider}"\nhelp: check "providers" in config.json`);
    if (!entry.tags || !Object.hasOwn(entry.tags, tag)) {
      throw new Error(`error: provider "${provider}" doesn't declare tag "${tag}"\nhelp: declared tags on "${provider}": ${entry.tags ? Object.keys(entry.tags).join(", ") : "(none)"}`);
    }
    return { resolved: `${provider}/${entry.tags[tag][0]}`, warning: null };
  }

  // Mode 3: --tag only
  if (tag) {
    const candidates = providersDeclaringTag(providers, tag);
    if (candidates.length === 0) {
      throw new Error(`error: "${tag}" isn't declared on any provider\nhelp: use --provider to name one explicitly, or add "${tag}" to a provider's tags`);
    }
    const chosen = pickByPriorityThenLoad(providers, candidates, inFlightCountFn);
    return { resolved: `${chosen}/${providers[chosen].tags[tag][0]}`, warning: null };
  }

  // Mode 2: --model only
  if (model) {
    const candidates = Object.keys(providers).filter((name) => providers[name].tags && Object.values(providers[name].tags).some((models) => models.includes(model)));
    if (candidates.length === 0) {
      throw new Error(`error: "${model}" isn't tagged on any provider\nhelp: use --provider to dispatch explicitly, or add it to a provider's tags`);
    }
    const chosen = pickByPriorityThenLoad(providers, candidates, inFlightCountFn);
    return { resolved: `${chosen}/${model}`, warning: null };
  }

  throw new Error(`error: one of --model or --tag is required\nhelp: see \`taskferry dispatch --help\``);
}
```

- [ ] **Step 4: Run to see them pass**

Run: `node --test src/model-routing.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model-routing.js src/model-routing.test.js
git commit -m "feat(routing): add four-mode model/provider/tag resolver"
```

---

### Task 4: CLI flags — `--provider`, `--tag`, bare `--model`

**Files:**
- Modify: `src/args.js`
- Test: `src/args.test.js`

**Interfaces:**
- Consumes: nothing new — this is the CLI parsing layer only.
- Produces: `options.provider: string|undefined`, `options.tag: string|undefined` on `parseArgs()`'s result for `dispatch`/`advisor`. `options.model` keeps its existing key/shape; a compound `provider/model-slug` value is left as-is for Task 5 to split (this task only adds the deprecation notice, doesn't split the string).

- [ ] **Step 1: Write failing tests**

Add to `src/args.test.js` (find the existing `dispatch` parsing block and add nearby):

```javascript
test("--provider and --tag parse for dispatch", () => {
  const result = parseArgs(["dispatch", "--directory", ".", "--prompt", "hi", "--provider", "ollama", "--tag", "cheap"]);
  assert.equal(result.options.provider, "ollama");
  // --tag alone with --provider is fine; the --tag+--model exclusivity check is separate
});

test("--tag and --model together is a usage error", () => {
  assert.throws(
    () => parseArgs(["dispatch", "--directory", ".", "--prompt", "hi", "--tag", "cheap", "--model", "kimi-k3"]),
    /--tag cannot be combined with --model/
  );
});

test("compound provider/model string prints a deprecation notice", () => {
  const result = parseArgs(["dispatch", "--directory", ".", "--prompt", "hi", "--model", "ollama/kimi-k3"]);
  assert.equal(result.options.model, "ollama/kimi-k3"); // unsplit; Task 5 owns the split
  assert.match(result.deprecationNotices?.join("\n") || "", /--model provider\/model-slug is deprecated/);
});
```

(Check the actual existing test file's structure for `parseArgs` import path and how other flag tests are laid out — e.g. the `--allowed-dirs` deprecation test nearby — and match that pattern exactly rather than guessing at helper names.)

- [ ] **Step 2: Run to see them fail**

Run: `node --test src/args.test.js`
Expected: FAIL — `--provider`/`--tag` are unrecognized flags.

- [ ] **Step 3: Implement**

In `src/args.js`, add to the flag table (near `"--model"` at line 364):

```javascript
  "--provider": { allow: ["dispatch", "advisor"], key: "provider" },
  "--tag": { allow: ["dispatch", "advisor"], key: "tag" },
```

Near the other cross-flag validations (e.g. line 617's `if (command === "advisor" && !options.model)`), add:

```javascript
  if (options.tag && options.model) throw usageError("--tag cannot be combined with --model", command);
```

For the compound-string deprecation notice, find where `options.model` is finalized after parsing (same function that resolves other deprecated flags, e.g. `--allowed-dirs`'s `deprecate` field at line 370) and add an equivalent check once parsing is complete:

```javascript
  if (typeof options.model === "string" && options.model.includes("/") && !options.provider) {
    pushDeprecationNotice(`--model provider/model-slug is deprecated; use --provider <name> --model <slug> instead`);
  }
```

(`pushDeprecationNotice` should already exist as the mechanism the `--allowed-dirs`/`--rw-dirs`/etc. `mention`/`deprecate` fields use to surface a notice — read that existing code path in `src/args.js` around lines 396-436 first and reuse its actual function name and the result object's actual field name instead of inventing `deprecationNotices` if the real one differs; update the Step 1 test to match whatever the real field is called.)

- [ ] **Step 4: Run to see them pass**

Run: `node --test src/args.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/args.js src/args.test.js
git commit -m "feat(cli): add --provider/--tag flags and --model deprecation notice"
```

---

### Task 5: Wire the resolver into dispatch

**Files:**
- Modify: `src/tasks.js` (`validateDispatchModel` at line 2215, `buildDispatchTask` at line 2248, and the dispatch call site that invokes them)
- Test: `src/tasks.dispatch.test.js`

**Interfaces:**
- Consumes: `resolveDispatchModel` from Task 3, `options.provider`/`options.tag`/`options.model` from Task 4.
- Produces: `buildDispatchTask` still receives a plain `model: "provider/model"` string as before (Task 3's resolution happens upstream of it, at the dispatch call site) — no signature change to `buildDispatchTask` itself, keeping this task's blast radius to the call site and `validateDispatchModel`.

- [ ] **Step 1: Write failing tests**

Add to `src/tasks.dispatch.test.js`:

```javascript
test("dispatch with --tag resolves to the tagged provider/model", () => {
  const mgr = makeManager({ config: { tags: ["cheap"], providers: { ollama: { tags: { cheap: ["kimi-k3"] } } } } });
  const result = mgr.dispatch({ directory: tmpDir(), prompt: "hi", tag: "cheap", role: "dispatch" });
  assert.equal(result.model, "ollama/kimi-k3");
});

test("dispatch with untagged --provider + --model still dispatches (mode 1)", () => {
  const mgr = makeManager({ config: { tags: ["cheap"], providers: { ollama: { tags: { cheap: ["kimi-k3"] } } } } });
  const result = mgr.dispatch({ directory: tmpDir(), prompt: "hi", provider: "ollama", model: "other-model", role: "dispatch" });
  assert.equal(result.model, "ollama/other-model");
});

test("dispatch with --model only, untagged anywhere, errors", () => {
  const mgr = makeManager({ config: { tags: ["cheap"], providers: { ollama: { tags: { cheap: ["kimi-k3"] } } } } });
  assert.throws(() => mgr.dispatch({ directory: tmpDir(), prompt: "hi", model: "nope", role: "dispatch" }), /isn't tagged on any provider/);
});
```

(Match these to `makeManager`'s and `mgr.dispatch`'s actual existing call signatures in this file — read a neighboring passing test first for the exact option names, e.g. whether `directory`/`tmpDir()` matches what's already there.)

- [ ] **Step 2: Run to see them fail**

Run: `node --test src/tasks.dispatch.test.js`
Expected: FAIL — `provider`/`tag` are silently ignored, dispatch still requires a plain `model`.

- [ ] **Step 3: Implement**

In `src/tasks.js`, near the top, add the import:

```javascript
import { resolveDispatchModel } from "./model-routing.js";
```

Find the dispatch call site that currently calls `validateDispatchModel({ model, priorSessionTask, sessionId })` before `buildDispatchTask(...)` (trace `validateDispatchModel`'s one caller from its definition at line 2215). Immediately before that call, resolve `provider`/`tag` into a plain `model` string when either was given:

```javascript
  let resolvedModel = model;
  let routingWarning = null;
  if (tag || (provider && !model)) {
    // model-only-or-tag routing: mode 2, 3, or 4 (mode 1 handled below for
    // the --provider+--model case since it never needs resolveDispatchModel's
    // multi-provider search, only its warning).
    const { resolved, warning } = resolveDispatchModel({ provider, model, tag }, {
      providers: (config && config.providers) || {},
      inFlightCountFn: (p) => providerRunningCount(p), // see below
    });
    resolvedModel = resolved;
    routingWarning = warning;
  } else if (provider && model) {
    const { resolved, warning } = resolveDispatchModel({ provider, model }, {
      providers: (config && config.providers) || {},
      inFlightCountFn: () => 0, // unused in mode 1
    });
    resolvedModel = resolved;
    routingWarning = warning;
  }
  if (routingWarning) process.stderr.write(routingWarning + "\n");
```

Read the actual dispatch call site's existing local variable names (`config`, `provider`, `tag`, `model` may already be destructured under slightly different names — e.g. `rawOptions.config` rather than a bare `config`) before pasting this in, and adjust names to match rather than introducing a second config-resolution path. Use `resolvedModel` in place of `model` in the subsequent `validateDispatchModel`/`buildDispatchTask` calls at that site.

For `providerRunningCount`, add a small helper next to `providerOf` (line 641) that reads the scheduler's live queue state already tracked in `ctx.launchScheduler.providerQueues` (see its use at `src/tasks.js:6788`):

```javascript
/**
 * @param {Map<string, {runningCount: number}>} providerQueues
 * @param {string} provider
 * @returns {number}
 */
function providerRunningCount(providerQueues, provider) {
  return providerQueues.get(provider)?.runningCount ?? 0;
}
```

Adjust the inline closure above to `(p) => providerRunningCount(ctx.launchScheduler.providerQueues, p)`, using whatever the call site's actual in-scope reference to the scheduler is named (it may already be `this` or a captured `ctx` — match the surrounding code).

- [ ] **Step 4: Run to see them pass**

Run: `node --test src/tasks.dispatch.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.dispatch.test.js
git commit -m "feat(dispatch): resolve --provider/--model/--tag through model-routing"
```

---

### Task 6: `taskferry providers list` and `taskferry tags list`

**Files:**
- Modify: `src/command-specs.js`, `src/commands.js`, `src/args.js`
- Test: `src/commands.test.js` (or the file housing existing local-command tests, e.g. `setup`/`init` — check first)

**Interfaces:**
- Consumes: `loadConfig()` from Task 1's `src/config.js`.
- Produces: `runProvidersList(options, deps)` → `{ providers: [{ name, priority, maxConcurrentTasks, running, tags: string[] }] }`; `runTagsList(options, deps)` → `{ tags: [{ name, providers: [{ name, model }] }] }`. Both are plain-object returns matching the shape every other local command (`setup`, `init`) already returns for the CLI's generic TOON printer.

- [ ] **Step 1: Write failing tests**

Find the existing test file covering `setup`/`init` (local, no-daemon commands) and add alongside it:

```javascript
test("providers list reports declared tags and priority", () => {
  const result = runProvidersList({}, { config: { providers: { ollama: { priority: 1, maxConcurrentTasks: 3, tags: { cheap: ["x"] } } } } });
  assert.deepEqual(result.providers[0], { name: "ollama", priority: 1, maxConcurrentTasks: 3, tags: ["cheap"] });
});

test("tags list reports which providers declare each tag and what model", () => {
  const result = runTagsList({}, { config: { tags: ["cheap"], providers: { ollama: { tags: { cheap: ["x"] } } } } });
  assert.deepEqual(result.tags[0], { name: "cheap", providers: [{ name: "ollama", model: "x" }] });
});
```

(Match this to the real test file's actual harness for constructing `deps` — check how `setup`/`init` tests build their `deps` object rather than inventing the shape here.)

- [ ] **Step 2: Run to see them fail**

Run: `node --test <that test file>`
Expected: FAIL — `runProvidersList`/`runTagsList` don't exist.

- [ ] **Step 3: Implement**

In `src/commands.js`, add:

```javascript
/**
 * @param {Record<string, unknown>} _options
 * @param {{config: Record<string, unknown>}} deps
 */
function runProvidersList(_options, deps) {
  const providers = /** @type {Record<string, any>} */ (deps.config.providers) || {};
  return {
    providers: Object.entries(providers).map(([name, entry]) => ({
      name,
      priority: entry.priority ?? null,
      maxConcurrentTasks: entry.maxConcurrentTasks ?? null,
      tags: entry.tags ? Object.keys(entry.tags) : [],
    })),
  };
}

/**
 * @param {Record<string, unknown>} _options
 * @param {{config: Record<string, unknown>}} deps
 */
function runTagsList(_options, deps) {
  const globalTags = /** @type {string[]} */ (deps.config.tags) || [];
  const providers = /** @type {Record<string, any>} */ (deps.config.providers) || {};
  return {
    tags: globalTags.map((tag) => ({
      name: tag,
      providers: Object.entries(providers)
        .filter(([, entry]) => entry.tags && Object.hasOwn(entry.tags, tag))
        .map(([name, entry]) => ({ name, model: entry.tags[tag][0] })),
    })),
  };
}
```

Add both to the exported dispatch table (find the `doctor: /** @type {...} */ (runDoctor),` line and add alongside it):

```javascript
  providers: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runProvidersList),
  tags: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runTagsList),
```

In `src/command-specs.js`, add entries mirroring `setup`'s (no-daemon, no options):

```javascript
  providers: {
    usage: "taskferry providers list",
    description: "List configured providers, their priority, concurrency limit, and declared tags.",
    options: {},
    examples: ["taskferry providers list"],
  },
  tags: {
    usage: "taskferry tags list",
    description: "List the global tag registry and which providers declare each tag.",
    options: {},
    examples: ["taskferry tags list"],
  },
```

In `src/args.js`, add `providers` and `tags` to whatever list makes `setup`/`init` local (no-daemon) commands recognized (`flagDefaultsFor`'s call table, near line 285), following the exact same pattern as the `doctor: () => flagDefaultsFor("doctor")` line. Both commands require a literal `list` positional argument in v1 (the only supported action) — add a check alongside the other positional-argument validations (near line 503/615) that errors with `usage: taskferry providers list` / `usage: taskferry tags list` if the positional isn't exactly `"list"`.

- [ ] **Step 4: Run to see them pass**

Run: `node --test <that test file>`
Expected: PASS.

- [ ] **Step 5: Manually verify end-to-end**

```bash
node src/cli.js providers list
node src/cli.js tags list
```

Expected: both print the TOON-formatted (empty, absent a real config.json) result with no crash.

- [ ] **Step 6: Commit**

```bash
git add src/commands.js src/command-specs.js src/args.js src/commands.test.js
git commit -m "feat(cli): add taskferry providers list and tags list"
```

---

### Task 7: Docs

**Files:**
- Modify: `README.md` (config reference section — find the existing `providerLimits` mention)
- Modify: `docs/daemon.md` ("Things that look like bugs but aren't" — add the mode-1-warns-not-errors behavior)

**Interfaces:** none — doc-only task.

- [ ] **Step 1: Update the config reference**

`rg -n "providerLimits" README.md` and replace each hit's description with the new `tags`/`providers` shape, matching Task 1's actual final schema (copy the example from the spec's "Config shape" section, adjusted for anything Task 1 changed during implementation).

- [ ] **Step 2: Add the "looks like a bug" entry**

Append to `docs/daemon.md`'s "Things that look like bugs but aren't" section:

```markdown
- **`--provider`+`--model` dispatches to an untagged model instead of erroring.**
  This is mode 1 in the model/provider/tag resolver
  (`src/model-routing.js`) — an exact `--provider`+`--model` pair is a
  deliberate override and always dispatches; it only prints a warning
  naming the tags that *are* declared on that provider. Auto-routing modes
  (`--model` alone, `--tag` alone, `--provider`+`--tag`) are the ones that
  hard-error on an unmatched model/tag. See
  `.superpowers/specs/2026-08-19-model-provider-tags-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/daemon.md
git commit -m "docs: document tags/providers config and mode-1 warn-not-error behavior"
```

---

## After all tasks land

- Close issue #499 with a comment summarizing what shipped and linking the merged PR (per this repo's CLAUDE.md "Check GitHub issues after merging a PR").
- Move `.superpowers/specs/2026-08-19-model-provider-tags-design.md` and this plan file to `.superpowers/.completed/{specs,plans}/` once merged (per CLAUDE.md's `.superpowers/` convention).
- Populating `tags`/`providers` in a real `config.json` from `choosing-a-model`'s `working-report.md` prose is explicit follow-up work per the spec's Non-goals — file a new issue for it rather than doing it inline here.
