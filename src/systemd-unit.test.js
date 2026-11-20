import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveConfigPath } from "./config.js";
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
  renderRotateService,
  renderPathUnit,
  renderSystemdUnit,
  resolveLogTarget,
  resolveDaemonConfigPath,
  resolveEnvFileGate,
  resolveUnitDir,
  substituteTemplate,
} from "./systemd-unit.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UNIT_TEMPLATE = path.join(REPO_ROOT, "deploy", "systemd", "taskferry-daemon.service.in");
const ROTATE_TEMPLATE = path.join(REPO_ROOT, "deploy", "systemd", "taskferry-daemon-logrotate.service.in");
const INSTALLER = path.join(REPO_ROOT, "scripts", "install-systemd-unit.js");
const ROTATE_SCRIPT = path.join(REPO_ROOT, "scripts", "rotate-daemon-logs.sh");

// Synthetic paths for render fixtures, built at runtime so no developer path
// is baked into the test.
const FIXTURE_HOME = path.join(os.tmpdir(), "taskferry-fixture-home");
const FIXTURE_REPO = path.join(FIXTURE_HOME, "taskferry");
const FIXTURE_NODE = path.join(FIXTURE_HOME, ".local", "share", "mise", "installs", "node", "26.5.1", "bin", "node");
const FIXTURE_PATH = [path.join(FIXTURE_HOME, ".local", "bin"), path.join(path.sep, "usr", "bin")].join(path.delimiter);
const OTHER_REPO = path.join(path.sep, "workspace", "taskferry");
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
  fs.mkdirSync(path.join(repo, "deploy", "systemd"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "client.js"), "TASKFERRY_DAEMON_SUPERVISOR startDaemonViaSystemd\n");
  fs.writeFileSync(path.join(repo, "src", "daemon.js"), "SUPERVISED_RESTART_EXIT_CODE TASKFERRY_DAEMON_SUPERVISOR\n");
  fs.writeFileSync(path.join(repo, "deploy", "systemd", "taskferry-daemon.service.in"), templateText());
  fs.copyFileSync(path.join(REPO_ROOT, PATH_TEMPLATE), path.join(repo, PATH_TEMPLATE));
  return repo;
}

