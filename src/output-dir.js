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
// Sibling caps on the directory walk: without them a worker that
// mkmdir's unbounded nested empty directories (or unbounded shallow
// ones) would force an unbounded synchronous readdir/stat walk on the
// daemon's single request thread (the listing call does the traversal
// in-process because it must return the whole tree in one RPC). Pair
// each with MAX_OUTPUT_LIST_ENTRIES / MAX_OUTPUT_TOTAL_BYTES so a worker
// can't pick whichever axis is uncapped to make the listing unbounded.
const MAX_OUTPUT_LIST_DIRS = 256;
const MAX_OUTPUT_LIST_DEPTH = 32;
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
    return collectOutputFiles(rootFd, rootPath);
  } finally {
    fs.closeSync(rootFd);
  }
}

/**
 * @param {number} rootFd
 * @param {string} rootPath
 * @returns {{files: Array<{path: string, size: number}>, bytes: number, total: number, truncated: boolean}}
 */
function collectOutputFiles(rootFd, rootPath) {
  /** @type {{files: Array<{path: string, size: number}>, bytes: number, truncated: boolean, visitedDirs: number}} */
  const state = { files: [], bytes: 0, truncated: false, visitedDirs: 0 };
  // depth=0 on the root, increments by 1 each time we push a subdirectory.
  /** @type {Array<{fd: number, full: string, relative: string, depth: number}>} */
  const stack = [{ fd: rootFd, full: rootPath, relative: "", depth: 0 }];
  try {
    while (stack.length && !state.truncated) {
      visitStackFrame(stack, state, rootFd);
    }
  } finally {
    // Close any subdirectory fds left on the stack from an early exit
    // (truncation). The root fd is the caller's to close.
    closeStackFds(stack, rootFd);
  }
  state.files.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  return { files: state.files, bytes: state.bytes, total: state.files.length, truncated: state.truncated };
}

/**
 * Pops one directory off the traversal stack, reads it, and folds every
 * entry into `state` (or pushes a freshly pinned fd for a subdirectory).
 * @param {Array<{fd: number, full: string, relative: string, depth: number}>} stack
 * @param {{files: Array<{path: string, size: number}>, bytes: number, truncated: boolean, visitedDirs: number}} state
 * @param {number} rootFd
 */
function visitStackFrame(stack, state, rootFd) {
  if (shouldStopListing(state)) {
    state.truncated = true;
    return;
  }
  const current = /** @type {{fd: number, full: string, relative: string, depth: number}} */ (stack.pop());
  state.visitedDirs++;
  try {
    const entries = readdirSafe(current.full);
    entries.some((entry) => visitEntry(entry, current, state, stack));
  } finally {
    if (current.fd !== rootFd) fs.closeSync(current.fd);
  }
}

/**
 * @param {import("node:fs").Dirent} entry
 * @param {{full: string, relative: string, depth: number}} current
 * @param {{files: Array<{path: string, size: number}>, bytes: number, truncated: boolean, visitedDirs: number}} state
 * @param {Array<{fd: number, full: string, relative: string, depth: number}>} stack
 * @returns {boolean} true to stop iterating this directory's entries early
 */
function visitEntry(entry, current, state, stack) {
  const result = processEntry(entry, current.full, current.relative, state);
  if (result === null) return false;
  if (result === "truncated") {
    state.truncated = true;
    return true;
  }
  if (result.kind === "file") {
    state.files.push({ path: result.rel, size: result.size });
    state.bytes += result.size;
  } else if (result.kind === "directory") {
    // Pin the subdirectory with its own O_NOFOLLOW fd the moment we
    // descend into it, rather than trusting the dirent's cached d_type
    // and re-resolving the plain path string later -- that gap is
    // exactly where a worker can swap a real subdirectory for a symlink
    // between discovery (readdir) and traversal (the next readdirSafe
    // call on that path).
    // Hit the depth cap: skip pushing this subdirectory. Mark truncated
    // so the caller's listing clearly reports the cut rather than a
    // silently smaller tree.
    if (current.depth + 1 > MAX_OUTPUT_LIST_DEPTH) {
      state.truncated = true;
      return true;
    }
    const childFd = openDirectoryNoFollow(result.full);
    if (childFd !== null) {
      pushChildStack(stack, childFd, result.full, result.rel, current.depth + 1);
    }
    // else: no longer a real directory by the time we opened it (removed,
    // or swapped for a symlink and rejected by O_NOFOLLOW) -- treat it as
    // vanished rather than following it.
  } else {
    // "skip" -> no-op (symlinks to nowhere, non-regular entries)
  }
  return false;
}

/**
 * @param {Array<{fd: number, full: string, relative: string, depth: number}>} stack
 * @param {number} childFd
 * @param {string} full
 * @param {string} rel
 * @param {number} depth
 */
function pushChildStack(stack, childFd, full, rel, depth) {
  try {
    stack.push({ fd: childFd, full: pathForDirectoryFd(childFd, full), relative: rel, depth });
  } catch (err) {
    try { fs.closeSync(childFd); } catch {}
    throw err;
  }
}

/**
 * @param {Array<{fd: number, full: string, relative: string, depth: number}>} stack
 * @param {number} rootFd
 */
