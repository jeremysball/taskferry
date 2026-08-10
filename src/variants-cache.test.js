import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readVariantsCache, refreshVariantsCache, hashFingerprint, VARIANTS_CACHE_SCHEMA } from "./variants-cache.js";

const CACHE_FILENAME = "opencode-variants.json";
const MODEL_FOO = "opencode/foo";

function tmpCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axi-variants-cache-"));
}

function writeCache(cacheDir, body) {
  fs.writeFileSync(path.join(cacheDir, CACHE_FILENAME), JSON.stringify(body));
}

describe("readVariantsCache()", () => {
  test("returns null when the file is absent", () => {
    assert.equal(readVariantsCache({ cacheDir: tmpCacheDir(), env: {} }), null);
  });

  test("returns the model map from a fresh, matching-fingerprint file", () => {
    const cacheDir = tmpCacheDir();
    writeCache(cacheDir, { schema: VARIANTS_CACHE_SCHEMA, generatedAt: new Date().toISOString(), fingerprint: hashFingerprint({}), models: { [MODEL_FOO]: ["low", "high"] } });
    const result = readVariantsCache({ cacheDir, env: {} });
    assert.deepEqual(result.get(MODEL_FOO), ["low", "high"]);
  });

  test("returns null when older than ttlMs", () => {
    const cacheDir = tmpCacheDir();
    writeCache(cacheDir, { schema: VARIANTS_CACHE_SCHEMA, generatedAt: new Date().toISOString(), fingerprint: hashFingerprint({}), models: {} });
    const past = Date.now() - 1000;
    fs.utimesSync(path.join(cacheDir, CACHE_FILENAME), past / 1000, past / 1000);
    assert.equal(readVariantsCache({ cacheDir, env: {}, ttlMs: 500 }), null);
  });

  test("returns null when the fingerprint doesn't match the given env", () => {
    const cacheDir = tmpCacheDir();
    writeCache(cacheDir, { schema: VARIANTS_CACHE_SCHEMA, generatedAt: new Date().toISOString(), fingerprint: hashFingerprint({ OPENAI_API_KEY: "old" }), models: { [MODEL_FOO]: ["low"] } });
    assert.equal(readVariantsCache({ cacheDir, env: { OPENAI_API_KEY: "new" } }), null);
  });

  test("returns null for malformed JSON", () => {
    const cacheDir = tmpCacheDir();
    fs.writeFileSync(path.join(cacheDir, CACHE_FILENAME), "{not json");
    assert.equal(readVariantsCache({ cacheDir, env: {} }), null);
  });

  test("returns null for a wrong schema version", () => {
    const cacheDir = tmpCacheDir();
    writeCache(cacheDir, { schema: 999, generatedAt: new Date().toISOString(), fingerprint: hashFingerprint({}), models: {} });
    assert.equal(readVariantsCache({ cacheDir, env: {} }), null);
  });

  test("reuses the in-process memo without re-reading when mtime is unchanged, and re-reads after a touch", () => {
    const cacheDir = tmpCacheDir();
    writeCache(cacheDir, { schema: VARIANTS_CACHE_SCHEMA, generatedAt: new Date().toISOString(), fingerprint: hashFingerprint({}), models: { [MODEL_FOO]: ["low"] } });
    let reads = 0;
    const readFileFn = (p) => { reads++; return fs.readFileSync(p, "utf8"); };
    readVariantsCache({ cacheDir, readFileFn, env: {} });
    readVariantsCache({ cacheDir, readFileFn, env: {} });
    assert.equal(reads, 1);
    writeCache(cacheDir, { schema: VARIANTS_CACHE_SCHEMA, generatedAt: new Date().toISOString(), fingerprint: hashFingerprint({}), models: { [MODEL_FOO]: ["low", "high"] } });
    const result = readVariantsCache({ cacheDir, readFileFn, env: {} });
    assert.equal(reads, 2);
    assert.deepEqual(result.get(MODEL_FOO), ["low", "high"]);
  });
});

describe("refreshVariantsCache()", () => {
  test("writes the file atomically via a temp file + rename", async () => {
    const cacheDir = tmpCacheDir();
    const renamed = [];
    await refreshVariantsCache({
      cacheDir,
      listModelVariantsFn: async () => new Map([[MODEL_FOO, ["low", "high"]]]),
      writeFileFn: (p, data) => fs.writeFileSync(p, data),
      renameFn: (from, to) => { renamed.push([from, to]); fs.renameSync(from, to); },
      env: {},
    });
    assert.equal(renamed.length, 1);
    assert.ok(renamed[0][0].includes(".tmp"));
    const result = readVariantsCache({ cacheDir, env: {} });
    assert.deepEqual(result.get(MODEL_FOO), ["low", "high"]);
  });

  test("single-flights concurrent refreshes for the same cacheDir and env", async () => {
    const cacheDir = tmpCacheDir();
    let calls = 0;
    const listModelVariantsFn = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return new Map(); };
    await Promise.all([
      refreshVariantsCache({ cacheDir, listModelVariantsFn, env: {} }),
      refreshVariantsCache({ cacheDir, listModelVariantsFn, env: {} }),
    ]);
    assert.equal(calls, 1);
  });

  test("does NOT single-flight two concurrent refreshes for the same cacheDir under different envs", async () => {
    // Regression for the finding that dedup was keyed on cacheDir alone: a
    // second caller with different credentials must get its own listModelVariantsFn
    // call and its own resulting catalog, not silently ride the first caller's.
    const cacheDir = tmpCacheDir();
    const seenEnvs = [];
    const listModelVariantsFn = async (env) => {
      seenEnvs.push(env.OPENAI_API_KEY);
      await new Promise((r) => setTimeout(r, 10));
      return new Map([[MODEL_FOO, [env.OPENAI_API_KEY]]]);
    };
    await Promise.all([
      refreshVariantsCache({ cacheDir, listModelVariantsFn, env: { OPENAI_API_KEY: "key-a" } }),
      refreshVariantsCache({ cacheDir, listModelVariantsFn, env: { OPENAI_API_KEY: "key-b" } }),
    ]);
    assert.deepEqual(seenEnvs.sort(), ["key-a", "key-b"]);
  });

  test("never persists a raw credential value to the on-disk cache file", async () => {
    const cacheDir = tmpCacheDir();
    await refreshVariantsCache({
      cacheDir,
      listModelVariantsFn: async () => new Map([[MODEL_FOO, ["low"]]]),
      env: { OPENAI_API_KEY: "sk-super-secret-value" },
    });
    const raw = fs.readFileSync(path.join(cacheDir, CACHE_FILENAME), "utf8");
    assert.ok(!raw.includes("sk-super-secret-value"), "raw API key must never appear in the on-disk cache file");
  });

  test("a failed refresh does not throw and leaves the previous file in place", async () => {
    const cacheDir = tmpCacheDir();
    writeCache(cacheDir, { schema: VARIANTS_CACHE_SCHEMA, generatedAt: new Date().toISOString(), fingerprint: hashFingerprint({}), models: { [MODEL_FOO]: ["low"] } });
    await assert.doesNotReject(refreshVariantsCache({ cacheDir, listModelVariantsFn: async () => { throw new Error("boom"); }, env: {} }));
    const result = readVariantsCache({ cacheDir, env: {} });
    assert.deepEqual(result.get(MODEL_FOO), ["low"]);
  });
});
