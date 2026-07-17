import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MANAGED_TARGETS = new Set([
  path.join("src", "cli.js"),
  path.join("src", "opencode-plugin.js"),
]);

function isTaskferryCheckout(resolvedSource) {
  const checkout = path.dirname(path.dirname(resolvedSource));
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(checkout, "package.json"), "utf8"));
    return manifest && manifest.name === "taskferry";
  } catch {
    return false;
  }
}

function isManagedSymlinkTarget(resolvedSource) {
  if (!MANAGED_TARGETS.has(path.join("src", path.basename(resolvedSource)))) {
    return path.basename(resolvedSource) === "taskferry.js"
      && path.dirname(resolvedSource).endsWith(path.join("opencode", "plugins"))
      && isTaskferryCheckout(resolvedSource);
  }
  return isTaskferryCheckout(resolvedSource);
}

export function replaceManagedSymlink(destination, source) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let existing = null;
  try {
    existing = fs.lstatSync(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
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
    if (!isManagedSymlinkTarget(resolved)) {
      throw new Error(`refusing to replace unmanaged path: ${destination}`);
    }
    fs.unlinkSync(destination);
  }
  fs.symlinkSync(source, destination, "file");
}

export function defaultNpmInstall(checkoutDirectory) {
  const result = spawnSync("npm", ["install"], { cwd: checkoutDirectory, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const detail = result.error ? result.error.message : `exit ${result.status}`;
    throw new Error(`npm install failed: ${detail}${stderr ? `\n${stderr}` : ""}`);
  }
  return result;
}

export function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    return { status: null, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
  }
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
  };
}

function ensureSuccess(result, command, args) {
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}${stderr ? `\n${stderr}` : ""}`);
  }
  return result;
}

function detectExecutable(result) {
  return !result.error || result.error.code !== "ENOENT";
}

function marketplaceHas(checkoutDirectory, listOutput) {
  return listOutput.includes(checkoutDirectory) || listOutput.includes("taskferry");
}

export function pluginInstalled(installedJson) {
  let parsed;
  try {
    parsed = JSON.parse(installedJson);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  return parsed.some((entry) => entry && entry.id === "taskferry@taskferry");
}

export function installClaude(checkoutDirectory, runCommand) {
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
  if (!installed) {
    ensureSuccess(
      runCommand("claude", ["plugin", "install", "taskferry@taskferry", "--scope", "user"]),
      "claude",
      ["plugin", "install", "taskferry@taskferry", "--scope", "user"],
    );
  } else {
    ensureSuccess(
      runCommand("claude", ["plugin", "update", "taskferry@taskferry"]),
      "claude",
      ["plugin", "update", "taskferry@taskferry"],
    );
  }
  return { status: "installed" };
}

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
  replaceManagedSymlink(binPath, cliPath);
  replaceManagedSymlink(opencodePath, opencodeSource);

  const binDirectory = path.dirname(binPath);
  const onPath = (env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === binDirectory);
  return {
    cli: { path: binPath, source: cliPath },
    opencode: { path: opencodePath, source: opencodeSource },
    dependencies: "installed",
    path: onPath ? "available" : "missing",
    ...(onPath ? {} : { pathInstruction: 'export PATH="$HOME/.local/bin:$PATH"' }),
    integrations: {
      claude: installClaude(checkoutDirectory, runCommand),
      codex: registerCodex(checkoutDirectory, runCommand),
    },
  };
}
