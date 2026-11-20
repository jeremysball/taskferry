import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";

export const UNIT_NAME = "taskferry-daemon.service";
export const PATH_UNIT_NAME = "taskferry-daemon.path";
export const PATH_TEMPLATE = path.join("deploy", "systemd", "taskferry-daemon.path.in");
export const ROTATE_SERVICE_NAME = "taskferry-daemon-logrotate.service";
export const ROTATE_TIMER_NAME = "taskferry-daemon-logrotate.timer";
export const DAEMON_LOG_BASENAME = "daemon.log";
export const DAEMON_LOG_FILE = "%h/.local/state/taskferry/logs/daemon.log";
export const DAEMON_ENTRY_RELATIVE = path.join("src", "daemon.js");
export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_KEEP = 5;

// Evidence that the checkout the unit will point at actually implements
// supervised mode. Static text, not a module import: importing the target
// daemon would execute another checkout's code from the installer, and the
// failure this guard exists for (a unit pointing at a pre-merge main
// checkout) is exactly a "the code is not there yet" case.
const SUPERVISOR_SUPPORT = [
  {
    file: path.join("src", "client.js"),
    markers: ["TASKFERRY_DAEMON_SUPERVISOR", "startDaemonViaSystemd"],
  },
  {
    file: path.join("src", "daemon.js"),
    markers: ["SUPERVISED_RESTART_EXIT_CODE", "TASKFERRY_DAEMON_SUPERVISOR"],
  },
  {
    file: path.join("deploy", "systemd", "taskferry-daemon.service.in"),
    markers: ["ExecStart"],
  },
];

/**
 * @param {string} file
 * @returns {string}
 */
function readUtf8(file) {
  return fs.readFileSync(file, "utf8");
}

/**
 * @param {object} options
 * @param {string} options.repo
 * @param {boolean} [options.gated]
 * @param {(file: string) => string} [options.readFileFn]
 * @returns {Array<{file: string, marker: string | null}>}
 */
export function findMissingSupervisorSupport({ repo, gated = false, readFileFn = readUtf8 }) {
  const missing = [];
  const checks = gated ? [...SUPERVISOR_SUPPORT, { file: PATH_TEMPLATE, markers: ["@ENV_FILE@"] }, {
    file: path.join("deploy", "systemd", "taskferry-daemon.service.in"),
    markers: ["@INSTALL_SECTION@", "@GATE_ENVIRONMENT@"],
  }] : SUPERVISOR_SUPPORT;
  for (const { file, markers } of checks) {
    let text;
    try {
      text = readFileFn(path.join(repo, file));
    } catch {
      missing.push({ file, marker: null });
      continue;
    }
    for (const marker of markers) {
      if (!text.includes(marker)) missing.push({ file, marker });
    }
  }
  return missing;
}

/**
 * Refuse to render a unit for a checkout that predates supervised mode.
 *
 * This is what stops the installer from repeating the earlier mistake: an
 * installed unit whose `ExecStart` pointed at the primary checkout while only
 * a feature worktree had the supervisor code. On that host the unit started
 * an old daemon that ignored `TASKFERRY_DAEMON_SUPERVISOR`, so nothing
 * restarted it and the client believed systemd owned the socket.
 *
 * @param {object} options
 * @param {string} options.repo
 * @param {(file: string) => string} [options.readFileFn]
 * @param {boolean} [options.gated]
 * @returns {void}
 */
export function assertRepoSupportsSupervisor({ repo, gated = false, readFileFn = readUtf8 }) {
  const missing = findMissingSupervisorSupport({ repo, gated, readFileFn });
  if (missing.length === 0) return;
  const detail = missing
    .map(({ file, marker }) => (marker ? `${file} lacks ${marker}` : `${file} is missing`))
    .join("; ");
  throw new Error(
    `error: refusing to install a unit pointing at ${repo}: that checkout does not contain the systemd supervisor support (${detail})\n`
    + "help: run this installer from a checkout that has the supervised-daemon branch merged (a feature worktree or an up-to-date main);"
    + " any previously installed unit was left untouched"
  );
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function containsControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Reject values that would silently change the meaning of a unit directive.
 * A path with a newline can inject a second directive; a path with spaces
 * splits `ExecStart` into the wrong arguments.
 *
 * @param {string} label
 * @param {string} value
 * @param {{allowWhitespace?: boolean}} [options]
 * @returns {void}
 */
export function assertUnitValue(label, value, { allowWhitespace = false } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`error: ${label} is empty; refusing to render an incomplete unit`);
  }
  if (containsControlCharacter(value)) {
    throw new Error(`error: ${label} contains a control character; refusing to render the unit`);
  }
  if (!allowWhitespace && /\s/.test(value)) {
    throw new Error(`error: ${label} contains whitespace (${JSON.stringify(value)}); systemd cannot represent it in ExecStart`);
  }
}

