import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveConfigPath } from "./config.js";
import { runInstaller as runInstallerProgrammatically } from "../scripts/install-systemd-unit.js";
import {
  DAEMON_LOG_FILE,
  UNIT_NAME,
  PATH_UNIT_NAME,
  PATH_TEMPLATE,
  assertRepoSupportsSupervisor,
  assertUnitValue,
  escapeUnitSpecifiers,
  extractExecStartRepo,
  findDetachedDaemon,
  findMissingSupervisorSupport,
  isJournalPersistent,
  parseJournaldStorage,
  renderPathUnit,
  renderSystemdUnit,
  resolveLogTarget,
  resolveDaemonConfigPath,
  resolveEnvFileGate,
  resolveUnitDir,
  substituteTemplate,
} from "./systemd-unit.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYSTEMD_NAME = "systemd";
const APP_NAME = "taskferry";
const SYSTEMD_DIR = path.join("deploy", SYSTEMD_NAME);
const SERVICE_TEMPLATE = path.join(SYSTEMD_DIR, "taskferry-daemon.service.in");
const UNIT_TEMPLATE = path.join(REPO_ROOT, SERVICE_TEMPLATE);
const CONFIG_FILE = "config.json";
const ACTIVE_STATE_CALL = "--user show taskferry-daemon.service --property=ActiveState --value";
const ENABLE_PATH_CALL = "--user enable --now taskferry-daemon.path";
const RELOAD_CALL = "--user daemon-reload";
const SYSTEMCTL_PATH = "/usr/bin/systemctl";
const SYSTEMD_ANALYZE_PATH = "/usr/bin/systemd-analyze";
const GIT_PATH = "/usr/bin/git";
const LOG_TARGET_ARG = "--log-target";
const TEST_INSTALLER_RUNNER = `
import { spawnSync } from "node:child_process";
import { runInstaller } from ${JSON.stringify(new URL("../scripts/install-systemd-unit.js", import.meta.url).href)};
const shim = process.argv[1];
const runFn = (file, args, options) => {
  if (file === ${JSON.stringify(SYSTEMCTL_PATH)}) return spawnSync(shim, args, options);
  if (file === ${JSON.stringify(SYSTEMD_ANALYZE_PATH)}) {
    if (process.env.TASKFERRY_TEST_FAIL_ANALYZE) return { error: new Error("unavailable"), stderr: "" };
    return { status: 0, stdout: "Storage=persistent\\n", stderr: "" };
  }
  if (file === ${JSON.stringify(GIT_PATH)}) return spawnSync(file, args, options);
  throw new Error("unexpected command: " + file);
};
try { runInstaller(process.argv.slice(2), { runFn }); }
catch (error) { console.error(error.message); process.exitCode = 1; }
`;

// Synthetic paths for render fixtures, built at runtime so no developer path
// is baked into the test.
const FIXTURE_HOME = path.join(os.tmpdir(), "taskferry-fixture-home");
const FIXTURE_REPO = path.join(FIXTURE_HOME, APP_NAME);
const FIXTURE_NODE = path.join(FIXTURE_HOME, ".local", "share", "mise", "installs", "node", "26.5.1", "bin", "node");
const FIXTURE_PATH = [path.join(FIXTURE_HOME, ".local", "bin"), path.join(path.sep, "usr", "bin")].join(path.delimiter);
const OTHER_REPO = path.join(path.sep, "workspace", APP_NAME);
const NODE_BINARY = path.join(path.sep, "usr", "bin", "node");

function temporaryDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-systemd-unit-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function templateText() {
  return fs.readFileSync(UNIT_TEMPLATE, "utf8");
}

function supervisorFixture(t) {
  const repo = temporaryDir(t);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, SYSTEMD_DIR), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "client.js"), "TASKFERRY_DAEMON_SUPERVISOR startDaemonViaSystemd\n");
  fs.writeFileSync(path.join(repo, "src", "daemon.js"), "SUPERVISED_RESTART_EXIT_CODE TASKFERRY_DAEMON_SUPERVISOR\n");
  fs.writeFileSync(path.join(repo, SERVICE_TEMPLATE), templateText());
  fs.copyFileSync(path.join(REPO_ROOT, PATH_TEMPLATE), path.join(repo, PATH_TEMPLATE));
  return repo;
}

