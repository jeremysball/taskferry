// src/changeset.js
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildBwrapArgs, buildBwrapBaseArgs } from "./sandbox.js";

/** @typedef {{status: number|null, stdout: string, stderr: string, error?: Error}} CommandResult */

// Diff/apply calls are heavier than sandbox.js's bwrap --version probe (a
// real git diff over a worker's changes), so this uses a longer timeout
// than sandbox.js's defaultRunCommand.
/**
 * @param {string} command
 * @param {string[]} args
 * @returns {CommandResult}
 */
export function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
  if (result.error) return { status: null, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
}

/** @param {string} value */
function shQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * @param {string} directory
 * @param {typeof defaultRunCommand} [runCommand]
 * @returns {string|null}
 */
export function resolvePreDispatchHead(directory, runCommand = defaultRunCommand) {
  const result = runCommand("git", ["-C", directory, "rev-parse", "HEAD"]);
  if (!result.error && result.status === 0) {
    const head = result.stdout.trim();
    if (head) return head;
  }
  // A git repo with an unborn HEAD (zero commits) is still a git target.
  // Anchor the diff on the empty tree so extraction stays on the git path:
  // misclassifying it as a non-git target would make a later accept rsync
  // the overlay's merged view -- .git included -- over the real directory,
  // replaying the worker's commits as real commits, which the design
  // forbids (commits flatten into a working-tree-style diff instead).
  const gitDirCheck = runCommand("git", ["-C", directory, "rev-parse", "--git-dir"]);
  if (!gitDirCheck.error && gitDirCheck.status === 0) {
    return "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git's empty tree object
  }
  return null;
}

/**
 * Extracts the overlay's upper into a single diff, anchored on the real
 * pre-dispatch HEAD (not whatever HEAD ends up at inside the overlay --
 * diffing against a possibly-advanced HEAD would show nothing for a worker
 * that committed cleanly). Runs `git add -A` first so untracked files and
 * deletions surface too, then resets the transient staging -- the upper
 * already captured everything needed by that point.
 * @param {object} params
 * @param {string} params.directory
 * @param {{upperDir: string, workDir: string}} params.overlay
 * @param {Array<{path: string, upperDir: string, workDir: string}>} params.overlayRwBinds
 * @param {Array<{path: string, bindSrc: string}>} [params.overlayRwFileBinds]
 * @param {string} params.preDispatchHead
 * @param {string} params.stateDir
 * @param {string} params.runtimeDir
 * @param {string} params.homeDir
 * @param {string[]} params.denyList
 * @param {string} params.diffPath
 * @param {typeof defaultRunCommand} [params.runCommand]
 * @param {(filePath: string, content: string) => void} [params.writeFileFn]
 * @param {(dirPath: string) => void} [params.mkdirFn]
 * @returns {{diffPath: string, hasChanges: boolean}}
 * @throws {Error} when the bwrap extraction fails to start or exits non-zero
 */