function render(options = {}) {
  return renderSystemdUnit({
    repo: FIXTURE_REPO,
    nodePath: FIXTURE_NODE,
    pathEnv: FIXTURE_PATH,
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
  return spawnSync(process.execPath, [INSTALLER, ...args], { encoding: "utf8", env: { ...cleanEnv, HOME: temporaryDir(t), PATH: `${shim}${path.delimiter}${process.env.PATH}`, ...env } });
}

function isolatedInstaller(t, { gated = false, stalePath = false, extraEnv = {}, managerEnv = "", args = [], repo = supervisorFixture(t) } = {}) {
  const home = temporaryDir(t);
  const unitDir = temporaryDir(t);
  const shim = temporaryDir(t);
  const calls = path.join(shim, "calls");
  const envFile = path.join(home, "secrets", "env");
  if (stalePath) fs.writeFileSync(path.join(unitDir, PATH_UNIT_NAME), "old path unit\n");
  if (gated) {
    const config = path.join(home, ".config", "taskferry");
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, "config.json"), JSON.stringify({ envFile }));
  }
  fs.writeFileSync(path.join(shim, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\ncase "$*" in *show-environment*) printf 'HOME=%s\\n' "$HOME"; printf '%s' "$MANAGER_ENV"; exit 0;; *is-active*) echo inactive; exit 3;; esac\nexit 0\n`, { mode: 0o755 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TASKFERRY_|XDG_|GIT_)/u.test(key)));
  Object.assign(env, { HOME: home, XDG_RUNTIME_DIR: temporaryDir(t), PATH: `${shim}${path.delimiter}${process.env.PATH}`, CALLS: calls, MANAGER_ENV: managerEnv }, extraEnv);
  const result = spawnSync(process.execPath, [INSTALLER, "--repo", repo, "--unit-dir", unitDir, "--log-target", "journal", ...args], { encoding: "utf8", env });
  return { result, envFile, unitDir, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [] };
}

describe("env-file gated start", () => {
  test("daemon config path matches the default config resolver", () => {
    assert.equal(resolveDaemonConfigPath(), resolveConfigPath({}));
  });

  test("resolves the gate and rejects invalid configuration", (t) => {
    const homeDir = temporaryDir(t);
    const dir = path.join(homeDir, ".config", "taskferry");
    const config = path.join(dir, "config.json");
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
    const service = path.join(repo, "deploy", "systemd", "taskferry-daemon.service.in");
    fs.writeFileSync(service, templateText().replace("@INSTALL_SECTION@", ""));
    assert.deepEqual(findMissingSupervisorSupport({ repo }), []);
    assert.throws(() => assertRepoSupportsSupervisor({ repo, gated: true }), /lacks @INSTALL_SECTION@/u);
  });

  test("installer enables the path in order and tolerates an inactive service", (t) => {
    const gated = isolatedInstaller(t, { gated: true, args: ["--enable"] });
    assert.equal(gated.result.status, 0, gated.result.stderr);
    assert.deepEqual(gated.calls, ["--user show-environment", "--user daemon-reload", "--user disable taskferry-daemon.service", "--user reset-failed taskferry-daemon.service taskferry-daemon.path", "--user enable --now taskferry-daemon.path", "--user --no-pager status taskferry-daemon.path", "--user is-active taskferry-daemon.service"]);
    assert.match(gated.result.stdout, /taskferry-daemon.service: inactive/u);
    assert.match(fs.readFileSync(path.join(gated.unitDir, PATH_UNIT_NAME), "utf8"), /PathExists=/u);
    assert.doesNotMatch(fs.readFileSync(path.join(gated.unitDir, UNIT_NAME), "utf8"), /^\[Install\]$/mu);
    const plain = isolatedInstaller(t, { args: ["--enable"] });
    assert.equal(plain.result.status, 0, plain.result.stderr);
    assert.ok(plain.calls.includes("--user enable --now taskferry-daemon.service"));
    assert.ok(plain.calls.every((call) => !call.includes(PATH_UNIT_NAME)));
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
    const configDir = path.join(configHome, "taskferry");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ envFile: path.join(configHome, "other") }));
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
    const probe = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
    if (probe.error?.code === "ENOENT") {
      t.skip("systemd-analyze is not installed");
      return;
    }
    const dir = temporaryDir(t);
    const service = path.join(dir, UNIT_NAME);
    const unitPath = path.join(dir, PATH_UNIT_NAME);
    fs.writeFileSync(service, render({ repo: REPO_ROOT, nodePath: process.execPath, pathEnv: process.env.PATH, gated: true }));
    fs.writeFileSync(unitPath, renderPathUnit({ repo: REPO_ROOT, envFile: path.join(dir, "env"), template: fs.readFileSync(path.join(REPO_ROOT, PATH_TEMPLATE), "utf8") }));
    const result = spawnSync("systemd-analyze", ["--user", "verify", service, unitPath], { encoding: "utf8" });
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
    assert.match(unit, /^ExecStartPre=.*touch %t\/taskferry\/systemd-supervised$/mu);
    assert.match(unit, /^StandardOutput=journal$/mu);
    assert.match(unit, /^StandardError=journal$/mu);
    assert.doesNotMatch(unit, /client\.js/u, "the unit must exec the daemon, not the client that could spawn a second one");
  });

  test("file logging appends to a durable path and installs the rotation pieces", () => {
    const unit = render({ logTarget: "file" });
    assert.match(unit, new RegExp(`^StandardOutput=append:${escapeRegExp(DAEMON_LOG_FILE)}$`, "mu"));
    assert.match(unit, /^StandardError=inherit$/mu);
    assert.match(unit, /^ExecStartPre=\/usr\/bin\/mkdir -p %h\/\.local\/state\/taskferry\/logs$/mu);
    assert.doesNotMatch(unit, /^StandardOutput=journal$/mu);

    const service = renderRotateService({ repo: FIXTURE_REPO, template: fs.readFileSync(ROTATE_TEMPLATE, "utf8") });
    assert.match(service, new RegExp(`^ExecStart=${escapeRegExp(FIXTURE_REPO)}/scripts/rotate-daemon-logs\\.sh$`, "mu"));
    assert.match(service, /^Environment=TASKFERRY_LOG_MAX_BYTES=10485760$/mu);
    assert.match(service, /^Environment=TASKFERRY_LOG_KEEP=5$/mu);
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
    const topLevel = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    assert.match(result.stdout, new RegExp(`^repo: ${escapeRegExp(topLevel)}$`, "mu"));
    assert.match(result.stdout, new RegExp(`^ExecStart=.* ${escapeRegExp(topLevel)}/src/daemon\\.js$`, "mu"));
    assert.equal(fs.existsSync(path.join(xdgConfig, "systemd", "user", UNIT_NAME)), false, "dry run must not write the unit");
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
  test("auto prefers persistent journald and falls back to a bounded file", () => {
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

  test("a live pid without the supervisor marker blocks the takeover", () => {
    const stateDir = path.join(path.sep, "state");
    const runtimeDir = path.join(path.sep, "run");
    assert.equal(findDetachedDaemon({ stateDir, runtimeDir, existsFn: () => true, readLivePidFn: () => 42 }), undefined);
    assert.equal(findDetachedDaemon({ stateDir, runtimeDir, existsFn: () => false, readLivePidFn: () => 42 }), 42);
    assert.equal(findDetachedDaemon({ stateDir, runtimeDir, existsFn: () => false, readLivePidFn: () => undefined }), undefined);
  });

  test("the unit directory honors XDG_CONFIG_HOME", () => {
    const xdgConfig = path.join(path.sep, "xdg", "config");
    assert.equal(resolveUnitDir({ env: { XDG_CONFIG_HOME: xdgConfig }, home: FIXTURE_HOME }), path.join(xdgConfig, "systemd", "user"));
    assert.equal(resolveUnitDir({ env: {}, home: FIXTURE_HOME }), path.join(FIXTURE_HOME, ".config", "systemd", "user"));
  });
});

describe("bounded log rotation", () => {
  test("copy-truncates the live log and keeps only the requested generations", (t) => {
    const dir = temporaryDir(t);
    const log = path.join(dir, "daemon.log");
    fs.writeFileSync(log, "x".repeat(2048));
    const rotate = () => spawnSync("bash", [ROTATE_SCRIPT, "--log-dir", dir, "--max-bytes", "512", "--keep", "2"], { encoding: "utf8" });

    const first = rotate();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(fs.readFileSync(log, "utf8"), "");
    assert.equal(fs.readFileSync(`${log}.1`, "utf8").length, 2048);

    fs.appendFileSync(log, "y".repeat(600));
    assert.equal(rotate().status, 0);
    fs.appendFileSync(log, "z".repeat(600));
    assert.equal(rotate().status, 0);
    assert.equal(fs.existsSync(`${log}.2`), true);
    assert.equal(fs.existsSync(`${log}.3`), false, "retention must be bounded");
    assert.equal(fs.readFileSync(log, "utf8"), "");
  });

  test("leaves a log below the threshold alone", (t) => {
    const dir = temporaryDir(t);
    const log = path.join(dir, "daemon.log");
    fs.writeFileSync(log, "small");
    const result = spawnSync("bash", [ROTATE_SCRIPT, "--log-dir", dir, "--max-bytes", "1024"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(log, "utf8"), "small");
  });
});
