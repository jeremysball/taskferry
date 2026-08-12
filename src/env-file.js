import fs from "node:fs";
import path from "node:path";
import { errCode } from "./errors.js";

const KEY_RE = /^[A-Za-z_]\w*$/;

/**
 * Strips a single layer of matching quotes from a raw value, unescaping
 * `\"` and `\\` for double-quoted values only (single-quoted values are
 * taken literally, matching POSIX shell semantics closely enough for a
 * secrets file without pulling in a full shell-quoting parser). Throws on
 * a value that opens a quote but never closes it (e.g. `"unterminated`)
 * rather than silently returning the leading quote character as part of
 * the value -- an unterminated quote left as data instead of a parse
 * error would corrupt the secret it's protecting into something that
 * fails at the worker's own auth step, indistinguishable from a wrong
 * credential, instead of failing loudly at daemon startup where it's
 * actually diagnosable.
 * @param {string} raw
 * @param {string} sourcePath
 * @param {number} lineNo
 * @returns {string}
 */
function unquote(raw, sourcePath, lineNo) {
  const quoteChar = raw[0];
  const opensWith = quoteChar === '"' || quoteChar === "'";
  if (!opensWith) return raw;

  const closesQuote = raw.length >= 2 && raw[raw.length - 1] === quoteChar;
  if (!closesQuote) {
    const quoteKind = quoteChar === '"' ? "double" : "single";
    throw new Error(`error: ${sourcePath}:${lineNo}: unterminated ${quoteKind}-quoted value\nhelp: close the quote, or remove the leading quote character if it wasn't meant to open one`);
  }

  const inner = raw.slice(1, -1);
  return quoteChar === '"' ? inner.replace(/\\(["\\])/g, "$1") : inner;
}

/**
 * Parses one non-blank, non-comment env-file line into a `[name, value]`
 * pair, or returns `null` for a line the caller should skip.
 * @param {string} trimmed
 * @param {string} sourcePath
 * @param {number} lineNo
 * @returns {[string, string]}
 */
function parseEnvFileLine(trimmed, sourcePath, lineNo) {
  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
  const eq = withoutExport.indexOf("=");
  if (eq === -1) {
    // Deliberately omits the line's own content from the message: this
    // file exists to hold secrets, and a malformed line's content
    // (e.g. a bare API key pasted without "NAME=") must never end up
    // embedded in an Error whose .message this same module's caller
    // (tasks.js's createTaskManager()) lets propagate into
    // daemon-boot.err -- a file callers/cron routinely capture into
    // their own logs on a boot failure. Naming the line number is
    // enough to fix the file without echoing its contents anywhere.
    throw new Error(`error: ${sourcePath}:${lineNo}: expected NAME=VALUE (line has no '=')\nhelp: each non-comment, non-blank line must be "NAME=VALUE" (optionally prefixed with "export ")`);
  }
  const name = withoutExport.slice(0, eq).trim();
  const rawValue = withoutExport.slice(eq + 1).trim();
  if (!KEY_RE.test(name)) {
    throw new Error(`error: ${sourcePath}:${lineNo}: invalid env var name ${JSON.stringify(name)}\nhelp: names must match [A-Za-z_][A-Za-z0-9_]*`);
  }
  return [name, unquote(rawValue, sourcePath, lineNo)];
}

/**
 * Parses simple `.env`-style text into a flat `{name: value}` object.
 *
 * Grammar (deliberately minimal, not a full dotenv/shell parser):
 *   - Blank lines and lines whose first non-whitespace character is `#`
 *     are skipped.
 *   - Every other line must be `[export ]NAME=VALUE`. `NAME` must match
 *     `/^[A-Za-z_][A-Za-z0-9_]*$/` (a valid POSIX env var name).
 *   - `VALUE` may be wrapped in matching single or double quotes, stripped
 *     before use; double-quoted values additionally unescape `\"`/`\\`.
 *     An unquoted value is taken verbatim, including any `#` it contains
 *     (no inline trailing-comment support, to avoid ambiguity with values
 *     that legitimately contain `#`).
 *   - A later `NAME` overrides an earlier one, last-write-wins.
 *
 * Throws on any line that doesn't match this grammar, naming the file and
 * line number, so a typo'd secrets file fails loudly at daemon startup
 * instead of silently loading a truncated environment.
 *
 * @param {string} text
 * @param {string} [sourcePath] - only used to make the error message actionable
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text, sourcePath = "<env file>") {
  /** @type {Record<string, string>} */
  const result = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const [name, value] = parseEnvFileLine(trimmed, sourcePath, i + 1);
    result[name] = value;
  }
  return result;
}

/**
 * Reads and parses an env file at `filePath`. A missing file is not an
 * error only when `filePath` came from a default that was never
 * explicitly configured -- callers that resolved `filePath` from an
 * explicit `TASKFERRY_ENV_FILE`/`envFile` setting should treat ENOENT as
 * a real misconfiguration and let it throw, the same way `loadConfig()`
 * throws on unparseable JSON rather than silently falling back.
 * @param {string} filePath
 * @param {object} [options]
 * @param {(path: string, encoding: "utf8") => string} [options.readFileFn]
 * @param {(path: string) => {mode: number}} [options.statFn]
 * @returns {Record<string, string>}
 */
export function loadEnvFile(filePath, { readFileFn = fs.readFileSync, statFn = fs.statSync } = {}) {
  let raw;
  try {
    raw = readFileFn(filePath, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      throw new Error(`error: env file not found: ${filePath}\nhelp: fix the path in TASKFERRY_ENV_FILE / the "envFile" config key, or remove the setting to stop loading one`, { cause: err });
    }
    throw err;
  }
  // This file exists specifically to hold secrets, unlike config.json --
  // reject anything group/other-readable rather than silently loading it,
  // the same way an insecure state/runtime dir is chmod 0700 elsewhere in
  // this codebase instead of left at the OS default.
  const stat = statFn(filePath);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`error: ${filePath} is readable by group or other (mode ${(stat.mode & 0o777).toString(8)})\nhelp: chmod 600 ${filePath}`);
  }
  return parseEnvFile(raw, filePath);
}

