import fs from "node:fs";
import path from "node:path";
import { parse, TomlError } from "smol-toml";
import { errCode } from "./errors.js";

const CONFIG_FILENAME = ".taskferry.toml";
const DEFAULT_CHECK_TIMEOUT_SECONDS = 900;
const KNOWN_KEYS = new Set(["check", "check_timeout_seconds", "read_only_paths", "roBind"]);

/** @typedef {{check: string|null, checkTimeoutSeconds: number, readOnlyPaths: string[], deprecatedReadOnlyPaths: boolean, parseError: string|null}} ProjectConfig */

/** @type {ProjectConfig} */
const EMPTY_CONFIG = Object.freeze({ check: null, checkTimeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS, readOnlyPaths: [], deprecatedReadOnlyPaths: false, parseError: null });

// Per-path cache: configPath -> { mtimeMs: number|null, result: ProjectConfig }.
// mtimeMs null means "file did not exist at last load" -- same shape as
// config.js's _configCache, so an edit (or a file appearing/disappearing) is
// observed on the next loadProjectConfig() call without an explicit reset.
const _projectConfigCache = new Map();

/** Clears the per-path cache. Exported for test use only. @returns {void} */
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
  const checkTimeoutSeconds = record.check_timeout_seconds;
  if (checkTimeoutSeconds !== undefined && !(typeof checkTimeoutSeconds === "number" && Number.isInteger(checkTimeoutSeconds) && checkTimeoutSeconds > 0)) {
    errors.push(`"check_timeout_seconds" must be a positive integer (got ${JSON.stringify(checkTimeoutSeconds)})`);
  }
  const readOnlyPaths = validateStringArray(record.read_only_paths, "read_only_paths", errors);
  const roBind = validateStringArray(record.roBind, "roBind", errors);
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`unrecognized key "${key}"`);
  }
  if (errors.length) {
    return { ...EMPTY_CONFIG, parseError: `${configPath}: ${errors.join("; ")}` };
  }
  const deprecatedReadOnlyPathsUsed = readOnlyPaths !== undefined;
  // The deprecated `read_only_paths` key UNIONS into the new `roBind` key
  // rather than being replaced by it, matching the union-not-replace pattern
  // the deprecated `allowedDirs`/`rwBind` CLI-flag alias already uses (see
  // resolveRwBind in tasks.js) -- a renamed key aliasing a still-live one is
  // the same shape of problem whether the rename lives in one config file or
  // across flag/env/config layers, so it gets the same answer.
  // `deprecatedReadOnlyPaths` records whether the old key contributed at all
  // (even when the new key also did) so callers can warn either way.
  const effectiveRoBind = [...new Set([...(readOnlyPaths ?? []), ...(roBind ?? [])])];
  return {
    check: /** @type {string|undefined} */ (record.check) ?? null,
    checkTimeoutSeconds: /** @type {number|undefined} */ (record.check_timeout_seconds) ?? DEFAULT_CHECK_TIMEOUT_SECONDS,
    readOnlyPaths: effectiveRoBind,
    deprecatedReadOnlyPaths: deprecatedReadOnlyPathsUsed,
    parseError: null,
  };
}

/**
 * Validates a config value as an array of strings (or `undefined`), pushing a
 * descriptive error when it isn't. Returns the value unchanged when it's a
 * valid string array or absent.
 * @param {unknown} value
 * @param {string} key
 * @param {string[]} errors
 * @returns {string[]|undefined}
 */
function validateStringArray(value, key, errors) {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  errors.push(`"${key}" must be an array of strings (got ${JSON.stringify(value)})`);
  return undefined;
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
    if (errCode(err) === "ENOENT") {
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

/**
 * Filters a project's declared `read_only_paths` down to safe `[src, dest]`
 * ro-bind pairs: an entry is dropped (and reported) if it doesn't exist on
 * this host, or if it overlaps a protected mount -- equals it, is an
 * ancestor of it, or is a descendant of it. bwrap applies mounts in argument
 * order and `read_only_paths` binds land last (see `buildBwrapArgs`), so an
 * overlapping entry would either shadow a protected mount (e.g.
 * `read_only_paths = ["/"]` re-exposing the deny-listed `~/.ssh` a `--tmpfs`
 * mount hid, or shadowing the overlay mount entirely) or punch a read hole
 * into an otherwise-hidden protected directory (e.g.
 * `["~/.ssh/known_hosts"]`). `.taskferry.toml` is project-supplied, not
 * daemon-trusted, so this check is mandatory, not defensive nicety.
 *
 * The `overlaps` predicate is the mount-order safety check: it must
 * recognize `/` as an ancestor of every other absolute path. The naive
 * `a.startsWith(b + path.sep)` form fails this case because `"/" + path.sep`
 * is `"//"`, which never prefixes any normal absolute path -- so
 * `read_only_paths = ["/"]` would otherwise sail through to become
 * `--ro-bind / /`, shadowing the deny-list tmpfs mounts and the overlay
 * mount. The `childPrefix` helper produces a non-double-slash prefix by
 * returning `base` unchanged when `base === path.sep`, which makes
 * `"/".startsWith("/")` (or any descendant) true and keeps the original
 * no-double-prefix semantics for every non-root base.
 * @param {string[]} readOnlyPaths
 * @param {{protectedPaths: string[], existsFn: (p: string) => boolean}} ctx
 * @returns {{roBinds: [string, string][], missing: string[], unsafe: string[]}}
 */
export function resolveReadOnlyProjectBinds(readOnlyPaths, ctx) {
  /** @param {string} base */
  const childPrefix = (base) => (base === path.sep ? base : base + path.sep);
  /** @param {string} a @param {string} b */
  const overlaps = (a, b) => a === b || a.startsWith(childPrefix(b)) || b.startsWith(childPrefix(a));
  /** @param {string} p */
  const isMissing = (p) => !ctx.existsFn(p);
  /** @param {string} p */
  const isUnsafe = (p) => ctx.protectedPaths.some((protectedPath) => overlaps(p, protectedPath));
  /** @type {[string, string][]} */
  const roBinds = [];
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const unsafe = [];
  for (const p of readOnlyPaths) {
    if (isMissing(p)) missing.push(p);
    else if (isUnsafe(p)) unsafe.push(p);
    else roBinds.push([p, p]);
  }
  return { roBinds, missing, unsafe };
}