export function extractGitDiff({
  directory,
  overlay,
  overlayRwBinds,
  overlayRwFileBinds = [],
  preDispatchHead,
  stateDir,
  runtimeDir,
  homeDir,
  denyList,
  diffPath,
  runCommand = defaultRunCommand,
  writeFileFn = (filePath, content) => fs.writeFileSync(filePath, content, { mode: 0o600 }),
  mkdirFn = (dirPath) => fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 }),
}) {
  // Fail closed on HEAD drift: `directory` below is a live bind to the real
  // checkout, not a snapshot from dispatch time. If something else (a manual
  // checkout, a branch switch, another dispatch) moved that checkout's HEAD
  // since preDispatchHead was recorded, the diff-cached-against-preDispatchHead
  // script still runs successfully but compares the wrong trees -- it can
  // report files as deleted/added that the worker never touched. Only refuse
  // on a *confirmed* mismatch (both hashes resolved and differ); an
  // inconclusive re-check (git failure, non-git target) falls through to
  // extraction unchanged, matching prior behavior.
  const currentHead = resolvePreDispatchHead(directory, runCommand);
  if (currentHead !== null && currentHead !== preDispatchHead) {
    throw new Error(
      `error: ${directory}'s HEAD moved from '${preDispatchHead}' to '${currentHead}' since dispatch\n` +
      `help: something else changed this directory's checkout while the task was in flight (a manual git checkout, a branch switch, or another process) -- diffing against the original HEAD would compare the wrong trees. Investigate what changed ${directory}, then retry against a stable target (a dedicated worktree avoids this)`
    );
  }
  const bwrapArgs = buildBwrapArgs({ directory, stateDir, runtimeDir, homeDir, denyList, overlay, overlayRwBinds, overlayRwFileBinds });
  // The final `exit $rc` propagates the diff's own status: the previous
  // `; git reset` tail made the whole script exit with reset's status, so a
  // failed diff still reported success. reset runs first regardless (undo
  // the transient staging -- the upper already captured everything), then
  // the shell exits with the diff's code.
  const script = `git -C ${shQuote(directory)} add -A && { git -C ${shQuote(directory)} diff --cached ${shQuote(preDispatchHead)}; rc=$?; git -C ${shQuote(directory)} reset > /dev/null 2>&1; exit $rc; }`;
  const result = runCommand("bwrap", [...bwrapArgs, "--", "sh", "-c", script]);
  if (result.error || result.status !== 0) {
    throw new Error(`error: git diff extraction failed for ${directory} (exit ${result.status ?? "null"}): ${(result.error?.message || result.stderr || "unknown error").trim()}`);
  }
  mkdirFn(pathDirname(diffPath));
  writeFileFn(diffPath, result.stdout);
  return { diffPath, hasChanges: result.stdout.trim().length > 0 };
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function pathDirname(filePath) {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "." : filePath.slice(0, idx);
}

/**
 * @param {string} taskId
 * @param {string} tmpRoot
 * @returns {{root: string, upperDir: string, workDir: string}}
 */
export function overlayPaths(taskId, tmpRoot) {
  const root = path.join(tmpRoot, `taskferry-cow-${taskId}`);
  return { root, upperDir: path.join(root, "upper", "main"), workDir: path.join(root, "work", "main") };
}

/**
 * Basename plus a short stable hash of the full path, so two paths that
 * happen to share a basename (e.g. two worktrees both named "my-repo"
 * under different parents) don't collide when used as an overlay
 * subdirectory name.
 * @param {string} targetPath
 * @returns {string}
 */
export function subOverlaySlug(targetPath) {
  const hash = crypto.createHash("sha1").update(targetPath).digest("hex").slice(0, 8);
  return `${path.basename(targetPath)}-${hash}`;
}

/**
 * Mounts directory's merged (overlay) view at a *separate* synthetic
 * mountpoint instead of at directory itself, so directory can be diffed
 * against its own merged view in the same sandbox (git targets don't need
 * this -- git diff only needs the merged tree at the real path -- this is
 * only for the non-git diff -ru / non-git apply cases).
 *
 * The /tmp-shadowing question (review finding folded in here): the
 * overlay paths themselves (`overlay.upperDir`, `overlay.workDir`, and
 * the synthetic `mergedMountPoint` -- all of which live under /tmp by
 * construction) do NOT need the same explicit bind protection that
 * `directory` gets below. `upperDir`/`workDir` are host-namespace paths
 * consumed directly by the kernel's overlay mount(2) call, not by
 * user-space lookups that go through the bwrap namespace's mounts, so
 * the fresh --tmpfs /tmp never shadows them. `mergedMountPoint` is a
 * path in the new namespace (created via `--dir` *after* the `--tmpfs
 * /tmp`, so it lands on the empty tmpfs), then immediately consumed as
 * the mount point for `--overlay` -- it's intentionally empty before the
 * mount and never needs to persist on the host.
 *
 * @param {object} params
 * @param {string} params.directory
 * @param {{upperDir: string, workDir: string}} params.overlay
 * @param {string} params.stateDir
 * @param {string} params.runtimeDir
 * @param {string} params.homeDir
 * @param {string[]} params.denyList
 * @param {string} params.mergedMountPoint
 * @param {boolean} [params.writable] - also rw-bind directory itself, for the apply step (Task 7); omit for
 *   pure extraction, where directory is bound read-only. The explicit bind (read-only or read-write)
 *   is always needed because the earlier --tmpfs /tmp can shadow directory when directory (or an
 *   ancestor) is under /tmp.
 * @returns {string[]}
 */
export function buildMergedViewBwrapArgs({ directory, overlay, stateDir, runtimeDir, homeDir, denyList, mergedMountPoint, writable = false }) {
  const args = buildBwrapBaseArgs({ denyList });
  args.push("--dir", mergedMountPoint);
  args.push("--overlay-src", directory, "--overlay", overlay.upperDir, overlay.workDir, mergedMountPoint);
  if (writable) args.push("--bind", directory, directory);
  else args.push("--ro-bind", directory, directory);
  args.push("--bind", runtimeDir, runtimeDir);
  args.push("--unshare-all", "--unshare-net", "--die-with-parent");
  return args;
}

/**
 * @param {object} params
 * @param {string} params.directory
 * @param {{root: string, upperDir: string, workDir: string}} params.overlay
 * @param {string} params.stateDir
 * @param {string} params.runtimeDir
 * @param {string} params.homeDir
 * @param {string[]} params.denyList
 * @param {string} params.diffPath
 * @param {typeof defaultRunCommand} [params.runCommand]
 * @param {(filePath: string, content: string) => void} [params.writeFileFn]
 * @param {(dirPath: string) => void} [params.mkdirFn]
 * @returns {{diffPath: string, hasChanges: boolean}}
 * @throws {Error} when the bwrap extraction fails to start or exits non-zero
 */
export function extractNonGitDiff({
  directory,
  overlay,
  stateDir,
  runtimeDir,
  homeDir,
  denyList,
  diffPath,
  runCommand = defaultRunCommand,
  writeFileFn = (filePath, content) => fs.writeFileSync(filePath, content, { mode: 0o600 }),
  mkdirFn = (dirPath) => fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 }),
}) {
  const mergedMountPoint = path.join(overlay.root, "merged");
  const bwrapArgs = buildMergedViewBwrapArgs({ directory, overlay, stateDir, runtimeDir, homeDir, denyList, mergedMountPoint, writable: false });
  // -N (--new-file) treats files missing from one side as empty, so a file
  // created inside the overlay shows its full content (a plain -ru would
  // collapse it to a bare "Only in ... merged" line with no content, and
  // the apply step would then lose the new file entirely).
  const result = runCommand("bwrap", [...bwrapArgs, "--", "diff", "-ruN", directory, mergedMountPoint]);
  // diff exits 0 = identical, 1 = differences found (success for us), >=2 =
  // real trouble. A bwrap failure (bad mount, timeout, killed) must not be
  // indistinguishable from "no changes" -- throw on anything but 0/1 so the
  // caller can record the failure and keep the overlay for recovery.
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`error: non-git diff extraction failed for ${directory} (exit ${result.status ?? "null"}): ${(result.error?.message || result.stderr || "unknown error").trim()}`);
  }
  mkdirFn(pathDirname(diffPath));
  writeFileFn(diffPath, result.stdout);
  return { diffPath, hasChanges: result.stdout.trim().length > 0 };
}