/**
 * `%` starts a specifier in unit files. Substituted values must escape it so a
 * PATH or repo containing `%` is treated literally.
 * @param {string} value
 * @returns {string}
 */
export function escapeUnitSpecifiers(value) {
  return value.replaceAll("%", "%%");
}

/** @param {{homeDir?: string, env?: NodeJS.ProcessEnv}} [options] */
export function resolveDaemonConfigPath({ homeDir = os.homedir(), env = {} } = {}) {
  const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  if (!path.isAbsolute(configHome)) {
    throw new Error("error: user manager XDG_CONFIG_HOME must be an absolute path\nhelp: set an absolute XDG_CONFIG_HOME in the user manager");
  }
  return path.join(configHome, "taskferry", "config.json");
}

/** @param {{homeDir?: string, env?: NodeJS.ProcessEnv}} [options] @returns {string | null} */
export function resolveEnvFileGate({ homeDir = os.homedir(), env = {} } = {}) {
  const configPath = resolveDaemonConfigPath({ homeDir, env });
  let config;
  try {
    config = loadConfig({ configPath });
  } catch (error) {
    if (error instanceof Error && error.message.includes("help:")) throw error;
    throw new Error(`error: could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}\nhelp: fix or remove the file; the installer only needs it to find "envFile"`, { cause: error });
  }
  const envFile = env.TASKFERRY_ENV_FILE !== undefined ? env.TASKFERRY_ENV_FILE : config.envFile;
  if (envFile === undefined || envFile === "") return null;
  if (typeof envFile !== "string" || !path.isAbsolute(envFile)) {
    throw new Error(`error: envFile for ${configPath} must be an absolute path for systemd\nhelp: use an absolute envFile path`);
  }
  return envFile;
}

/** @param {{repo: string, envFile: string, template: string}} options */
export function renderPathUnit({ repo, envFile, template }) {
  assertUnitValue("repo root", repo);
  assertUnitValue("envFile", envFile);
  if (!path.isAbsolute(envFile)) throw new Error("error: envFile must be an absolute path");
  return substituteTemplate(template, {
    "@REPO@": escapeUnitSpecifiers(repo),
    "@ENV_FILE@": escapeUnitSpecifiers(envFile),
  });
}

/**
 * The storage mode journald will actually use. `auto` means persistent only
 * when /var/log/journal already exists.
 * @param {string | undefined} storageValue
 * @returns {"persistent" | "volatile" | "auto"}
 */
export function resolveJournalStorage(storageValue) {
  if (storageValue === "persistent" || storageValue === "volatile") return storageValue;
  return "auto";
}

/**
 * @param {string} configText
 * @returns {string | undefined}
 */
export function parseJournaldStorage(configText) {
  let resolved;
  for (const line of String(configText).split("\n")) {
    const match = /^\s*Storage\s*=\s*(\S+)\s*$/u.exec(line);
    // cat-config prints the main file first and every drop-in after it, so
    // the last assignment is the one journald will use.
    if (match) resolved = match[1];
  }
  return resolved;
}

/**
 * @param {object} options
 * @param {string | null | undefined} options.storageValue
 * @param {boolean} options.journalDirExists
 * @returns {boolean}
 */
export function isJournalPersistent({ storageValue, journalDirExists }) {
  const storage = resolveJournalStorage(storageValue);
  if (storage === "persistent") return true;
  if (storage === "volatile") return false;
  return journalDirExists;
}

/**
 * @param {object} options
 * @param {"auto" | "journal" | "file"} options.requested
 * @param {boolean} options.journalPersistent
 * @returns {"journal" | "file"}
 */
export function resolveLogTarget({ requested = "auto", journalPersistent }) {
  if (requested === "journal" || requested === "file") return requested;
  if (requested !== "auto") {
    throw new Error(`error: unknown log target ${JSON.stringify(requested)}; use auto, journal, or file`);
  }
  return journalPersistent ? "journal" : "file";
}

/**
 * @param {"journal" | "file"} logTarget
 * @param {string} logFile
 * @returns {{prep: string, stdout: string, stderr: string}}
 */
function renderLogging({ logTarget, logFile }) {
  if (logTarget === "file") {
    return {
      prep: `ExecStartPre=/usr/bin/mkdir -p ${path.posix.dirname(logFile)}`,
      stdout: `StandardOutput=append:${logFile}`,
      stderr: "StandardError=inherit",
    };
  }
  return { prep: "", stdout: "StandardOutput=journal", stderr: "StandardError=journal" };
}

