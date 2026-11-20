#!/usr/bin/env node
// Render and install the TaskFerry systemd --user unit.
//
// This writes the unit file and reloads the user manager. It only starts or
// enables anything with --enable, and it refuses to do that while a detached
// daemon still owns the socket, because two owners of one socket is the
// failure supervised mode exists to prevent.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveConfigPath } from "../src/config.js";
import { resolveRuntimeDir, resolveStateDir } from "../src/paths.js";
import {
  PATH_TEMPLATE,
  PATH_UNIT_NAME,
  UNIT_NAME,
  assertRepoSupportsSupervisor,
  extractExecStartRepo,
  findDetachedDaemon,
  isJournalPersistent,
  parseJournaldStorage,
  renderPathUnit,
  renderSystemdUnit,
  resolveDaemonConfigPath,
  resolveEnvFileGate,
  resolveLogTarget,
  resolveUnitDir,
} from "../src/systemd-unit.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join("deploy", "systemd", "taskferry-daemon.service.in");
const JOURNAL_DIR = "/var/log/journal";
const SOCKET_FILENAME = "daemon.sock";

const HELP = `Render and install the TaskFerry systemd --user unit.

Usage:
  scripts/install-systemd-unit.sh [options]

Options:
  --dry-run              Print the rendered unit(s); write nothing, run nothing.
  --enable               Enable and start the unit. Refuses while a detached
                         daemon owns the socket or a gated service is active.
  --log-target MODE      auto (default), journal, or file. File logs append
                         without automatic deletion or truncation.
  --repo PATH            Render for another checkout (the checkout is still
                         verified to contain supervised-daemon support).
  --unit-dir PATH        Write the unit elsewhere (default: XDG_CONFIG_HOME/
                         systemd/user).
  -h, --help             Show this help.

The installer never starts a systemd unit unless --enable is passed, and never
spawns a detached daemon. When config.envFile is set, a path unit starts the
service when the file exists. Stop both units in gated mode:
  systemctl --user stop taskferry-daemon.path taskferry-daemon.service`;

/**
 * @param {string[]} argv
 * @returns {{enable: boolean, dryRun: boolean, logTarget: string, repo: string | null, unitDir: string | null, help: boolean}}
 */
function parseArgs(argv) {
  /** @type {{enable: boolean, dryRun: boolean, logTarget: string, repo: string | null, unitDir: string | null, help: boolean}} */
  const options = { enable: false, dryRun: false, logTarget: "auto", repo: null, unitDir: null, help: false };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    switch (arg) {
      case "--enable": options.enable = true; index += 1; break;
      case "--dry-run": options.dryRun = true; index += 1; break;
      case "--help":
      case "-h": options.help = true; index += 1; break;
      case "--repo": options.repo = takeValue(argv, index, arg); index += 2; break;
      case "--unit-dir": options.unitDir = takeValue(argv, index, arg); index += 2; break;
      case "--log-target": options.logTarget = takeValue(argv, index, arg); index += 2; break;
      default: throw new Error(`error: unknown argument: ${arg}\n\n${HELP}`);
    }
  }
  return options;
}

/**
 * @param {string[]} argv
 * @param {number} index
 * @param {string} flag
 * @returns {string}
 */
function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`error: ${flag} needs a value\n\n${HELP}`);
  return value;
}

/**
 * The checkout this script lives in. Running from a linked worktree renders
 * that worktree, not the primary checkout, which is what lets a feature
 * branch prove its unit before it lands.
 * @param {string} directory
 * @returns {string}
 */
function gitTopLevel(directory) {
  const result = spawnSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`error: cannot resolve the repository for ${directory}: ${(result.stderr || "").trim()}`);
  }
  return result.stdout.trim();
}

/**
 * @returns {string | undefined}
 */
