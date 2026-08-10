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