/**
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function substituteTemplate(template, values) {
  let rendered = template;
  for (const [token, value] of Object.entries(values)) rendered = rendered.split(token).join(value);
  const leftover = /@[A-Z][A-Z0-9_]*@/u.exec(rendered);
  if (leftover) {
    throw new Error(`error: unit template left ${leftover[0]} unrendered; the template and installer are out of sync`);
  }
  return rendered;
}

/**
 * @param {object} options
 * @param {string} options.repo
 * @param {string} options.nodePath
 * @param {string} options.pathEnv
 * @param {string} options.template
 * @param {"journal" | "file"} [options.logTarget]
 * @param {string} [options.logFile]
 * @param {boolean} [options.gated]
 * @param {string} [options.gateConfigHome]
 * @param {string} [options.gateEnvFile]
 * @returns {string}
 */
export function renderSystemdUnit({ repo, nodePath, pathEnv, template, logTarget = "journal", logFile = DAEMON_LOG_FILE, gated = false, gateConfigHome = "", gateEnvFile = "" }) {
  assertUnitValue("repo root", repo);
  assertUnitValue("node path", nodePath);
  assertUnitValue("PATH", pathEnv);
  if (gated) {
    assertUnitValue("manager config home", gateConfigHome);
    assertUnitValue("envFile", gateEnvFile);
    if (!path.isAbsolute(gateConfigHome) || !path.isAbsolute(gateEnvFile)) throw new Error("error: gate paths must be absolute");
  }
  const logging = renderLogging({ logTarget, logFile });
  return substituteTemplate(template, {
    "@NODE@": escapeUnitSpecifiers(nodePath),
    "@REPO@": escapeUnitSpecifiers(repo),
    "@PATH@": escapeUnitSpecifiers(pathEnv),
    "@LOG_PREP@": logging.prep,
    "@LOG_STDOUT@": logging.stdout,
    "@LOG_STDERR@": logging.stderr,
    "@GATE_ENVIRONMENT@": gated
      ? `Environment=XDG_CONFIG_HOME=${escapeUnitSpecifiers(gateConfigHome)}\nEnvironment=TASKFERRY_ENV_FILE=${escapeUnitSpecifiers(gateEnvFile)}`
      : "",
    "@INSTALL_SECTION@": gated ? "" : "[Install]\nWantedBy=default.target",
  });
}

/**
 * @param {object} options
 * @param {string} options.repo
 * @param {string} options.template
 * @param {number} [options.maxBytes]
 * @param {number} [options.keep]
 * @returns {string}
 */
export function renderRotateService({ repo, template, maxBytes = DEFAULT_LOG_MAX_BYTES, keep = DEFAULT_LOG_KEEP }) {
  assertUnitValue("repo root", repo);
  return substituteTemplate(template, {
    "@REPO@": escapeUnitSpecifiers(repo),
    "@MAX_BYTES@": String(maxBytes),
    "@KEEP@": String(keep),
  });
}

/**
 * @param {{env?: NodeJS.ProcessEnv, home?: string}} [options]
 * @returns {string}
 */
export function resolveUnitDir({ env = process.env, home = os.homedir() } = {}) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user");
}

/**
 * @param {{env?: NodeJS.ProcessEnv, home?: string}} [options]
 * @returns {string}
 */
export function resolveUnitPath(options = {}) {
  return path.join(resolveUnitDir(options), UNIT_NAME);
}

/**
 * The repo a rendered unit currently points at, used to warn when the
 * installer replaces a unit that pointed somewhere else.
 * @param {string} unitText
 * @returns {string | null}
 */
export function extractExecStartRepo(unitText) {
  const entry = "/src/daemon.js";
  for (const rawLine of String(unitText).split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.startsWith("ExecStart=") || !line.endsWith(entry)) continue;
    const beforeEntry = line.slice("ExecStart=".length, line.length - entry.length);
    return beforeEntry.trim().split(/\s+/u).pop() || null;
  }
  return null;
}

/**
 * @param {string} file
 * @param {{killFn?: (pid: number, signal: number) => void}} [options]
 * @returns {number | undefined}
 */
export function readLivePid(file, { killFn = process.kill } = {}) {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim().split(/\s+/u)[0], 10);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    killFn(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

/**
 * The pid of a detached (not systemd-supervised) daemon still holding this
 * state directory, if there is one. The marker check comes first because a
 * supervised daemon also writes the pid file, and that is not a conflict.
 * @param {object} options
 * @param {string} options.stateDir
 * @param {string} options.runtimeDir
 * @param {string} [options.markerName]
 * @param {(candidate: string) => boolean} [options.existsFn]
 * @param {(file: string) => number | undefined} [options.readLivePidFn]
 * @returns {number | undefined}
 */
export function findDetachedDaemon({
  stateDir,
  runtimeDir,
  markerName = "systemd-supervised",
  existsFn = fs.existsSync,
  readLivePidFn = readLivePid,
}) {
  if (existsFn(path.join(runtimeDir, markerName))) return undefined;
  return readLivePidFn(path.join(stateDir, "daemon.pid"));
}
