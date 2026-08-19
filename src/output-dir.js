import fs from "node:fs";
import path from "node:path";
import { errCode } from "./errors.js";

export const TASKFERRY_OUTPUT_DIR_ENV = "TASKFERRY_OUTPUT_DIR";

const PROMPT_BLOCK_SEPARATOR = "\n\n";

// Kept well under daemon-server.js's MAX_BUFFER_BYTES (1 MiB) rather than
// matching it exactly -- the file's raw bytes are only part of the wire
// response; JSON-string escaping plus the surrounding RPC envelope add
// overhead on top, so a cap equal to the response ceiling still risks
// RESPONSE_TOO_LARGE for a file that fits this check.
const MAX_OUTPUT_FILE_BYTES = 512 * 1024;
const MAX_OUTPUT_LIST_ENTRIES = 256;
const MAX_OUTPUT_TOTAL_BYTES = 8 * 1024 * 1024;
const DIRECTORY_OPEN_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY ?? 0)
  | (fs.constants.O_NOFOLLOW ?? 0);

/**
 * @param {string} stateDir
 * @returns {string}
 */
export function resolveOutputDirRoot(stateDir) {
  return path.join(stateDir, "outputs");
}

/**
 * Per-task output dir lives under <stateDir>/outputs/<id>/ so it is covered
 * by stateDir's existing 0o700 permission and stateDir-level sweep. Each
 * dispatch reserves its directory before the worker starts -- the bwrap
 * rw-bind needs the source path to exist on the host (`bwrap --bind`
 * errors otherwise), the worker uses the same path inside the sandbox
 * (so the env var is the absolute host path, not a relative `outputs/`
 * shape that would shift between the in-sandbox and outside views), and
 * the directory is created with 0o700 so a worker that writes something
 * secret inside doesn't accidentally expose it to other local users.
 * @param {string} stateDir
 * @param {string} taskId
 * @returns {string}
 */
export function resolveTaskOutputDir(stateDir, taskId) {
  return path.join(resolveOutputDirRoot(stateDir), taskId);
}

/**
 * Creates the task's scratch dir with 0o700 permissions. Idempotent
 * (`recursive: true` + chmod on an opened directory fd): re-running for the
 * same taskId should not fail. Refuses a symlink in the task-dir position so
 * permission repair cannot be redirected to another directory.
 * @param {string} dir
 */