function render(options = {}) {
  return renderSystemdUnit({
    repo: FIXTURE_REPO,
    nodePath: FIXTURE_NODE,
    pathEnv: FIXTURE_PATH,
    stateDir: path.join(FIXTURE_HOME, "state"),
    runtimeDir: path.join(FIXTURE_HOME, "run"),
    socketPath: path.join(FIXTURE_HOME, "run", "daemon.sock"),
    gateConfigHome: path.join(FIXTURE_HOME, ".config"),
    gateEnvFile: path.join(FIXTURE_HOME, "secrets"),
    template: templateText(),
    ...options,
  });
}

function runInstaller(t, args, env = {}) {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TASKFERRY_|XDG_|GIT_)/u.test(key)));
  const shim = temporaryDir(t);
  fs.writeFileSync(path.join(shim, "systemctl"), "#!/bin/sh\nprintf 'HOME=%s\\n' \"$HOME\"\n", { mode: 0o755 });
  return spawnSync(process.execPath, ["--input-type=module", "-e", TEST_INSTALLER_RUNNER, path.join(shim, "systemctl"), ...args], { encoding: "utf8", env: { ...cleanEnv, HOME: temporaryDir(t), PATH: `${shim}${path.delimiter}${process.env.PATH}`, ...env } });
}

