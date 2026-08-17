import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureClaudeCodePlaywrightIsolation, ensureOpencodePlaywrightIsolation } from "./mcp-isolation.js";
import { defaultRunCommand } from "./sandbox.js";
import { errCode } from "./errors.js";

const PLUGIN_ID = "taskferry@taskferry";

const SRC = "src";
const MANAGED_TARGETS = new Set([
  path.join(SRC, "cli.js"),
  path.join(SRC, "opencode-plugin.js"),
  path.join(SRC, "kilo-plugin.js"),
  path.join(SRC, "tf-sl.sh"),
]);

/**
 * @typedef {{status: number|null, stdout: string, stderr: string, error?: import("node:child_process").ExecException | NodeJS.ErrnoException}} CommandResult
 */

/**
 * @typedef {(command: string, args: readonly string[]) => CommandResult} RunCommandFn
 */

/**
 * @typedef {object} RunSetupOptions
 * @property {string} checkoutDirectory
 * @property {string} cliPath
 * @property {string} [homeDirectory]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {NodeJS.Platform} [platform]
 * @property {(checkoutDirectory: string) => unknown} [runNpmInstall]
 * @property {RunCommandFn} [runCommand]
 */

/**
 * @param {string} resolvedSource
 * @returns {boolean}
 */
function isTaskferryCheckout(resolvedSource) {
  const checkout = path.dirname(path.dirname(resolvedSource));
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(checkout, "package.json"), "utf8"));
    return manifest && manifest.name === "taskferry";
  } catch {
    return false;
  }
}

// A symlink is safe to silently re-point only if it already points into the
// exact checkout `setup` is being run from right now - never merely "some
// checkout whose package.json happens to be named taskferry". Without the
// checkout-identity check, running setup from any throwaway/scratch clone
// silently re-points an unrelated, currently-in-use global taskferry symlink.
/**
 * @param {string} resolvedExisting
 * @param {string} resolvedNewSource
 * @returns {boolean}
 */
function isManagedSymlinkTarget(resolvedExisting, resolvedNewSource) {
  const existingCheckout = path.dirname(path.dirname(resolvedExisting));
  const newCheckout = path.dirname(path.dirname(resolvedNewSource));
  if (existingCheckout !== newCheckout) {
    return false;
  }
  if (!MANAGED_TARGETS.has(path.join(SRC, path.basename(resolvedExisting)))) {
    // eslint-disable-next-line sonarjs/no-duplicate-string -- three "plugins" paths flagged only after kilo added third
    const isTaskferryJs = path.basename(resolvedExisting) === "taskferry.js"
      && (
        path.dirname(resolvedExisting).endsWith(path.join("opencode", "plugins"))
        || path.dirname(resolvedExisting).endsWith(path.join("kilo", "plugins"))
        || path.dirname(resolvedExisting).endsWith(path.join(".config", "kilo", "plugins"))
      );
    return isTaskferryJs && isTaskferryCheckout(resolvedExisting);
  }
  return isTaskferryCheckout(resolvedExisting);
}

/**
 * @param {string} destination
 * @param {string} source
 * @returns {void}
 */
export function replaceManagedSymlink(destination, source) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let existing = null;
  try {
    existing = fs.lstatSync(destination);
  } catch (error) {
    if (errCode(error) !== "ENOENT") throw error;
  }
  if (existing) {
    if (!existing.isSymbolicLink()) {
      throw new Error(`refusing to replace unmanaged path: ${destination}`);
    }
    let resolved;
    try {
      resolved = fs.realpathSync(destination);
    } catch {
      throw new Error(`refusing to replace unmanaged path: ${destination}`);
    }
    if (!isManagedSymlinkTarget(resolved, fs.realpathSync(source))) {
      throw new Error(`refusing to replace unmanaged path: ${destination}`);
    }
    fs.unlinkSync(destination);
  }
  fs.symlinkSync(source, destination, "file");
}

/**
 * @param {string} checkoutDirectory
 * @returns {ReturnType<typeof import("node:child_process").spawnSync>}
 */
