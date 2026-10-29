import fs from "node:fs";

/**
 * Percentage of effective memory usage at or above which the launch
 * scheduler stops admitting new ferries. A value of 100 disables the gate;
 * the default leaves a little headroom below an OOM.
 */
export const DEFAULT_MEMORY_ADMISSION_PERCENT = 85;

/**
 * How often a memory-blocked scheduler re-reads the metric. A concurrency
 * cap has a running child's exit to react to, but memory falling back below
 * the threshold fires no event, so it has to be polled like the existing
 * concurrency poll.
 */
export const MEMORY_ADMISSION_POLL_MS = 1000;

// cgroup v1 reports "unlimited" as a huge sentinel near 2^63 rather than the
// literal "max" cgroup v2 uses. Anything at or above this floor is not a real
// memory ceiling for a host taskferry can run on.
const UNLIMITED_CGROUP_LIMIT_FLOOR = 2 ** 60;

const MEMINFO_PATH = "/proc/meminfo";
const PROC_SELF_CGROUP_PATH = "/proc/self/cgroup";
const CGROUP_ROOT = "/sys/fs/cgroup";

/**
 * Reads a file, returning null when it does not exist. Other I/O errors are
 * propagated: a permission error on /proc/meminfo is a real metric failure,
 * not an absent optional cgroup file.
 * @param {(path: string, encoding: BufferEncoding) => string} readFileFn
 * @param {string} filePath
 * @returns {string|null}
 */
