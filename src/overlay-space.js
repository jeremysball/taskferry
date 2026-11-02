import fs from "node:fs";
import path from "node:path";

/**
 * Default headroom required on the overlay filesystem before a new overlay is
 * created. Chosen large enough that one ordinary task can write a useful diff
 * without immediately exhausting the tmpfs, but small enough that a genuine
 * filesystem with several gigabytes free is never blocked.
 */
export const DEFAULT_OVERLAY_MIN_FREE_BYTES = 256 * 1024 * 1024;

/** Stable error code so callers can distinguish this from a generic mkdir failure. */
export const OVERLAY_SPACE_LOW = "OVERLAY_SPACE_LOW";

/**
 * @typedef {object} OverlayStatFs
 * @property {number} bsize
 * @property {number} blocks
 * @property {number} bfree
 * @property {number} bavail
 */

/**
 * @typedef {object} OverlaySpaceOptions
 * @property {string} root overlay root (`<runtimeDir>/overlay`)
 * @property {number} [minFreeBytes] headroom required before creating an overlay; 0 disables the preflight
 * @property {(path: string) => OverlayStatFs} [statfsFn] test seam for `fs.statfsSync`
 * @property {(path: string) => unknown} [statFn] test seam used to find the nearest existing ancestor
 */

/**
 * @typedef {object} OverlaySpaceDiagnostic
 * @property {boolean} checked whether a filesystem measurement was made
 * @property {boolean} ok false only when a measurement succeeded and free space is below the reserve
 * @property {string} root
 * @property {string} [checkedPath] existing ancestor actually measured
 * @property {number} [freeBytes] bytes available to the current user
 * @property {number} [totalBytes]
 * @property {number} [usedBytes]
 * @property {number} [minFreeBytes] effective reserve after the small-filesystem cap
 * @property {number} [configuredMinFreeBytes]
 * @property {string} [reason] why the preflight did not run, or `below-reserve`
 * @property {string} [error]
 */

/**
 * @param {number} value
 * @returns {number}
 */
function normalizeMinFreeBytes(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_OVERLAY_MIN_FREE_BYTES;
}

/**
 * @param {string} filePath
 * @returns {unknown}
 */
function defaultStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Finds the nearest existing ancestor so a first dispatch can be measured
 * before the overlay root exists. `statfs` reports the filesystem containing
 * that ancestor, which is the same filesystem the root will be created on.
 * @param {string} root
 * @param {(path: string) => unknown} statFn
 * @returns {string|null}
 */
