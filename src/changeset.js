// src/changeset.js
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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

// bwrap's exact wording for the taskferry#318/#326 overlay-mount race: a
// fresh overlay mount raced against another mount namespace's teardown
// (either a concurrent dispatch to the same lowerdir, #318, or -- #326 --
// this same task's own just-exited dispatch bwrap, whose overlayfs
// superblock can still be unwinding asynchronously on a kernel workqueue
// after the process itself has been reaped). Matched against both a raw
// bwrap stderr result and the persisted changesetError text, which can span
// the error's own multi-line wrapping -- "s" flag so "." also matches
// newlines.
export const OVERLAY_MOUNT_BUSY_PATTERN = /overlay mount on .*Device or resource busy/s;

// Bounded retry for the extraction bwrap specifically on the overlay-mount-
// busy signature: the teardown this races is a kernel-internal async
// cleanup with no user-space signal to wait on, so a short bounded backoff
// is the only lever available short of restructuring extraction to be
// async (see taskferry#326's fix-direction discussion for why that was
// rejected as the first move).
const OVERLAY_MOUNT_RETRY_BACKOFF_MS = [100, 300, 900];

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether a bwrap command result carries the overlay-mount-busy signature,
 * checked against `stderr` and `error?.message` independently rather than
 * via `stderr || error?.message`: a slow/hung mount (spawnSync's 30s
 * timeout firing after bwrap already wrote the busy line to stderr) reports
 * `{error: ETIMEDOUT, stderr: <busy text>}`, and `error.message` ("spawn
 * bwrap ETIMEDOUT") would win a `||` fallback and hide the busy signature
 * actually sitting in stderr.
 * @param {CommandResult} result
 * @returns {boolean}
 */
function isOverlayMountBusy(result) {
  return OVERLAY_MOUNT_BUSY_PATTERN.test(result.stderr || "") || OVERLAY_MOUNT_BUSY_PATTERN.test(result.error?.message || "");
}

/**
 * Runs a bwrap extraction command, retrying with backoff when the failure is
 * specifically the overlay-mount-busy race (never on any other failure --
 * a real sandbox misconfiguration or a genuine diff error should surface
 * immediately, not be masked behind three silent retries).
 * @param {typeof defaultRunCommand} runCommand
 * @param {string[]} args
 * @param {(ms: number) => void} [sleepFn]
 * @returns {CommandResult}
 */
function runExtractionBwrap(runCommand, args, sleepFn = sleepSync) {
  for (let attempt = 0; attempt <= OVERLAY_MOUNT_RETRY_BACKOFF_MS.length; attempt++) {
    const result = runCommand("bwrap", args);
    const busy = isOverlayMountBusy(result);
    if (!busy || attempt === OVERLAY_MOUNT_RETRY_BACKOFF_MS.length) return result;
    sleepFn(OVERLAY_MOUNT_RETRY_BACKOFF_MS[attempt]);
  }
  // Unreachable: the loop above always returns by its final iteration
  // (attempt === OVERLAY_MOUNT_RETRY_BACKOFF_MS.length short-circuits the
  // busy check). Present only so control flow analysis doesn't see a
  // function that can fall through without returning.
  throw new Error("unreachable");
}

/**
 * Detects whether `directory`'s current HEAD has confirmably moved away from
 * `preDispatchHead`. Returns `null` when there's no confirmed drift — either
 * HEAD still matches, or the check itself was inconclusive (a git failure, a
 * non-git target) — deliberately fail-open on the inconclusive case, same as
 * this replaced `assertNoHeadDrift`'s behavior. Unlike that function, this
 * never throws: taskferry changed drift from a fatal abort into something
 * `extractGitDiff` resolves via a real 3-way apply instead (see
 * `resolveHeadDrift`).
 * @param {string} directory
 * @param {typeof defaultRunCommand} runCommand
 * @param {string} preDispatchHead
 * @returns {{from: string, to: string} | null}
 */
export function detectHeadDrift(directory, runCommand, preDispatchHead) {
  const currentHead = resolvePreDispatchHead(directory, runCommand);
  if (currentHead !== null && currentHead !== preDispatchHead) {
    return { from: preDispatchHead, to: currentHead };
  }
  return null;
}

// Matches a `git status --porcelain` line for any unmerged path (both
// added, both deleted, or one/both sides modified) -- the exact signature
// the spec's --check correction says is the only trustworthy way to detect
// a real conflict, since --3way --check's own exit code can't be trusted
// (see the spec's "A --check correction" section).
const CONFLICT_STATUS_PATTERN = /^(?:UU|AA|DD|AU|UD|UA|DU) /m;

/**
 * Probes whether `diffPath` (already extracted, anchored on the original
 * preDispatchHead) would forward-apply cleanly onto `currentHead` via a real
 * `git apply --3way` -- never `--check`, which cannot distinguish a clean
 * merge from a real conflict (spec "A `--check` correction"). Runs entirely
 * inside a disposable detached worktree created off the live `directory`;
 * `directory` itself is only ever read (as `worktree add`'s source) and is
 * removed unconditionally afterward, whether the merge succeeded or not.
 * @param {object} params
 * @param {string} params.directory - live directory; read-only source for the scratch worktree
 * @param {string} params.diffPath
 * @param {string} params.currentHead
 * @param {string} params.scratchDir
 * @param {typeof defaultRunCommand} [params.runCommand]
 * @returns {{recovered: boolean|null, conflictDetail: string|null}}
 */
export function resolveHeadDrift({ directory, diffPath, currentHead, scratchDir, runCommand = defaultRunCommand }) {
  const add = runCommand("git", ["-C", directory, "worktree", "add", "--detach", scratchDir, currentHead]);
  if (add.error || add.status !== 0) {
    // worktree add itself failed -- nothing was created, so no cleanup
    // work to do (and no scratch tree to leak).
    return { recovered: null, conflictDetail: `could not evaluate: ${gitApplyFailureReason(add)}` };
  }
  try {
    return evaluateApplyAndStatus(scratchDir, diffPath, runCommand);
  } finally {
    // Unconditional cleanup of the disposable scratch worktree once it has
    // been created, regardless of how the try exited: a normal end, a
    // returned result, OR a thrown runCommand (the documented contract
    // says "runCommand" returns a result object, but defense-in-depth
    // matters here -- a throwing wrapper would otherwise leak the worktree
    // tree on every probe). The worktree-add failure path above doesn't
    // need this branch because nothing was created.
    runCommand("git", ["-C", directory, "worktree", "remove", "--force", scratchDir]);
  }
}

/**
 * Runs `git apply --3way` + `git status --porcelain` inside the scratch
 * worktree and classifies the outcome. Split out of `resolveHeadDrift` to
 * keep that function's cyclomatic complexity under the file cap; the
 * classification logic (status failure / clean merge / conflict) is the
 * only thing that grows with each new branch, so it lives here.
 * @param {string} scratchDir
 * @param {string} diffPath
 * @param {typeof defaultRunCommand} runCommand
 * @returns {{recovered: boolean|null, conflictDetail: string|null}}
 */
function evaluateApplyAndStatus(scratchDir, diffPath, runCommand) {
  const apply = runCommand("git", ["-C", scratchDir, "apply", "--3way", diffPath]);
  const statusResult = runCommand("git", ["-C", scratchDir, "status", "--porcelain"]);
  // A failed status inspection (spawn error or non-zero exit) means we
  // can't tell whether the merge produced conflict markers -- the empty
  // stdout isn't a clean merge, it's "didn't get to read porcelain" -- so
  // treat as could-not-evaluate rather than trusting an empty/absent
  // match against CONFLICT_STATUS_PATTERN.
  if (statusResult.error || statusResult.status !== 0) {
    return { recovered: null, conflictDetail: `could not evaluate status inspection: ${gitApplyFailureReason(statusResult)}` };
  }
  const hasConflictMarkers = CONFLICT_STATUS_PATTERN.test(statusResult.stdout || "");
  if (!apply.error && apply.status === 0 && !hasConflictMarkers) {
    return { recovered: true, conflictDetail: null };
  }
  return { recovered: false, conflictDetail: gitApplyFailureReason(apply) || statusResult.stdout.trim() || null };
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
 * @param {(ms: number) => void} [params.sleepFn] - injectable for tests; real callers get a blocking sleep between retries
 * @param {() => string} [params.scratchDirFn]
 * @returns {{diffPath: string, hasChanges: boolean, headDrift: null | {from: string, to: string, recovered: boolean|null, conflictDetail: string|null}}}
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
  sleepFn = sleepSync,
  scratchDirFn = () => path.join(os.tmpdir(), `taskferry-stale-base-${crypto.randomUUID()}`),
}) {
  const bwrapArgs = buildBwrapArgs({ directory, stateDir, runtimeDir, homeDir, denyList, overlay, overlayRwBinds, overlayRwFileBinds });
  // The final `exit $rc` propagates the diff's own status: the previous
  // `; git reset` tail made the whole script exit with reset's status, so a
  // failed diff still reported success. reset runs first regardless (undo
  // the transient staging -- the upper already captured everything), then
  // the shell exits with the diff's code.
  const script = `git -C ${shQuote(directory)} add -A && { git -C ${shQuote(directory)} diff --cached ${shQuote(preDispatchHead)}; rc=$?; git -C ${shQuote(directory)} reset > /dev/null 2>&1; exit $rc; }`;
  const result = runExtractionBwrap(runCommand, [...bwrapArgs, "--", "sh", "-c", script], sleepFn);
  if (result.error || result.status !== 0) {
    throw new Error(`error: git diff extraction failed for ${directory} (exit ${result.status ?? "null"}): ${(result.stderr || result.error?.message || "unknown error").trim()}`);
  }
  mkdirFn(pathDirname(diffPath));
  writeFileFn(diffPath, result.stdout);
  // Extraction always completes and the diff is always written -- nothing
  // about the diff's content depends on live HEAD (see the module-level
  // "key insight" comment below `resolveHeadDrift`). A drift, if any, is
  // resolved here rather than aborting: a stale-base diff is still valid
  // content, `git apply --3way` exists precisely to forward-apply it.
  const drift = detectHeadDrift(directory, runCommand, preDispatchHead);
  let headDrift = null;
  if (drift) {
    const { recovered, conflictDetail } = resolveHeadDrift({ directory, diffPath, runCommand, currentHead: drift.to, scratchDir: scratchDirFn() });
    headDrift = { recovered, conflictDetail, from: drift.from, to: drift.to };
  }
  return { diffPath, headDrift, hasChanges: result.stdout.trim().length > 0 };
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
 * @param {string} params.stateDir - unused by this function; kept in the options object so the
 *   shared buildMergedViewBwrapArgs() scaffolding stays symmetric with buildBwrapArgs().
 * @param {string} params.runtimeDir
 * @param {string} params.homeDir - unused by this function; kept for scaffolding symmetry with buildBwrapArgs().
 * @param {string[]} params.denyList
 * @param {string} params.mergedMountPoint
 * @param {boolean} [params.writable] - also rw-bind directory itself, for the apply step (Task 7); omit for
 *   pure extraction, where directory is bound read-only. The explicit bind (read-only or read-write)
 *   is always needed because the earlier --tmpfs /tmp can shadow directory when directory (or an
 *   ancestor) is under /tmp.
 * @returns {string[]}
 */
export function buildMergedViewBwrapArgs({ directory, overlay, runtimeDir, denyList, mergedMountPoint, writable = false, stateDir: _stateDir, homeDir: _homeDir }) {
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
 * @param {(ms: number) => void} [params.sleepFn] - injectable for tests; real callers get a blocking sleep between retries
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
  sleepFn = sleepSync,
}) {
  const mergedMountPoint = path.join(overlay.root, "merged");
  const bwrapArgs = buildMergedViewBwrapArgs({ directory, overlay, stateDir, runtimeDir, homeDir, denyList, mergedMountPoint, writable: false });
  // -N (--new-file) treats files missing from one side as empty, so a file
  // created inside the overlay shows its full content (a plain -ru would
  // collapse it to a bare "Only in ... merged" line with no content, and
  // the apply step would then lose the new file entirely).
  const result = runExtractionBwrap(runCommand, [...bwrapArgs, "--", "diff", "-ruN", directory, mergedMountPoint], sleepFn);
  // diff exits 0 = identical, 1 = differences found (success for us), >=2 =
  // real trouble. A bwrap failure (bad mount, timeout, killed) must not be
  // indistinguishable from "no changes" -- throw on anything but 0/1 so the
  // caller can record the failure and keep the overlay for recovery. bwrap
  // itself also exits 1 on a setup failure (its own die() convention), which
  // collides with diff's own exit-1-for-differences-found on this exact
  // status code -- an overlay-mount-busy failure that survives every retry
  // must still throw even though its exit code alone looks like success, or
  // the worker's real edits get silently discarded as "no changes".
  if (result.error || isOverlayMountBusy(result) || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`error: non-git diff extraction failed for ${directory} (exit ${result.status ?? "null"}): ${(result.stderr || result.error?.message || "unknown error").trim()}`);
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
 * @param {(ms: number) => void} [params.sleepFn] - injectable for tests; real callers get a blocking sleep between retries (non-git apply only -- applyGitChangeset uses `git apply`, not bwrap, so it never hits the overlay-mount race)
 * @returns {{applied: boolean, reason: string|null}}
 */
export function applyChangeset({ directory, diffPath, isGitTarget, overlay, stateDir, runtimeDir, homeDir, denyList, runCommand = defaultRunCommand, sleepFn = sleepSync }) {
  if (isGitTarget) {
    return applyGitChangeset({ directory, diffPath, runCommand });
  }
  return applyNonGitChangeset({ directory, overlay, stateDir, runtimeDir, homeDir, denyList, runCommand, sleepFn });
}

// Shared by the two live-overlay-input guard clauses below (thrown from two
// places, so lifted to one module constant to keep no-duplicate-string quiet).
const NON_GIT_APPLY_ERROR =
  "error: non-git changeset apply requires a live overlay, stateDir, runtimeDir, homeDir, and denyList\n" +
  "help: preserve the pending overlay and retry through taskferry accept with a complete task record";

/**
 * Applies a git-target changeset via `git apply`. Mirrors the original
 * in-place logic; split out so applyChangeset stays under the complexity
 * budget.
 * @param {object} params
 * @param {string} params.directory
 * @param {string} params.diffPath
 * @param {typeof defaultRunCommand} params.runCommand
 * @returns {{applied: boolean, reason: string|null}}
 */
function applyGitChangeset({ directory, diffPath, runCommand }) {
  const result = runCommand("git", ["-C", directory, "apply", diffPath]);
  if (result.status !== 0) {
    return { applied: false, reason: gitApplyFailureReason(result) };
  }
  return { applied: true, reason: null };
}

/** @param {{status: number|null, stderr: string, error?: Error}} result */
function gitApplyFailureReason(result) {
  if (result.stderr.trim()) return result.stderr.trim();
  if (result.error?.message) return result.error.message;
  return `git apply exited with status ${result.status}`;
}

/**
 * Applies a non-git-target changeset by rsyncing the merged overlay view
 * onto directory inside one writable remount. Split out of applyChangeset
 * (which routes to this or applyGitChangeset) to keep branching shallow.
 * @param {object} params
 * @param {string} params.directory
 * @param {{root: string, upperDir: string, workDir: string}} [params.overlay]
 * @param {string} [params.stateDir]
 * @param {string} [params.runtimeDir]
 * @param {string} [params.homeDir]
 * @param {string[]} [params.denyList]
 * @param {typeof defaultRunCommand} params.runCommand
 * @param {(ms: number) => void} [params.sleepFn]
 * @returns {{applied: boolean, reason: string|null}}
 */
function applyNonGitChangeset({ directory, overlay, stateDir, runtimeDir, homeDir, denyList, runCommand, sleepFn = sleepSync }) {
  // Guard clauses (split so each stays under the expression-complexity cap)
  // double as the TS narrowing the rsync remount below needs: a missing input
  // means a partial/tampered task record, which must surface as a hard error
  // rather than a silent mis-apply.
  if (stateDir == null || runtimeDir == null || homeDir == null || denyList == null) {
    throw new Error(NON_GIT_APPLY_ERROR);
  }
  if (overlay == null) {
    throw new Error(NON_GIT_APPLY_ERROR);
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
  // Same overlay-mount-busy race as extraction (taskferry#326): this bwrap
  // call mounts its own overlay merged view, which can race the async
  // mount-namespace teardown of whatever bwrap just exited before this
  // accept() ran. Routed through the same bounded retry-with-backoff rather
  // than a bespoke copy -- unlike extractNonGitDiff, no fail-open guard is
  // needed here: rsync doesn't share diff's "non-zero exit can mean success"
  // convention, so a persistent busy failure (exit 1) already falls through
  // to the existing `status !== 0` branch as a real failure.
  const result = runExtractionBwrap(runCommand, [...bwrapArgs, "--", "sh", "-c", script], sleepFn);
  if (result.status !== 0) {
    return { applied: false, reason: copyApplyFailureReason(result) };
  }
  return { applied: true, reason: null };
}

/** @param {{status: number|null, stderr: string}} result */
function copyApplyFailureReason(result) {
  if (result.stderr.trim()) return result.stderr.trim();
  return `apply copy exited with status ${result.status}`;
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
 * chmod's own result isn't just discarded on failure: a chmod failure for a
 * *different* reason than the expected mode-000 case (an immutable flag, a
 * read-only remount) would otherwise surface only as rm's own opaque
 * failure, losing the more specific diagnostic chmod's stderr carries.
 * @param {object} params
 * @param {string} params.root
 * @param {string} params.tmpRoot - the overlayTmpRoot the overlay was created under; removal is
 *   refused for any root that isn't a taskferry-cow tree under it (review finding #12 -- defense
 *   in depth against a corrupted/tampered tasks.json pointing rm -rf elsewhere; exploiting it
 *   already requires the daemon's own uid, which is exactly the attacker this feature targets).
 * @param {typeof spawnSync} [params.spawnFn] - overridable for tests; the default rmFn's chmod/rm
 *   subprocess calls both run through this.
 * @param {(path: string) => void} [params.rmFn]
 * @returns {{removed: boolean, reason: string|null}}
 */
export function cleanupOverlay({ root, tmpRoot, spawnFn = spawnSync, rmFn = (p) => {
    const chmodResult = spawnFn("chmod", ["-R", "u+rwX", p]);
    const rmResult = spawnFn("rm", ["-rf", p]);
    if (rmResult.status !== 0) {
      let chmodDetail = null;
      if (chmodResult.status !== 0) {
        const chmodStderr = (chmodResult.stderr || "").toString().trim();
        const chmodFallback = `exit ${chmodResult.status}`;
        chmodDetail = `chmod failed: ${chmodStderr || chmodFallback}`;
      }
      const rmStderr = (rmResult.stderr || "").toString().trim();
      const rmFallback = `exit ${rmResult.status}`;
      const rmDetail = `rm -rf failed: ${rmStderr || rmFallback}`;
      const details = [chmodDetail, rmDetail].filter(Boolean).join("; ");
      throw new Error(details);
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
