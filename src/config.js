import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseKeySlots } from "./tasks.js";

const CONFIG_FIELD_TYPES = {
  maxConcurrentTasks: "number",
  maxDispatchesPerWindow: "number",
  dispatchWindowMs: "number",
  noOutputTimeoutMs: "number",
  postOutputNoOutputTimeoutMs: "number",
  summaryModel: "string",
  activitySummariesEnabled: "boolean",
  summarizerTimeoutMs: "number",
  activityMaxWords: "number",
  advisorSessionTtlMs: "number",
  watchdogGraceMs: "number",
  keySlots: "string",
  providerKeyEnv: "string",
  summaryKeySlot: "string",
  summaryProviderKeyEnv: "string",
  sandboxEnabled: "boolean",
  allowedDirs: "string",
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
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.configPath]
 * @returns {Record<string, unknown>}
 */
export function loadConfig({ env = process.env, configPath = resolveConfigPath(env) } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }

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

  if (parsed.keySlots !== undefined) parseKeySlots(parsed.keySlots);

  return parsed;
}
