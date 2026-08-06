import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { resolveProjectConfigPath } from "./project-config.js";

function packageCheckCommand(packageJsonPath, readFileFn) {
  let pkg;
  try {
    pkg = JSON.parse(readFileFn(packageJsonPath));
  } catch {
    return null;
  }
  const scripts = pkg?.scripts ?? {};
  if (typeof scripts.check === "string") return "npm run check";
  const composed = ["lint", "typecheck", "test"].filter((name) => typeof scripts[name] === "string");
  return composed.length ? composed.map((name) => `npm run ${name}`).join(" && ") : null;
}

const ECOSYSTEM_CHECKS = [
  [["pyproject.toml"], "uv run pytest && uv run ruff check ."],
  [["go.mod"], "go vet ./... && go test ./..."],
  [["Cargo.toml"], "cargo clippy -- -D warnings && cargo test"],
  [["deno.json", "deno.jsonc"], "deno check . && deno test"],
  [["bunfig.toml"], "bun test"],
];

/**
 * Sniffs a repo's ecosystem to propose a `.taskferry.toml` `check` command.
 * package.json wins outright if it already declares its own composite
 * "check" script; otherwise the best available combination of lint/
 * typecheck/test scripts. Falls through to one fixed command per other
 * ecosystem marker file. Never parses beyond `package.json`'s top-level
 * `scripts` object -- this is the one place in taskferry that reads a
 * manifest at all, and it stays deliberately shallow (no dependency
 * inspection, no nested config).
 * @param {string} directory
 * @param {{existsFn?: (p: string) => boolean, readFileFn?: (p: string) => string}} [deps]
 * @returns {string|null}
 */
export function detectCheckCommand(directory, { existsFn = fs.existsSync, readFileFn = (p) => fs.readFileSync(p, "utf8") } = {}) {
  const packageJsonPath = path.join(directory, "package.json");
  if (existsFn(packageJsonPath)) {
    const packageCommand = packageCheckCommand(packageJsonPath, readFileFn);
    if (packageCommand) return packageCommand;
  }
  const match = ECOSYSTEM_CHECKS.find(([markers]) => markers.some((marker) => existsFn(path.join(directory, marker))));
  return match?.[1] ?? null;
}

const TEMPLATE_HEADER = `# taskferry project config -- see docs/config.md#taskferrytoml\n`;

/** @param {string|null} checkCommand @returns {string} */
function renderConfig(checkCommand) {
  const checkLine = checkCommand
    ? `check = ${JSON.stringify(checkCommand)}\n`
    : `# check = "npm run check"  -- fill this in; until it's set, there is no gate\n`;
  return `${TEMPLATE_HEADER}# Command the verification gate runs at settle, and that workers are told to\n# run before declaring done. Absent = no gate; taskferry says so loudly.\n${checkLine}\n# Optional. Gate run is killed after this many seconds and recorded as a\n# timeout. Default 900.\n# check_timeout_seconds = 900\n\n# Optional. Host paths bound read-only into the sandbox for every dispatch\n# from this project. Ignored when sandboxing is off.\n# read_only_paths = ["/path/to/reference-docs"]\n`;
}

/**
 * Scaffolds `.taskferry.toml` in `directory`. Never overwrites an existing
 * file. When a check command is detected and stdin is an interactive TTY,
 * asks for confirmation before writing it in directly; otherwise (no
 * detection, or no TTY to confirm with) writes the commented fill-in
 * template so the file never silently encodes a guess nobody approved.
 * @param {string} directory
 * @param {{existsFn?: (p: string) => boolean, writeFileFn?: (p: string, content: string) => void, io?: {stdin: {isTTY?: boolean}, stdout: {write: (s: string) => unknown}}, detect?: typeof detectCheckCommand}} [deps]
 * @returns {Promise<{path: string, written: boolean, checkCommand: string|null, reason?: string}>}
 */
export async function runInit(directory, {
  existsFn = fs.existsSync,
  writeFileFn = (p, content) => fs.writeFileSync(p, content, { mode: 0o644 }),
  io = process,
  detect = detectCheckCommand,
} = {}) {
  const configPath = resolveProjectConfigPath(directory);
  if (existsFn(configPath)) {
    return { path: configPath, written: false, checkCommand: null, reason: `${configPath} already exists -- taskferry init never overwrites it` };
  }
  const detected = detect(directory);
  if (detected && io.stdin?.isTTY) {
    const rl = readline.createInterface({ input: /** @type {NodeJS.ReadableStream} */ (io.stdin), output: /** @type {NodeJS.WritableStream} */ (io.stdout) });
    let answer;
    try {
      answer = await rl.question(`Detected check command: ${detected}\nWrite .taskferry.toml with this command? [Y/n] `);
    } finally {
      rl.close();
    }
    if (/^n/i.test(answer.trim())) {
      writeFileFn(configPath, renderConfig(null));
      return { path: configPath, written: true, checkCommand: null };
    }
    writeFileFn(configPath, renderConfig(detected));
    return { path: configPath, written: true, checkCommand: detected };
  }
  if (detected) {
    io.stdout.write(`Detected check command: ${detected}\nNo TTY to confirm -- writing .taskferry.toml with a commented fill-in instead. Edit "check" in ${configPath} to enable the gate.\n`);
    writeFileFn(configPath, renderConfig(detected).replace(/^check =/m, "# check ="));
    return { path: configPath, written: true, checkCommand: null };
  }
  writeFileFn(configPath, renderConfig(null));
  return { path: configPath, written: true, checkCommand: null };
}