function findExistingAncestor(root, statFn) {
  let current = path.resolve(root);
  for (;;) {
    let found;
    try {
      found = statFn(current);
    } catch {
      found = null;
    }
    if (found) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * @param {string} reason
 * @param {string} root
 * @param {Partial<OverlaySpaceDiagnostic>} [extra]
 * @returns {OverlaySpaceDiagnostic}
 */
function unchecked(reason, root, extra = {}) {
  return { checked: false, ok: true, root, reason, ...extra };
}

/**
 * The pre-measurement refusal reasons. Returned separately so
 * `checkOverlaySpace` itself stays a short read of the measurement flow.
 * @param {{root: string, configuredMinFreeBytes: number, statfsFn: unknown}} options
 * @returns {OverlaySpaceDiagnostic|null}
 */
function earlyUnchecked({ root, configuredMinFreeBytes, statfsFn }) {
  if (!root) return unchecked("no-overlay-root", "", { configuredMinFreeBytes });
  if (configuredMinFreeBytes === 0) {
    return unchecked("disabled", root, { configuredMinFreeBytes, minFreeBytes: 0 });
  }
  if (typeof statfsFn !== "function") {
    return unchecked("statfs-unavailable", root, { configuredMinFreeBytes });
  }
  return null;
}

/**
 * @param {unknown} stats
 * @returns {{blockSize: number, blocks: number, bfree: number, bavail: number}|null}
 */
function normalizeStatfs(stats) {
  const source = /** @type {Partial<OverlayStatFs>|null|undefined} */ (stats);
  const blockSize = Number(source?.bsize);
  const blocks = Number(source?.blocks);
  const bfree = Number(source?.bfree);
  const bavail = Number(source?.bavail);
  if (![blockSize, blocks, bfree, bavail].every(Number.isFinite)) return null;
  if (blockSize <= 0 || blocks <= 0) return null;
  return { blockSize, blocks, bfree, bavail };
}

/**
 * @param {{root: string, checkedPath: string, configuredMinFreeBytes: number, normalized: {blockSize: number, blocks: number, bfree: number, bavail: number}}} options
 * @returns {OverlaySpaceDiagnostic}
 */
function measuredDiagnostic({ root, checkedPath, configuredMinFreeBytes, normalized }) {
  const { blockSize, blocks, bfree, bavail } = normalized;
  const totalBytes = blocks * blockSize;
  const freeBytes = Math.max(0, bavail * blockSize);
  const usedBytes = Math.max(0, totalBytes - bfree * blockSize);
  // On a filesystem smaller than twice the configured reserve, cap the reserve
  // at half the filesystem: a 100 MiB tmpfs should still accept a dispatch
  // with 60 MiB free rather than demanding an impossible 256 MiB.
  const effectiveMinFreeBytes = Math.min(configuredMinFreeBytes, Math.floor(totalBytes / 2));
  const ok = freeBytes >= effectiveMinFreeBytes;
  return {
    checked: true,
    ok,
    root,
    checkedPath,
    freeBytes,
    totalBytes,
    usedBytes,
    minFreeBytes: effectiveMinFreeBytes,
    configuredMinFreeBytes,
    ...(ok ? {} : { reason: "below-reserve" }),
  };
}

/**
 * Measures free space on the filesystem that holds the overlay root. This is
 * deliberately a floor check, not a quota or reservation: it refuses a launch
 * when the filesystem is already too full to give the new overlay reasonable
 * headroom, but it cannot stop a single task from filling the filesystem after
 * it starts. An unmeasurable filesystem (statfs missing or throwing) fails
 * open, because a preflight that cannot measure must not block every dispatch.
 * @param {OverlaySpaceOptions} options
 * @returns {OverlaySpaceDiagnostic}
 */
export function checkOverlaySpace({
  root,
  minFreeBytes = DEFAULT_OVERLAY_MIN_FREE_BYTES,
  statfsFn = fs.statfsSync,
  statFn = defaultStat,
}) {
  const configuredMinFreeBytes = normalizeMinFreeBytes(minFreeBytes);
  const early = earlyUnchecked({ root, configuredMinFreeBytes, statfsFn });
  if (early) return early;

  const checkedPath = findExistingAncestor(root, statFn);
  if (checkedPath === null) {
    return unchecked("no-existing-ancestor", root, { configuredMinFreeBytes });
  }

  /** @type {unknown} */
  let stats;
  try {
    const measure = /** @type {(p: string) => OverlayStatFs} */ (statfsFn);
    stats = measure(checkedPath);
  } catch (err) {
    return unchecked("statfs-failed", root, {
      checkedPath,
      configuredMinFreeBytes,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const normalized = normalizeStatfs(stats);
  if (!normalized) {
    return unchecked("statfs-invalid", root, { checkedPath, configuredMinFreeBytes });
  }
  return measuredDiagnostic({ root, checkedPath, configuredMinFreeBytes, normalized });
}

/**
 * @param {OverlaySpaceOptions} options
 * @returns {OverlaySpaceDiagnostic}
 */
export function assertOverlaySpace(options) {
  const diagnostic = checkOverlaySpace(options);
  if (!diagnostic.ok) throw new OverlaySpaceError(diagnostic);
  return diagnostic;
}

export class OverlaySpaceError extends Error {
  /**
   * @param {OverlaySpaceDiagnostic} diagnostic
   */
  constructor(diagnostic) {
    super(formatOverlaySpaceError(diagnostic));
    this.name = "OverlaySpaceError";
    this.code = OVERLAY_SPACE_LOW;
    /** @type {OverlaySpaceDiagnostic} */
    this.diagnostic = diagnostic;
  }
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * @param {OverlaySpaceDiagnostic} diagnostic
 * @returns {string}
 */
export function formatOverlaySpaceError(diagnostic) {
  const measured = diagnostic.checkedPath && diagnostic.checkedPath !== diagnostic.root
    ? ` (measured ${diagnostic.checkedPath})`
    : "";
  return `error: overlay storage is low at ${diagnostic.root}${measured}: ${formatBytes(diagnostic.freeBytes ?? 0)} free of ${formatBytes(diagnostic.totalBytes ?? 0)}, below the ${formatBytes(diagnostic.minFreeBytes ?? 0)} reserve\nhelp: settle pending changesets with \`taskferry accept <id>\` or \`taskferry reject <id>\`, lower overlayMinFreeBytes / TASKFERRY_OVERLAY_MIN_FREE_BYTES, or point TASKFERRY_OVERLAY_TMP_DIR at a filesystem with more free space`;
}
