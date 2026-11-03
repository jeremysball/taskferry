import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DAEMON_LOG_FILE,
  UNIT_NAME,
  assertRepoSupportsSupervisor,
  assertUnitValue,
  escapeUnitSpecifiers,
  extractExecStartRepo,
  findDetachedDaemon,
  findMissingSupervisorSupport,
  isJournalPersistent,
  parseJournaldStorage,
  renderRotateService,
  renderSystemdUnit,
  resolveLogTarget,
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
  return repo;
}

function render(options = {}) {
  return renderSystemdUnit({
    repo: FIXTURE_REPO,
    nodePath: FIXTURE_NODE,
    pathEnv: FIXTURE_PATH,
    template: templateText(),
    ...options,
  });
}

function runInstaller(args, env = {}) {
  return spawnSync(process.execPath, [INSTALLER, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

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
    const result = runInstaller(["--dry-run"], { XDG_CONFIG_HOME: xdgConfig });
    assert.equal(result.status, 0, result.stderr);
    const topLevel = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    assert.match(result.stdout, new RegExp(`^repo: ${escapeRegExp(topLevel)}$`, "mu"));
    assert.match(result.stdout, new RegExp(`^ExecStart=.* ${escapeRegExp(topLevel)}/src/daemon\\.js$`, "mu"));
    assert.equal(fs.existsSync(path.join(xdgConfig, "systemd", "user", UNIT_NAME)), false, "dry run must not write the unit");
  });

  test("the installer refuses --repo for an unsupported checkout", (t) => {
    const fixture = supervisorFixture(t);
    fs.rmSync(path.join(fixture, "src", "daemon.js"));
    const result = runInstaller(["--dry-run", "--repo", fixture]);
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
    const result = runInstaller(["--dry-run", "--repo", repo, "--unit-dir", unitDir]);
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
