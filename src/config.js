import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KNOWN_EXECUTORS } from "./executor.js";

// Per-path cache so repeated loadConfig() calls in the same process only
// stat the file (cheap) instead of re-reading, re-parsing, and re-validating
// on every invocation.  The cache entry is invalidated when the file's mtime
// changes, so a config.json edit is observed on the next call without
// requiring an explicit reset.
//
// Entries: configPath -> { mtimeMs: number | null, result: object }
// mtimeMs is null when the file did not exist (ENOENT) at last load.
const _configCache = new Map();

/**
 * Clear the internal config cache so the next loadConfig() call re-reads
 * from disk.  Exported for test use only.
 */
export function _resetConfigCache() {
  _configCache.clear();
}

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
  advisorContextChars: "number",
  envFile: "string",
  profilingEnabled: "boolean",
};

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveConfigPath(env = process.env) {
  return path.join(
    env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "taskferry",
    "config.json"
  );
}

/**
 * @param {string} configPath
 * @returns {Record<string, unknown>}
 */
function parseAndValidateConfig(configPath) {
  const raw = fs.readFileSync(configPath, "utf8");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`error: could not parse ${configPath}: ${err.message}\nhelp: fix the JSON syntax, or delete the file to use built-in defaults`, { cause: err });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`error: ${configPath} must contain a JSON object\nhelp: use a flat {"key": value, ...} object with the recognized config keys`);
  }

  for (const key of Object.keys(parsed)) {
    if (!Object.hasOwn(CONFIG_FIELD_TYPES, key)) {
      throw new Error(`error: unrecognized config key "${key}" in ${configPath}\nhelp: recognized keys are: ${Object.keys(CONFIG_FIELD_TYPES).join(", ")}`);
    }
    const expectedType = CONFIG_FIELD_TYPES[key];
    const value = parsed[key];
    if (typeof value !== expectedType) {
      throw new Error(`error: config key "${key}" in ${configPath} must be a ${expectedType} (got ${JSON.stringify(value)})\nhelp: fix the value's type in ${configPath}`);
    }
  }

  if (parsed.defaultExecutor !== undefined && !KNOWN_EXECUTORS.includes(parsed.defaultExecutor)) {
    throw new Error(`error: config key "defaultExecutor" in ${configPath} must be one of ${KNOWN_EXECUTORS.join(", ")} (got ${JSON.stringify(parsed.defaultExecutor)})\nhelp: fix the value in ${configPath}`);
  }

  return parsed;
}

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.configPath]
 * @returns {Record<string, unknown>}
 */
export function loadConfig({ env = process.env, configPath = resolveConfigPath(env) } = {}) {
  // Fast path: stat the file and return the cached result if mtime is unchanged.
  let currentMtimeMs;
  try {
    currentMtimeMs = fs.statSync(configPath).mtimeMs;
  } catch (err) {
    if (err.code === "ENOENT") {
      const cached = _configCache.get(configPath);
      if (cached && cached.mtimeMs === null) return cached.result;
      const result = {};
      _configCache.set(configPath, { mtimeMs: null, result });
      return result;
    }
    throw err;
  }

  const cached = _configCache.get(configPath);
  if (cached && cached.mtimeMs === currentMtimeMs) return cached.result;

  const parsed = parseAndValidateConfig(configPath);
  _configCache.set(configPath, { mtimeMs: currentMtimeMs, result: parsed });
  return parsed;
}
