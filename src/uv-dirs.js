// Per-task uv dir layout, shared by the worker sandbox, the check gate, and
// the boot sweep in tasks.js. Split out of tasks.js so the derivation the
// worker and the gate must agree on lives in one small module.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { registerDeferredCleanup } from "./deferred-cleanup.js";
import { resolveInvokedPath } from "./paths.js";

// Per-task uv cache + tool dirs (<cacheDir>/uv-{cache,tools}/<taskId>)
// accumulate without bound across a long-lived install -- each uvx run pulls
// a full interpreter plus wheels, and a project that runs thousands of
// ferries reaches tens of GB. Reaped at real settlement
// (src/deferred-cleanup.js) and swept at boot. The two buckets the daemon
// owns for cleanliness.
export const UV_DIR_BUCKETS = ["uv-cache", "uv-tools"];
// Hash length used to namespace new uv dirs by their owning state dir (see
// uvDirNamespace). 12 hex chars = 48 bits: collision-safe for the thousands
// of state dirs a developer might touch over a career, short enough not to
// dominate the path the worker sees in $UV_CACHE_DIR.
const UV_DIR_NAMESPACE_HASH_BYTES = 12;
/** Pre-namespace flat uv dirs were named by bare task id (`oc_<base36>_<hex>`). */
export const LEGACY_UV_DIR_ENTRY = /^oc_[a-z0-9]+_[0-9a-f]+$/;
// Default age floor for legacy flat uv dirs (those without a state-dir
// namespace -- pre-#594 records whose uv dirs landed directly under
// <cacheDir>/uv-cache/oc_*). 7 days: long enough that an active developer
// who just upgraded is unaffected, short enough that the existing 30-100G
// of accumulated dirts is reaped within a week.
export const DEFAULT_UV_LEGACY_SWEEP_AGE_DAYS = 7;

/**
 * Short stable namespace derived from the owning state dir. Every new uv
 * dir the daemon creates is rooted at `<cacheDir>/uv-{cache,tools}/<ns>/<id>`,
 * so a daemon only ever sweeps its own namespace and a `tasks.json` (or
 * `cacheDir`) leaked from one state dir cannot convince a different daemon
 * to reap its in-flight tasks' uv dirs.
 *
 * Hashes the state dir's realpath, so a symlinked spelling of the same
 * directory lands in the same namespace instead of stranding its dirs in one
 * no daemon ever sweeps.
 *
 * The namespace is a deterministic prefix of a sha256 hex digest, not a
 * reverse-DNS string -- any change to `stateDir` (a rebase to a different
 * checkout, a parallel worktree) yields a new namespace, so two daemons
 * sharing the same `cacheDir` never share a uv dir.
 * @param {string} stateDir
 * @returns {string}
 */
export function uvDirNamespace(stateDir) {
  const digest = createHash("sha256").update(resolveInvokedPath(stateDir)).digest("hex");
  return digest.slice(0, UV_DIR_NAMESPACE_HASH_BYTES);
}

/**
 * Single source of truth for the per-task uv dir layout. Both the worker's
 * sandbox (`buildBwrapBinds`) and the check gate's re-mount
 * (`startCheckGate`) reach it through `prepareUvDirs`; the boot sweep reads
 * it back. Returns
 * the canonical path so callers can `mkdirSync` and `rw-bind` at exactly the
 * path the dir lives at, never a sibling or a typo of one.
 * @param {string} cacheDir
 * @param {string} stateDir
 * @param {string} taskId
 * @param {"uv-cache"|"uv-tools"} bucket
 */
export function uvDirPath(cacheDir, stateDir, taskId, bucket) {
  if (!UV_DIR_BUCKETS.includes(bucket)) {
    throw new Error(`error: unknown uv dir bucket ${JSON.stringify(bucket)}`);
  }
  return path.join(cacheDir, bucket, uvDirNamespace(stateDir), taskId);
}

/**
 * The two roots a freshly configured per-task uv dir can live under for the
 * current daemon: `<cacheDir>/uv-cache/<ns>` and `<cacheDir>/uv-tools/<ns>`,
 * where `<ns>` is `uvDirNamespace(stateDir)`. `confinePath` and the boot
 * sweep's safe-realpath check use this to refuse anything outside the
 * current daemon's own namespace -- a `tasks.json` (or hand-edited list)
 * pointing at another state dir's uv dir is rejected before the rm fires.
 * @param {string} cacheDir
 * @param {string} stateDir
 * @returns {string[]}
 */
export function uvDirRootsFor(cacheDir, stateDir) {
  const ns = uvDirNamespace(stateDir);
  return UV_DIR_BUCKETS.map((bucket) => path.join(cacheDir, bucket, ns));
}

/**
 * Creates a task's two uv dirs and registers them for deferred cleanup. The
 * worker (`buildBwrapBinds`) and the check gate (`startCheckGate`) both call
 * this, so the gate always re-binds exactly the dirs the worker ran with.
 * Registration dedupes, so the gate's call is a no-op when the worker's
 * already stands, and re-adds the paths when an interrupted-boot drain
 * emptied the list before the gate re-ran.
 * @param {{deferredCleanup?: string[], id: string}} task
 * @param {{cacheDir: string, stateDir: string}} ctx
 * @returns {{uvCacheDir: string, uvToolsDir: string}}
 */
export function prepareUvDirs(task, ctx) {
  const uvCacheDir = uvDirPath(ctx.cacheDir, ctx.stateDir, task.id, "uv-cache");
  const uvToolsDir = uvDirPath(ctx.cacheDir, ctx.stateDir, task.id, "uv-tools");
  fs.mkdirSync(uvCacheDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(uvToolsDir, { recursive: true, mode: 0o700 });
  registerDeferredCleanup(task, uvCacheDir, uvToolsDir);
  return { uvCacheDir, uvToolsDir };
}
