import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "./errors.js";
import { resolveGitCommonDir, defaultRunCommand } from "./sandbox.js";

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

// Sandboxed workers' data homes (opencode/pi auth + growing caches like
// opencode's unbounded snapshot store) belong on real disk, not the small
// XDG_RUNTIME_DIR tmpfs — that dir is meant for transient sockets/locks, and
// filled it entirely once opencode's snapshot data accumulated there across
// dispatches. XDG_CACHE_HOME (not the state dir) is the right fit: this data
// is regenerable and safe to delete, unlike taskferry's own persisted state.
export function resolveCacheDir(env = process.env) {
  return env.TASKFERRY_CACHE_DIR
    || path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "taskferry");
}

// Emitted at most once per process: a startup-time git lookup failing
// repeatedly for the same reason (no git repo anywhere in the workspace)
// would otherwise spam stderr on every observation-command invocation.
let hasWarnedNoGitRepo = false;

/**
 * Resolves the git workspace root for `startDir`: the parent directory of
 * `git rev-parse --git-common-dir`, which already correctly handles nested
 * (`.worktrees/x`) and sibling (`git worktree add ../x`) worktree layouts,
 * and treats submodules as their own repo boundary the same way plain git
 * does. Falls back to `startDir` unchanged (today's existing default
 * behavior) when no git repository is found, warning once per process.
 * @param {string} startDir
 * @param {object} [options]
 * @param {(command: string, args: readonly string[]) => {status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}} [options.runCommand]
 * @param {(message: string) => void} [options.warn]
 * @returns {string}
 */
export function resolveWorkspaceRoot(startDir, { runCommand = defaultRunCommand, warn = (message) => process.stderr.write(`${message}\n`) } = {}) {
  const gitCommonDir = resolveGitCommonDir(startDir, runCommand);
  if (gitCommonDir) return path.dirname(gitCommonDir);
  if (!hasWarnedNoGitRepo) {
    hasWarnedNoGitRepo = true;
    warn(`no git repository found for ${startDir}; using it directly`);
  }
  return startDir;
}