export function ensureTaskOutputDir(dir) {
  let existing;
  try {
    existing = fs.lstatSync(dir);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  if (existing?.isSymbolicLink()) throw outputDirSymlinkError(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openDirectoryNoFollow(dir);
  if (fd === null) {
    let current;
    try {
      current = fs.lstatSync(dir);
    } catch (err) {
      if (errCode(err) === "ENOENT") throw new Error(`error: task output directory disappeared while creating it: ${dir}`, { cause: err });
      throw err;
    }
    if (current.isSymbolicLink()) throw outputDirSymlinkError(dir);
    throw new Error(`error: task output path is not a directory: ${dir}`);
  }
  try {
    fs.fchmodSync(fd, 0o700);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The prompt block appended to every dispatch's prompt (alongside the
 * project's check-gate block, when present) naming the per-task output
 * directory. Plain prose by design: the worker is already told about the
 * scratch dir via TASKFERRY_OUTPUT_DIR, but the prompt explicitly naming
 * the path is what makes the instruction survive prompts that are reset
 * to a fresh turn. Verbatim per the issue's request that the dispatch
 * prompt "gets a line naming that path, the same way the check-gate
 * command already gets injected via verificationPromptBlock."
 * @param {string|null|undefined} outputDir
 * @returns {string}
 */
export function outputDirPromptBlock(outputDir) {
  if (!outputDir) return "";
  return `${PROMPT_BLOCK_SEPARATOR}## Persistent output dir\nThis task has a writable scratch directory at \`${outputDir}\` (also exposed as the \`${TASKFERRY_OUTPUT_DIR_ENV}\` environment variable inside the sandbox). Anything you write here persists past turn end — use it for deliverables that must survive the task settling, getting cancelled, or ending on a tool call instead of a final message. Retrieve its contents with \`taskferry output <id>\` after settlement.`;
}

/**
 * Lists a task's output directory's contents as a flat relative-path ->
 * byte size map, recursing into subdirectories but skipping anything that
 * looks like a node_modules or .git subtree (those would never be a worker
 * deliverable). Symlinks are reported with their resolved size when the
 * target is a regular file, otherwise skipped. Returns the empty string
 * for an absent or empty directory so a fresh dispatch reads sensibly.
 * @param {string} dir
 * @returns {{files: Array<{path: string, size: number}>, bytes: number, total: number, truncated: boolean}}
 */
export function listTaskOutputFiles(dir) {
  const rootFd = openDirectoryNoFollow(dir);
  if (rootFd === null) return emptyListing();
  const rootPath = pathForDirectoryFd(rootFd, dir);
  try {
    return collectOutputFiles(rootPath);
  } finally {
    fs.closeSync(rootFd);
  }
}

/**
 * @param {string} rootPath
 * @returns {{files: Array<{path: string, size: number}>, bytes: number, total: number, truncated: boolean}}
 */
function collectOutputFiles(rootPath) {
  /** @type {Array<{path: string, size: number}>} */
  const files = [];
  let bytes = 0;
  let truncated = false;
  /** @type {Array<{full: string, relative: string}>} */
  const stack = [{ full: rootPath, relative: "" }];
  while (stack.length && !truncated) {
    if (shouldStopListing(files.length, bytes)) {
      truncated = true;
    } else {
      const current = /** @type {{full: string, relative: string}} */ (stack.pop());
      const entries = readdirSafe(current.full);
      entries.some((entry) => {
        const result = processEntry(entry, current.full, current.relative, files.length, bytes);
        if (result === null) return false;
        if (result === "truncated") {
          truncated = true;
          return true;
        }
        if (result.kind === "file") {
          files.push({ path: result.rel, size: result.size });
          bytes += result.size;
        } else if (result.kind === "directory") {
          stack.push({ full: result.full, relative: result.rel });
        } else {
          // "skip" -> no-op (symlinks to nowhere, non-regular entries)
        }
        return false;
      });
    }
  }
  files.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  const total = files.length;
  return { files, bytes, total, truncated };
}

/**
 * Classify a single directory entry for the listing. Returns:
 *  - `null` for excluded entries (skip-list: node_modules, .git).
 *  - `"truncated"` if the listing caps have been hit (caller should stop).
 *  - `{ kind: "file", rel, size }` for a regular file.
 *  - `{ kind: "directory", full, rel }` for a subdirectory to descend into.
 *  - `{ kind: "skip" }` for anything else (symlinks to nowhere, etc.).
 *
 * @param {import("node:fs").Dirent} entry
 * @param {string} current
 * @param {string} currentRelative
 * @param {number} fileCount
 * @param {number} byteCount
 * @returns {null | "truncated" | {kind: "file", rel: string, size: number} | {kind: "directory", full: string, rel: string} | {kind: "skip"}}
 */
function processEntry(entry, current, currentRelative, fileCount, byteCount) {
  if (excludedEntry(entry.name)) return null;
  if (shouldStopListing(fileCount, byteCount)) return "truncated";
  const full = path.join(current, entry.name);
  const rel = path.join(currentRelative, entry.name);
  const classified = classifyEntry(entry, full);
  if (classified.kind === "file") {
    // Checked here (with this entry's own size), not just via the
    // pre-entry shouldStopListing() cap above -- otherwise a single file
    // larger than MAX_OUTPUT_TOTAL_BYTES is admitted whole because the
    // running total was still 0 (or under-cap) before this entry.
    if (byteCount + classified.size > MAX_OUTPUT_TOTAL_BYTES) return "truncated";
    return { rel, size: classified.size, kind: "file" };
  }
  if (classified.kind === "directory") {
    return { kind: "directory", full, rel };
  }
  return { kind: "skip" };
}

/** @param {number} fileCount @param {number} bytes */
function shouldStopListing(fileCount, bytes) {
  return fileCount >= MAX_OUTPUT_LIST_ENTRIES || bytes >= MAX_OUTPUT_TOTAL_BYTES;
}

/** @param {string} dir */
function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (errCode(err) === "ENOENT") return [];
    throw err;
  }
}

/**
 * Opens a real directory without following a symlink in the final path
 * component. Keeping the descriptor open also lets callers traverse the root
 * through the descriptor rather than resolving the root path again.
 * @param {string} dir
 * @returns {number|null}
 */
function openDirectoryNoFollow(dir) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
  if (!stat.isDirectory()) return null;
  try {
    return fs.openSync(dir, DIRECTORY_OPEN_FLAGS);
  } catch (err) {
    if (errCode(err) === "ENOENT" || errCode(err) === "ENOTDIR" || errCode(err) === "ELOOP") return null;
    throw err;
  }
}

/** @param {number} fd @returns {string|null} */
function descriptorPath(fd) {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  if (process.platform === "darwin") return `/dev/fd/${fd}`;
  return null;
}

/** @param {number} fd @param {string} fallback */
function pathForDirectoryFd(fd, fallback) {
  return descriptorPath(fd) ?? fallback;
}

/** @param {number} fd @param {string} fallback */
function realpathForFd(fd, fallback) {
  return fs.realpathSync(descriptorPath(fd) ?? fallback);
}

/** @returns {{files: Array<{path: string, size: number}>, bytes: number, total: number, truncated: boolean}} */
function emptyListing() {
  return { files: [], bytes: 0, total: 0, truncated: false };
}

/** @param {string} dir @param {string} target */
function isInsideDirectory(dir, target) {
  const dirWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return target === dir || target.startsWith(dirWithSep);
}

/** @param {string} dir */
function outputDirSymlinkError(dir) {
  return new Error(`error: task output directory is a symlink: ${dir}\nhelp: remove the symlink before retrying`);
}

/** @param {string} relativePath */
function outputPathEscapeError(relativePath) {
  return new Error(`error: --path "${relativePath}" escapes the task's output directory\nhelp: pass a relative path like "deliverable.txt" or "subdir/notes.md"`);
}

/** @param {string} name */
function excludedEntry(name) {
  return name === "node_modules" || name === ".git";
}

/**
 * @param {fs.Dirent} entry
 * @param {string} full
 * @returns {{kind: "file", size: number} | {kind: "directory"} | {kind: "skip"}}
 */
function classifyEntry(entry, full) {
  if (entry.isSymbolicLink()) {
    let target;
    try {
      target = fs.statSync(full);
    } catch (err) {
      if (errCode(err) === "ENOENT" || errCode(err) === "ELOOP") return { kind: "skip" };
      throw err;
    }
    if (target.isFile()) return { kind: "file", size: target.size };
    // Deliberately not { kind: "directory" } here: descending into a
    // symlinked directory has no cycle detection (a self- or
    // ancestor-referential symlink would re-enter itself via the
    // traversal stack indefinitely) and can walk arbitrary host
    // directories the symlink points outside the output dir. Only a
    // symlink-to-file is reported (as its resolved size, above).
    return { kind: "skip" };
  }
  if (entry.isDirectory()) {
    return { kind: "directory" };
  } else if (!entry.isFile()) {
    return { kind: "skip" };
  } else {
    return { kind: "file", size: fs.statSync(full).size };
  }
}

/**
 * Resolves a relative path under a base dir and rejects any traversal
 * (`..`, absolute path) that would escape the base. Throws on escape so
 * the CLI surfaces it as a usage error rather than silently reading
 * /etc/passwd.
 * @param {string} baseDir
 * @param {string} relativePath
 * @returns {string}
 */
export function resolveInsideDir(baseDir, relativePath) {
  const resolved = path.resolve(baseDir, relativePath);
  const baseWithSep = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (resolved !== baseDir && !resolved.startsWith(baseWithSep)) {
    throw outputPathEscapeError(relativePath);
  }
  return resolved;
}

/**
 * Reads a single file's bytes from a task's output dir, capped at
 * MAX_OUTPUT_FILE_BYTES. Returns `null` when the file does not exist or
 * exceeds the cap; the caller surfaces a "too large to retrieve via CLI,
 * inspect on disk" hint. Resolves paths against the dir basename --
 * rejects any path that would escape the per-task directory so this
 * can't be used to read stateDir siblings (tasks.json, etc.) or anywhere
 * outside the scratch root.
 * @param {string} dir
 * @param {string} relativePath
 * @returns {{content: string|null, size: number, truncated: boolean, error?: string}}
 */
export function readTaskOutputFile(dir, relativePath) {
  const target = resolveInsideDir(dir, relativePath);
  const dirFd = openDirectoryNoFollow(dir);
  if (dirFd === null) return { content: null, size: 0, truncated: false, error: "not_found" };
  let fd;
  try {
    try {
      fd = fs.openSync(target, "r");
    } catch (err) {
      if (errCode(err) === "ENOENT") return { content: null, size: 0, truncated: false, error: "not_found" };
      throw err;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return { content: null, size: stat.size, truncated: false, error: "not_a_file" };
      // The descriptor is opened before this check. Its real path remains
      // pinned even if the worker replaces the path string with a symlink
      // before the read below.
      const realTarget = realpathForFd(fd, target);
      const realDir = realpathForFd(dirFd, dir);
      if (!isInsideDirectory(realDir, realTarget)) {
        throw outputPathEscapeError(relativePath);
      }
      if (stat.size > MAX_OUTPUT_FILE_BYTES) return { content: null, size: stat.size, truncated: true, error: "too_large" };
      const buffer = fs.readFileSync(fd);
      return { content: buffer.toString("utf8"), size: stat.size, truncated: false };
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.closeSync(dirFd);
  }
}
