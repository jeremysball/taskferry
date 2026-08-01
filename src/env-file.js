import fs from "node:fs";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strips a single layer of matching quotes from a raw value, unescaping
 * `\"` and `\\` for double-quoted values only (single-quoted values are
 * taken literally, matching POSIX shell semantics closely enough for a
 * secrets file without pulling in a full shell-quoting parser).
 * @param {string} raw
 * @returns {string}
 */
function unquote(raw) {
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
      throw new Error(`error: ${sourcePath}:${i + 1}: expected NAME=VALUE, got ${JSON.stringify(line)}\nhelp: each non-comment, non-blank line must be "NAME=VALUE" (optionally prefixed with "export ")`);
    }
    const name = withoutExport.slice(0, eq).trim();
    const rawValue = withoutExport.slice(eq + 1).trim();
    if (!KEY_RE.test(name)) {
      throw new Error(`error: ${sourcePath}:${i + 1}: invalid env var name ${JSON.stringify(name)}\nhelp: names must match [A-Za-z_][A-Za-z0-9_]*`);
    }
    result[name] = unquote(rawValue);
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
 * @returns {Record<string, string>}
 */
export function loadEnvFile(filePath, { readFileFn = fs.readFileSync } = {}) {
  let raw;
  try {
    raw = readFileFn(filePath, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      throw new Error(`error: env file not found: ${filePath}\nhelp: fix the path in TASKFERRY_ENV_FILE / the "envFile" config key, or remove the setting to stop loading one`, { cause: err });
    }
    throw err;
  }
  return parseEnvFile(raw, filePath);
}
