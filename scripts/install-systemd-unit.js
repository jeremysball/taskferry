#!/usr/bin/env node
// Render and install the TaskFerry systemd --user unit.
//
// This writes the unit file and reloads the user manager. It only starts or
// enables anything with --enable, and it refuses to do that while a detached
// daemon still owns the socket, because two owners of one socket is the
// failure supervised mode exists to prevent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveConfigPath } from "../src/config.js";
import {
  DAEMON_LOG_BASENAME,
  DEFAULT_LOG_KEEP,
  DEFAULT_LOG_MAX_BYTES,
  PATH_TEMPLATE,
  PATH_UNIT_NAME,
  ROTATE_SERVICE_NAME,
  ROTATE_TIMER_NAME,
  UNIT_NAME,
  assertRepoSupportsSupervisor,
  extractExecStartRepo,
  findDetachedDaemon,
  isJournalPersistent,
  parseJournaldStorage,
  renderPathUnit,
  renderRotateService,
  renderSystemdUnit,
  resolveDaemonConfigPath,
  resolveEnvFileGate,
  resolveLogTarget,
  resolveUnitDir,
} from "../src/systemd-unit.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join("deploy", "systemd", "taskferry-daemon.service.in");
const ROTATE_TEMPLATE = path.join("deploy", "systemd", "taskferry-daemon-logrotate.service.in");
const TIMER_TEMPLATE = path.join("deploy", "systemd", "taskferry-daemon-logrotate.timer");
const JOURNAL_DIR = "/var/log/journal";
const LOG_DIR = path.join(os.homedir(), ".local", "state", "taskferry", "logs");