function closeStackFds(stack, rootFd) {
  for (const entry of stack) {
    if (entry.fd !== rootFd) fs.closeSync(entry.fd);
  }
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
 * @param {{files: Array<{path: string, size: number}>, bytes: number, visitedDirs: number}} state
 * @returns {null | "truncated" | {kind: "file", rel: string, size: number} | {kind: "directory", full: string, rel: string} | {kind: "skip"}}
 */
function processEntry(entry, current, currentRelative, state) {
  if (excludedEntry(entry.name)) return null;
  if (shouldStopListing(state)) return "truncated";
  const full = path.join(current, entry.name);
  const rel = path.join(currentRelative, entry.name);
  const classified = classifyEntry(entry, full);
  if (classified.kind === "file") {
    // Checked here (with this entry's own size), not just via the
    // pre-entry shouldStopListing() cap above -- otherwise a single file
    // larger than MAX_OUTPUT_TOTAL_BYTES is admitted whole because the
    // running total was still 0 (or under-cap) before this entry.
    if (state.bytes + classified.size > MAX_OUTPUT_TOTAL_BYTES) return "truncated";
    return { rel, size: classified.size, kind: "file" };
  }
  if (classified.kind === "directory") {
    // Sibling directory-count cap on top of the depth cap the caller
    // enforces in visitEntry: either axis independently can be hit by a
    // worker (a chain of nested empties vs. a wide tree of empties).
    if (state.visitedDirs >= MAX_OUTPUT_LIST_DIRS) return "truncated";
    return { kind: "directory", full, rel };
  }
  return { kind: "skip" };
}

/** @param {{files: Array<{path: string, size: number}>, bytes: number, visitedDirs: number}} state */
function shouldStopListing(state) {
  return state.files.length >= MAX_OUTPUT_LIST_ENTRIES
    || state.bytes >= MAX_OUTPUT_TOTAL_BYTES
    || state.visitedDirs >= MAX_OUTPUT_LIST_DIRS;
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

/**
 * The magic-symlink path through which fd-pinned directory/file access is
 * implemented: /proc/self/fd/<n> (Linux) and /dev/fd/<n> (Darwin) both
 * resolve to whatever the fd is actually attached to, immune to the
 * original path string being renamed or replaced with a symlink afterward.
 * No other supported platform exists (taskferry does not run on Windows),
 * so there is no real fallback case here -- surface that loudly instead of
 * silently resolving the caller's mutable path string, which would quietly
 * defeat every TOCTOU protection built on top of this function.
 * @param {number} fd @returns {string}
 */
function descriptorPath(fd) {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  if (process.platform === "darwin") return `/dev/fd/${fd}`;
  throw new Error(
    `error: task output directory access requires linux or darwin (got "${process.platform}")\n` +
      `help: fd-pinned path resolution has no implementation on this platform`
  );
}

/** @param {number} fd @param {string} _fallback unused; kept so call sites don't need to change */
function pathForDirectoryFd(fd, _fallback) {
  return descriptorPath(fd);
}

/** @param {number} fd @param {string} _fallback unused; kept so call sites don't need to change */
function realpathForFd(fd, _fallback) {
  return fs.realpathSync(descriptorPath(fd));
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
    return classifySymlink(full);
  }
  if (entry.isDirectory()) {
    return { kind: "directory" };
  }
  if (!entry.isFile()) {
    return { kind: "skip" };
  }
  return statRegularFile(full);
}

/** @param {string} full @returns {{kind: "file", size: number} | {kind: "skip"}} */
function classifySymlink(full) {
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

/** @param {string} full @returns {{kind: "file", size: number} | {kind: "skip"}} */
function statRegularFile(full) {
  try {
    return { kind: "file", size: fs.statSync(full).size };
  } catch (err) {
    if (errCode(err) === "ENOENT") return { kind: "skip" };
    throw err;
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
  if (!isInsideDirectory(baseDir, resolved)) {
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
      // O_NONBLOCK on the read so a worker-created FIFO at the path can't
      // block the daemon's request thread waiting for a writer that never
      // arrives (FIFOs block open() for readers until a writer connects).
      // The errno is ENXIO on Linux for "open with O_NONBLOCK against a
      // FIFO with no writers"; we translate it into not_a_file below via
      // the fstat check, since the worker replaced a regular file with a
      // FIFO (which is a non-file), not actually expecting a write.
      fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    } catch (err) {
      if (errCode(err) === "ENOENT") return { content: null, size: 0, truncated: false, error: "not_found" };
      // ENXIO = O_NONBLOCK open against a FIFO with no writer attached.
      // Surface as not_a_file: the worker swapped a regular file for a
      // pipe to wedge the daemon's read, not to legitimately stream.
      if (errCode(err) === "ENXIO") return { content: null, size: 0, truncated: false, error: "not_a_file" };
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
      // Read with a size cap rather than `fs.readFileSync(fd)` (which
      // allocates by stat.size): the file might have grown past the cap
      // between the fstat and the read, and the daemon-server's
      // MAX_BUFFER_BYTES response ceiling plus JSON escaping can't carry
      // more than that cap. Read up to MAX+1 so a single byte over the
      // cap is detectable on the post-read size check.
      const buffer = Buffer.allocUnsafe(MAX_OUTPUT_FILE_BYTES + 1);
      const totalRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (totalRead > MAX_OUTPUT_FILE_BYTES) {
        return { content: null, size: totalRead, truncated: true, error: "too_large" };
      }
      return { content: buffer.toString("utf8", 0, totalRead), size: totalRead, truncated: false };
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.closeSync(dirFd);
  }
}
