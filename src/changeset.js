// src/changeset.js
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildBwrapArgs } from "./sandbox.js";

// Diff/apply calls are heavier than sandbox.js's bwrap --version probe (a
// real git diff over a worker's changes), so this uses a longer timeout
// than sandbox.js's defaultRunCommand.
function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
  if (result.error) return { status: null, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
}

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
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
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
 */
export function extractGitDiff({
  directory,
  overlay,
  overlayRwBinds,
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
  const bwrapArgs = buildBwrapArgs({ directory, stateDir, runtimeDir, homeDir, denyList, overlay, overlayRwBinds });
  const script = `git -C ${shQuote(directory)} add -A && git -C ${shQuote(directory)} diff --cached ${shQuote(preDispatchHead)}; git -C ${shQuote(directory)} reset > /dev/null 2>&1`;
  const result = runCommand("bwrap", [...bwrapArgs, "--", "sh", "-c", script]);
  mkdirFn(pathDirname(diffPath));
  writeFileFn(diffPath, result.stdout);
  return { diffPath, hasChanges: result.stdout.trim().length > 0 };
}

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
 * @param {string} root
 * @param {string} targetPath
 * @returns {{path: string, upperDir: string, workDir: string}}
 */
export function subOverlayPaths(root, targetPath) {
  const slug = subOverlaySlug(targetPath);
  return { path: targetPath, upperDir: path.join(root, "upper", "extra", slug), workDir: path.join(root, "work", "extra", slug) };
}