/**
 * @param {string} root
 * @param {string} targetPath
 * @returns {{path: string, upperDir: string, workDir: string}}
 */
export function subOverlayPaths(root, targetPath) {
  const slug = subOverlaySlug(targetPath);
  return { path: targetPath, upperDir: path.join(root, "upper", "extra", slug), workDir: path.join(root, "work", "extra", slug) };
}

/**
 * Scratch-copy bind for a writable FILE outside the dispatch directory
 * (e.g. a worktree git common-dir's packed-refs). Overlayfs mounts are
 * directory-only, so files get a scratch copy under the overlay root,
 * bound rw onto the host path, instead of a sub-overlay; extraction
 * re-mounts the same bind so the diff sees the worker's writes.
 * @param {string} root
 * @param {string} targetPath
 * @returns {{path: string, bindSrc: string}}
 */
export function subFilePaths(root, targetPath) {
  return { path: targetPath, bindSrc: path.join(root, "files", subOverlaySlug(targetPath)) };
}

/**
 * @param {object} params
 * @param {string} params.directory
 * @param {string} params.diffPath
 * @param {boolean} params.isGitTarget
 * @param {{root: string, upperDir: string, workDir: string}} [params.overlay] - required when isGitTarget is false
 * @param {string} [params.stateDir]
 * @param {string} [params.runtimeDir]
 * @param {string} [params.homeDir]
 * @param {string[]} [params.denyList]
 * @param {typeof defaultRunCommand} [params.runCommand]
 * @returns {{applied: boolean, reason: string|null}}
 */
