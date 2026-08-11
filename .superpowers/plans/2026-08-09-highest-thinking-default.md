# Highest-Thinking Default + Required --model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Dispatch lane:** every task below (implementer, fixer, task reviewer,
> final reviewer) goes through `taskferry` per this repo's dispatch-lanes
> rule (`CLAUDE.md`) — never the Agent tool, and never inline edits in the
> orchestrating session. Load `taskferry:using-taskferry` before dispatching
> the first task.

**Goal:** When `--variant` is omitted, dispatch the target model at its highest supported thinking level instead of sending no reasoning flag (or the old hardcoded `"high"`); make `--model` required on a fresh dispatch, deleting the implicit per-executor default model it dragged in.

**Architecture:** pi already resolves "highest" internally (`clampThinkingLevel` walks up-then-down over its ordered level list), so the pi executor just needs `--thinking max` passed straight through. opencode does not self-resolve, so a small daemon-owned cache of `opencode models --verbose`'s per-model `variants` keys (refreshed daily, read synchronously off an mtime-memoized file) backs a pure ranking function that picks the highest declared key. A new `defaultVariant` config (default sentinel `"highest"`) governs what gets requested when `--variant` is omitted, resolved once at dispatch time in `tasks.js` so the recorded task always reflects the real request.

**Tech Stack:** Node.js, `node:test` + `node:assert/strict`, existing `tasks.test-helpers.js` fixtures (`makeManager`, `fakeChild`, `trackManager`, `mkdtempTracked`, `passthroughIfSet`).

**Reference spec:** `.superpowers/specs/2026-08-09-highest-thinking-default-design.md` — read it before starting; this plan implements it section by section. Move it (and the two specs it supersedes) to `.superpowers/.completed/specs/` in the last task once everything lands.

## Global Constraints