function isolatedInstaller(t, { gated = false, stalePath = false, staleRotation = false, occupiedSocket = false, extraEnv = {}, managerEnv = "", args = [], repo = supervisorFixture(t) } = {}) {
  const home = temporaryDir(t);
  const unitDir = path.join(home, ".config", SYSTEMD_NAME, "user");
  fs.mkdirSync(unitDir, { recursive: true });
  const shim = temporaryDir(t);
  const calls = path.join(shim, "calls");
  const envFile = path.join(home, "secrets", "env");
  if (stalePath) fs.writeFileSync(path.join(unitDir, PATH_UNIT_NAME), "old path unit\n");
  if (staleRotation) fs.writeFileSync(path.join(unitDir, "taskferry-daemon-logrotate.timer"), "old timer\n");
  if (gated) {
    const config = path.join(home, ".config", APP_NAME);
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, CONFIG_FILE), JSON.stringify({ envFile }));
  }
  fs.writeFileSync(path.join(shim, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\ncase "$*" in *show-environment*) printf 'HOME=%s\\nXDG_RUNTIME_DIR=%s\\n' "$HOME" "$XDG_RUNTIME_DIR"; printf '%s' "$MANAGER_ENV"; exit 0;; *is-active*taskferry-daemon.path*) if [ "\${PATH_STATE:-inactive}" = missing ]; then echo inactive; exit 4; fi; if [ "\${PATH_STATE:-inactive}" = active ]; then echo active; exit 0; fi; echo inactive; exit 3;; *stop*taskferry-daemon.path*) touch "$CALLS.stopped"; exit 0;; *is-active*) echo inactive; exit 3;; *--property=MainPID*) if [ "\${MISSING_SERVICE:-0}" = 1 ]; then echo 'Unit taskferry-daemon.service could not be found.' >&2; exit 1; fi; echo "\${MAIN_PID:-0}"; exit 0;; *--property=ActiveState*) if [ -f "$CALLS.stopped" ] && [ "\${START_AFTER_STOP:-0}" = 1 ]; then echo active; else echo "\${ACTIVE_STATE:-inactive}"; fi; exit 0;; esac\nexit 0\n`, { mode: 0o755 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TASKFERRY_|XDG_|GIT_)/u.test(key)));
  const runtime = temporaryDir(t);
  if (occupiedSocket) {
    fs.mkdirSync(path.join(runtime, APP_NAME));
    fs.writeFileSync(path.join(runtime, APP_NAME, "daemon.sock"), "occupied");
  }
  Object.assign(env, { HOME: home, XDG_RUNTIME_DIR: runtime, PATH: `${shim}${path.delimiter}${process.env.PATH}`, CALLS: calls, MANAGER_ENV: managerEnv }, extraEnv);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", TEST_INSTALLER_RUNNER, path.join(shim, "systemctl"), "--repo", repo, "--unit-dir", unitDir, LOG_TARGET_ARG, "journal", ...args], { encoding: "utf8", env });
  return { result, envFile, home, runtime, unitDir, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [] };
}

test("installer uses fixed executables and reports a missing binary", (t) => {
  const home = temporaryDir(t);
  const calls = [];
  assert.throws(() => runInstallerProgrammatically(["--dry-run"], {
    runFn: (file) => {
      calls.push(file);
      if (file === SYSTEMCTL_PATH) return { status: 0, stdout: `HOME=${home}\n`, stderr: "" };
      if (file === GIT_PATH) return { status: 0, stdout: `${REPO_ROOT}\n`, stderr: "" };
      return { error: new Error("not installed"), stderr: "" };
    },
  }), /cannot execute \/usr\/bin\/systemd-analyze/u);
  assert.deepEqual(calls, [SYSTEMCTL_PATH, GIT_PATH, SYSTEMD_ANALYZE_PATH]);
});

test("explicit log targets do not invoke systemd-analyze", (t) => {
  for (const target of ["file", "journal"]) {
    const result = isolatedInstaller(t, {
      args: ["--dry-run", LOG_TARGET_ARG, target],
      extraEnv: { TASKFERRY_TEST_FAIL_ANALYZE: "1" },
    });
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.match(result.result.stdout, new RegExp(`^log target: ${target}$`, "mu"));
  }
  const automatic = isolatedInstaller(t, {
    args: ["--dry-run", LOG_TARGET_ARG, "auto"],
    extraEnv: { TASKFERRY_TEST_FAIL_ANALYZE: "1" },
  });
  assert.notEqual(automatic.result.status, 0);
  assert.match(automatic.result.stderr, /cannot execute \/usr\/bin\/systemd-analyze/u);
});

describe("env-file gated start", () => {
  test("daemon config path matches the default config resolver", () => {
    assert.equal(resolveDaemonConfigPath(), resolveConfigPath({}));
  });

  test("resolves the gate and rejects invalid configuration", (t) => {
    const homeDir = temporaryDir(t);
    const dir = path.join(homeDir, ".config", APP_NAME);
    const config = path.join(dir, CONFIG_FILE);
    assert.equal(resolveEnvFileGate({ homeDir }), null);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ envFile: path.join(homeDir, "secret") }));
    assert.equal(resolveEnvFileGate({ homeDir }), path.join(homeDir, "secret"));
    fs.writeFileSync(config, JSON.stringify({ envFile: "relative" }));
    assert.throws(() => resolveEnvFileGate({ homeDir }), /envFile.*absolute/u);
    fs.writeFileSync(config, "{");
    assert.throws(() => resolveEnvFileGate({ homeDir }), /help:/u);
    fs.rmSync(config);
    fs.mkdirSync(config);
    assert.throws(() => resolveEnvFileGate({ homeDir }), (error) => /help:/u.test(error.message) && Boolean(error.cause));
  });

  test("renders a path unit and removes service installation only when gated", () => {
    const template = fs.readFileSync(path.join(REPO_ROOT, PATH_TEMPLATE), "utf8");
    const envFile = path.join(FIXTURE_HOME, "100%secret");
    const unit = renderPathUnit({ repo: FIXTURE_REPO, envFile, template });
    assert.match(unit, new RegExp(`^PathExists=${escapeRegExp(envFile.replaceAll("%", "%%"))}$`, "mu"));
    assert.match(unit, /^Unit=taskferry-daemon\.service$/mu);
    assert.match(unit, /^WantedBy=default.target$/mu);
    for (const invalid of ["", "relative", "/with space", "/line\nbreak"]) {
      assert.throws(() => renderPathUnit({ repo: FIXTURE_REPO, envFile: invalid, template }));
    }
    assert.match(render(), /^\[Install\]$/mu);
    assert.doesNotMatch(render({ gated: true }), /^\[Install\]$/mu);
  });

  test("gated support requires the path template and service marker", (t) => {
    const repo = supervisorFixture(t);
    fs.rmSync(path.join(repo, PATH_TEMPLATE));
    assert.deepEqual(findMissingSupervisorSupport({ repo }), []);
    assert.throws(() => assertRepoSupportsSupervisor({ repo, gated: true }), /is missing/u);
    fs.copyFileSync(path.join(REPO_ROOT, PATH_TEMPLATE), path.join(repo, PATH_TEMPLATE));
    const service = path.join(repo, SERVICE_TEMPLATE);
    fs.writeFileSync(service, templateText().replace("@INSTALL_SECTION@", ""));
    assert.deepEqual(findMissingSupervisorSupport({ repo }), []);
    assert.throws(() => assertRepoSupportsSupervisor({ repo, gated: true }), /lacks @INSTALL_SECTION@/u);
  });

  test("installer enables the path in order and tolerates an inactive service", (t) => {
    const gated = isolatedInstaller(t, { gated: true, args: ["--enable"] });
    assert.equal(gated.result.status, 0, gated.result.stderr);
    assert.deepEqual(gated.calls, ["--user show-environment", "--user show taskferry-daemon.service --property=MainPID --value", ACTIVE_STATE_CALL, "--user is-active taskferry-daemon.path", RELOAD_CALL, "--user disable taskferry-daemon.service", "--user reset-failed taskferry-daemon.service taskferry-daemon.path", ENABLE_PATH_CALL, "--user --no-pager status taskferry-daemon.path", "--user is-active taskferry-daemon.service"]);
    assert.match(gated.result.stdout, /taskferry-daemon.service: inactive/u);
    assert.match(fs.readFileSync(path.join(gated.unitDir, PATH_UNIT_NAME), "utf8"), /PathExists=/u);
    assert.match(fs.readFileSync(path.join(gated.unitDir, UNIT_NAME), "utf8"), /^ConditionPathExists=/mu);
    assert.doesNotMatch(fs.readFileSync(path.join(gated.unitDir, UNIT_NAME), "utf8"), /^\[Install\]$/mu);
    const plain = isolatedInstaller(t, { args: ["--enable"] });
    assert.equal(plain.result.status, 0, plain.result.stderr);
    assert.ok(plain.calls.includes("--user enable --now taskferry-daemon.service"));
    assert.ok(plain.calls.every((call) => !call.includes(PATH_UNIT_NAME)));
  });

  test("gated enable refuses an already-running service without writing units", (t) => {
    const gated = isolatedInstaller(t, { gated: true, args: ["--enable"], extraEnv: { MAIN_PID: "123" } });
    assert.notEqual(gated.result.status, 0);
    assert.match(gated.result.stderr, /already running/u);
    assert.equal(fs.existsSync(path.join(gated.unitDir, UNIT_NAME)), false);
    const activating = isolatedInstaller(t, { gated: true, args: ["--enable"], extraEnv: { ACTIVE_STATE: "activating" } });
    assert.notEqual(activating.result.status, 0);
    assert.match(activating.result.stderr, /state is uncertain/u);
  });

  test("a not-yet-installed service can be enabled after checking the pid file", (t) => {
    const result = isolatedInstaller(t, { gated: true, args: ["--enable"], extraEnv: { MISSING_SERVICE: "1" } });
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.ok(result.calls.includes(ENABLE_PATH_CALL));
  });

  test("an unloaded path reported inactive with exit 4 can be installed", (t) => {
    const result = isolatedInstaller(t, { gated: true, args: ["--enable"], extraEnv: { PATH_STATE: "missing" } });
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.ok(result.calls.includes(ENABLE_PATH_CALL));
  });

  test("re-arms an active path after stopping it and rechecking the service", (t) => {
    const result = isolatedInstaller(t, { gated: true, args: ["--enable"], extraEnv: { PATH_STATE: "active" } });
    assert.equal(result.result.status, 0, result.result.stderr);
    const stop = result.calls.indexOf("--user stop taskferry-daemon.path");
    const reload = result.calls.indexOf(RELOAD_CALL);
    assert.ok(stop >= 0 && stop < reload);
    assert.ok(result.calls.slice(stop + 1, reload).includes(ACTIVE_STATE_CALL));
    assert.ok(result.calls.includes(ENABLE_PATH_CALL));
  });

  test("rearming stops if the old path starts the service during handover", (t) => {
    const result = isolatedInstaller(t, { gated: true, args: ["--enable"], extraEnv: { PATH_STATE: "active", START_AFTER_STOP: "1" } });
    assert.notEqual(result.result.status, 0);
    assert.match(result.result.stderr, /was stopped/u);
    assert.ok(result.calls.includes("--user stop taskferry-daemon.path"));
    assert.ok(!result.calls.includes(RELOAD_CALL));
  });

  test("file logging creates its parent before asking systemd to start", (t) => {
    const result = isolatedInstaller(t, { args: ["--enable", LOG_TARGET_ARG, "file"] });
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.ok(fs.statSync(path.join(result.home, ".local", "state", APP_NAME, "logs")).isDirectory());
    assert.match(fs.readFileSync(path.join(result.unitDir, UNIT_NAME), "utf8"), /^StandardOutput=append:/mu);
  });

  test("install without enable directs cutover through the guarded installer", (t) => {
    const result = isolatedInstaller(t, { gated: true });
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.match(result.result.stdout, /re-run.*--enable/u);
    assert.doesNotMatch(result.result.stdout, /systemctl --user enable --now/u);
    assert.ok(result.calls.includes(RELOAD_CALL));
  });

  test("manager and shell daemon path mismatches refuse enable", (t) => {
    const stateDir = temporaryDir(t);
    const result = isolatedInstaller(t, { args: ["--enable"], managerEnv: `TASKFERRY_STATE_DIR=${stateDir}\n` });
    assert.notEqual(result.result.status, 0);
    assert.match(result.result.stderr, /resolve different daemon state/u);
    assert.equal(fs.existsSync(path.join(result.unitDir, UNIT_NAME)), false);
  });

  test("an existing socket blocks takeover even without a matching pid file", (t) => {
    const result = isolatedInstaller(t, { occupiedSocket: true, args: ["--enable"] });
    assert.notEqual(result.result.status, 0);
    assert.match(result.result.stderr, /socket.*exists/u);
    assert.equal(fs.existsSync(path.join(result.unitDir, UNIT_NAME)), false);
  });

  test("an existing socket blocks reinstall even when systemd reports a MainPID", (t) => {
    const result = isolatedInstaller(t, { occupiedSocket: true, args: ["--enable"], extraEnv: { MAIN_PID: String(process.pid) } });
    assert.notEqual(result.result.status, 0);
    assert.match(result.result.stderr, /socket.*exists/u);
    assert.equal(fs.existsSync(path.join(result.unitDir, UNIT_NAME)), false);
  });

  test("refuses to install over an obsolete log-rotation timer", (t) => {
    const result = isolatedInstaller(t, { staleRotation: true, args: ["--dry-run"] });
    assert.notEqual(result.result.status, 0);
    assert.match(result.result.stderr, /obsolete automatic log rotation/u);
    assert.equal(fs.readFileSync(path.join(result.unitDir, "taskferry-daemon-logrotate.timer"), "utf8"), "old timer\n");
  });

  test("dry run follows manager config and warns about shell overrides", (t) => {
    const other = temporaryDir(t);
    const gated = isolatedInstaller(t, { gated: true, args: ["--dry-run"], extraEnv: { TASKFERRY_ENV_FILE: "/ignored", XDG_CONFIG_HOME: other } });
    assert.equal(gated.result.status, 0, gated.result.stderr);
    assert.match(gated.result.stdout, new RegExp(`PathExists=${escapeRegExp(gated.envFile)}`, "u"));
    assert.match(gated.result.stderr, /TASKFERRY_ENV_FILE/u);
    assert.match(gated.result.stderr, /gate follows/u);
    const plain = isolatedInstaller(t, { args: ["--dry-run"] });
    assert.equal(plain.result.status, 0, plain.result.stderr);
    assert.match(plain.result.stdout, /^\[Install\]$/mu);
    assert.doesNotMatch(plain.result.stdout, /PathExists=/u);
  });

  test("manager overrides select and pin the effective gate", (t) => {
    const configHome = temporaryDir(t);
    const envFile = path.join(configHome, "manager-secret");
    const configDir = path.join(configHome, APP_NAME);
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, CONFIG_FILE), JSON.stringify({ envFile: path.join(configHome, "other") }));
    const result = isolatedInstaller(t, { args: ["--dry-run"], managerEnv: `XDG_CONFIG_HOME=${configHome}\nTASKFERRY_ENV_FILE=${envFile}\n` });
    assert.equal(result.result.status, 0, result.result.stderr);
    assert.match(result.result.stdout, new RegExp(`PathExists=${escapeRegExp(envFile)}`, "u"));
    assert.match(result.result.stdout, new RegExp(`Environment=TASKFERRY_ENV_FILE=${escapeRegExp(envFile)}`, "u"));
    assert.match(result.result.stdout, new RegExp(`Environment=XDG_CONFIG_HOME=${escapeRegExp(configHome)}`, "u"));
    const empty = isolatedInstaller(t, { gated: true, args: ["--dry-run"], managerEnv: "TASKFERRY_ENV_FILE=\n" });
    assert.equal(empty.result.status, 0, empty.result.stderr);
    assert.doesNotMatch(empty.result.stdout, /PathExists=/u);
  });

  test("ungated installation warns about but leaves an old path unit", (t) => {
    const plain = isolatedInstaller(t, { stalePath: true, args: ["--dry-run"] });
    assert.equal(plain.result.status, 0, plain.result.stderr);
    assert.match(plain.result.stderr, /disable --now taskferry-daemon\.path/u);
    assert.equal(fs.readFileSync(path.join(plain.unitDir, PATH_UNIT_NAME), "utf8"), "old path unit\n");
    const gated = isolatedInstaller(t, { gated: true, args: ["--dry-run"] });
    assert.match(gated.result.stdout, /PathExists=/u);
  });

  test("installer checks gated template support without requiring it ungated", (t) => {
    const repo = supervisorFixture(t);
    fs.rmSync(path.join(repo, PATH_TEMPLATE));
    const gated = isolatedInstaller(t, { repo, gated: true, args: ["--dry-run"] });
    assert.notEqual(gated.result.status, 0);
    assert.match(gated.result.stderr, /is missing/u);
    const plain = isolatedInstaller(t, { repo, args: ["--dry-run"] });
    assert.equal(plain.result.status, 0, plain.result.stderr);
  });

  test("systemd-analyze accepts the rendered gated pair", (t) => {
    const probe = spawnSync(SYSTEMD_ANALYZE_PATH, ["--version"], { encoding: "utf8" });
    if (probe.error?.code === "ENOENT") {
      t.skip("systemd-analyze is not installed");
      return;
    }
    const dir = temporaryDir(t);
    const service = path.join(dir, UNIT_NAME);
    const unitPath = path.join(dir, PATH_UNIT_NAME);
    fs.writeFileSync(service, render({ repo: REPO_ROOT, nodePath: process.execPath, pathEnv: process.env.PATH, gated: true }));
    fs.writeFileSync(unitPath, renderPathUnit({ repo: REPO_ROOT, envFile: path.join(dir, "env"), template: fs.readFileSync(path.join(REPO_ROOT, PATH_TEMPLATE), "utf8") }));
    const result = spawnSync(SYSTEMD_ANALYZE_PATH, ["--user", "verify", service, unitPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
});

describe("systemd unit rendering", () => {
  test("renders a supervised unit that points at the checkout's daemon entry", () => {
    const unit = render();
    assert.match(unit, /^Type=exec$/mu);
    assert.match(unit, new RegExp(`^WorkingDirectory=${escapeRegExp(FIXTURE_REPO)}$`, "mu"));
    assert.match(unit, new RegExp(`^ExecStart=${escapeRegExp(FIXTURE_NODE)} ${escapeRegExp(FIXTURE_REPO)}/src/daemon\\.js$`, "mu"));
    assert.match(unit, /^Restart=on-failure$/mu);
    assert.match(unit, /^RestartSec=2$/mu);
    assert.match(unit, /^TimeoutStartSec=60$/mu);
    assert.match(unit, /^TimeoutStopSec=30$/mu);
    assert.match(unit, /^KillMode=process$/mu);
    assert.match(unit, /^Environment=TASKFERRY_DAEMON_SUPERVISOR=systemd$/mu);
    assert.match(unit, new RegExp(`^ExecStartPre=.*touch ${escapeRegExp(path.join(FIXTURE_HOME, "run", "systemd-supervised"))}$`, "mu"));
    assert.match(unit, /^StandardOutput=journal$/mu);
    assert.match(unit, /^StandardError=journal$/mu);
    assert.doesNotMatch(unit, /client\.js/u, "the unit must exec the daemon, not the client that could spawn a second one");
  });

  test("file logging appends without installing automatic rotation", () => {
    const unit = render({ logTarget: "file" });
    assert.match(unit, new RegExp(`^StandardOutput=append:${escapeRegExp(DAEMON_LOG_FILE)}$`, "mu"));
    assert.match(unit, /^StandardError=inherit$/mu);
    assert.doesNotMatch(unit, /^ExecStartPre=.*mkdir.*logs$/mu);
    assert.doesNotMatch(unit, /^StandardOutput=journal$/mu);

  });

  test("file log paths escape systemd specifiers and reject unit escapes", () => {
    const file = path.join(FIXTURE_HOME, "100%home", "daemon.log");
    const unit = render({ logTarget: "file", logFile: file });
    assert.match(unit, new RegExp(`^StandardOutput=append:${escapeRegExp(file.replaceAll("%", "%%"))}$`, "mu"));
    assert.throws(() => render({ logTarget: "file", logFile: `${file}\\n` }), /unit syntax/u);
  });

  test("escapes unit specifiers in substituted values", () => {
    const percentRepo = path.join(os.tmpdir(), "100%repo");
    const percentNode = path.join(path.sep, "usr", "bin", "%node");
    assert.equal(escapeUnitSpecifiers(percentRepo), percentRepo.replaceAll("%", "%%"));
    const unit = render({ repo: percentRepo, nodePath: percentNode });
    const expectedRepo = escapeRegExp(escapeUnitSpecifiers(percentRepo));
    const expectedNode = escapeRegExp(escapeUnitSpecifiers(percentNode));
    assert.match(unit, new RegExp(`^WorkingDirectory=${expectedRepo}$`, "mu"));
    assert.match(unit, new RegExp(`^ExecStart=${expectedNode} ${expectedRepo}/src/daemon\\.js$`, "mu"));
  });

  test("rejects values that cannot be represented unambiguously", () => {
    assert.throws(() => assertUnitValue("repo root", ""), /is empty/u);
    assert.throws(() => assertUnitValue("repo root", "/tmp/with space"), /contains whitespace/u);
    assert.throws(() => assertUnitValue("repo root", "/tmp/line\nbreak"), /control character/u);
    assert.throws(() => render({ pathEnv: "" }), /PATH is empty/u);
    for (const value of [`${FIXTURE_REPO}"quote`, `${FIXTURE_REPO}\\escape`, `${FIXTURE_REPO}'quote`]) {
      assert.throws(() => render({ repo: value }), /unit syntax/u);
    }
    assert.throws(() => render({ repo: path.join(FIXTURE_HOME, "${HOME}") }), /systemd would expand/u);
    assert.throws(() => substituteTemplate("ExecStart=@MISSING@", {}), /left @MISSING@ unrendered/u);
  });
});

