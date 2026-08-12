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

