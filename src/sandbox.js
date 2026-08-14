import { spawnSync } from "node:child_process";
import path from "node:path";
import { errCode } from "./errors.js";
import { defaultRunCommandAsync } from "./setup.js";

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
 * @param {import("./setup.js").CommandResult} result
 * @returns {{checked: boolean, available: boolean, reason?: string, raw?: string}}
 */
function getBwrapAvailabilityResult(result) {
  if (result.error) {
    return {
      checked: true,
      available: false,
      reason:
        errCode(result.error) === "ENOENT"
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
 * @param {import("./setup.js").RunCommandFn} [runCommand]
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
 * Async variant of checkBwrapAvailable for use with async runCommand
 * implementations. Awaits the async runCommand, then delegates the rest to
 * checkBwrapAvailable so both variants share the same probe invocation and
 * classification logic.
 * @param {(command: string, args: readonly string[]) => Promise<import("./setup.js").CommandResult>} [runCommand]
 * @returns {Promise<{checked: boolean, available: boolean, reason?: string, raw?: string}>}
 */
export async function checkBwrapAvailableAsync(runCommand = defaultRunCommandAsync) {
  const result = await runCommand("bwrap", ["--version"]);
  return checkBwrapAvailable(() => result);
}

/**
 * The default deny-list. Callers building a real bwrap invocation must
 * filter out entries that don't exist on disk before passing this to
 * buildBwrapArgs() — bwrap's --tmpfs fails if the mount point doesn't
 * already exist under the read-only-bound root.
 *
 * Covers two distinct risk categories, not just one: `.ssh`/`.aws`/gcloud/
 * gh/gnupg are pivot-capable credentials (grant outbound access to other
 * systems); `.claude` is personal instruction/context content (a global
 * CLAUDE.md carries user preferences and private context, not a credential,
 * but has no legitimate reason to be readable by a worker either). Extendable
 * per-install via TASKFERRY_SANDBOX_DENYLIST / config.sandboxDenylist (see
 * tasks.js) for paths beyond this fixed set — those extra paths are always
 * directories, same as this list; a file-shaped credential deny-list
 * (.npmrc, .netrc, .git-credentials, etc.) needs a different bwrap mechanism
 * (masking a file mount point, not a directory tmpfs) and is tracked
 * separately, not covered by this function.
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
    path.join(homeDir, ".claude"),
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
 * Appends a `--bind <path> <path>` read-write bind at the same path for each
 * entry. Shared so buildBwrapArgs() stays under the complexity ceiling.
 * @param {string[]} args
 * @param {string[]} paths
 */
function pushSamePathBinds(args, paths) {
  for (const extra of paths) {
    args.push("--bind", extra, extra);
  }
}

/**
 * Appends a `--bind <src> <dest>`-style bind for each [src, dest] pair using
 * the given flag. Shared so buildBwrapArgs() stays under the complexity
 * ceiling.
 * @param {string[]} args
 * @param {[string, string][]} pairs
 * @param {string} flag - the bind flag to emit (e.g. "--bind" or "--ro-bind").
 */
function pushPairBinds(args, pairs, flag) {
  for (const [src, dest] of pairs) {
    args.push(flag, src, dest);
  }
}

/**
 * Appends one independent `--overlay-src <path> --overlay <upper> <work>
 * <path>` copy-on-write mount per entry. Shared so buildBwrapArgs() stays
 * under the complexity ceiling.
 * @param {string[]} args
 * @param {Array<{path: string, upperDir: string, workDir: string}>} overlays
 */
function pushOverlayRwBinds(args, overlays) {
  for (const { path: overlayPath, upperDir, workDir } of overlays) {
    args.push("--overlay-src", overlayPath, "--overlay", upperDir, workDir, overlayPath);
  }
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
 * @param {Array<{path: string, bindSrc: string}>} [options.overlayRwFileBinds] - writable FILE paths outside
 *   `directory` (e.g. a worktree git common-dir's packed-refs): overlayfs mounts are directory-only, so each
 *   is bound rw from a scratch copy (bindSrc) onto its host path (path). Applied right after overlayRwBinds.
 * @param {boolean} [options.shareNet] - default true (matches today's --share-net); pass false for
 *   advisor-role dispatches to emit --unshare-net instead.
 * @param {string|null} [options.socketPath] - the daemon's Unix socket path to bind into the sandbox
 *   (roles that need to call back to the daemon), or null to bind no socket at all. When null, the
 *   daemon is unreachable from the sandbox (the #454 fix -- a read-only bind never gated connect(),
 *   so the old ro-bind approach was ineffective). This replaces the legacy whole-runtimeDir bind,
 *   which exposed every sibling overlay (#453) and un-masked the stateDir deny-list (#455); only the
 *   socket is now reachable, not the rest of runtimeDir. Defaults to `<runtimeDir>/daemon.sock`.
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
  overlayRwFileBinds = [],
  shareNet = true,
  socketPath = path.join(runtimeDir, "daemon.sock"),
}) {
  const args = buildBwrapBaseArgs({ denyList });
  if (overlay) {
    args.push("--overlay-src", directory, "--overlay", overlay.upperDir, overlay.workDir, directory);
  } else {
    args.push("--bind", directory, directory);
  }
  // Narrow per-task runtime mounts (the #453/#454/#455 fix): bind only the
  // daemon socket, not the whole runtimeDir. bwrap creates the intermediate
  // destination directories, so the socket bind works even when runtimeDir is
  // masked by the stateDir deny-list tmpfs. Sibling overlays and other tasks'
  // state under runtimeDir are no longer reachable, and the stateDir deny is
  // no longer un-masked by a whole-runtimeDir bind.
  if (socketPath) {
    args.push("--bind", socketPath, socketPath);
  }
  pushSamePathBinds(args, extraRwBinds);
  pushOverlayRwBinds(args, overlayRwBinds);
  for (const { bindSrc, path: filePath } of overlayRwFileBinds) {
    args.push("--bind", bindSrc, filePath);
  }
  pushPairBinds(args, extraRwPairBinds, "--bind");
  pushPairBinds(args, extraRoBinds, "--ro-bind");
  args.push("--unshare-all", shareNet ? "--share-net" : "--unshare-net", "--die-with-parent");
  return args;
}