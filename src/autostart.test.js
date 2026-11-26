import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectClient } from "./client.js";
import { parseArgs, helpText } from "./args.js";
import { runCli } from "./cli.js";

const bootInvoked = "boot invoked";
const ON = "--auto-start";
const OFF = "--no-auto-start";

function configRoot(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-autostart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, "taskferry");
  fs.mkdirSync(configDir);
  const configPath = path.join(configDir, "config.json");
  if (config !== undefined) fs.writeFileSync(configPath, JSON.stringify(config));
  return { root, configPath };
}

function connectOptions(root, env = {}) {
  return {
    env: { XDG_CONFIG_HOME: root, ...env },
    socketPath: path.join(root, "missing.sock"),
    maxBufferBytes: 1024,
    ensureDaemonFn: () => { throw new Error(bootInvoked); },
  };
}

test("autostart obeys option, environment, config and default precedence", async (t) => {
  const { root, configPath } = configRoot(t, { autoStart: false });
  const base = connectOptions(root);
  // Config false: the client fails fast instead of booting.
  await assert.rejects(connectClient(base), { code: "ENOENT" });
  // Env beats config in both directions.
  await assert.rejects(connectClient(connectOptions(root, { TASKFERRY_AUTO_START: "1" })), new RegExp(bootInvoked));
  // An explicit option beats env in both directions.
  await assert.rejects(connectClient({ ...connectOptions(root, { TASKFERRY_AUTO_START: "0" }), autoStart: true }), new RegExp(bootInvoked));
  await assert.rejects(connectClient({ ...connectOptions(root, { TASKFERRY_AUTO_START: "1" }), autoStart: false }), { code: "ENOENT" });
  // A value other than "0" enables, as it did before the config key existed.
  await assert.rejects(connectClient(connectOptions(root, { TASKFERRY_AUTO_START: "" })), new RegExp(bootInvoked));
  // No config at all: the default is on.
  fs.unlinkSync(configPath);
  await assert.rejects(connectClient(base), new RegExp(bootInvoked));
});

test("config autoStart: true boots even when no env or option is set", async (t) => {
  const { root } = configRoot(t, { autoStart: true });
  await assert.rejects(connectClient(connectOptions(root)), new RegExp(bootInvoked));
});

test("a non-boolean autoStart config value is rejected at connect", async (t) => {
  const { root } = configRoot(t, { autoStart: "false" });
  await assert.rejects(connectClient(connectOptions(root)), /autoStart/);
});

test("daemon commands accept --auto-start and --no-auto-start, and leave the option unset without them", () => {
  assert.equal(parseArgs(["list"]).options.autoStart, undefined);
  assert.equal(parseArgs(["list", ON]).options.autoStart, true);
  assert.equal(parseArgs(["list", OFF]).options.autoStart, false);
  assert.equal(parseArgs(["status", "oc_1", OFF]).options.autoStart, false);
  assert.throws(() => parseArgs(["list", ON, OFF]), /duplicate/i);
  assert.throws(() => parseArgs(["list", "--auto-start=1"]), /does not take a value/);
});

test("setup and init never connect, so they reject the auto-start flags", () => {
  for (const command of ["setup", "init"]) {
    assert.throws(() => parseArgs([command, ON]), /unknown flag --auto-start/);
    assert.throws(() => parseArgs([command, OFF]), /unknown flag --no-auto-start/);
    assert.equal(Object.hasOwn(helpText(command).options, ON), false);
  }
});

test("help and usage errors list the auto-start flags for daemon commands", () => {
  assert.ok(Object.hasOwn(helpText("list").options, ON));
  assert.ok(Object.hasOwn(helpText("list").options, OFF));
  assert.throws(() => parseArgs(["list", "--bogus"]), (error) => /--auto-start, --no-auto-start/.test(error.help ?? error.message));
});

test("the CLI hands the override to connectClient, leaving it undefined without a flag", async () => {
  const stopClient = { request: async () => { throw new Error("error: stop here\nhelp: test"); }, close() {} };
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  for (const [extra, expected] of [[[], undefined], [[ON], true], [[OFF], false]]) {
    const seen = [];
    await runCli(["status", "oc_1", ...extra], { io, connectClient: async (opts) => { seen.push(opts); return stopClient; } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].autoStart, expected);
  }
});

test("daemon code never reads autoStart, so a daemon's restart onto new source ignores it", () => {
  const read = (name) => fs.readFileSync(new URL(name, import.meta.url), "utf8");
  const mentionsAutoStart = (source) => /autoStart|AUTO_START/.test(source);
  // Control: the scan must see the setting where it is read, or the absence below proves nothing.
  assert.ok(mentionsAutoStart(read("./client.js")));
  for (const file of ["./daemon.js", "./daemon-server.js"]) {
    assert.equal(mentionsAutoStart(read(file)), false, `${file} must not read autoStart (docs/things-that-look-like-bugs.md)`);
  }
});
