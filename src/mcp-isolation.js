import fs from "node:fs";
import path from "node:path";

export function stripJsonComments(text) {
  return text.replace(/("(?:\\.|[^"\\])*")|(\/\/.*$|\/\*[\s\S]*?\*\/)/gm, (_match, str) => str || "");
}

function resolveOpencodeConfigDir(homeDirectory, env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDirectory, ".config"), "opencode");
}

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
      return { checked: true, path: configPath, isolated: parsed.mcp.playwright.command.includes("--isolated") };
    }
  }
  return { checked: false, reason: "no opencode config with a playwright MCP entry found" };
}

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
  if (parsed.mcp.playwright.command.includes("--isolated")) {
    return { changed: false, path: jsonPath };
  }
  parsed.mcp.playwright.command.push("--isolated");
  fs.writeFileSync(jsonPath, JSON.stringify(parsed, null, 2));
  return { changed: true, path: jsonPath };
}

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
  const configIdx = args.findIndex((arg) => arg === "--config");
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
