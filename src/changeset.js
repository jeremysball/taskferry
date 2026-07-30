// src/changeset.js
import crypto from "node:crypto";
import path from "node:path";

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
