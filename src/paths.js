import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "./errors.js";
import { resolveGitCommonDir, defaultRunCommand } from "./sandbox.js";

// Names of the TASKFERRY_* plumbing env vars paths.js owns -- the state /
// runtime / cache dirs and the explicit socket override. tasks.js builds
// its caller-env exclusion set from this export plus PATH and HOME, so a
// new plumbing var added here is excluded automatically without a parallel
// edit in tasks.js (review fix: the exclusion set was duplicated between
// paths.js and tasks.js, so the two could silently drift apart).
export const TASKFERRY_PLUMBING_ENV_VARS = Object.freeze([
  "TASKFERRY_STATE_DIR",
  "TASKFERRY_RUNTIME_DIR",
  "TASKFERRY_CACHE_DIR",
  "TASKFERRY_SOCKET_PATH",
  "TASKFERRY_OVERLAY_TMP_DIR",
]);

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

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// XDG_RUNTIME_DIR is set by the login session (pam_systemd), not exported by
// every process that inherits that session -- a cron job, a stripped-env
// subshell, or an orphaned/backgrounded daemon booter can all lack the var
// while still running under a session where /run/user/<uid> genuinely
// exists and is writable. Treating an unexported var as "XDG_RUNTIME_DIR
// doesn't apply here" made two callers on the *same machine* resolve to two
// different runtime dirs (and so boot two independent, mutually invisible
// daemons) purely because one of them happened not to have the var
// exported. Compute the real value instead of trusting only the export.
export function resolveRuntimeDir({
  env = process.env,
  stateDir = resolveStateDir(env),
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
  pathExists = isDirectory,
} = {}) {
  if (env.TASKFERRY_RUNTIME_DIR) return env.TASKFERRY_RUNTIME_DIR;
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, "taskferry");
  if (uid != null) {
    const candidate = path.join("/run/user", String(uid));
    if (pathExists(candidate)) return path.join(candidate, "taskferry");
  }
  return path.join(stateDir, "run");
}

