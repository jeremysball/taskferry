import fs from "node:fs";
import path from "node:path";

const ISOLATED_FLAG = "--isolated";

/**
 * A JSON string can't legally contain a raw newline, so if we can't find a
 * closing quote before one, this is an unterminated string -- return null
 * rather than hunting across lines for the next real quote, which is what
 * let a comment on a later line survive unstripped.
 * @param {string} text
 * @param {number} start
 * @returns {number|null} index just past the closing quote, or null
 */
function findStringEnd(text, start) {
  const n = text.length;
  let j = start + 1;
  while (j < n) {
    const cj = text[j];
    if (cj === "\n") return null;
    if (cj === '"') return j + 1;
    j += cj === "\\" && j + 1 < n && text[j + 1] !== "\n" ? 2 : 1;
  }
  return null;
}

/**
 * @param {string} text
 * @param {number} i
 * @returns {number|null} index just past a `//`/`/* *\/` comment starting at
 * `i`, or null if `i` isn't a comment start (including an unterminated
 * block comment, which is left as literal text rather than swallowing the
 * rest of the file).
 */
function commentSkipEnd(text, i) {
  if (text[i] !== "/") return null;
  if (text[i + 1] === "/") {
    const newline = text.indexOf("\n", i + 2);
    return newline === -1 ? text.length : newline;
  }
  if (text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? null : end + 2;
  }
  return null;
}

// Manual scan instead of a regex: matching a possibly-unterminated JSON
// string with backtracking alternation (`\\.` vs `[^"\\\n]`) is exactly the
// super-linear shape sonarjs flags, and this parses config files whose
// content isn't guaranteed trusted. A single forward pass is O(n) by
// construction, so there's nothing left to backtrack.
/**
 * @param {string} text
 * @returns {string}
 */
export function stripJsonComments(text) {
  let result = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const stringEnd = ch === '"' ? findStringEnd(text, i) : null;
    const commentEnd = ch === "/" ? commentSkipEnd(text, i) : null;
    if (stringEnd !== null) {
      result += text.slice(i, stringEnd);
      i = stringEnd;
    } else if (commentEnd !== null) {
      i = commentEnd;
    } else {
      result += ch;
      i += 1;
    }
  }
  return result;
}

/**
 * @param {string} homeDirectory
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function resolveOpencodeConfigDir(homeDirectory, env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDirectory, ".config"), "opencode");
}

/**
 * @param {string} homeDirectory
 * @param {NodeJS.ProcessEnv} env
 * @returns {{checked: boolean, path?: string, isolated?: boolean, reason?: string}}
 */
export function checkOpencodePlaywrightIsolation(homeDirectory, env) {
  const configDir = resolveOpencodeConfigDir(homeDirectory, env);
  const jsoncPath = path.join(configDir, "opencode.jsonc");
  const jsonPath = path.join(configDir, "opencode.json");
  for (const configPath of [jsoncPath, jsonPath]) {
    if (!fs.existsSync(configPath)) continue;
    let parsed;
    try {
      parsed = JSON.parse(stripJsonComments(fs.readFileSync(configPath, "utf8")));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { checked: false, path: configPath, reason: `failed to parse: ${message}` };
    }
    if (Array.isArray(parsed?.mcp?.playwright?.command)) {
      return { checked: true, path: configPath, isolated: parsed.mcp.playwright.command.includes(ISOLATED_FLAG) };
    }
  }
  return { checked: false, reason: "no opencode config with a playwright MCP entry found" };
}

/**
 * @param {string} homeDirectory
 * @param {NodeJS.ProcessEnv} env
 * @returns {{changed: boolean, path?: string, reason?: string}}
 */
export function ensureOpencodePlaywrightIsolation(homeDirectory, env) {
  const configDir = resolveOpencodeConfigDir(homeDirectory, env);
  const jsonPath = path.join(configDir, "opencode.json");
  if (!fs.existsSync(jsonPath)) {
    return { changed: false, reason: "no writable opencode.json with a playwright MCP entry found" };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { changed: false, reason: `failed to parse opencode.json: ${message}` };
  }
  if (!Array.isArray(parsed?.mcp?.playwright?.command)) {
    return { changed: false, reason: "no writable opencode.json with a playwright MCP entry found" };
  }
  if (parsed.mcp.playwright.command.includes(ISOLATED_FLAG)) {
    return { changed: false, path: jsonPath };
  }
  parsed.mcp.playwright.command.push(ISOLATED_FLAG);
  fs.writeFileSync(jsonPath, JSON.stringify(parsed, null, 2));
  return { changed: true, path: jsonPath };
}

/**
 * @param {string} homeDirectory
 * @returns {{checked: boolean, path?: string, isolated?: boolean, reason?: string}}
 */
export function checkClaudeCodePlaywrightIsolation(homeDirectory) {
  const claudePath = path.join(homeDirectory, ".claude.json");
  if (!fs.existsSync(claudePath)) {
    return { checked: false, reason: "~/.claude.json not found" };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(claudePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { checked: false, reason: `failed to parse ~/.claude.json: ${message}` };
  }
  if (!Array.isArray(parsed?.mcpServers?.playwright?.args)) {
    return { checked: false, reason: "no playwright MCP entry found in ~/.claude.json" };
  }
  const args = parsed.mcpServers.playwright.args;
  const configIdx = args.findIndex((/** @type {unknown} */ arg) => arg === "--config");
  if (configIdx === -1 || configIdx + 1 >= args.length) {
    return { checked: true, isolated: false, reason: "playwright MCP entry has no --config file; cannot verify isolation" };
  }
  const configPath = args[configIdx + 1];
  if (!fs.existsSync(configPath)) {
    return { checked: true, isolated: false, path: configPath, reason: "referenced config file does not exist" };
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { checked: true, isolated: false, path: configPath, reason: `failed to parse referenced config: ${message}` };
  }
  return { checked: true, path: configPath, isolated: config?.browser?.isolated === true };
}

/**
 * @param {string} homeDirectory
 * @returns {{changed: boolean, path?: string, reason?: string}}
 */
export function ensureClaudeCodePlaywrightIsolation(homeDirectory) {
  const check = checkClaudeCodePlaywrightIsolation(homeDirectory);
  if (!check.checked || !check.path) {
    return { changed: false, reason: check.reason };
  }
  if (check.isolated) {
    return { changed: false, path: check.path };
  }
  try {
    const config = JSON.parse(fs.readFileSync(check.path, "utf8"));
    config.browser = { ...(config.browser || {}), isolated: true };
    fs.writeFileSync(check.path, JSON.stringify(config, null, 2));
    return { changed: true, path: check.path };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { changed: false, reason: `failed to update referenced config: ${message}` };
  }
}