function readOptional(readFileFn, filePath) {
  try {
    return readFileFn(filePath, "utf8");
  } catch (err) {
    if (/** @type {{code?: string}} */ (err)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Parses the two /proc/meminfo fields the admission metric uses. Values are
 * in kB, the unit /proc/meminfo always prints; converting here keeps every
 * caller in bytes and avoids a second unit convention in the scheduler.
 * @param {string} text
 * @returns {{totalBytes: number, availableBytes: number}}
 */
function parseMeminfo(text) {
  /** @type {{MemTotal?: number, MemAvailable?: number}} */
  const fields = {};
  for (const line of text.split("\n")) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB\s*$/.exec(line.trim());
    if (!match) continue;
    fields[/** @type {"MemTotal"|"MemAvailable"} */ (match[1])] = Number(match[2]) * 1024;
  }
  if (!Number.isSafeInteger(fields.MemTotal) || /** @type {number} */ (fields.MemTotal) <= 0) {
    throw new Error(`error: ${MEMINFO_PATH} has no usable MemTotal`);
  }
  if (!Number.isSafeInteger(fields.MemAvailable) || /** @type {number} */ (fields.MemAvailable) < 0) {
    throw new Error(`error: ${MEMINFO_PATH} has no usable MemAvailable`);
  }
  return {
    totalBytes: /** @type {number} */ (fields.MemTotal),
    availableBytes: /** @type {number} */ (fields.MemAvailable),
  };
}

/**
 * Extracts the cgroup v2 path from `/proc/self/cgroup` (the `0::/...` line)
 * and the cgroup v1 memory-controller path (the line whose controller list
 * contains `memory`). Both are returned as absolute paths relative to their
 * controller mount, because a container's own cgroup namespace can make the
 * host-level limit visible at a nested path.
 * @param {string} text
 * @returns {{v2Path: string|null, v1Path: string|null}}
 */
function parseSelfCgroup(text) {
  let v2Path = null;
  let v1Path = null;
  for (const line of text.split("\n")) {
    const parts = line.trim().split(":");
    if (parts.length === 3) {
      const [, controllers, cgroupPath] = parts;
      const isV2 = controllers === "";
      if (isV2) v2Path = cgroupPath;
      if (!isV2 && controllers.split(",").includes("memory")) v1Path = cgroupPath;
    }
  }
  return { v2Path, v1Path };
}

/**
 * Builds the cgroup directories to inspect, deduplicated by path. The mount
 * root is always tried because a cgroup namespace can present the container's
 * own limit at `/`; every ancestor of the `/proc/self/cgroup` leaf is also
 * tried, because a systemd slice or LXC parent can hold the finite limit while
 * the leaf itself reports `max`.
 * @param {string} cgroupRoot
 * @param {{v2Path: string|null, v1Path: string|null}} paths
 * @returns {Array<{dir: string, version: 1|2}>}
 */
function cgroupDirectories(cgroupRoot, paths) {
  /** @type {Array<{dir: string, version: 1|2}>} */
  const candidates = [
    { dir: cgroupRoot, version: 2 },
    { dir: `${cgroupRoot}/memory`, version: 1 },
  ];
  if (paths.v2Path) candidates.push(...cgroupAncestors(cgroupRoot, paths.v2Path, 2));
  if (paths.v1Path) candidates.push(...cgroupAncestors(`${cgroupRoot}/memory`, paths.v1Path, 1));

  /** @type {Array<{dir: string, version: 1|2}>} */
  const unique = [];
  for (const candidate of candidates) {
    if (unique.some((seen) => seen.dir === candidate.dir && seen.version === candidate.version)) continue;
    unique.push(candidate);
  }
  return unique;
}

/**
 * Every directory from the mount root down to the leaf, in ancestor-first
 * order, under `base`.
 * @param {string} base
 * @param {string} cgroupPath
 * @param {1|2} version
 * @returns {Array<{dir: string, version: 1|2}>}
 */
function cgroupAncestors(base, cgroupPath, version) {
  const parts = cgroupPath.split("/").filter(Boolean);
  return parts.map((_, index) => ({ dir: [base, ...parts.slice(0, index + 1)].join("/"), version }));
}

/**
 * Parses a cgroup limit file. `null` (missing), `max`, the v1 unlimited
 * sentinel, and any non-positive value mean "not constrained"; a non-empty
 * value that is not a usable byte count is a malformed metric and throws so
 * the scheduler's fail-open warning fires instead of silently dropping a
 * real ceiling.
 * @param {string|null} rawLimit
 * @param {string} limitPath
 * @returns {number|null}
 */
function parseFiniteCgroupLimit(rawLimit, limitPath) {
  if (rawLimit === null) return null;
  const trimmed = rawLimit.trim();
  if (trimmed === "max") return null;
  const limitBytes = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(limitBytes)) {
    throw new Error(`error: ${limitPath} is not a usable byte count`);
  }
  if (limitBytes <= 0 || limitBytes >= UNLIMITED_CGROUP_LIMIT_FLOOR) return null;
  if (!Number.isSafeInteger(limitBytes)) {
    throw new Error(`error: ${limitPath} is not a usable byte count`);
  }
  return limitBytes;
}

/**
 * Parses a cgroup `current` file that must exist for a finite limit.
 * @param {string|null} rawCurrent
 * @param {string} currentPath
 * @returns {number}
 */
function parseCgroupCurrent(rawCurrent, currentPath) {
  if (rawCurrent === null) {
    throw new Error(`error: ${currentPath} is missing for a finite cgroup memory limit`);
  }
  const trimmed = rawCurrent.trim();
  const currentBytes = Number(trimmed);
  if (trimmed === "" || !Number.isSafeInteger(currentBytes) || currentBytes < 0) {
    throw new Error(`error: ${currentPath} is not a usable byte count`);
  }
  return currentBytes;
}

/**
 * Reads one cgroup's finite memory ceiling and current usage. A missing
 * limit file, a `max` value, or the v1 unlimited sentinel means this cgroup
 * does not constrain memory. A finite limit with an unreadable `current`
 * file is a malformed metric and is thrown rather than guessed at.
 * @param {(path: string, encoding: BufferEncoding) => string} readFileFn
 * @param {{dir: string, version: 1|2}} candidate
 * @returns {{limitBytes: number, currentBytes: number}|null}
 */
function readCgroupMemory(readFileFn, candidate) {
  const limitFile = candidate.version === 2 ? "memory.max" : "memory.limit_in_bytes";
  const currentFile = candidate.version === 2 ? "memory.current" : "memory.usage_in_bytes";
  const limitPath = `${candidate.dir}/${limitFile}`;
  const limitBytes = parseFiniteCgroupLimit(readOptional(readFileFn, limitPath), limitPath);
  if (limitBytes === null) return null;
  const currentPath = `${candidate.dir}/${currentFile}`;
  const currentBytes = parseCgroupCurrent(readOptional(readFileFn, currentPath), currentPath);
  return { limitBytes, currentBytes };
}

/**
 * Reads every finite cgroup ceiling the candidate directories expose.
 * @param {(path: string, encoding: BufferEncoding) => string} readFileFn
 * @param {string} cgroupRoot
 * @param {{v2Path: string|null, v1Path: string|null}} paths
 * @returns {Array<{limitBytes: number, currentBytes: number}>}
 */
function finiteCgroupReadings(readFileFn, cgroupRoot, paths) {
  /** @type {Array<{limitBytes: number, currentBytes: number}>} */
  const readings = [];
  for (const candidate of cgroupDirectories(cgroupRoot, paths)) {
    const reading = readCgroupMemory(readFileFn, candidate);
    if (reading !== null) readings.push(reading);
  }
  return readings;
}

/**
 * Reads effective memory usage for launch admission.
 *
 * The effective ceiling is the smaller of the visible physical total
 * (`MemTotal`) and any finite cgroup memory limit, so an LXC/container limit
 * below the host's physical total is honored. The effective availability is
 * the smaller of Linux's `MemAvailable` and each constrained cgroup's
 * `limit - current`, clamped to the ceiling. That keeps reclaimable page
 * cache from counting as pressure when the kernel says it is available,
 * while still treating a cgroup close to its own limit as unavailable even
 * when the host has memory to spare.
 *
 * Any unreadable or malformed required value throws; the scheduler's
 * admission wrapper documents the resulting fail-open behavior.
 * @param {object} [options]
 * @param {(path: string, encoding: BufferEncoding) => string} [options.readFileFn]
 * @param {string} [options.meminfoPath]
 * @param {string} [options.procSelfCgroupPath]
 * @param {string} [options.cgroupRoot]
 * @returns {{percent: number, limitBytes: number, availableBytes: number, cgroupLimited: boolean}}
 */
export function readMemoryUsage({
  readFileFn = fs.readFileSync,
  meminfoPath = MEMINFO_PATH,
  procSelfCgroupPath = PROC_SELF_CGROUP_PATH,
  cgroupRoot = CGROUP_ROOT,
} = {}) {
  const meminfoText = readOptional(readFileFn, meminfoPath);
  if (meminfoText === null) throw new Error(`error: ${meminfoPath} is not readable`);
  const meminfo = parseMeminfo(meminfoText);
  const cgroupText = readOptional(readFileFn, procSelfCgroupPath);
  const cgroupPaths = cgroupText === null ? { v2Path: null, v1Path: null } : parseSelfCgroup(cgroupText);

  const cgroupReadings = finiteCgroupReadings(readFileFn, cgroupRoot, cgroupPaths);
  const limitBytes = Math.min(meminfo.totalBytes, ...cgroupReadings.map((reading) => reading.limitBytes));
  const unclampedAvailable = Math.min(
    meminfo.availableBytes,
    ...cgroupReadings.map((reading) => Math.max(0, reading.limitBytes - reading.currentBytes))
  );
  const availableBytes = Math.min(Math.max(unclampedAvailable, 0), limitBytes);
  return {
    limitBytes,
    availableBytes,
    percent: ((limitBytes - availableBytes) / limitBytes) * 100,
    cgroupLimited: cgroupReadings.length > 0,
  };
}
