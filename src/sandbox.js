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
 * `raw` carries bwrap's own `--version` stdout so callers that need the version
 * (checkOverlaySupport() via parseBwrapVersion()) don't have to re-probe. It is
 * only set when bwrap is actually available.
 * @param {{status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}} result
 * @returns {{checked: boolean, available: boolean, reason?: string, raw?: string}}
 */
function getBwrapAvailabilityResult(result) {
  if (result.error) {
    return {
      checked: true,
      available: false,
      reason:
        result.error.code === "ENOENT"
          ? "bwrap not found"
          : `bwrap --version failed: ${result.error.message}`,
    };
  }

  if (result.status !== 0) {
    return {
      checked: true,
      available: false,
      reason: `bwrap --version exited with status ${result.status}`,
    };
  }

  return {
    checked: true,
    available: true,
    raw: result.stdout,
  };
}

/**
 * @param {(command: string, args: readonly string[]) => {status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}} [runCommand]
 * @returns {{checked: boolean, available: boolean, reason?: string, raw?: string}}
 */
export function checkBwrapAvailable(runCommand = defaultRunCommand) {
  const result = runCommand("bwrap", ["--version"]);
  return getBwrapAvailabilityResult(result);
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
  return getBwrapAvailabilityResult(result);
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
 * Shared prefix both `buildBwrapArgs()` (sandboxed dispatch) and
 * `buildMergedViewBwrapArgs()` (changeset extraction/apply over a CoW
 * overlay) start from: the read-only root bind, the standard
 * `/proc`/`/dev`/`/tmp` scaffolding, and the per-deny-list tmpfs mounts.
 * bwrap applies mounts in argument order and a later mount on a parent
 * directory shadows an earlier mount nested inside it, so --tmpfs /tmp
 * must come before the deny-list and the read-write binds below — any
 * deny-list entry or bind path that happens to live under /tmp (a
 * plausible scratch/CI/worktree path) must not be silently hidden by a
 * /tmp mount that comes after it.
 * @param {object} options
 * @param {string[]} options.denyList
 * @returns {string[]}
 */
export function buildBwrapBaseArgs({ denyList }) {
  const args = ["--ro-bind", "/", "/"];
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  for (const denied of denyList) {
    args.push("--tmpfs", denied);
  }
  return args;
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
 * @param {{upperDir: string, workDir: string}} [options.overlay] - when given, `directory` is mounted as a
 *   copy-on-write overlay (`--overlay-src <directory> --overlay <upperDir> <workDir> <directory>`) instead of
 *   a plain read-write bind; all writes/deletes land in upperDir, `directory` itself is never mutated.
 * @param {Array<{path: string, upperDir: string, workDir: string}>} [options.overlayRwBinds] - extra paths
 *   (e.g. a worktree's git-common-dir slice) that need the same CoW treatment instead of a plain writable
 *   bind, one independent overlay mount per entry. Applied after extraRwBinds and before extraRwPairBinds.
 * @param {boolean} [options.shareNet] - default true (matches today's --share-net); pass false for
 *   advisor-role dispatches to emit --unshare-net instead.
 * @param {boolean} [options.runtimeDirWritable] - default true (today's --bind runtimeDir for dispatch
 *   roles); pass false for advisor-role dispatches to emit --ro-bind instead, so the daemon's Unix
 *   socket inside runtimeDir is unreachable from the sandbox (connect() fails on a read-only mount).
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
  overlay,
  overlayRwBinds = [],
  shareNet = true,
  runtimeDirWritable = true,
}) {
  const args = buildBwrapBaseArgs({ denyList });
  if (overlay) {
    args.push("--overlay-src", directory, "--overlay", overlay.upperDir, overlay.workDir, directory);
  } else {
    args.push("--bind", directory, directory);
  }
  args.push(runtimeDirWritable ? "--bind" : "--ro-bind", runtimeDir, runtimeDir);
  for (const extra of extraRwBinds) {
    args.push("--bind", extra, extra);
  }
  for (const { path: overlayPath, upperDir, workDir } of overlayRwBinds) {
    args.push("--overlay-src", overlayPath, "--overlay", upperDir, workDir, overlayPath);
  }
  for (const [src, dest] of extraRwPairBinds) {
    args.push("--bind", src, dest);
  }
  for (const [src, dest] of extraRoBinds) {
    args.push("--ro-bind", src, dest);
  }
  args.push("--unshare-all", shareNet ? "--share-net" : "--unshare-net", "--die-with-parent");
  return args;
}