export function defaultNpmInstall(checkoutDirectory) {
  const result = spawnSync("npm", ["install"], { cwd: checkoutDirectory, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const detail = result.error ? result.error.message : `exit ${result.status}`;
    const suffix = stderr ? `\n${stderr}` : "";
    throw new Error(`npm install failed: ${detail}${suffix}`);
  }
  return result;
}

// execFile's callback sets `error` both when the process fails to launch
// (ENOENT, EACCES -- error.code is the string errno) and when it launches
// but exits non-zero (error.code is the numeric exit code). spawnSync only
// sets `error` for the former case, leaving `status` to carry a non-zero
// exit. Splitting on the type of error.code here keeps this function's
// result shape consistent with defaultRunCommand's, so callers that treat
// `status !== 0` and `error` as distinct failure modes (e.g.
// getBwrapAvailabilityResult) behave the same regardless of which runner
// they were given.
/**
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {Promise<CommandResult>}
 */
export function defaultRunCommandAsync(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        if (typeof error.code === "number") {
          resolve({ status: error.code, stdout: stdout || "", stderr: stderr || "" });
          return;
        }
        resolve({ status: null, stdout: stdout || "", stderr: stderr || "", error });
        return;
      }
      resolve({ status: 0, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

/**
 * @param {CommandResult} result
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {CommandResult}
 */
function ensureSuccess(result, command, args) {
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const suffix = stderr ? `\n${stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}${suffix}`);
  }
  return result;
}

/**
 * @param {CommandResult} result
 * @returns {boolean}
 */
function detectExecutable(result) {
  return !result.error || result.error.code !== "ENOENT";
}

/**
 * @param {string} checkoutDirectory
 * @param {string} listOutput
 * @returns {boolean}
 */
function marketplaceHas(checkoutDirectory, listOutput) {
  return listOutput.includes(checkoutDirectory) || listOutput.includes("taskferry");
}

/**
 * @param {string} installedJson
 * @returns {boolean}
 */
export function pluginInstalled(installedJson) {
  let parsed;
  try {
    parsed = JSON.parse(installedJson);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  return parsed.some((entry) => entry && entry.id === PLUGIN_ID);
}

/**
 * @param {RunCommandFn} runCommand
 * @returns {string|null}
 */
function resolveGitHash(runCommand) {
  const hashResult = runCommand("git", ["rev-parse", "HEAD"]);
  if (!hashResult.error && hashResult.status === 0) {
    return (hashResult.stdout || "").trim();
  }
  return null;
}

/**
 * @param {string} hashFile
 * @returns {string|null}
 */
function readStoredHash(hashFile) {
  try {
    return fs.readFileSync(hashFile, "utf8").trim();
  } catch (error) {
    if (errCode(error) !== "ENOENT") throw error;
    return null;
  }
}

/**
 * @param {RunCommandFn} runCommand
 * @returns {void}
 */
function installPlugin(runCommand) {
  ensureSuccess(
    runCommand("claude", ["plugin", "install", PLUGIN_ID, "--scope", "user"]),
    "claude",
    ["plugin", "install", PLUGIN_ID, "--scope", "user"],
  );
}

/**
 * @param {RunCommandFn} runCommand
 * @returns {void}
 */
function forceResyncPlugin(runCommand) {
  ensureSuccess(
    runCommand("claude", ["plugin", "uninstall", PLUGIN_ID, "--keep-data", "-y"]),
    "claude",
    ["plugin", "uninstall", PLUGIN_ID, "--keep-data", "-y"],
  );
  installPlugin(runCommand);
}

/**
 * @param {string} hashFile
 * @param {string} hash
 * @returns {void}
 */
function writeHashFile(hashFile, hash) {
  fs.mkdirSync(path.dirname(hashFile), { recursive: true });
  fs.writeFileSync(hashFile, hash);
}

/**
 * @param {string} checkoutDirectory
 * @param {RunCommandFn} runCommand
 * @param {string} homeDirectory
 * @param {NodeJS.ProcessEnv} env
 * @returns {{status: "installed"}|{status: "unavailable"}}
 */
export function installClaude(checkoutDirectory, runCommand, homeDirectory, env) {
  const probe = runCommand("claude", ["plugin", "marketplace", "list"]);
  if (!detectExecutable(probe)) return { status: "unavailable" };

  ensureSuccess(probe, "claude", ["plugin", "marketplace", "list"]);
  if (!marketplaceHas(checkoutDirectory, probe.stdout || "")) {
    ensureSuccess(
      runCommand("claude", ["plugin", "marketplace", "add", checkoutDirectory]),
      "claude",
      ["plugin", "marketplace", "add", checkoutDirectory],
    );
  }

  const listed = ensureSuccess(
    runCommand("claude", ["plugin", "list", "--json"]),
    "claude",
    ["plugin", "list", "--json"],
  );
  const installed = pluginInstalled(listed.stdout || "");

  const currentHash = resolveGitHash(runCommand);
  const stateDir = env.XDG_STATE_HOME || path.join(homeDirectory, ".local", "state");
  const hashFile = path.join(stateDir, "taskferry", "claude-plugin-hash");

  if (!installed) {
    installPlugin(runCommand);
    if (currentHash) {
      writeHashFile(hashFile, currentHash);
    }
    return { status: "installed" };
  }

  if (!currentHash) {
    // No current hash available (git not available / not a checkout)
    // Fall back to version-gated update as best-effort
    ensureSuccess(
      runCommand("claude", ["plugin", "update", PLUGIN_ID]),
      "claude",
      ["plugin", "update", PLUGIN_ID],
    );
    return { status: "installed" };
  }

  const storedHash = readStoredHash(hashFile);
  if (storedHash !== currentHash) {
    // Hash differs or never stored — force resync via uninstall + install
    // since claude plugin update's version-gating can't be trusted
    forceResyncPlugin(runCommand);
    writeHashFile(hashFile, currentHash);
  }

  return { status: "installed" };
}

/**
 * @param {string} checkoutDirectory
 * @param {RunCommandFn} runCommand
 * @returns {{status: "desktop-install-required", next: string}|{status: "unavailable"}}
 */
export function registerCodex(checkoutDirectory, runCommand) {
  const probe = runCommand("codex", ["plugin", "marketplace", "list"]);
  if (!detectExecutable(probe)) return { status: "unavailable" };

  ensureSuccess(probe, "codex", ["plugin", "marketplace", "list"]);
  if (!marketplaceHas(checkoutDirectory, probe.stdout || "")) {
    ensureSuccess(
      runCommand("codex", ["plugin", "marketplace", "add", checkoutDirectory]),
      "codex",
      ["plugin", "marketplace", "add", checkoutDirectory],
    );
  } else {
    ensureSuccess(
      runCommand("codex", ["plugin", "marketplace", "upgrade", "taskferry"]),
      "codex",
      ["plugin", "marketplace", "upgrade", "taskferry"],
    );
  }

  return {
    status: "desktop-install-required",
    next: "Open Codex desktop, install Taskferry from its marketplace, then review and trust its hooks.",
  };
}

/**
 * @param {string} _checkoutDirectory
 * @param {RunCommandFn} runCommand
 * @param {string} _homeDirectory
 * @param {NodeJS.ProcessEnv} _env
 * @returns {{status: "installed"}|{status: "unavailable"}}
 */
export function installKilo(_checkoutDirectory, runCommand, _homeDirectory, _env) {
  const probe = runCommand("kilo", ["plugin", "--help"]);
  if (!detectExecutable(probe)) return { status: "unavailable" };

  // Kilo's plugin system is npm-based; the file symlink is the primary
  // integration surface (like OpenCode). Marketplace registration via
  // `kilo plugin` is handled by the symlink itself, not a marketplace add.
  // This probe just confirms `kilo` is present so setup can report status.
  return { status: "installed" };
}

/**
 * @param {RunSetupOptions} options
 * @returns {{
 *   cli: {path: string, source: string},
 *   opencode: {path: string, source: string},
 *   kilo: {path: string, source: string},
 *   statusline: {path: string, source: string},
 *   dependencies: string,
 *   path: "available"|"missing",
 *   pathInstruction?: string,
 *   integrations: {
 *     claude: ReturnType<typeof installClaude>,
 *     codex: ReturnType<typeof registerCodex>,
 *     kilo: ReturnType<typeof installKilo>,
 *   },
 *   playwrightMcpIsolation: {
 *     opencode: ReturnType<typeof ensureOpencodePlaywrightIsolation>,
 *     claudeCode: ReturnType<typeof ensureClaudeCodePlaywrightIsolation>,
 *   },
 * }}
 */
export function runSetup({
  checkoutDirectory,
  cliPath,
  homeDirectory = os.homedir(),
  env = process.env,
  platform = process.platform,
  runNpmInstall = defaultNpmInstall,
  runCommand = defaultRunCommand,
}) {
  if (platform === "win32") {
    throw new Error("taskferry setup requires Unix domain sockets and is unavailable on Windows");
  }

  runNpmInstall(checkoutDirectory);
  const binPath = path.join(homeDirectory, ".local", "bin", "taskferry");
  const opencodePath = path.join(
    env.XDG_CONFIG_HOME || path.join(homeDirectory, ".config"),
    "opencode",
    "plugins",
    "taskferry.js",
  );
  const opencodeSource = path.join(checkoutDirectory, "src", "opencode-plugin.js");
  const kiloPath = path.join(
    env.XDG_CONFIG_HOME || path.join(homeDirectory, ".config"),
    "kilo",
    "plugins",
    "taskferry.js",
  );
  const kiloSource = path.join(checkoutDirectory, "src", "kilo-plugin.js");
  const tfSlPath = path.join(homeDirectory, ".local", "bin", "tf-sl");
  const tfSlSource = path.join(checkoutDirectory, "src", "tf-sl.sh");
  replaceManagedSymlink(binPath, cliPath);
  replaceManagedSymlink(opencodePath, opencodeSource);
  replaceManagedSymlink(kiloPath, kiloSource);
  replaceManagedSymlink(tfSlPath, tfSlSource);

  const binDirectory = path.dirname(binPath);
  const onPath = (env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === binDirectory);

  const opencodeMCP = ensureOpencodePlaywrightIsolation(homeDirectory, env);
  const claudeCodeMCP = ensureClaudeCodePlaywrightIsolation(homeDirectory);

  return {
    cli: { path: binPath, source: cliPath },
    opencode: { path: opencodePath, source: opencodeSource },
    kilo: { path: kiloPath, source: kiloSource },
    statusline: { path: tfSlPath, source: tfSlSource },
    dependencies: "installed",
    path: onPath ? "available" : "missing",
    ...(onPath ? {} : { pathInstruction: 'export PATH="$HOME/.local/bin:$PATH"' }),
    integrations: {
      claude: installClaude(checkoutDirectory, runCommand, homeDirectory, env),
      codex: registerCodex(checkoutDirectory, runCommand),
      kilo: installKilo(checkoutDirectory, runCommand, homeDirectory, env),
    },
    playwrightMcpIsolation: { opencode: opencodeMCP, claudeCode: claudeCodeMCP },
  };
}
