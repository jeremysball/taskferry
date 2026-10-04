import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { modelsCacheFingerprint } from "./tasks.js";
import { detectOpencodeCliMajor } from "./opencode-version.js";

export const VARIANTS_CACHE_SCHEMA = 2;
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
  if (cached && cached.mtimeMs === mtimeMs) return builtForCurrentMajor(cached.builtMajor) ? checkFingerprint(cached.result, env) : null;
  let parsed;
  try {
    parsed = JSON.parse(readFileFn(filePath));
  } catch {
    return null;
  }
  if (parsed.schema !== VARIANTS_CACHE_SCHEMA || typeof parsed.models !== "object" || parsed.models === null) return null;
  // A cache file written before the field existed was necessarily built on
  // 1.x: 2.x has no `models --verbose` to build one from.
  const builtMajor = typeof parsed.opencodeMajor === "number" ? parsed.opencodeMajor : 1;
  const result = { fingerprint: parsed.fingerprint, models: new Map(Object.entries(parsed.models)) };
  _memo.set(filePath, { mtimeMs, result, builtMajor });
  return builtForCurrentMajor(builtMajor) ? checkFingerprint(result, env) : null;
}

/**
 * A cache built under one opencode major must not be read under another:
 * 2.x has no per-model variants listing, so a 1.x cache would hand 2.x
 * dispatches variant names nothing on 2.x vouched for. Checked on the memo
 * path too, since the memo outlives an opencode upgrade. An unknown current
 * major (no probe has succeeded yet) does not reject; `prepareLaunch` fails
 * the dispatch on that case before anything spawns.
 * @param {number} builtMajor
 * @returns {boolean}
 */
function builtForCurrentMajor(builtMajor) {
  const currentMajor = detectOpencodeCliMajor();
  return currentMajor === null || currentMajor === builtMajor;
}

/**
 * `modelsCacheFingerprint()` returns a `NAME=value` line per matching env
 * var (API keys, `OPENCODE_AUTH_CONTENT`, etc.) -- fine for an in-memory
 * comparison key, but this cache's fingerprint field is written to a plaintext
 * JSON file on disk, so the raw credential values must never land there.
 * SHA-256 keeps the same "does this env produce the same catalog" equality
 * check without persisting anything reversible to the secret itself.
 * Exported (only) so tests can build a matching on-disk fixture without
 * duplicating the hash algorithm.
 * @param {NodeJS.ProcessEnv} env @returns {string}
 */
export function hashFingerprint(env) {
  return createHash("sha256").update(modelsCacheFingerprint(env)).digest("hex");
}

/** @param {{fingerprint: string, models: Map<string, string[]>}} result @param {NodeJS.ProcessEnv} env @returns {Map<string, string[]> | null} */
function checkFingerprint(result, env) {
  return result.fingerprint === hashFingerprint(env) ? result.models : null;
}

// Single-flight per (cacheDir, env fingerprint): a daemon startup warm and
// its first 24h interval tick landing at the same moment must not shell out
// twice, but two refreshes for the *same* cacheDir under two different
// caller envs (different credentials/base URLs) are genuinely different
// requests -- keying on cacheDir alone would let the second caller's
// fingerprint silently ride along on the first caller's in-flight result
// and never actually populate its own catalog.
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
  const fingerprint = hashFingerprint(env);
  const inFlightKey = `${filePath}::${fingerprint}`;
  let inFlight = _inFlight.get(inFlightKey);
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const currentMajor = detectOpencodeCliMajor();
        // opencode 2.x has no `models --verbose`, so there is nothing to list.
        if (currentMajor !== null && currentMajor >= 2) {
          return;
        }
        const models = await listModelVariantsFn(env);
        const body = {
          fingerprint,
          schema: VARIANTS_CACHE_SCHEMA,
          generatedAt: new Date().toISOString(),
          opencodeMajor: currentMajor,
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
        _inFlight.delete(inFlightKey);
      }
    })();
    _inFlight.set(inFlightKey, inFlight);
  }
  await inFlight;
}