/**
 * Re-applies `loadEnvFileFn(filePath)` whenever the file changes, so a
 * secret rotated after daemon startup (e.g. a `secrets-unlock`-style
 * decrypt-and-replace) reaches spawned children without a daemon restart.
 * Does *not* perform the required initial load itself -- callers are
 * expected to have already called `loadEnvFile(filePath)` once (that's
 * what surfaces a missing/misconfigured path as the hard daemon-startup
 * error `docs/config.md` documents) before calling this, so this function
 * can assume the directory already exists and doesn't need a fallback for
 * watching a not-yet-created one.
 *
 * Watches the parent directory rather than the file itself, filtered by
 * filename: a decrypt-and-replace rewrite goes through mktemp+rename,
 * which swaps the file's inode out from under a direct watch on it, but a
 * directory watch survives that. Multiple filesystem events from one
 * rewrite are coalesced with a short debounce.
 *
 * A reload that fails (a transient partial write caught mid-rename, a
 * permission regression, the file removed) is reported via `onError` and
 * otherwise ignored -- the caller keeps whatever `onReload` last gave it,
 * since a live daemon dropping every secret because the file was briefly
 * unreadable is worse than serving one more request with a
 * stale-but-valid value.
 *
 * @param {string} filePath
 * @param {object} options
 * @param {(vars: Record<string, string>) => void} options.onReload
 * @param {(error: Error) => void} [options.onError]
 * @param {number} [options.debounceMs]
 * @param {typeof fs.watch} [options.watchFn]
 * @param {(path: string) => Record<string, string>} [options.loadEnvFileFn]
 * @param {(path: string) => {mtimeMs: number, size: number}} [options.statFn]
 * @returns {{close: () => void}}
 */
export function watchEnvFile(filePath, { onReload, onError = () => {}, debounceMs = 100, watchFn = fs.watch, loadEnvFileFn = loadEnvFile, statFn = fs.statSync }) {
  const dir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  /** @type {ReturnType<typeof setTimeout>} */
  let debounceTimer;
  let closed = false;

  const statOrNull = () => {
    try {
      return statFn(filePath);
    } catch {
      return null;
    }
  };

  const reload = () => {
    if (closed) return;
    // Guard against a torn read: some rotation tools write in place
    // (truncate, then write) rather than mktemp+rename, so a read that
    // lands mid-write can succeed while returning truncated/partial
    // content. Comparing a stat taken before and after the read catches
    // that window -- if the file changed size or mtime while we were
    // reading it, the read is untrustworthy, so reschedule instead of
    // handing a possibly-truncated `{}` to `onReload` and silently wiping
    // every previously loaded secret.
    const statBefore = statOrNull();
    // Deliberately split apart rather than `onReload(loadEnvFileFn(...))`
    // inlined behind a try -- keeping the fallible read and the
    // side-effecting callback on separate lines makes it obvious neither
    // one is accidentally skipped by short-circuiting, the failure mode
    // that bit an earlier optional-chained version of this same pattern.
    let vars;
    try {
      vars = loadEnvFileFn(filePath);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const statAfter = statOrNull();
    if (statBefore && statAfter && (statBefore.mtimeMs !== statAfter.mtimeMs || statBefore.size !== statAfter.size)) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(reload, debounceMs);
      return;
    }
    try {
      onReload(vars);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const watcher = watchFn(dir, (_eventType, changedName) => {
    if (closed) return;
    // `changedName` can be null/undefined on platforms fs.watch doesn't
    // report filenames on (see the Node docs' "Caveats" for `fs.watch`).
    // We can't filter by name in that case, so we conservatively still
    // reload rather than silently drop what might be the real rename
    // event -- an extra debounced read of unrelated directory activity is
    // harmless (the mtime/size guard above makes it idempotent), missing
    // a real secret rotation is not.
    if (changedName && changedName !== fileName) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(reload, debounceMs);
  });
  watcher.on("error", (error) => { if (!closed) onError(error); });

  return {
    close: () => {
      closed = true;
      clearTimeout(debounceTimer);
      watcher.close();
    },
  };
}