function journalStorage() {
  const result = spawnSync("systemd-analyze", ["cat-config", "systemd/journald.conf"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return undefined;
  return parseJournaldStorage(result.stdout || "");
}

/**
 * @param {string} file
 * @param {string} content
 * @returns {void}
 */
function writeAtomic(file, content) {
  const temporary = `${file}.tmp-${process.pid}`;
  // Unit files hold no secrets (a PATH and repo paths); systemd reads them as
  // the same user, so the umask may narrow 0644 without affecting the render.
  fs.writeFileSync(temporary, content, { mode: 0o644 });
  fs.renameSync(temporary, file);
}

/**
 * @param {string[]} args
 * @returns {void}
 */
function systemctlUser(args) {
  const result = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`error: systemctl --user ${args.join(" ")} exited ${result.status}`);
}

/** @returns {NodeJS.ProcessEnv} */
function managerEnvironment() {
  const result = spawnSync("systemctl", ["--user", "show-environment"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || String(result.status);
    throw new Error(`error: cannot read the systemd user manager environment: ${detail}\nhelp: start the user manager and re-run the installer`);
  }
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const line of result.stdout.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) env[line.slice(0, index)] = line.slice(index + 1);
  }
  if (!env.HOME || !path.isAbsolute(env.HOME)) {
    throw new Error("error: systemd user manager HOME is missing or not absolute\nhelp: set an absolute HOME in the user manager and re-run the installer");
  }
  return env;
}

/**
 * @param {string} unitText
 * @param {string} repo
 * @param {string} unitDir
 * @returns {void}
 */
function warnAboutExistingUnit(unitText, repo, unitDir) {
  let existing;
  try {
    existing = fs.readFileSync(path.join(unitDir, UNIT_NAME), "utf8");
  } catch {
    return;
  }
  const previousRepo = extractExecStartRepo(existing);
  if (previousRepo !== null && previousRepo !== repo) {
    process.stderr.write(`warning: the installed unit currently points at ${previousRepo}; this run would replace it with ${repo}\n`);
  }
  if (existing === unitText) process.stdout.write("note: the installed unit already matches this render\n");
}


/**
 * @param {{unitDir: string, unitText: string, pathUnitText: string | null, enable: boolean}} plan
 * @returns {void}
 */
function install({ unitDir, unitText, pathUnitText, enable }) {
  fs.mkdirSync(unitDir, { recursive: true });
  writeAtomic(path.join(unitDir, UNIT_NAME), unitText);
  process.stdout.write(`wrote ${path.join(unitDir, UNIT_NAME)}\n`);
  if (pathUnitText !== null) {
    writeAtomic(path.join(unitDir, PATH_UNIT_NAME), pathUnitText);
    process.stdout.write(`wrote ${path.join(unitDir, PATH_UNIT_NAME)}\n`);
  }
  systemctlUser(["daemon-reload"]);
  const enabled = pathUnitText === null ? UNIT_NAME : PATH_UNIT_NAME;
  if (!enable) {
    process.stdout.write("\nnext steps: stop any existing daemon and re-run this installer with --enable to perform the guarded cutover.\n");
    return;
  }
  enableUnit(pathUnitText !== null, enabled);
}

/** @param {boolean} gated @param {string} enabled */
function enableUnit(gated, enabled) {
  if (gated) {
    systemctlUser(["disable", UNIT_NAME]);
    systemctlUser(["reset-failed", UNIT_NAME, PATH_UNIT_NAME]);
  }
  systemctlUser(["enable", "--now", enabled]);
  process.stdout.write(`\nenabled and started ${enabled}\n`);
  systemctlUser(["--no-pager", "status", enabled]);
  if (gated) {
    const result = spawnSync("systemctl", ["--user", "is-active", UNIT_NAME], { encoding: "utf8" });
    if (result.error) throw result.error;
    process.stdout.write(`${UNIT_NAME}: ${(result.stdout || "").trim() || "unknown"}\n`);
  }
}

/**
 * @param {string} stateDir
 * @param {string} runtimeDir
 * @param {boolean} gated
 * @returns {void}
 */