- `--model` is required on a fresh `dispatch` (no `--session-id`, or a `--session-id` matching no prior task). `advisor` already enforces this at both `args.js:375` and `tasks.js:2710` — do not touch either of those.
- No vendored copy of pi's model registry and no `@earendil-works/pi-ai` runtime dependency. pi resolves "highest" itself via `clampThinkingLevel`; taskferry sends `--thinking max` for pi whenever "highest" is requested, full stop.
- opencode's `--variant` silently accepts unknown values (verified: `--variant bogusnonsense` completes normally with no error) — never guess a variant name for opencode without a live table entry backing it.
- The opencode variant table lives at `<cacheDir>/opencode-variants.json` (`resolveCacheDir()`, `src/paths.js:104`), refreshed by the daemon on startup and every 24h, read by `dispatch()` synchronously via an mtime memo (same pattern as `src/config.js`'s `_configCache`). `dispatch()` never shells out and never blocks on a refresh.
- Explicit `--variant` values are never validated or reinterpreted, on either executor — passthrough only, worker CLI is the backstop.
- `defaultVariant` config accepts the sentinel `"highest"` (built-in default) or one of pi's seven levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Applies to dispatch and advisor; never to summaries.
- `taskferry models` does not exist as a command — do not reference it in help text. Point users at `opencode models` / `pi --list-models` instead.
- Every new/changed function keeps the existing dependency-injection test style — no new function should make it harder to construct an isolated `makeManager()` in tests.

---

## File Structure

- Create `src/variants.js`: pure `resolveVariant()` (pi passthrough, opencode ranking-over-table) plus the ranking helper. No I/O.
- Create `src/variants.test.js`: unit tests for `resolveVariant()` and the ranking helper.
- Create `src/variants-cache.js`: the opencode variants cache — `parseOpencodeModelsVerbose()` (text → `Map<model, string[]>`), `readVariantsCache()` (mtime-memoized sync read), `writeVariantsCacheAtomic()` (temp-file + rename), `refreshVariantsCache()` (shell out via an injected `listModelVariantsFn`, single-flight, writes the file).
- Create `src/variants-cache.test.js`: parser fixtures, mtime-memo reuse/invalidation, TTL/fingerprint staleness, malformed-file-treated-as-absent, atomic write.
- Modify `src/executor.js`: delete `defaultModel` from the `WorkerExecutor` typedef and both implementations; add `listModelVariantsFn` to the opencode executor only.
- Modify `src/executor.test.js`: drop the `defaultModel` assertion; add `listModelVariantsFn` coverage.
- Modify `src/config.js`: add `defaultVariant` to `CONFIG_FIELD_TYPES` plus its enum validator.
- Modify `src/config.test.js`: accept/reject coverage for `defaultVariant`.
- Modify `src/tasks.js`: `resolveStringOptions` gains `defaultVariant`; `buildDispatchTask` deletes `usingDefaultModel`/`executor.defaultModel` and calls `resolveVariant()`; `dispatchTask` threads the variants-cache reader and a once-per-model warning through `ctx`; `bootstrapManagerContext` kicks off the opencode cache warm/refresh (fire-and-forget, `unref()`'d interval).
- Modify `src/tasks.test-helpers.js`: `defaultVariant` and `opencodeVariantsTable`/`variantWarnings` passthroughs on `buildManagerOptions()`.
- Modify `src/tasks.dispatch.test.js`, `src/tasks.executor.test.js`, `src/tasks.failure.test.js`, `src/tasks.summarize.test.js`: delete fixture `defaultModel` fields; flip the hardcoded-`"high"`/fallback-model assertions; add `--model` where a test relied on the old fallback.
- Modify `docs/cli-reference.md`, `docs/config.md`, `docs/daemon.md`, `skills/using-taskferry/SKILL.md`, `README.md`.

---

## Task 1: `config.js` validates a `defaultVariant` field

**Files:**
- Modify: `src/config.js:24-49` (`CONFIG_FIELD_TYPES`), and the validation block around `src/config.js:155-158`
- Test: `src/config.test.js`

**Interfaces:**
- Produces: `defaultVariant` becomes a recognized `config.json` key, string type, validated against `KNOWN_VARIANT_LEVELS = ["highest", "off", "minimal", "low", "medium", "high", "xhigh", "max"]` exported from `src/config.js`. `loadConfig()` returns it verbatim.

- [ ] **Step 1: Write the failing tests**

Add to `src/config.test.js`, inside the existing `describe("loadConfig()", ...)` block (after the `providerLimits` tests):

```js
  test("accepts the highest sentinel for defaultVariant", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: "highest" }));
    assert.deepEqual(loadConfig({ configPath }), { defaultVariant: "highest" });
  });

  test("accepts each of pi's concrete thinking levels for defaultVariant", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const dir = tmpConfigDir();
      const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: level }));
      assert.deepEqual(loadConfig({ configPath }), { defaultVariant: level });
    }
  });

  test("rejects an unrecognized defaultVariant string", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: "medium-plus" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "defaultVariant" in .* must be one of highest, off, minimal, low, medium, high, xhigh, max \(got "medium-plus"\)\nhelp:/);
  });

  test("rejects an empty or whitespace-only defaultVariant", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: "   " }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "defaultVariant".*must be one of/);
  });

  test("rejects a non-string defaultVariant", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: 5 }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "defaultVariant" in .* must be a string \(got 5\)\nhelp:/);
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "defaultVariant"`
Expected: FAIL — `defaultVariant` is not a recognized config key yet.

- [ ] **Step 3: Implement the validator**

In `src/config.js`, add `defaultVariant: "string",` to `CONFIG_FIELD_TYPES` (after `defaultExecutor: "string",`):

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
  rwBind: "string",
  roBind: "string",
  envDenylist: "string",
  sandboxDenylist: "string",
  waitDefaultTimeoutMs: "number",
  cancelGraceMs: "number",
  defaultExecutor: "string",
  defaultVariant: "string",
  advisorContextChars: "number",
  envFile: "string",
  profilingEnabled: "boolean",
  providerLimits: "object",
};

export const KNOWN_VARIANT_LEVELS = /** @type {readonly string[]} */ (["highest", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
```

Then, right after the existing `defaultExecutor` special-case block in `parseAndValidateConfig()`:

```js
  if (parsed.defaultExecutor !== undefined && !KNOWN_EXECUTORS.includes(parsed.defaultExecutor)) {
    throw new Error(`error: config key "defaultExecutor" in ${configPath} must be one of ${KNOWN_EXECUTORS.join(", ")} (got ${JSON.stringify(parsed.defaultExecutor)})\nhelp: fix the value in ${configPath}`);
  }

  if (parsed.defaultVariant !== undefined && !KNOWN_VARIANT_LEVELS.includes(parsed.defaultVariant.trim())) {
    throw new Error(`error: config key "defaultVariant" in ${configPath} must be one of ${KNOWN_VARIANT_LEVELS.join(", ")} (got ${JSON.stringify(parsed.defaultVariant)})\nhelp: fix the value in ${configPath}`);
  }
```

Note the type check on line ~148 (`typeof value !== expectedType`) already rejects the non-string case before this block runs, so the "rejects a non-string" test is covered by existing code, not new code — verify its message matches (`must be a string (got 5)`) rather than adding a redundant check.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "defaultVariant"`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full config test file to check for regressions**

Run: `npm test src/config.test.js`
Expected: PASS, all tests

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/config.test.js
git commit -m "feat(config): validate a defaultVariant field"
```

---

## Task 2: `src/variants.js` — pure variant resolution

**Files:**
- Create: `src/variants.js`
- Test: `src/variants.test.js`

**Interfaces:**
- Consumes: nothing external — pure function over its own inputs.
- Produces:
  - `export function rankOpencodeVariants(keys: string[]): string` — given an opencode model's declared variant keys **in declaration order**, returns the single key representing "highest."
  - `export function resolveVariant({ executorId, requested, opencodeVariants }: { executorId: "pi"|"opencode", requested: string, opencodeVariants?: string[] }): string|null` — `opencodeVariants` is that one model's key list from the cache (or `undefined`/`[]` when the model is not in the table).

- [ ] **Step 1: Write the failing tests**

Create `src/variants.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rankOpencodeVariants, resolveVariant } from "./variants.js";

describe("rankOpencodeVariants()", () => {
  test("picks the highest-ranked known name regardless of declaration order", () => {
    assert.equal(rankOpencodeVariants(["low", "high", "medium"]), "high");
    assert.equal(rankOpencodeVariants(["high", "max"]), "max");
  });

  test("picks xhigh over high", () => {
    assert.equal(rankOpencodeVariants(["low", "medium", "high", "xhigh"]), "xhigh");
  });

  test("an unknown trailing key outranks the known key before it", () => {
    // The verified real-world case: MiniMax-M3's {none, thinking} pair.
    assert.equal(rankOpencodeVariants(["none", "thinking"]), "thinking");
  });

  test("an unknown leading key is outranked by a known key after it", () => {
    assert.equal(rankOpencodeVariants(["mystery", "high"]), "high");
  });

  test("a single unknown key is returned as-is", () => {
    assert.equal(rankOpencodeVariants(["mystery"]), "mystery");
  });

  test("ties on rank break toward the later-declared key", () => {
    assert.equal(rankOpencodeVariants(["alpha", "beta"]), "beta");
  });

  test("empty list returns null", () => {
    assert.equal(rankOpencodeVariants([]), null);
  });
});

describe("resolveVariant()", () => {
  test("a concrete requested level passes through untouched for pi", () => {
    assert.equal(resolveVariant({ executorId: "pi", requested: "medium" }), "medium");
  });

  test("a concrete requested level passes through untouched for opencode, even if not in the table", () => {
    assert.equal(resolveVariant({ executorId: "opencode", requested: "medium", opencodeVariants: ["low", "high"] }), "medium");
  });

  test("highest on pi always resolves to max (pi clamps per-model itself)", () => {
    assert.equal(resolveVariant({ executorId: "pi", requested: "highest" }), "max");
  });

  test("highest on opencode resolves to the model's ranked-highest key", () => {
    assert.equal(resolveVariant({ executorId: "opencode", requested: "highest", opencodeVariants: ["low", "high", "max"] }), "max");
  });

  test("highest on opencode with no table entry sends no flag", () => {
    assert.equal(resolveVariant({ executorId: "opencode", requested: "highest", opencodeVariants: [] }), null);
    assert.equal(resolveVariant({ executorId: "opencode", requested: "highest" }), null);
  });

  test("highest on opencode resolving to none/off sends no flag", () => {
    assert.equal(resolveVariant({ executorId: "opencode", requested: "highest", opencodeVariants: ["none"] }), null);
    assert.equal(resolveVariant({ executorId: "opencode", requested: "highest", opencodeVariants: ["off"] }), null);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "rankOpencodeVariants|resolveVariant"`
Expected: FAIL — `src/variants.js` does not exist yet.

- [ ] **Step 3: Implement `src/variants.js`**

```js
// Rank table for opencode's known variant vocabulary, observed across the
// installed catalog (`opencode models --verbose`): none/off < minimal <
// low < medium < high < xhigh < max. An unknown name (e.g. MiniMax-M3's
// "thinking") has no fixed rank -- it takes the rank of the key declared
// immediately before it, plus 0.5, so it reads as "one step up from
// whatever came before," matching the observed invariant that every
// model's variants are declared in ascending-effort order.
const KNOWN_RANKS = { none: 0, off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

/**
 * Picks the single "highest" key from a model's declared opencode variant
 * keys, given in the order opencode declared them.
 * @param {string[]} keys
 * @returns {string|null}
 */
export function rankOpencodeVariants(keys) {
  if (keys.length === 0) return null;
  let bestKey = keys[0];
  let bestRank = Object.hasOwn(KNOWN_RANKS, keys[0]) ? KNOWN_RANKS[keys[0]] : -0.5;
  let prevRank = bestRank;
  for (let i = 1; i < keys.length; i++) {
    const key = keys[i];
    const rank = Object.hasOwn(KNOWN_RANKS, key) ? KNOWN_RANKS[key] : prevRank + 0.5;
    if (rank >= bestRank) {
      bestRank = rank;
      bestKey = key;
    }
    prevRank = rank;
  }
  return bestKey;
}

/**
 * Resolves what `--variant`/`--thinking` value (if any) to send for a
 * dispatch, given the level the caller requested (a concrete level, or the
 * `"highest"` sentinel from `defaultVariant`).
 *
 * A concrete `requested` value is never reinterpreted on either executor --
 * the worker CLI is the backstop for an invalid one.
 *
 * `"highest"` on pi always becomes `"max"`: pi's own `clampThinkingLevel`
 * walks up-then-down over its ordered level list at runtime, so requesting
 * the top level is already "give me whatever this model supports,"
 * including on extension providers taskferry cannot see the registry for.
 *
 * `"highest"` on opencode looks up `opencodeVariants` (that model's variant
 * keys from the cached `opencode models --verbose` table, in declaration
 * order) and ranks them. No table entry, an empty list, or a ranked result
 * of `none`/`off` all mean "send no flag" -- opencode silently ignores an
 * unrecognized `--variant`, so guessing is worse than omitting.
 *
 * @param {{executorId: "pi"|"opencode", requested: string, opencodeVariants?: string[]}} params
 * @returns {string|null}
 */
export function resolveVariant({ executorId, requested, opencodeVariants }) {
  if (requested !== "highest") return requested;
  if (executorId === "pi") return "max";
  const ranked = rankOpencodeVariants(opencodeVariants ?? []);
  return ranked === "none" || ranked === "off" ? null : ranked;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "rankOpencodeVariants|resolveVariant"`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add src/variants.js src/variants.test.js
git commit -m "feat(variants): add resolveVariant() for the highest-thinking default"
```

---

## Task 3: opencode executor exposes `listModelVariantsFn`

**Files:**
- Modify: `src/executor.js:312-320` (top of `opencodeExecutor()`)
- Test: `src/executor.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `opencodeExecutor().listModelVariantsFn(env: NodeJS.ProcessEnv): Promise<Map<string, string[]>>` — shells out to `opencode models --verbose`, parses its `provider/model\n{...json...}` block format, returns a map of `provider/model` to that model's `Object.keys(variants)` in declaration order. Only defined on the opencode executor; pi's executor object has no `listModelVariantsFn` property at all — its absence is the statement that pi needs no such table.

- [ ] **Step 1: Write the failing tests**

Add to `src/executor.test.js`, inside `describe("opencodeExecutor()", ...)`:

```js
describe("opencodeExecutor().listModelVariantsFn", () => {
  const FIXTURE = [
    "opencode/deepseek-v4-flash-free",
    '{"id":"deepseek-v4-flash-free","variants":{"low":{"reasoningEffort":"low"},"high":{"reasoningEffort":"high"},"max":{"reasoningEffort":"max"}}}',
    "opencode/no-variants-model",
    '{"id":"no-variants-model","variants":{}}',
    "minimax/MiniMax-M3",
    '{"id":"MiniMax-M3","variants":{"none":{"thinking":{"type":"disabled"}},"thinking":{"thinking":{"type":"enabled","budgetTokens":16000}}}}',
  ].join("\n");

  test("parses provider/model blocks into an ordered variant-key map", async () => {
    const ex = opencodeExecutor();
    const result = await ex.listModelVariantsFn(process.env, { execFileFn: async () => ({ stdout: FIXTURE, stderr: "" }) });
    assert.deepEqual(result.get("opencode/deepseek-v4-flash-free"), ["low", "high", "max"]);
    assert.deepEqual(result.get("minimax/MiniMax-M3"), ["none", "thinking"]);
  });

  test("omits models with no variants from the map", async () => {
    const ex = opencodeExecutor();
    const result = await ex.listModelVariantsFn(process.env, { execFileFn: async () => ({ stdout: FIXTURE, stderr: "" }) });
    assert.equal(result.has("opencode/no-variants-model"), false);
  });

  test("skips a malformed JSON block instead of throwing", async () => {
    const ex = opencodeExecutor();
    const malformed = "opencode/broken-model\n{not valid json\nopencode/deepseek-v4-flash-free\n" + FIXTURE.split("\n")[1];
    const result = await ex.listModelVariantsFn(process.env, { execFileFn: async () => ({ stdout: malformed, stderr: "" }) });
    assert.equal(result.has("opencode/broken-model"), false);
    assert.deepEqual(result.get("opencode/deepseek-v4-flash-free"), ["low", "high", "max"]);
  });
});

test("piExecutor() has no listModelVariantsFn -- pi needs no variant table", () => {
  assert.equal(piExecutor().listModelVariantsFn, undefined);
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "listModelVariantsFn"`
Expected: FAIL — `listModelVariantsFn` is not defined on `opencodeExecutor()`.

- [ ] **Step 3: Implement the parser and shell-out**

In `src/executor.js`, add near the top of the file (after `SUMMARY_PREFLIGHT_TIMEOUT_MS`):

```js
const LIST_MODEL_VARIANTS_TIMEOUT_MS = 30000;

// `opencode models --verbose` prints one model per block: a `provider/model`
// line at column 0 with no leading whitespace, followed by that model's
// full JSON description (always indented -- a JSON body line is never
// mistaken for the next model-id line). A block that fails to JSON.parse
// is skipped rather than aborting the whole listing; one malformed model
// must not cost every other model's variant data.
const OPENCODE_MODEL_ID_LINE = /^(\S+\/\S+)$/;

/**
 * @param {string} verboseOutput - raw stdout of `opencode models --verbose`
 * @returns {Map<string, string[]>}
 */
function parseOpencodeModelVariants(verboseOutput) {
  /** @type {Map<string, string[]>} */
  const result = new Map();
  const lines = verboseOutput.split("\n");
  let currentModel = null;
  let currentBlockLines = [];
  const flush = () => {
    if (!currentModel || currentBlockLines.length === 0) return;
    try {
      const parsed = JSON.parse(currentBlockLines.join("\n"));
      const keys = Object.keys(parsed.variants ?? {});
      if (keys.length > 0) result.set(currentModel, keys);
    } catch {
      // Malformed block for this one model -- skip it, keep going.
    }
  };
  for (const line of lines) {
    const idMatch = OPENCODE_MODEL_ID_LINE.exec(line);
    if (idMatch) {
      flush();
      currentModel = idMatch[1];
      currentBlockLines = [];
    } else if (currentModel) {
      currentBlockLines.push(line);
    }
  }
  flush();
  return result;
}
```

Then, inside `opencodeExecutor()`'s returned object (after `listModelsFn`, before `buildSpawnArgs`):

```js
    /** @param {NodeJS.ProcessEnv} env @param {{execFileFn?: typeof execFileAsync}} [options] @returns {Promise<Map<string, string[]>>} */
    listModelVariantsFn: async (env, { execFileFn = execFileAsync } = {}) => {
      const { stdout } = await execFileFn("opencode", ["models", "--verbose"], { encoding: "utf8", timeout: LIST_MODEL_VARIANTS_TIMEOUT_MS, env, maxBuffer: 32 * 1024 * 1024 });
      return parseOpencodeModelVariants(stdout);
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "listModelVariantsFn"`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full executor test file to check for regressions**

Run: `npm test src/executor.test.js`
Expected: PASS, all tests

- [ ] **Step 6: Commit**

```bash
git add src/executor.js src/executor.test.js
git commit -m "feat(executor): opencode listModelVariantsFn parses opencode models --verbose"
```

---

## Task 4: `src/variants-cache.js` — mtime-memoized, fingerprinted cache

**Files:**
- Create: `src/variants-cache.js`
- Test: `src/variants-cache.test.js`

**Interfaces:**
- Consumes: `opencodeExecutor().listModelVariantsFn` (Task 3) as the injectable `listModelVariantsFn`; `modelsCacheFingerprint` (already exported-internal to `src/tasks.js` at `src/tasks.js:4707` — re-export it from `tasks.js` for this module to import, see Step 3 below).
- Produces:
  - `export function readVariantsCache({ cacheDir, env, ttlMs, statFn, readFileFn }): Map<string, string[]> | null` — sync, mtime-memoized per `cacheDir`. Returns `null` when the file is absent, malformed, wrong-schema, stale by TTL, or fingerprint-mismatched against `env`.
  - `export function refreshVariantsCache({ cacheDir, env, listModelVariantsFn, writeFileFn, renameFn, mkdirFn }): Promise<void>` — single-flight per `cacheDir`, writes atomically (temp file + rename).
  - `export const VARIANTS_CACHE_SCHEMA = 1` and `export const DEFAULT_VARIANT_CACHE_TTL_MS = 24 * 60 * 60 * 1000`.

- [ ] **Step 1: Write the failing tests**

Create `src/variants-cache.test.js`:

```js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readVariantsCache, refreshVariantsCache, VARIANTS_CACHE_SCHEMA } from "./variants-cache.js";

function tmpCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axi-variants-cache-"));
}

function writeCache(cacheDir, body) {
  fs.writeFileSync(path.join(cacheDir, "opencode-variants.json"), JSON.stringify(body));
}

describe("readVariantsCache()", () => {
  test("returns null when the file is absent", () => {
    assert.equal(readVariantsCache({ cacheDir: tmpCacheDir(), env: {} }), null);
  });

  test("returns the model map from a fresh, matching-fingerprint file", () => {
    const cacheDir = tmpCacheDir();
    writeCache(cacheDir, { schema: VARIANTS_CACHE_SCHEMA, generatedAt: new Date().toISOString(), fingerprint: "", models: { "opencode/foo": ["low", "high"] } });
    const result = readVariantsCache({ cacheDir, env: {} });
    assert.deepEqual(result.get("opencode/foo"), ["low", "high"]);
  });

  test("returns null when older than ttlMs", () => {
    const cacheDir = tmpCacheDir();
    writeCache(cacheDir, { schema: VARIANTS_CACHE_SCHEMA, generatedAt: new Date().toISOString(), fingerprint: "", models: {} });
    const past = Date.now() - 1000;
    fs.utimesSync(path.join(cacheDir, "opencode-variants.json"), past / 1000, past / 1000);
    assert.equal(readVariantsCache({ cacheDir, env: {}, ttlMs: 500 }), null);
  });

  test("returns null when the fingerprint doesn't match the given env", () => {
    const cacheDir = tmpCacheDir();
    writeCache(cacheDir, { schema: VARIANTS_CACHE_SCHEMA, generatedAt: new Date().toISOString(), fingerprint: "OPENAI_API_KEY=old", models: { "opencode/foo": ["low"] } });
    assert.equal(readVariantsCache({ cacheDir, env: { OPENAI_API_KEY: "new" } }), null);
  });

  test("returns null for malformed JSON", () => {
    const cacheDir = tmpCacheDir();
    fs.writeFileSync(path.join(cacheDir, "opencode-variants.json"), "{not json");
    assert.equal(readVariantsCache({ cacheDir, env: {} }), null);
  });

  test("returns null for a wrong schema version", () => {
    const cacheDir = tmpCacheDir();
    writeCache(cacheDir, { schema: 999, generatedAt: new Date().toISOString(), fingerprint: "", models: {} });
    assert.equal(readVariantsCache({ cacheDir, env: {} }), null);
  });

  test("reuses the in-process memo without re-reading when mtime is unchanged, and re-reads after a touch", () => {
    const cacheDir = tmpCacheDir();
    writeCache(cacheDir, { schema: VARIANTS_CACHE_SCHEMA, generatedAt: new Date().toISOString(), fingerprint: "", models: { "opencode/foo": ["low"] } });
    let reads = 0;
    const readFileFn = (p) => { reads++; return fs.readFileSync(p, "utf8"); };
    readVariantsCache({ cacheDir, env: {}, readFileFn });
    readVariantsCache({ cacheDir, env: {}, readFileFn });
    assert.equal(reads, 1);
    writeCache(cacheDir, { schema: VARIANTS_CACHE_SCHEMA, generatedAt: new Date().toISOString(), fingerprint: "", models: { "opencode/foo": ["low", "high"] } });
    const result = readVariantsCache({ cacheDir, env: {}, readFileFn });
    assert.equal(reads, 2);
    assert.deepEqual(result.get("opencode/foo"), ["low", "high"]);
  });
});

describe("refreshVariantsCache()", () => {
  test("writes the file atomically via a temp file + rename", async () => {
    const cacheDir = tmpCacheDir();
    const renamed = [];
    await refreshVariantsCache({
      cacheDir,
      env: {},
      listModelVariantsFn: async () => new Map([["opencode/foo", ["low", "high"]]]),
      writeFileFn: (p, data) => fs.writeFileSync(p, data),
      renameFn: (from, to) => { renamed.push([from, to]); fs.renameSync(from, to); },
    });
    assert.equal(renamed.length, 1);
    assert.ok(renamed[0][0].includes(".tmp"));
    const result = readVariantsCache({ cacheDir, env: {} });
    assert.deepEqual(result.get("opencode/foo"), ["low", "high"]);
  });

  test("single-flights concurrent refreshes for the same cacheDir", async () => {
    const cacheDir = tmpCacheDir();
    let calls = 0;
    const listModelVariantsFn = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return new Map(); };
    await Promise.all([
      refreshVariantsCache({ cacheDir, env: {}, listModelVariantsFn }),
      refreshVariantsCache({ cacheDir, env: {}, listModelVariantsFn }),
    ]);
    assert.equal(calls, 1);
  });

  test("a failed refresh does not throw and leaves the previous file in place", async () => {
    const cacheDir = tmpCacheDir();
    writeCache(cacheDir, { schema: VARIANTS_CACHE_SCHEMA, generatedAt: new Date().toISOString(), fingerprint: "", models: { "opencode/foo": ["low"] } });
    await assert.doesNotReject(refreshVariantsCache({ cacheDir, env: {}, listModelVariantsFn: async () => { throw new Error("boom"); } }));
    const result = readVariantsCache({ cacheDir, env: {} });
    assert.deepEqual(result.get("opencode/foo"), ["low"]);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "VariantsCache|readVariantsCache|refreshVariantsCache"`
Expected: FAIL — `src/variants-cache.js` does not exist yet.

- [ ] **Step 3: Export `modelsCacheFingerprint` from `tasks.js`**

In `src/tasks.js`, change the existing `function modelsCacheFingerprint(env = {})` (line 4707) to `export function modelsCacheFingerprint(env = {})`. It has no other callers outside `tasks.js` today, so this is a pure export-visibility change — verify with `rg -n "modelsCacheFingerprint" src/*.js` that only `tasks.js` itself calls it before and after.

- [ ] **Step 4: Implement `src/variants-cache.js`**

```js
import fs from "node:fs";
import path from "node:path";
import { modelsCacheFingerprint } from "./tasks.js";

export const VARIANTS_CACHE_SCHEMA = 1;
export const DEFAULT_VARIANT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILENAME = "opencode-variants.json";

// Per-cacheDir memo, the same shape as config.js's `_configCache`: keyed
// on the file's mtime, so repeated reads in the same process only stat
// (cheap) instead of re-reading and re-parsing every dispatch.
const _memo = new Map();

/** @param {string} cacheDir @returns {string} */
function cacheFilePath(cacheDir) {
  return path.join(cacheDir, CACHE_FILENAME);
}

/**
 * Synchronous, mtime-memoized read of the opencode variants cache. Returns
 * `null` on any reason the caller should treat the table as absent: no
 * file, malformed JSON, wrong schema, stale by `ttlMs`, or a fingerprint
 * that no longer matches `env` (different credentials can expose a
 * different model catalog). A `null` return is never an error -- callers
 * fall back to sending no variant flag.
 * @param {{cacheDir: string, env: NodeJS.ProcessEnv, ttlMs?: number, statFn?: (p: string) => {mtimeMs: number}, readFileFn?: (p: string) => string}} params
 * @returns {Map<string, string[]> | null}
 */
export function readVariantsCache({ cacheDir, env, ttlMs = DEFAULT_VARIANT_CACHE_TTL_MS, statFn = fs.statSync, readFileFn = (p) => fs.readFileSync(p, "utf8") }) {
  const filePath = cacheFilePath(cacheDir);
  let mtimeMs;
  try {
    mtimeMs = statFn(filePath).mtimeMs;
  } catch {
    return null;
  }
  if (Date.now() - mtimeMs > ttlMs) return null;
  const cached = _memo.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return checkFingerprint(cached.result, env);
  let parsed;
  try {
    parsed = JSON.parse(readFileFn(filePath));
  } catch {
    return null;
  }
  if (parsed.schema !== VARIANTS_CACHE_SCHEMA || typeof parsed.models !== "object" || parsed.models === null) return null;
  const result = { fingerprint: parsed.fingerprint, models: new Map(Object.entries(parsed.models)) };
  _memo.set(filePath, { mtimeMs, result });
  return checkFingerprint(result, env);
}

/** @param {{fingerprint: string, models: Map<string, string[]>}} result @param {NodeJS.ProcessEnv} env @returns {Map<string, string[]> | null} */
function checkFingerprint(result, env) {
  return result.fingerprint === modelsCacheFingerprint(env) ? result.models : null;
}

// Single-flight per cacheDir: a daemon startup warm and its first 24h
// interval tick landing at the same moment must not shell out twice.
const _inFlight = new Map();

/**
 * Refreshes the opencode variants cache by shelling out (via the injected
 * `listModelVariantsFn`, normally `opencodeExecutor().listModelVariantsFn`)
 * and writing the result atomically (temp file + rename, so a concurrent
 * `readVariantsCache()` never observes a half-written file). Never throws:
 * a failed refresh logs nothing itself (the caller decides how to log) and
 * simply leaves whatever file was already on disk in place.
 * @param {{cacheDir: string, env: NodeJS.ProcessEnv, listModelVariantsFn: (env: NodeJS.ProcessEnv) => Promise<Map<string, string[]>>, writeFileFn?: (p: string, data: string) => void, renameFn?: (from: string, to: string) => void, mkdirFn?: (p: string) => void}} params
 * @returns {Promise<void>}
 */
export async function refreshVariantsCache({ cacheDir, env, listModelVariantsFn, writeFileFn = fs.writeFileSync, renameFn = fs.renameSync, mkdirFn = (p) => fs.mkdirSync(p, { recursive: true }) }) {
  const filePath = cacheFilePath(cacheDir);
  let inFlight = _inFlight.get(filePath);
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const models = await listModelVariantsFn(env);
        const body = {
          schema: VARIANTS_CACHE_SCHEMA,
          generatedAt: new Date().toISOString(),
          fingerprint: modelsCacheFingerprint(env),
          models: Object.fromEntries(models),
        };
        mkdirFn(cacheDir);
        const tmpPath = `${filePath}.tmp.${process.pid}`;
        writeFileFn(tmpPath, JSON.stringify(body, null, 2));
        renameFn(tmpPath, filePath);
      } catch {
        // Leave the previous file (if any) in place. The caller's own
        // startup/interval hook is responsible for surfacing this via
        // stderr if it wants to; this module stays silent by design so
        // it has no test-visible logging seam to inject.
      } finally {
        _inFlight.delete(filePath);
      }
    })();
    _inFlight.set(filePath, inFlight);
  }
  await inFlight;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "VariantsCache|readVariantsCache|refreshVariantsCache"`
Expected: PASS (10 tests)

- [ ] **Step 6: Commit**

```bash
git add src/variants-cache.js src/variants-cache.test.js src/tasks.js
git commit -m "feat(variants): add the daily-refreshed opencode variants cache"
```

---

## Task 5: `--model` required on a fresh dispatch; delete `executor.defaultModel`

**Files:**
- Modify: `src/executor.js:80` (typedef), `:214` (pi), `:320` (opencode)
- Modify: `src/tasks.js:2108-2119` (`buildDispatchTask`)
- Modify: `src/executor.test.js:31` (delete the assertion)
- Modify test fixtures: `src/tasks.executor.test.js` (11 occurrences), `src/tasks.failure.test.js` (3), `src/tasks.summarize.test.js` (2), `src/tasks.dispatch.test.js` (1, plus the tests below)
- Test: `src/tasks.dispatch.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildDispatchTask()` throws `error: --model is required` / `error: no task found for session id "..." to inherit a model from` instead of silently falling back. `WorkerExecutor` no longer has a `defaultModel` field.

- [ ] **Step 1: Write the failing tests**

Replace the two tests in `src/tasks.dispatch.test.js` that assert the old fallback behavior:

```js
  test("dispatch without --model and without a resolvable --session-id throws", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" }),
      /error: --model is required\nhelp: name the model/
    );
  });

  test("an unrecognized --session-id with no --model throws, naming the session id", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    assert.throws(
      () => mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_never_seen", executor: "opencode" }),
      /error: no task found for session id "ses_never_seen" to inherit a model from\nhelp:/
    );
  });
```

Delete the test named `"defaults to openai/gpt-5.6-luna --variant high when no model is given"` and the test named `"an unrecognized --session-id with no --model still falls back to the hardcoded default"` (superseded by the two above).

Update the `fakePi` fixture object at `src/tasks.dispatch.test.js:89` (the "reuses that exact instance" test) to delete its `defaultModel: "fake-pi/marker-model",` line — that test's assertions never depend on `defaultModel`, only on `buildSpawnArgs`'s `--fake-pi-marker` sentinel, so this is a pure fixture trim, not a behavior change.

- [ ] **Step 2: Run the new/changed tests to verify they fail**

Run: `npm test -- --test-name-pattern "model is required|no task found for session id"`
Expected: FAIL — `buildDispatchTask` still silently falls back.

- [ ] **Step 3: Delete `defaultModel` from the executor typedef and both implementations**

In `src/executor.js`, remove `@property {string} defaultModel` from the `WorkerExecutor` typedef (line 80), and remove the `defaultModel: "minimax/MiniMax-M2.7",` line (pi, ~214) and `defaultModel: "openai/gpt-5.6-luna",` line (opencode, ~320).

In `src/executor.test.js`, delete the line `assert.equal(ex.defaultModel, PI_MODEL);` from the `"exposes pi identity and defaults"` test — leave the other three assertions in that test (`id`, `taskIdPrefix`, `errorBucketPrefix`) as-is.

- [ ] **Step 4: Make `buildDispatchTask` throw instead of falling back**

In `src/tasks.js`, replace the body of `buildDispatchTask` (lines 2108-2119):

```js
function buildDispatchTask({ id, directory, prompt, model, executor, priorSessionTask, variant, sessionId, originSessionId, internal, finalMarker, role, logPath, class: taskClass, parentTaskId = null }) {
  if (!model && !priorSessionTask && sessionId) {
    throw new Error(`error: no task found for session id "${sessionId}" to inherit a model from\nhelp: pass --model explicitly, or check the session id with taskferry list`);
  }
  if (!model && !priorSessionTask) {
    throw new Error(`error: --model is required\nhelp: name the model, e.g. --model provider/model (opencode models or pi --list-models lists what's available); to resume an existing session and inherit its model, pass --session-id instead`);
  }
  const resolvedModel = model || priorSessionTask.model;
  return {
    id,
    directory,
    logPath,
    role,
    status: "queued",
    model: resolvedModel,
    executorId: executor.id,
    variant: null, // set by Task 6 (resolveVariant wiring); this task only removes the model fallback
    sessionId: sessionId || null,
    originSessionId: originSessionId || null,
    pid: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    signal: null,
    promptPreview: prompt.length > 200 ? prompt.slice(0, 200) + "…" : prompt,
    promptTotalChars: prompt.length > 200 ? prompt.length : null,
    spawnError: null,
    cancelRequested: false,
    internal: internal === true,
    failureReason: null,
    failureDetail: null,
    incomplete: false,
    finalMarker: finalMarker == null ? null : finalMarker,
```

(Leave every field after `finalMarker` untouched — only the model-resolution preamble and the `variant` line change in this step. Task 6 replaces the `variant: null` placeholder with the real `resolveVariant()` call once the cache-reading `ctx` is threaded in.)

Note the `!model && !priorSessionTask && sessionId` check must come first: a `--session-id` that matches nothing is a more specific, more useful error than the generic "--model is required," and both share the "neither model nor priorSessionTask" precondition.

- [ ] **Step 5: Trim `defaultModel` out of every test fixture**

Run `rg -n "defaultModel" src/*.test.js` and delete every remaining `defaultModel: ...,` line it reports (`tasks.executor.test.js`, `tasks.failure.test.js`, `tasks.summarize.test.js`). These are fake-executor object literals passed as `defaultExecutor` to `makeManager()`; none of the assertions in those files reference `.defaultModel`, so removing the field is a pure trim — confirm with `rg -n "\.defaultModel" src/*.test.js` returning no hits afterward.

- [ ] **Step 6: Run the full dispatch, executor, and failure test files**

Run: `npm test src/tasks.dispatch.test.js src/executor.test.js src/tasks.executor.test.js src/tasks.failure.test.js src/tasks.summarize.test.js`
Expected: PASS, all tests. If any test besides the ones already updated in Step 1 still asserts a fallback model or the hardcoded `"high"` variant, fix that test now rather than leaving it red for Task 6 — the `variant: null` placeholder from Step 4 means any such test currently expects a non-null variant will fail here, which is expected and resolved in Task 6.

- [ ] **Step 7: Commit**

```bash
git add src/executor.js src/executor.test.js src/tasks.js src/tasks.dispatch.test.js src/tasks.executor.test.js src/tasks.failure.test.js src/tasks.summarize.test.js
git commit -m "feat(cli)!: require --model on a fresh dispatch, drop executor.defaultModel

BREAKING CHANGE: dispatching without --model and without a --session-id
that resolves to a prior task now errors with '--model is required'
instead of silently falling back to a hardcoded per-executor default
model. Pass --model explicitly, or resume via --session-id to inherit
a prior task's model."
```

---

## Task 6: Wire `resolveVariant()` and the variants cache into `dispatchTask`

**Files:**
- Modify: `src/tasks.js` (`resolveStringOptions` ~3715, `buildDispatchTask` line touched in Task 5, `dispatchTask` ~6224-6247, `bootstrapManagerContext` ~4516)
- Modify: `src/tasks.test-helpers.js` (`buildManagerOptions`, ~245)
- Test: `src/tasks.dispatch.test.js`

**Interfaces:**
- Consumes: `resolveVariant()` (Task 2), `readVariantsCache()` (Task 4).
- Produces: a fresh dispatch (or advisor call) with no explicit `--variant` now requests the resolved-highest level; the task record's `variant` field reflects what was actually requested (`"max"` for pi, a ranked opencode key, or `null`).

- [ ] **Step 1: Write the failing tests**

Add to `src/tasks.dispatch.test.js`:

```js
  test("omitted --variant on pi requests max (highest), by default", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: MIMIMAX_MODEL, executor: "pi" });
    assert.ok(captured.includes("--thinking"));
    assert.equal(captured[captured.indexOf("--thinking") + 1], "max");
  });

  test("omitted --variant on opencode resolves the model's ranked-highest cached variant", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (_cmd, args) => { captured = args; return fakeChild(); },
      opencodeVariantsTable: new Map([[LUNA_MODEL, ["low", "high", "max"]]]),
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode" });
    assert.deepEqual(captured.slice(captured.indexOf("-m")), ["-m", LUNA_MODEL, "--variant", "max", "--", "hi"]);
  });

  test("omitted --variant on opencode with no cache entry for the model sends no flag", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); }, opencodeVariantsTable: new Map() });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode" });
    assert.equal(captured.includes("--variant"), false);
  });

  test("explicit --variant is never reinterpreted, even against a cached table", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (_cmd, args) => { captured = args; return fakeChild(); },
      opencodeVariantsTable: new Map([[LUNA_MODEL, ["low", "high", "max"]]]),
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, variant: "low", executor: "opencode" });
    assert.equal(captured[captured.indexOf("--variant") + 1], "low");
  });

  test("a resumed session with no --variant inherits the resumed task's own variant, not a fresh highest", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: MIMIMAX_MODEL, variant: "low", sessionId: "ses_v", executor: "opencode" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_v", executor: "opencode" });
    assert.equal(captured[captured.indexOf("--variant") + 1], "low");
  });

  test("a configured defaultVariant of a concrete level is requested verbatim when --variant is omitted", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); }, defaultVariant: "medium" });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: MIMIMAX_MODEL, executor: "pi" });
    assert.equal(captured[captured.indexOf("--thinking") + 1], "medium");
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "highest|ranked-highest|reinterpreted|inherits the resumed"`
Expected: FAIL — `opencodeVariantsTable`/`defaultVariant` are not recognized test options yet, and `buildDispatchTask` still sets `variant: null` unconditionally (from Task 5's placeholder).

- [ ] **Step 3: Add `defaultVariant` to `resolveStringOptions`**

In `src/tasks.js`, extend `resolveStringOptions` (~line 3715):

```js
function resolveStringOptions(rawOptions) {
  const config = rawOptions.config || {};
  return {
    activitySummaryModel: rawOptions.activitySummaryModel ?? process.env.TASKFERRY_SUMMARY_MODEL ?? config.summaryModel ?? DEFAULT_SUMMARY_MODEL,
    defaultVariant: rawOptions.defaultVariant ?? process.env.TASKFERRY_DEFAULT_VARIANT ?? config.defaultVariant ?? "highest",
  };
}
```

- [ ] **Step 4: Add a test-only `opencodeVariantsTable` seam and thread `defaultVariant` through `buildManagerOptions`**

In `src/tasks.test-helpers.js`, add two lines inside `buildManagerOptions()` (near the `defaultExecutor` passthrough at line 245):

```js
    ...passthroughIfSet({ defaultVariant: options.defaultVariant }, "defaultVariant", "defaultVariant"),
    ...passthroughIfSet({ opencodeVariantsTable: options.opencodeVariantsTable }, "opencodeVariantsTable", "opencodeVariantsTable"),
```

`opencodeVariantsTable` is a test-only injection seam (a real daemon reads this from `readVariantsCache()` instead — see Step 6): when set, `createTaskManager()` treats it as the resolved table directly, bypassing the file entirely. Wire this into `resolveCoreOptions()` in `src/tasks.js` (same function that already resolves `defaultExecutor`, `listModelsFn`, etc.):

```js
function resolveCoreOptions(rawOptions) {
  const config = rawOptions.config || {};
  return {
    spawnFn: rawOptions.spawnFn ?? spawn,
    killFn: rawOptions.killFn ?? /** @type {(pid: number, signal: NodeJS.Signals) => void} */ ((pid, signal) => process.kill(pid, signal)),
    stateDir: rawOptions.stateDir ?? DEFAULT_STATE_DIR,
    defaultExecutor: rawOptions.defaultExecutor ?? resolveExecutor(process.env.TASKFERRY_DEFAULT_EXECUTOR || config.defaultExecutor),
    listModelsFn: rawOptions.listModelsFn ?? opencodeExecutor().listModelsFn,
    // Test-only direct injection of the resolved opencode variants table,
    // bypassing readVariantsCache()/the cache file entirely. A real
    // manager passes undefined here and resolves the table per-dispatch
    // from disk instead (see dispatchTask's ctx.readOpencodeVariants).
    opencodeVariantsTable: rawOptions.opencodeVariantsTable,
    platform: rawOptions.platform ?? process.platform,
    onEvent: rawOptions.onEvent,
    config,
  };
}
```

- [ ] **Step 5: Replace the `variant: null` placeholder in `buildDispatchTask` with the real resolution**

Add a new parameter to `buildDispatchTask`'s destructured params: `resolveOpencodeVariants` (a function `(model: string) => string[]`, always present — see Step 6 for what the real one does), then replace this task's earlier `variant: null` placeholder:

```js
function buildDispatchTask({ id, directory, prompt, model, executor, priorSessionTask, variant, sessionId, originSessionId, internal, finalMarker, role, logPath, class: taskClass, parentTaskId = null, defaultVariant, resolveOpencodeVariants }) {
  if (!model && !priorSessionTask && sessionId) {
    throw new Error(`error: no task found for session id "${sessionId}" to inherit a model from\nhelp: pass --model explicitly, or check the session id with taskferry list`);
  }
  if (!model && !priorSessionTask) {
    throw new Error(`error: --model is required\nhelp: name the model, e.g. --model provider/model (opencode models or pi --list-models lists what's available); to resume an existing session and inherit its model, pass --session-id instead`);
  }
  const resolvedModel = model || priorSessionTask.model;
  // Precedence: explicit --variant > resumed session's own variant > the
  // configured defaultVariant sentinel/level. Only the third case ever
  // needs resolveVariant() -- an explicit or inherited value is already
  // concrete and passes straight through resolveVariant() as a no-op.
  const requestedVariant = variant || priorSessionTask?.variant || defaultVariant;
  const resolvedVariant = resolveVariant({
    executorId: executor.id,
    requested: requestedVariant,
    opencodeVariants: executor.id === "opencode" ? resolveOpencodeVariants(resolvedModel) : undefined,
  });
  return {
    id,
    directory,
    logPath,
    role,
    status: "queued",
    model: resolvedModel,
    executorId: executor.id,
    variant: resolvedVariant,
    sessionId: sessionId || null,
```

Add `import { resolveVariant } from "./variants.js";` to `src/tasks.js`'s import block.

- [ ] **Step 6: Thread `defaultVariant` and a variants-table reader through `dispatchTask`/`ctx`**

In `src/tasks.js`, update `dispatchTask`'s `ctx` typedef and body (~line 6224-6247) to accept and pass through `defaultVariant` and `resolveOpencodeVariants`:

```js
 * @param {{ensureStateLoaded: () => void, tasks: Map<string, Task>, defaultExecutor: import("./executor.js").WorkerExecutor, LOG_DIR: string, persistTask: (taskId: string) => void, pendingLaunches: Map<string, LaunchSpec>, providerQueues: Map<string, ProviderQueue>, launchQueuedTasks: () => void, defaultVariant: string, resolveOpencodeVariants: (model: string) => string[]}} ctx
 */
function dispatchTask(params, ctx) {
  const { prompt, directory, model, variant, sessionId, internal = false, finalMarker = null, originSessionId, noSandbox = false, noOverlay = false, allowedDirs: dispatchAllowedDirs, rwBind: dispatchRwBind, roBind: dispatchRoBind, executor: executorName, env, role = "dispatch", class: taskClass = null, parentTaskId = null } = params;
  const effectiveRwBind = [...new Set([...(dispatchRwBind ?? []), ...(dispatchAllowedDirs ?? [])])];
  ctx.ensureStateLoaded();
  const priorSessionTask = resolvePriorSessionTask(ctx.tasks, sessionId, executorName);
  const executor = resolveDispatchExecutor(priorSessionTask, executorName, ctx.defaultExecutor);
  validateDispatchParameters({ prompt, directory });
  validateDispatchFinalMarker(finalMarker);
  const normalizedDirectory = resolveDispatchDirectory(directory);
  const projectConfig = loadProjectConfig(normalizedDirectory);
  const dispatchPrompt = role === "dispatch" && !noOverlay && projectConfig.check
    ? `${prompt}${verificationPromptBlock(projectConfig.check)}`
    : prompt;
  const id = `oc_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const logPath = path.join(ctx.LOG_DIR, `${id}.ndjson`);
  const task = buildDispatchTask({ id, model, executor, priorSessionTask, variant, sessionId, originSessionId, internal, finalMarker, role, logPath, parentTaskId, class: taskClass, prompt: dispatchPrompt, directory: normalizedDirectory, defaultVariant: ctx.defaultVariant, resolveOpencodeVariants: ctx.resolveOpencodeVariants });
```

Then update the `ctx.dispatch` wiring where `dispatchTask` is invoked (search for the line building this ctx object — the one shown earlier at `ctx.dispatch: (params) => dispatchTask(params, { ... })`), adding two fields:

```js
    dispatch: (params) => dispatchTask(params, { ensureStateLoaded: () => ctx.helpers.ensureStateLoaded(), tasks: ctx.maps.tasks, defaultExecutor: ctx.opts.defaultExecutor, LOG_DIR: ctx.paths.LOG_DIR, persistTask: (taskId) => ctx.helpers.persistTask(taskId), pendingLaunches: ctx.maps.pendingLaunches, providerQueues: ctx.maps.providerQueues, launchQueuedTasks: () => ctx.helpers.launchQueuedTasks(), defaultVariant: ctx.opts.defaultVariant, resolveOpencodeVariants: ctx.helpers.resolveOpencodeVariants }),
```

Find the same call site used by `dispatchAdvisorTask` (advisor funnels through `dispatch()`, per the spec — confirm this is the same `ctx.dispatch` reference, not a separate one, by checking `dispatchAdvisorTask`'s body around `src/tasks.js:2583`) and apply the identical two-field addition if it builds its own separate ctx object rather than reusing `ctx.dispatch`.

- [ ] **Step 7: Add `ctx.helpers.resolveOpencodeVariants`, backed by `opencodeVariantsTable` (tests) or `readVariantsCache()` (real)**

In `src/tasks.js`, in the function that builds `ctx.helpers` (search for where other `ctx.helpers.X` closures like `sweepOrphanedPromptFiles` are defined), add:

```js
  resolveOpencodeVariants: (model) => {
    if (opts.opencodeVariantsTable) return opts.opencodeVariantsTable.get(model) ?? [];
    const table = readVariantsCache({ cacheDir: opts.cacheDir, env: process.env });
    return table?.get(model) ?? [];
  },
```

Add `import { readVariantsCache } from "./variants-cache.js";` to `src/tasks.js`'s import block. This closure is what Task 3's real daemon path calls; Task 6's tests use the `opencodeVariantsTable` short-circuit exclusively, so no test in this task touches `readVariantsCache()` or the filesystem.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test src/tasks.dispatch.test.js`
Expected: PASS, all tests (existing + the 6 new ones from Step 1).

- [ ] **Step 9: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS. Pay particular attention to any test in `tasks.executor.test.js`/`tasks.advisor.test.js` asserting a specific `--thinking`/`--variant` argv shape with no explicit `variant` passed to `dispatch()` — those now resolve through `defaultVariant: "highest"` and will need an explicit `variant:` in the test's `dispatch()` call (pi tests) or an `opencodeVariantsTable` fixture (opencode tests) if they don't already pass one.

- [ ] **Step 10: Commit**

```bash
git add src/tasks.js src/tasks.test-helpers.js src/tasks.dispatch.test.js
git commit -m "feat(cli): default an omitted --variant to the model's highest supported level"
```

---

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

## Task 8: Documentation sweep

**Files:**
- Modify: `docs/cli-reference.md:57-58`, `:135`, `:137`
- Modify: `docs/config.md:57-61`
- Modify: `docs/daemon.md:375` (append two entries after the existing list)
- Modify: `src/command-specs.js` (dispatch's `--model`/`--variant` option text)
- Modify: `skills/using-taskferry/SKILL.md` (canonical only, then regenerate)
- Modify: `README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `docs/cli-reference.md`**

Replace line 57:

```
| `--model <id>` | `provider/model`, e.g. `opencode-go/minimax-m3`. Run `opencode models` to list installed models. Required unless resuming via `--session-id` with a matching prior task, in which case the model is inherited from that task |
```

Replace line 58:

```
| `--variant <name>` | Reasoning-effort override. Precedence when omitted: the resumed session's own variant (on a `--session-id` resume) wins, otherwise the configured `defaultVariant` (default `highest`) applies -- see `docs/config.md`. `highest` resolves to `--thinking max` on pi (pi clamps to the model's real ceiling itself) or the model's highest cached opencode variant, sending no flag at all if the model has none. Accepted concrete values: pi takes `off`, `minimal`, `low`, `medium`, `high`, `xhigh`; opencode's depend on the model and are never validated by taskferry -- an unrecognized value is silently ignored by opencode itself |
```

Replace line 135 (`advisor`'s `--model <id>` row) — no change needed; `advisor` already requires `--model`, but drop any stale cross-reference to a default if present. Verify by reading the current line before editing; if it already reads "Required, no default; the caller picks the advisor," leave it as-is.

Replace line 137:

```
| `--variant <name>` | Optional reasoning-effort override. Same omitted-flag resolution chain as `dispatch`'s `--variant` above (resumed session, then `defaultVariant`, default `highest`) |
```

- [ ] **Step 2: Update `docs/config.md`**

Add a row after the `defaultExecutor` row (line 57):

```
| `defaultVariant` | `TASKFERRY_DEFAULT_VARIANT` | string (`highest`, or one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) | `highest` |
```

- [ ] **Step 3: Update `docs/daemon.md`'s "Things that look like bugs but aren't"**

Append two entries after the existing last bullet in that section (find it with `rg -n "## Things that look like bugs but aren't" -A 200 docs/daemon.md` to locate the true end of the list before editing, since the list has grown since this plan was written):

```markdown
- A pi dispatch's task record shows `variant: "max"` but the actual provider
  ran at, say, `high`. Expected: pi's own `clampThinkingLevel()` clamps a
  requested level to the model's real ceiling at runtime, including on
  extension providers (`ollama/*`, custom pi providers) taskferry cannot see
  the registry for. taskferry records what was requested, not what pi
  clamped it to, because it has no way to observe the clamp.
- A model dispatches with no `--variant` flag even though `defaultVariant`
  is `highest`, until up to 24h after that model first became available
  through opencode. Expected: the opencode variants cache
  (`<cacheDir>/opencode-variants.json`) refreshes once at daemon startup and
  once every 24h afterward, never synchronously on the dispatch path (a
  fresh `opencode models --verbose` shell-out costs ~3-4s, which would
  otherwise block the daemon's single thread on every affected dispatch).
  A model absent from the cache resolves to no variant flag, not an error.
```

- [ ] **Step 4: Update `src/command-specs.js`**

In the `dispatch` entry's `options` object, change:

```js
"--model <id>": "required unless resuming via --session-id with a matching prior task",
"--variant <name>": "optional; defaults to the model's highest supported thinking level (see defaultVariant in docs/config.md)",
```

- [ ] **Step 5: Regenerate the skill and sweep the README**

Edit `skills/using-taskferry/SKILL.md` (canonical copy) to state `--model` is required for a fresh dispatch and that an omitted `--variant` now means "this model's hardest thinking level," then run `npm run skill:generate` and commit the regenerated integration copies alongside it. Run `rg -n "taskferry dispatch" README.md` and add `--model <provider/model>` to any example invocation that currently omits it.

- [ ] **Step 6: Commit**

```bash
git add docs/cli-reference.md docs/config.md docs/daemon.md src/command-specs.js skills/using-taskferry/SKILL.md README.md
git commit -m "docs: document required --model and the highest-thinking default variant"
```

---

## Task 9: Post-merge cleanup

**Files:** none modified in this task beyond housekeeping moves.

- [ ] **Step 1: Move all three specs to `.completed`**

```bash
mkdir -p .superpowers/.completed/specs
git mv .superpowers/specs/2026-07-28-default-variant-effort-design.md .superpowers/.completed/specs/
git mv .superpowers/specs/2026-07-31-required-model-and-default-variant-design.md .superpowers/.completed/specs/
git mv .superpowers/specs/2026-08-09-highest-thinking-default-design.md .superpowers/.completed/specs/
git mv .superpowers/plans/2026-08-09-highest-thinking-default.md .superpowers/.completed/plans/
git commit -m "chore: archive the highest-thinking-default specs and plan"
```

- [ ] **Step 2: Sweep open issues**

Run `gh-axi issue view 137` and `gh-axi issue view 236`, re-read each against the actual merged diff (per the repo's "back non-obvious claims with code" rule — do not close on title-match alone):
- #137 ("`--variant` can't turn reasoning off") — check whether `defaultVariant: "off"` plus an explicit `--variant off` (pi) now expresses this. If yes, close with `gh-axi issue close 137 --reason completed --comment "..."` citing the config addition.
- #236 (codify pi's effort vocabulary as canonical config syntax) — check whether `KNOWN_VARIANT_LEVELS` in `src/config.js` and this plan's design fully answer it, or only partially (e.g. if the issue also asked for something this plan explicitly scoped out). Close or comment accordingly.

- [ ] **Step 3: Update the retiring memory entry**

The `feedback_explicit_variant_naming` memory (under this project's Claude
memory directory — `~/.claude/projects/<this-workspace's-slug>/memory/`; look
it up via that directory's `MEMORY.md` index rather than a hardcoded path)
says to always pass `--variant` explicitly, especially for cheap models, because there was previously no good default. Update it to note that an omitted `--variant` now defaults to the model's highest supported level (`defaultVariant: "highest"`), so the explicit-pass rule is now about *choosing a lower* effort deliberately, not about avoiding an absent default.
