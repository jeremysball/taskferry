import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "./errors.js";

export function resolveStateDir(env = process.env) {
  return env.TASKFERRY_STATE_DIR
    || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "taskferry");
}

/**
 * @param {string} directory
 * @returns {string}
 */
export function normalizeDirectory(directory) {
  let normalized;
  try {
    normalized = fs.realpathSync(directory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(
      `directory does not exist: ${directory}`,
      `Use an existing directory path for --directory (${message})`
    );
  }
  if (!fs.statSync(normalized).isDirectory()) {
    throw new UsageError(
      `path is not a directory: ${directory}`,
      "Use --directory with a workspace directory, not a file"
    );
  }
  return normalized;
}

export function resolveRuntimeDir({ env = process.env, stateDir = resolveStateDir(env) } = {}) {
  if (env.TASKFERRY_RUNTIME_DIR) return env.TASKFERRY_RUNTIME_DIR;
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, "taskferry");
  return path.join(stateDir, "run");
}