describe("checkout guard for the installed unit", () => {
  test("accepts a checkout that implements supervised mode", (t) => {
    const repo = supervisorFixture(t);
    assert.deepEqual(findMissingSupervisorSupport({ repo }), []);
    assert.doesNotThrow(() => assertRepoSupportsSupervisor({ repo }));
  });

  test("refuses a checkout without supervisor support, naming what is missing", (t) => {
    const repo = supervisorFixture(t);
    fs.writeFileSync(path.join(repo, "src", "client.js"), "import fs from 'node:fs';\n");
    assert.throws(
      () => assertRepoSupportsSupervisor({ repo }),
      (error) => {
        assert.match(error.message, /refusing to install a unit pointing at/u);
        assert.match(error.message, new RegExp(escapeRegExp(repo), "u"));
        assert.match(error.message, /src\/client\.js lacks TASKFERRY_DAEMON_SUPERVISOR/u);
        assert.match(error.message, /previously installed unit was left untouched/u);
        return true;
      }
    );
  });

  test("the installer's dry run renders this checkout, not the primary checkout", (t) => {
    const xdgConfig = temporaryDir(t);
    const result = runInstaller(t, ["--dry-run"], { XDG_CONFIG_HOME: xdgConfig });
    assert.equal(result.status, 0, result.stderr);
    const topLevel = execFileSync(GIT_PATH, ["-C", REPO_ROOT, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    assert.match(result.stdout, new RegExp(`^repo: ${escapeRegExp(topLevel)}$`, "mu"));
    assert.match(result.stdout, new RegExp(`^ExecStart=.* ${escapeRegExp(topLevel)}/src/daemon\\.js$`, "mu"));
    assert.equal(fs.existsSync(path.join(xdgConfig, SYSTEMD_NAME, "user", UNIT_NAME)), false, "dry run must not write the unit");
  });

  test("the installer refuses --repo for an unsupported checkout", (t) => {
    const fixture = supervisorFixture(t);
    fs.rmSync(path.join(fixture, "src", "daemon.js"));
    const result = runInstaller(t, ["--dry-run", "--repo", fixture]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to install a unit pointing at/u);
    assert.match(result.stderr, /src\/daemon\.js is missing/u);
  });

  test("warns when a rendered unit would replace one pointing elsewhere", (t) => {
    assert.equal(extractExecStartRepo(`ExecStart=${NODE_BINARY} ${OTHER_REPO}/src/daemon.js`), OTHER_REPO);
    assert.equal(extractExecStartRepo(`ExecStart=${NODE_BINARY}`), null);
    const repo = supervisorFixture(t);
    const unitDir = temporaryDir(t);
    fs.writeFileSync(path.join(unitDir, UNIT_NAME), `ExecStart=${NODE_BINARY} ${OTHER_REPO}/src/daemon.js\n`);
    const result = runInstaller(t, ["--dry-run", "--repo", repo, "--unit-dir", unitDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`currently points at ${escapeRegExp(OTHER_REPO)}`, "u"));
    assert.match(result.stdout, new RegExp(`^repo: ${escapeRegExp(repo)}$`, "mu"));
  });
});

describe("log target selection and detached-daemon takeover guard", () => {
  test("auto prefers persistent journald and falls back to a file", () => {
    assert.equal(resolveLogTarget({ requested: "auto", journalPersistent: true }), "journal");
    assert.equal(resolveLogTarget({ requested: "auto", journalPersistent: false }), "file");
    assert.equal(resolveLogTarget({ requested: "file", journalPersistent: true }), "file");
    assert.throws(() => resolveLogTarget({ requested: "syslog", journalPersistent: true }), /unknown log target/u);
  });

  test("journald storage parsing follows the last assignment", () => {
    assert.equal(parseJournaldStorage("#Storage=persistent\n[Journal]\n"), undefined);
    assert.equal(parseJournaldStorage("[Journal]\nStorage=auto\n"), "auto");
    assert.equal(parseJournaldStorage("[Journal]\nStorage=auto\nStorage=volatile\n"), "volatile");
    assert.equal(isJournalPersistent({ storageValue: "persistent", journalDirExists: false }), true);
    assert.equal(isJournalPersistent({ storageValue: "volatile", journalDirExists: true }), false);
    assert.equal(isJournalPersistent({ storageValue: null, journalDirExists: true }), true);
    assert.equal(isJournalPersistent({ storageValue: "auto", journalDirExists: false }), false);
  });

  test("a stale marker cannot hide a detached daemon", () => {
    const stateDir = path.join(path.sep, "state");
    assert.equal(findDetachedDaemon({ stateDir, supervisedPid: 42, readLivePidFn: () => 42 }), undefined);
    assert.equal(findDetachedDaemon({ stateDir, supervisedPid: 17, readLivePidFn: () => 42 }), 42);
    assert.equal(findDetachedDaemon({ stateDir, supervisedPid: 0, readLivePidFn: () => 42 }), 42);
    assert.equal(findDetachedDaemon({ stateDir, supervisedPid: 0, readLivePidFn: () => undefined }), undefined);
  });


  test("the unit directory honors XDG_CONFIG_HOME", () => {
    const xdgConfig = path.join(path.sep, "xdg", "config");
    assert.equal(resolveUnitDir({ env: { XDG_CONFIG_HOME: xdgConfig }, home: FIXTURE_HOME }), path.join(xdgConfig, SYSTEMD_NAME, "user"));
    assert.equal(resolveUnitDir({ env: {}, home: FIXTURE_HOME }), path.join(FIXTURE_HOME, ".config", SYSTEMD_NAME, "user"));
  });
});

