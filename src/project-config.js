import fs from "node:fs";
import path from "node:path";
import { parse, TomlError } from "smol-toml";

const CONFIG_FILENAME = ".taskferry.toml";
const DEFAULT_CHECK_TIMEOUT_SECONDS = 900;
const KNOWN_KEYS = new Set(["check", "check_timeout_seconds", "read_only_paths"]);

/** @typedef {{check: string|null, checkTimeoutSeconds: number, readOnlyPaths: string[], parseError: string|null}} ProjectConfig */

/** @type {ProjectConfig} */
const EMPTY_CONFIG = Object.freeze({ check: null, checkTimeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS, readOnlyPaths: [], parseError: null });

// Per-path cache: configPath -> { mtimeMs: number|null, result: ProjectConfig }.
// mtimeMs null means "file did not exist at last load" -- same shape as
// config.js's _configCache, so an edit (or a file appearing/disappearing) is
// observed on the next loadProjectConfig() call without an explicit reset.
const _projectConfigCache = new Map();

/** Exported for test use only. */
export function _resetProjectConfigCache() {
  _projectConfigCache.clear();
}

/** @param {string} directory @returns {string} */
export function resolveProjectConfigPath(directory) {
  return path.join(directory, CONFIG_FILENAME);
}

/**
 * @param {unknown} raw
 * @param {string} configPath
 * @returns {ProjectConfig}
 */
// eslint-disable-next-line complexity, sonarjs/cyclomatic-complexity -- brief-mandated shape; each `??` and chained &&/|| arm counts, and the per-field checks are intentionally inlined so the EMPTY_CONFIG-shaped parseError stays in one place
function validateAndNormalize(raw, configPath) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...EMPTY_CONFIG, parseError: `${configPath} must contain a TOML table at the top level` };
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  const errors = [];
  if (record.check !== undefined && typeof record.check !== "string") {
    errors.push(`"check" must be a string (got ${JSON.stringify(record.check)})`);
  }
  if (record.check_timeout_seconds !== undefined && !(Number.isInteger(record.check_timeout_seconds) && record.check_timeout_seconds > 0)) {
    errors.push(`"check_timeout_seconds" must be a positive integer (got ${JSON.stringify(record.check_timeout_seconds)})`);
  }
  const readOnlyPaths = record.read_only_paths;
  if (readOnlyPaths !== undefined && !(Array.isArray(readOnlyPaths) && readOnlyPaths.every((entry) => typeof entry === "string"))) {
    errors.push(`"read_only_paths" must be an array of strings (got ${JSON.stringify(readOnlyPaths)})`);
  }
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`unrecognized key "${key}"`);
  }
  if (errors.length) {
    return { ...EMPTY_CONFIG, parseError: `${configPath}: ${errors.join("; ")}` };
  }
  return {
    check: /** @type {string|undefined} */ (record.check) ?? null,
    checkTimeoutSeconds: /** @type {number|undefined} */ (record.check_timeout_seconds) ?? DEFAULT_CHECK_TIMEOUT_SECONDS,
    readOnlyPaths: /** @type {string[]|undefined} */ (record.read_only_paths) ?? [],
    parseError: null,
  };
}

/**
 * Loads `.taskferry.toml` from a dispatch's working-tree root. Never throws:
 * an absent file returns EMPTY_CONFIG (no gate, no injection, no extra
 * binds); an unparseable or invalid file also returns an EMPTY_CONFIG-shaped
 * result, but with `parseError` set so the caller can surface a loud warning
 * instead of silently guessing a partial config -- dispatch proceeds with no
 * gate, per the design's error table. Cached per absolute path by mtime,
 * mirroring config.js's loadConfig() invalidation strategy, so the three
 * independent call sites in a task's lifecycle (dispatch-time prompt
 * injection, spawn-time read-only binds, settle-time gate) each pay only a
 * stat() when the file hasn't changed since the last read.
 * @param {string} directory
 * @param {{statFn?: (p: string) => {mtimeMs: number}, readFileFn?: (p: string) => string}} [deps]
 * @returns {ProjectConfig}
 */
export function loadProjectConfig(directory, { statFn = fs.statSync, readFileFn = (p) => fs.readFileSync(p, "utf8") } = {}) {
  const configPath = resolveProjectConfigPath(directory);
  let currentMtimeMs;
  try {
    currentMtimeMs = statFn(configPath).mtimeMs;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      const cached = _projectConfigCache.get(configPath);
      if (cached && cached.mtimeMs === null) return cached.result;
      _projectConfigCache.set(configPath, { mtimeMs: null, result: EMPTY_CONFIG });
      return EMPTY_CONFIG;
    }
    throw err;
  }
  const cached = _projectConfigCache.get(configPath);
  if (cached && cached.mtimeMs === currentMtimeMs) return cached.result;

  /** @type {ProjectConfig} */
  let result;
  try {
    result = validateAndNormalize(parse(readFileFn(configPath)), configPath);
  } catch (err) {
    if (err instanceof TomlError) {
      result = { ...EMPTY_CONFIG, parseError: `${configPath}: ${err.message.split("\n")[0]}` };
    } else {
      throw err;
    }
  }
  _projectConfigCache.set(configPath, { mtimeMs: currentMtimeMs, result });
  return result;
}

/**
 * The always-on prompt block appended to a dispatch's prompt when the
 * project declares a check command, verbatim per the design's §3.
 * @param {string} checkCommand
 * @returns {string}
 */
export function verificationPromptBlock(checkCommand) {
  return `\n\n## Verification (required)\nThis repo declares a check command in .taskferry.toml:\n    ${checkCommand}\nRun it before declaring the task done. If it fails, fix the failures and\nre-run until it passes. State the final result in your summary.\n`;
}