function refuseDetachedOwner(stateDir, runtimeDir, gated) {
  const result = spawnSync("systemctl", ["--user", "show", UNIT_NAME, "--property=MainPID", "--value"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  if (result.error) throw result.error;
  const missing = result.status !== 0 && /Unit .* (?:could not be found|not found)/u.test(result.stderr);
  if (!missing && (result.status !== 0 || !/^\d+$/u.test(result.stdout.trim()))) {
    throw new Error("error: cannot determine the current service owner\nhelp: inspect the user manager before installing");
  }
  const supervisedPid = missing ? 0 : Number.parseInt(result.stdout.trim(), 10);
  if (gated && !missing) refuseActiveService(supervisedPid);
  const pid = findDetachedDaemon({ stateDir, supervisedPid });
  if (pid === undefined) return;
  throw new Error(
    `error: a detached taskferry daemon is already running (pid ${pid})\n`
    + `help: stop it before enabling the unit, so two daemons never own ${path.join(runtimeDir, SOCKET_FILENAME)}:\n`
    + `  kill "$(cut -d' ' -f1 ${path.join(stateDir, "daemon.pid")})"\n`
    + "  # wait for the socket to disappear, then re-run with --enable"
  );
}

/** @param {number} supervisedPid */
function refuseActiveService(supervisedPid) {
  const result = spawnSync("systemctl", ["--user", "show", UNIT_NAME, "--property=ActiveState", "--value"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 || !["inactive", "failed"].includes(result.stdout.trim())) {
    throw new Error("error: the service is running or its state is uncertain; stop it before enabling gated startup");
  }
  if (supervisedPid > 0) throw new Error("error: the service is already running; stop it before enabling gated startup");
}

/** @param {NodeJS.ProcessEnv} managerEnv @param {string} daemonConfig */
function warnAboutOverrides(managerEnv, daemonConfig) {
  const shellConfig = resolveConfigPath(process.env);
  if (process.env.TASKFERRY_ENV_FILE !== undefined && process.env.TASKFERRY_ENV_FILE !== managerEnv.TASKFERRY_ENV_FILE) {
    process.stderr.write("warning: shell TASKFERRY_ENV_FILE differs from the user manager; the gate follows the manager\n");
  }
  if (shellConfig !== daemonConfig) {
    process.stderr.write(`warning: shell config is ${shellConfig}, but the gate follows daemon config ${daemonConfig}\n`);
  }
}

/** @param {string} stateDir @param {string} runtimeDir @param {string} socketPath @param {boolean} gated */
function checkEnableSafety(stateDir, runtimeDir, socketPath, gated) {
  const shellState = resolveStateDir(process.env);
  const shellRuntime = resolveRuntimeDir({ env: process.env, stateDir: shellState });
  const shellSocket = process.env.TASKFERRY_SOCKET_PATH || path.join(shellRuntime, SOCKET_FILENAME);
  if (stateDir !== shellState || runtimeDir !== shellRuntime || socketPath !== shellSocket) {
    throw new Error("error: shell and user manager resolve different daemon state, runtime, or socket paths\nhelp: align their TASKFERRY_* and XDG_* settings before enabling the service");
  }
  refuseDetachedOwner(stateDir, runtimeDir, gated);
  if (fs.existsSync(socketPath)) {
    throw new Error(`error: daemon socket ${socketPath} exists; its owner may use another state directory\nhelp: stop the existing owner and inspect the socket before enabling`);
  }
}

/** @param {string} stateDir @param {string} runtimeDir @param {string} socketPath */
function stopExistingPath(stateDir, runtimeDir, socketPath) {
  const result = spawnSync("systemctl", ["--user", "is-active", PATH_UNIT_NAME], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 3 && ["inactive", "failed"].includes(result.stdout.trim())) return false;
  if (result.status === 4 && ["inactive", "unknown"].includes(result.stdout.trim()) && !result.stderr.trim()) return false;
  if (result.status !== 0) throw new Error(`error: cannot determine ${PATH_UNIT_NAME} state`);
  systemctlUser(["stop", PATH_UNIT_NAME]);
  // The previous path could have started the service immediately before stop.
  try {
    checkEnableSafety(stateDir, runtimeDir, socketPath, true);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nhelp: ${PATH_UNIT_NAME} was stopped; resolve the conflict and re-run the installer`, { cause: error });
  }
  return true;
}

/** @param {string} unitDir @param {NodeJS.ProcessEnv} managerEnv @param {boolean} enable @param {boolean} gated */
function checkUnitDirectory(unitDir, managerEnv, enable, gated) {
  if (enable && unitDir !== resolveUnitDir({ env: managerEnv, home: managerEnv.HOME })) {
    throw new Error("error: --enable requires the user manager's unit directory\nhelp: omit --unit-dir or use the manager's systemd/user directory");
  }
  const oldTimer = path.join(unitDir, "taskferry-daemon-logrotate.timer");
  if (fs.existsSync(oldTimer)) {
    throw new Error(`error: obsolete automatic log rotation unit exists at ${oldTimer}\nhelp: disable and remove the old rotation units explicitly before installing; existing log files must be preserved`);
  }
  if (!gated && fs.existsSync(path.join(unitDir, PATH_UNIT_NAME))) {
    process.stderr.write(`warning: existing ${path.join(unitDir, PATH_UNIT_NAME)} can still trigger the service; run systemctl --user disable --now ${PATH_UNIT_NAME} and delete that file if no longer needed\n`);
  }
}

/** @param {{repo: string, managerEnv: NodeJS.ProcessEnv, daemonConfig: string, envFile: string | null, logTarget: "journal" | "file"}} options */
function renderPlan({ repo, managerEnv, daemonConfig, envFile, logTarget }) {
  const gated = envFile !== null;
  const template = fs.readFileSync(path.join(repo, TEMPLATE), "utf8");
  const pathEnv = { ...managerEnv, XDG_STATE_HOME: managerEnv.XDG_STATE_HOME || path.join(managerEnv.HOME, ".local", "state") };
  const stateDir = resolveStateDir(pathEnv);
  const runtimeDir = resolveRuntimeDir({ env: pathEnv, stateDir });
  const socketPath = managerEnv.TASKFERRY_SOCKET_PATH || path.join(runtimeDir, SOCKET_FILENAME);
  const logDir = path.join(managerEnv.HOME, ".local", "state", "taskferry", "logs");
  const unitText = renderSystemdUnit({ nodePath: process.execPath, pathEnv: process.env.PATH || "", gateConfigHome: path.dirname(path.dirname(daemonConfig)), gateEnvFile: envFile || "", logFile: path.join(logDir, "daemon.log"), repo, template, logTarget, gated, stateDir, runtimeDir, socketPath });
  const pathUnitText = envFile === null ? null : renderPathUnit({ repo, envFile, template: fs.readFileSync(path.join(repo, PATH_TEMPLATE), "utf8") });
  return { stateDir, runtimeDir, socketPath, logDir, unitText, pathUnitText };
}

/** @param {{enable: boolean, gated: boolean, stateDir: string, runtimeDir: string, socketPath: string, logTarget: string, logDir: string, unitDir: string, unitText: string, pathUnitText: string | null}} plan */
function finishInstall({ enable, gated, stateDir, runtimeDir, socketPath, logTarget, logDir, unitDir, unitText, pathUnitText }) {
  let stoppedPath = false;
  if (enable) {
    checkEnableSafety(stateDir, runtimeDir, socketPath, gated);
    if (gated) stoppedPath = stopExistingPath(stateDir, runtimeDir, socketPath);
  }
  try {
    if (logTarget === "file") fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    install({ unitDir, unitText, pathUnitText, enable });
  } catch (error) {
    if (!stoppedPath) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nhelp: ${PATH_UNIT_NAME} was stopped; re-run the installer after resolving the error`, { cause: error });
  }
}

/** @param {string[]} argv */
function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const managerEnv = managerEnvironment();
  const daemonConfig = resolveDaemonConfigPath({ homeDir: managerEnv.HOME, env: managerEnv });
  const envFile = resolveEnvFileGate({ homeDir: managerEnv.HOME, env: managerEnv });
  const gated = envFile !== null;
  warnAboutOverrides(managerEnv, daemonConfig);
  const repo = path.resolve(options.repo ?? gitTopLevel(SCRIPT_DIR));
  assertRepoSupportsSupervisor({ repo, gated });


  const journalPersistent = isJournalPersistent({
    storageValue: journalStorage(),
    journalDirExists: fs.existsSync(JOURNAL_DIR),
  });
  const logTarget = resolveLogTarget({ requested: options.logTarget, journalPersistent });
  const unitDir = options.unitDir === null ? resolveUnitDir({ env: managerEnv, home: managerEnv.HOME }) : path.resolve(options.unitDir);
  checkUnitDirectory(unitDir, managerEnv, options.enable, gated);
  const { stateDir, runtimeDir, socketPath, logDir, unitText, pathUnitText } = renderPlan({ repo, managerEnv, daemonConfig, envFile, logTarget });

  process.stdout.write(`repo: ${repo}\nnode: ${process.execPath}\nunit dir: ${unitDir}\nlog target: ${logTarget}\n`);
  warnAboutExistingUnit(unitText, repo, unitDir);

  if (options.dryRun) {
    process.stdout.write(`\n--- ${path.join(unitDir, UNIT_NAME)} ---\n${unitText}`);
    if (pathUnitText !== null) process.stdout.write(`\n--- ${path.join(unitDir, PATH_UNIT_NAME)} ---\n${pathUnitText}`);
    return;
  }

  finishInstall({ enable: options.enable, gated, stateDir, runtimeDir, socketPath, logTarget, logDir, unitDir, unitText, pathUnitText });
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
