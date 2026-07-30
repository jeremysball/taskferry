import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function platformSupportsSandbox(platform = process.platform) {
  return platform === "linux";
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {{status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}}
 */
export function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000 });
  if (result.error) {
    return { status: null, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
  }
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
}

/**
 * @param {(command: string, args: readonly string[]) => {status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}} [runCommand]
 * @returns {{checked: boolean, available: boolean, reason?: string, raw?: string}}
 */
export function checkBwrapAvailable(runCommand = defaultRunCommand) {
  const result = runCommand("bwrap", ["--version"]);
  if (result.error) {
    return {
      checked: true,
      available: false,
      reason: result.error.code === "ENOENT" ? "bwrap not found" : `bwrap --version failed: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return { checked: true, available: false, reason: `bwrap --version exited with status ${result.status}` };
  }
  return { checked: true, available: true, raw: result.stdout };
}

/**
 * Parses `bubblewrap X.Y.Z` (bwrap's own `--version` output) into a
 * [major, minor, patch] tuple, or null if the string doesn't match.
 * @param {string} stdout
 * @returns {[number, number, number]|null}
 */
export function parseBwrapVersion(stdout) {
  const match = /^bubblewrap (\d+)\.(\d+)\.(\d+)/.exec(stdout);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Overlay support (`--overlay-src`/`--overlay`) requires bwrap >= 0.8. No
 * separate unprivileged-userns probe is needed: buildBwrapArgs() already
 * emits --unshare-all, which every existing sandboxed dispatch already
 * requires -- overlay only raises the version floor, it adds no new
 * namespace dependency.
 * @param {(command: string, args: readonly string[]) => {status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}} [runCommand]
 * @returns {{supported: boolean, reason?: string}}
 */
export function checkOverlaySupport(runCommand = defaultRunCommand) {
  const probe = checkBwrapAvailable(runCommand);
  if (!probe.available) return { supported: false, reason: probe.reason };
  const version = parseBwrapVersion(probe.raw ?? "");
  if (!version) return { supported: false, reason: "could not parse bwrap version" };
  const [major, minor] = version;
  if (major > 0 || (major === 0 && minor >= 8)) return { supported: true };
  return { supported: false, reason: `bwrap ${version.join(".")} < 0.8 required for --overlay` };
}

/**
 * Async variant of checkBwrapAvailable for use with async runCommand implementations.
 * @param {(command: string, args: readonly string[]) => Promise<{status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}>} runCommand
 * @returns {Promise<{checked: boolean, available: boolean, reason?: string}>}
 */
export async function checkBwrapAvailableAsync(runCommand) {
  const result = await runCommand("bwrap", ["--version"]);
  if (result.error) {
    return {
      checked: true,
      available: false,
      reason: result.error.code === "ENOENT" ? "bwrap not found" : `bwrap --version failed: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return { checked: true, available: false, reason: `bwrap --version exited with status ${result.status}` };
  }
  return { checked: true, available: true };
}

/**
 * The fixed v1 deny-list. Callers building a real bwrap invocation must
 * filter out entries that don't exist on disk before passing this to
 * buildBwrapArgs() — bwrap's --tmpfs fails if the mount point doesn't
 * already exist under the read-only-bound root.
 * @param {string} homeDir
 * @param {string} stateDir
 * @returns {string[]}
 */
export function defaultDenyList(homeDir, stateDir) {
  return [
    stateDir,
    path.join(homeDir, ".ssh"),
    path.join(homeDir, ".aws"),
    path.join(homeDir, ".config", "gcloud"),
    path.join(homeDir, ".config", "gh"),
    path.join(homeDir, ".gnupg"),
  ];
}

/**
 * A git worktree's `.git` is a file pointing at its real gitdir under the
 * main checkout's `.git/worktrees/<name>` -- outside the worktree's own
 * directory, so it's invisible to the read-write bind on `directory` alone
 * and any `git commit`/`git add` inside the sandbox fails with a read-only
 * filesystem error. `git rev-parse --git-common-dir` resolves the shared
 * `.git` (objects/refs live there too, so new commits need it writable)
 * regardless of whether `directory` is a worktree or the main checkout.
 * @param {string} directory
 * @param {(command: string, args: readonly string[]) => {status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}} [runCommand]
 * @returns {string|null}
 */
export function resolveGitCommonDir(directory, runCommand = defaultRunCommand) {
  const result = runCommand("git", ["-C", directory, "rev-parse", "--git-common-dir"]);
  if (result.error || result.status !== 0) return null;
  const raw = result.stdout.trim();
  if (!raw) return null;
  return path.resolve(directory, raw);
}

/**
 * A linked worktree's *own* gitdir (HEAD/index/logs private to that
 * worktree) lives at `<git-common-dir>/worktrees/<name>`, distinct from the
 * common dir's top level, which holds the *main* checkout's own private
 * HEAD/index/config -- see taskferry#224. `git rev-parse --absolute-git-dir`
 * resolves that worktree-specific path; for the main checkout itself it
 * resolves to the same directory as `resolveGitCommonDir`.
 * @param {string} directory
 * @param {(command: string, args: readonly string[]) => {status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}} [runCommand]
 * @returns {string|null}
 */
export function resolveGitDir(directory, runCommand = defaultRunCommand) {
  const result = runCommand("git", ["-C", directory, "rev-parse", "--absolute-git-dir"]);
  if (result.error || result.status !== 0) return null;
  const raw = result.stdout.trim();
  return raw || null;
}

/**
 * @param {object} options
 * @param {string} options.directory
 * @param {string} options.stateDir
 * @param {string} options.runtimeDir
 * @param {string} options.homeDir
 * @param {string[]} [options.denyList]
 * @param {string[]} [options.extraRwBinds] - extra directories bound read-write at the same path, applied
 *   after directory/runtimeDir (e.g. a git worktree's real gitdir, which lives outside `directory`).
 * @param {[string, string][]} [options.extraRwPairBinds] - extra [src, dest] read-write binds, for a real
 *   file or directory that must be writable but lives outside the executor's redirected sandbox data home
 *   (e.g. pi's single resumed session file, bound onto the matching path under the sandboxed
 *   PI_CODING_AGENT_DIR's sessions/ tree so a sandboxed resume can both read and persist to it without
 *   also exposing the user's other sessions to write/delete). Applied after extraRwBinds and before
 *   extraRoBinds.
 * @param {[string, string][]} [options.extraRoBinds] - extra [src, dest] read-only binds, applied last so a
 *   more specific path (e.g. a single credentials file) can be pinned read-only even though it sits under
 *   an already read-write-bound directory.
 * @returns {string[]}
 */
export function buildBwrapArgs({
  directory,
  stateDir,
  runtimeDir,
  homeDir,
  denyList = defaultDenyList(homeDir, stateDir),
  extraRwBinds = [],
  extraRwPairBinds = [],
  extraRoBinds = [],
}) {
  const args = ["--ro-bind", "/", "/"];
  // bwrap applies mounts in argument order, and a later mount on a parent
  // directory shadows an earlier mount nested inside it. --tmpfs /tmp must
  // come before the deny-list and read-write binds below, or any of them
  // that happen to live under /tmp (a plausible scratch/CI/worktree path)
  // would silently disappear behind the fresh, empty /tmp tmpfs.
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  for (const denied of denyList) {
    args.push("--tmpfs", denied);
  }
  args.push("--bind", directory, directory);
  args.push("--bind", runtimeDir, runtimeDir);
  for (const extra of extraRwBinds) {
    args.push("--bind", extra, extra);
  }
  for (const [src, dest] of extraRwPairBinds) {
    args.push("--bind", src, dest);
  }
  for (const [src, dest] of extraRoBinds) {
    args.push("--ro-bind", src, dest);
  }
  args.push("--unshare-all", "--share-net", "--die-with-parent");
  return args;
}