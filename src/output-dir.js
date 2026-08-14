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
 * (`recursive: true` + best-effort chmod): re-running for the same taskId
 * should not fail, so the boot-time orphan sweep can pre-create them when
 * it re-discovers them.
 * @param {string} dir
 */
export function ensureTaskOutputDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
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
  /** @type {Array<{path: string, size: number}>} */
  const files = [];
  let bytes = 0;
  let truncated = false;
  /** @type {string[]} */
  const stack = [dir];
  while (stack.length && !truncated) {
    if (shouldStopListing(files.length, bytes)) {
      truncated = true;
    } else {
      const current = /** @type {string} */ (stack.pop());
      const entries = readdirSafe(current);
      entries.some((entry) => {
        const result = processEntry(entry, current, dir, files.length, bytes);
        if (result === null) return false;
        if (result === "truncated") {
          truncated = true;
          return true;
        }
        if (result.kind === "file") {
          files.push({ path: result.rel, size: result.size });
          bytes += result.size;
        } else if (result.kind === "directory") {
          stack.push(result.full);
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
 *  - `{ kind: "directory", full }` for a subdirectory to descend into.
 *  - `{ kind: "skip" }` for anything else (symlinks to nowhere, etc.).
 *
 * @param {import("node:fs").Dirent} entry
 * @param {string} current
 * @param {string} dir
 * @param {number} fileCount
 * @param {number} byteCount
 * @returns {null | "truncated" | {kind: "file", rel: string, size: number} | {kind: "directory", full: string} | {kind: "skip"}}
 */
function processEntry(entry, current, dir, fileCount, byteCount) {
  if (excludedEntry(entry.name)) return null;
  if (shouldStopListing(fileCount, byteCount)) return "truncated";
  const full = path.join(current, entry.name);
  const rel = path.relative(dir, full);
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
    return { kind: "directory", full };
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
    throw new Error(`error: --path "${relativePath}" escapes the task's output directory\nhelp: pass a relative path like "deliverable.txt" or "subdir/notes.md"`);
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
  /** @type {fs.Stats} */
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    if (errCode(err) === "ENOENT") return { content: null, size: 0, truncated: false, error: "not_found" };
    throw err;
  }
  if (!stat.isFile()) return { content: null, size: stat.size, truncated: false, error: "not_a_file" };
  // resolveInsideDir only rejects lexical escape (`..`, an absolute path);
  // it does not stop a symlink planted inside dir from pointing outside
  // it, since path.resolve() doesn't dereference the final symlink. Now
  // that the target is known to exist, check its *real* path against the
  // real path of dir so a worker-planted symlink can't leak arbitrary
  // host files (/etc/passwd, /proc/self/environ) through this RPC.
  const realTarget = fs.realpathSync(target);
  const realDir = fs.realpathSync(dir);
  const realDirWithSep = realDir.endsWith(path.sep) ? realDir : realDir + path.sep;
  if (realTarget !== realDir && !realTarget.startsWith(realDirWithSep)) {
    throw new Error(`error: --path "${relativePath}" escapes the task's output directory\nhelp: pass a relative path like "deliverable.txt" or "subdir/notes.md"`);
  }
  if (stat.size > MAX_OUTPUT_FILE_BYTES) return { content: null, size: stat.size, truncated: true, error: "too_large" };
  const buffer = fs.readFileSync(target);
  return { content: buffer.toString("utf8"), size: stat.size, truncated: false };
}