export function applyChangeset({ directory, diffPath, isGitTarget, overlay, stateDir, runtimeDir, homeDir, denyList, runCommand = defaultRunCommand }) {
  if (isGitTarget) {
    const result = runCommand("git", ["-C", directory, "apply", diffPath]);
    if (result.status === 0) return { applied: true, reason: null };
    return { applied: false, reason: result.stderr.trim() || result.error?.message || `git apply exited with status ${result.status}` };
  }
  if (!overlay || stateDir == null || runtimeDir == null || homeDir == null || denyList == null) {
    throw new Error(
      "error: non-git changeset apply requires a live overlay, stateDir, runtimeDir, homeDir, and denyList\n" +
      "help: preserve the pending overlay and retry through taskferry accept with a complete task record"
    );
  }
  const mergedMountPoint = path.join(overlay.root, "merged");
  const bwrapArgs = buildMergedViewBwrapArgs({ directory, overlay, stateDir, runtimeDir, homeDir, denyList, mergedMountPoint, writable: true });
  // --delay-updates (review finding #9): rsync stages each updated file and
  // renames them all into place in the final update phase, so an interrupted
  // apply leaves old files intact rather than a half-mutated tree. Not fully
  // transactional (deletions still apply incrementally), but retryable: a
  // failed apply leaves changesetStatus "pending" and never runs cleanup
  // (spec §5.4), so the overlay survives for a second attempt.
  const script = `rsync -a --delete --delay-updates ${shQuote(mergedMountPoint)}/ ${shQuote(directory)}/`;
  const result = runCommand("bwrap", [...bwrapArgs, "--", "sh", "-c", script]);
  if (result.status === 0) return { applied: true, reason: null };
  return { applied: false, reason: result.stderr.trim() || `apply copy exited with status ${result.status}` };
}

/**
 * Overlay upper/work dirs come back owned by the invoking (daemon's own)
 * uid, not an unmapped namespace one -- bwrap's default --unshare-user
 * identity-maps the outer uid, and nothing in this design passes
 * --uid/--gid. Verified live against the exact buildBwrapArgs() flag set on
 * the target host: overlayfs's internal work/work scratch subdir comes back
 * mode 000. An *empty* mode-000 directory is still removable by a same-uid
 * `rm -rf` (GNU rm's optimistic rmdir() fast path needs only the parent's
 * permissions), which is the case ADR 0001's "Namespace-owned leftovers"
 * entry verified -- but once anything was ever deleted inside the overlay,
 * that scratch dir holds an internal whiteout entry (confirmed live: `sudo
 * ls -la` on a real leftover showed a mode-000 dir containing a single
 * char-device entry) and is no longer empty. Removing a *non-empty*
 * directory forces rm to opendir()/readdir() it first, which does require
 * read+execute on the directory itself -- mode 000 blocks that, so rm fails
 * with EACCES partway through and aborts, having already deleted sibling
 * entries like upper/. That silently strands a task claiming a live overlay
 * whose upper/ no longer exists (taskferry issue #273: "Can't find source
 * path .../upper/main"). A same-uid `chmod -R` needs no special permission
 * on its own targets (only the parent's, to resolve each path), so running
 * one before rm -rf makes every entry openable regardless of how it landed
 * in this state. The default rmFn shells out to real `chmod`/`rm` (rather
 * than Node's fs.chmodSync/fs.rmSync) because fs.rmSync's own directory walk
 * hits the same EACCES on a not-yet-chmod'd mode-000 entry that rm -rf does.
 * @param {object} params
 * @param {string} params.root
 * @param {string} params.tmpRoot - the overlayTmpRoot the overlay was created under; removal is
 *   refused for any root that isn't a taskferry-cow tree under it (review finding #12 -- defense
 *   in depth against a corrupted/tampered tasks.json pointing rm -rf elsewhere; exploiting it
 *   already requires the daemon's own uid, which is exactly the attacker this feature targets).
 * @param {(path: string) => void} [params.rmFn]
 * @returns {{removed: boolean, reason: string|null}}
 */
export function cleanupOverlay({ root, tmpRoot, rmFn = (p) => {
    // Best-effort: a mode-000 entry blocks rm's own opendir() the same way
    // it blocks ours, so chmod failing here isn't fatal -- rm -rf below is
    // still the operation whose result actually matters.
    spawnSync("chmod", ["-R", "u+rwX", p]);
    const result = spawnSync("rm", ["-rf", p]);
    if (result.status !== 0) {
      throw new Error(`rm -rf ${p} failed: ${(result.stderr || "").toString().trim() || `exit ${result.status}`}`);
    }
  } }) {
  const resolved = path.resolve(root);
  if (!resolved.startsWith(path.resolve(tmpRoot) + path.sep) || !path.basename(resolved).startsWith("taskferry-cow-")) {
    return { removed: false, reason: `refusing to remove ${root}: not a taskferry-cow overlay under ${tmpRoot}` };
  }
  try {
    rmFn(root);
    return { removed: true, reason: null };
  } catch (err) {
    return { removed: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