const HELP = `Render and install the TaskFerry systemd --user unit.

Usage:
  scripts/install-systemd-unit.sh [options]

Options:
  --dry-run              Print the rendered unit(s); write nothing, run nothing.
  --enable               Enable and start the unit (and the log-rotation timer
                         when file logging is selected). Refuses while a
                         detached daemon still owns the socket.
  --log-target MODE      auto (default), journal, or file. auto uses journald
                         when it persists across boots, and a bounded
                         rotated file under the state dir otherwise.
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
    throw new Error(`error: cannot read the systemd user manager environment: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}\nhelp: start the user manager and re-run the installer`);
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
 * @param {{repo: string, logTarget: string}} options
 * @returns {{service: string, timer: string} | undefined}
 */
function buildRotation({ repo, logTarget }) {
  if (logTarget !== "file") return undefined;
  return {
    service: renderRotateService({ repo, template: fs.readFileSync(path.join(repo, ROTATE_TEMPLATE), "utf8") }),
    timer: fs.readFileSync(path.join(repo, TIMER_TEMPLATE), "utf8"),
  };
}

/**
 * @param {{unitDir: string, unitText: string, pathUnitText: string | null, rotation: {service: string, timer: string} | undefined, enable: boolean}} plan
 * @returns {void}
 */
function install({ unitDir, unitText, pathUnitText, rotation, enable }) {
  fs.mkdirSync(unitDir, { recursive: true });
  writeAtomic(path.join(unitDir, UNIT_NAME), unitText);
  process.stdout.write(`wrote ${path.join(unitDir, UNIT_NAME)}\n`);
  if (pathUnitText !== null) {
    writeAtomic(path.join(unitDir, PATH_UNIT_NAME), pathUnitText);
    process.stdout.write(`wrote ${path.join(unitDir, PATH_UNIT_NAME)}\n`);
  }
  if (rotation) {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    writeAtomic(path.join(unitDir, ROTATE_SERVICE_NAME), rotation.service);
    writeAtomic(path.join(unitDir, ROTATE_TIMER_NAME), rotation.timer);
    process.stdout.write(`wrote ${path.join(unitDir, ROTATE_SERVICE_NAME)} and ${ROTATE_TIMER_NAME}\n`);
  }
  systemctlUser(["daemon-reload"]);
  if (!enable) {
    process.stdout.write("\nnext steps (after stopping any detached daemon):\n");
    if (pathUnitText !== null) process.stdout.write(`  systemctl --user disable ${UNIT_NAME}\n`);
    process.stdout.write(`  systemctl --user enable --now ${pathUnitText === null ? UNIT_NAME : PATH_UNIT_NAME}\n`);
    if (rotation) process.stdout.write(`  systemctl --user enable --now ${ROTATE_TIMER_NAME}\n`);
    return;
  }
  if (pathUnitText !== null) {
    systemctlUser(["disable", UNIT_NAME]);
    systemctlUser(["reset-failed", UNIT_NAME, PATH_UNIT_NAME]);
    systemctlUser(["enable", "--now", PATH_UNIT_NAME]);
  } else {
    systemctlUser(["enable", "--now", UNIT_NAME]);
  }
  if (rotation) systemctlUser(["enable", "--now", ROTATE_TIMER_NAME]);
  const enabled = pathUnitText === null ? UNIT_NAME : PATH_UNIT_NAME;
  process.stdout.write(`\nenabled and started ${enabled}\n`);
  systemctlUser(["--no-pager", "status", enabled]);
  if (pathUnitText !== null) {
    const result = spawnSync("systemctl", ["--user", "is-active", UNIT_NAME], { encoding: "utf8" });
    if (result.error) throw result.error;
    process.stdout.write(`${UNIT_NAME}: ${(result.stdout || "").trim() || "unknown"}\n`);
  }
}

/**
 * @returns {void}
 */
function refuseDetachedOwner() {
  const stateDir = path.join(os.homedir(), ".local", "state", "taskferry");
  const runtimeDir = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, "taskferry");
  const pid = findDetachedDaemon({ stateDir, runtimeDir });
  if (pid === undefined) return;
  throw new Error(
    `error: a detached taskferry daemon is already running (pid ${pid})\n`
    + `help: stop it before enabling the unit, so two daemons never own ${path.join(runtimeDir, "daemon.sock")}:\n`
    + `  kill "$(cut -d' ' -f1 ${path.join(stateDir, "daemon.pid")})"\n`
    + "  # wait for the socket to disappear, then re-run with --enable"
  );
}

/**
 * @param {string[]} argv
 * @returns {void}
 */
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
  const shellConfig = resolveConfigPath(process.env);
  if (process.env.TASKFERRY_ENV_FILE !== undefined && process.env.TASKFERRY_ENV_FILE !== managerEnv.TASKFERRY_ENV_FILE) {
    process.stderr.write("warning: shell TASKFERRY_ENV_FILE differs from the user manager; the gate follows the manager\n");
  }
  if (shellConfig !== daemonConfig) {
    process.stderr.write(`warning: shell config is ${shellConfig}, but the gate follows daemon config ${daemonConfig}\n`);
  }
  const repo = path.resolve(options.repo ?? gitTopLevel(SCRIPT_DIR));
  assertRepoSupportsSupervisor({ repo, gated });
  const template = fs.readFileSync(path.join(repo, TEMPLATE), "utf8");

  const journalPersistent = isJournalPersistent({
    storageValue: journalStorage(),
    journalDirExists: fs.existsSync(JOURNAL_DIR),
  });
  const logTarget = resolveLogTarget({ requested: options.logTarget, journalPersistent });
  const unitDir = options.unitDir === null ? resolveUnitDir({ env: process.env }) : path.resolve(options.unitDir);
  const unitText = renderSystemdUnit({ nodePath: process.execPath, pathEnv: process.env.PATH || "", repo, template, logTarget, gated, gateConfigHome: path.dirname(path.dirname(daemonConfig)), gateEnvFile: envFile || "" });
  const pathUnitText = envFile === null ? null : renderPathUnit({ repo, envFile, template: fs.readFileSync(path.join(repo, PATH_TEMPLATE), "utf8") });
  if (!gated && fs.existsSync(path.join(unitDir, PATH_UNIT_NAME))) {
    process.stderr.write(`warning: existing ${path.join(unitDir, PATH_UNIT_NAME)} can still trigger the service; run systemctl --user disable --now ${PATH_UNIT_NAME} and delete that file if no longer needed\n`);
  }
  const rotation = buildRotation({ repo, logTarget });

  process.stdout.write(`repo: ${repo}\nnode: ${process.execPath}\nunit dir: ${unitDir}\nlog target: ${logTarget}\n`);
  warnAboutExistingUnit(unitText, repo, unitDir);

  if (options.dryRun) {
    process.stdout.write(`\n--- ${path.join(unitDir, UNIT_NAME)} ---\n${unitText}`);
    if (pathUnitText !== null) process.stdout.write(`\n--- ${path.join(unitDir, PATH_UNIT_NAME)} ---\n${pathUnitText}`);
    if (rotation) {
      process.stdout.write(`\n--- ${path.join(unitDir, ROTATE_SERVICE_NAME)} ---\n${rotation.service}`);
      process.stdout.write(`\n--- ${path.join(unitDir, ROTATE_TIMER_NAME)} ---\n${rotation.timer}`);
    }
    return;
  }

  if (options.enable) refuseDetachedOwner();
  process.stdout.write(`log file name: ${DAEMON_LOG_BASENAME}, max ${DEFAULT_LOG_MAX_BYTES} bytes, keep ${DEFAULT_LOG_KEEP}\n`);
  install({ unitDir, unitText, pathUnitText, rotation, enable: options.enable });
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
