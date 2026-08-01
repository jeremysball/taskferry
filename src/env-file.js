import fs from "node:fs";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  const opensWith = raw[0] === '"' || raw[0] === "'";
  if (opensWith && (raw.length < 2 || raw[raw.length - 1] !== raw[0])) {
    throw new Error(`error: ${sourcePath}:${lineNo}: unterminated ${raw[0] === '"' ? "double" : "single"}-quoted value\nhelp: close the quote, or remove the leading quote character if it wasn't meant to open one`);
  }
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    return raw.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (raw.length >= 2 && raw[0] === "'" && raw[raw.length - 1] === "'") {
    return raw.slice(1, -1);
  }
  return raw;
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
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

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
      throw new Error(`error: ${sourcePath}:${i + 1}: expected NAME=VALUE (line has no '=')\nhelp: each non-comment, non-blank line must be "NAME=VALUE" (optionally prefixed with "export ")`);
    }
    const name = withoutExport.slice(0, eq).trim();
    const rawValue = withoutExport.slice(eq + 1).trim();
    if (!KEY_RE.test(name)) {
      throw new Error(`error: ${sourcePath}:${i + 1}: invalid env var name ${JSON.stringify(name)}\nhelp: names must match [A-Za-z_][A-Za-z0-9_]*`);
    }
    result[name] = unquote(rawValue, sourcePath, i + 1);
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
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
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