// Plain os.tmpdir() ("/tmp" on Linux) is shared by every taskferry daemon
// on the host regardless of TASKFERRY_STATE_DIR/RUNTIME_DIR isolation, so a
// daemon's startup orphan-overlay sweep (tasks.js's sweepOrphanedOverlays())
// could delete a *different* daemon's in-flight overlay -- see taskferry#286.
// Scoping under the already-isolated runtime dir (itself keyed off
// TASKFERRY_RUNTIME_DIR/XDG_RUNTIME_DIR/stateDir) gives every daemon instance
// its own overlay namespace for free, with TASKFERRY_OVERLAY_TMP_DIR as an
// explicit escape hatch for callers that want to pin it elsewhere.
export function resolveOverlayTmpRoot({ env = process.env, runtimeDir = resolveRuntimeDir({ env }) } = {}) {
  return env.TASKFERRY_OVERLAY_TMP_DIR || path.join(runtimeDir, "overlay");
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

// Symlink-safe, comparing the real (resolved) path against the caller's own
// module path. A bare path.resolve() compares the symlink path against the
// real module path, so invoking cli.js or client.js through a symlink (an
// installed bin entry) never matches and the direct-execution guard never runs.
/** @param {string} invoked */
export function resolveInvokedPath(invoked) {
  try {
    return fs.realpathSync(invoked);
  } catch {
    return path.resolve(invoked);
  }
}

// Emitted at most once per directory (not once per process): a startup-time
// git lookup failing repeatedly for the same non-repo startDir would
// otherwise spam stderr on every observation-command invocation, but a
// single boolean would silently swallow the warning for a second
// non-repo directory in the same process -- leaving the caller to wonder
// why the second workspace also didn't resolve.
const warnedNoGitRepoDirs = new Set();

/**
 * Resolves the git workspace root for `startDir`. For a plain repo or a
 * git worktree (nested `.worktrees/x` or sibling `git worktree add
 * ../x`), that's the parent directory of `git rev-parse
 * --git-common-dir`, which already handles all three layouts uniformly.
 * For a git submodule, `--git-common-dir` returns the parent repo's
 * `<parent>/.git/modules/<name>`, whose `path.dirname()` lands at the
 * parent repo's `.git/modules` directory -- not the submodule's own
 * working tree. The submodule case is detected by the `.git/modules/`
 * segment in the git-common-dir path and resolved with `git rev-parse
 * --show-toplevel`, which always reports the working-tree root of
 * whichever repo the startDir belongs to. Falls back to `startDir`
 * unchanged (today's existing default behavior) when no git repository
 * is found, warning once per directory (not once per process).
 *
 * Bare-repository case: `git rev-parse --git-common-dir` returns `.`,
 * which `path.resolve(startDir, ".")` normalizes to `startDir` itself
 * (no `.git` substring to trigger the submodule branch). `path.dirname`
 * then lands at the bare repo's parent directory, which is the best
 * available answer given a bare repo has no working tree.
 * @param {string} startDir
 * @param {object} [options]
 * @param {(command: string, args: readonly string[]) => {status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}} [options.runCommand]
 * @param {(message: string) => void} [options.warn]
 * @returns {string}
 */
export function resolveWorkspaceRoot(startDir, { runCommand = defaultRunCommand, warn = (message) => process.stderr.write(`${message}\n`) } = {}) {
  const gitCommonDir = resolveGitCommonDir(startDir, runCommand);
  if (!gitCommonDir) {
    if (!warnedNoGitRepoDirs.has(startDir)) {
      warnedNoGitRepoDirs.add(startDir);
      warn(`no git repository found for ${startDir}; using it directly`);
    }
    return startDir;
  }
  // Submodule detection: a `.git/modules/` segment in the git-common-dir
  // path means we're inside a submodule whose shared gitdir lives under
  // the parent repo's `.git/modules/<name>`. The plain-repo / worktree
  // paths never contain `.git/modules/`, so this check correctly
  // excludes them (and the bare-repo case, whose git-common-dir is `.`).
  const normalized = gitCommonDir.split(path.sep).join("/");
  if (normalized.includes("/.git/modules/")) {
    const toplevel = runCommand("git", ["-C", startDir, "rev-parse", "--show-toplevel"]);
    if (!toplevel.error && toplevel.status === 0) {
      const resolved = toplevel.stdout.trim();
      if (resolved) return path.resolve(startDir, resolved);
    }
  }
  return path.dirname(gitCommonDir);
}

/**
 * Memoizing wrapper around resolveWorkspaceRoot(): a long-lived caller (the
 * daemon) compares directories against each other repeatedly over its whole
 * lifetime -- every watch/list filter check and every live event delivery
 * (taskferry#315) -- and re-running `git rev-parse --git-common-dir` for the
 * same directory on every comparison would spawn a process per check. A
 * directory's git-common-dir doesn't change while the daemon is running, so
 * caching it for the resolver's lifetime is safe. Callers that live for the
 * daemon's lifetime should create exactly one resolver at startup and reuse
 * it, rather than calling this factory per comparison.
 * @param {object} [options]
 * @param {(command: string, args: readonly string[]) => {status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}} [options.runCommand]
 * @returns {(startDir: string) => string}
 */
export function createWorkspaceRootResolver({ runCommand = defaultRunCommand } = {}) {
  const cache = new Map();
  return function resolveCachedWorkspaceRoot(startDir) {
    if (cache.has(startDir)) return cache.get(startDir);
    const root = resolveWorkspaceRoot(startDir, { runCommand });
    cache.set(startDir, root);
    return root;
  };
}

/**
 * True when `a` and `b` are the exact same directory, or resolve to the same
 * git workspace root (e.g. a repo's root and one of its linked worktrees,
 * both dispatched into by `--directory`) -- the shared "same workspace" check
 * behind watch/list's directory filter and live event-subscription routing
 * (taskferry#315: a root-scoped `watch` was silently blind to any dispatch
 * that passed an explicit worktree `--directory`, since both compared raw
 * directory strings with `===`). The literal-equality fast path skips
 * `resolveRoot` (and, on a cache miss, a git spawn) for the overwhelmingly
 * common case where both sides are already the same directory.
 * @param {string} a
 * @param {string} b
 * @param {(startDir: string) => string} resolveRoot
 * @returns {boolean}
 */
export function sameWorkspace(a, b, resolveRoot) {
  return a === b || resolveRoot(a) === resolveRoot(b);
}
