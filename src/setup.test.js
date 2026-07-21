import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSetup } from "./setup.js";
import {
  checkClaudeCodePlaywrightIsolation,
  checkOpencodePlaywrightIsolation,
  ensureClaudeCodePlaywrightIsolation,
  ensureOpencodePlaywrightIsolation,
  stripJsonComments,
} from "./mcp-isolation.js";

function makeFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-setup-home-"));
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-setup-checkout-"));
  const src = path.join(checkout, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "taskferry" }));
  fs.writeFileSync(path.join(src, "cli.js"), "export {};\n");
  fs.writeFileSync(path.join(src, "opencode-plugin.js"), "export {};\n");
  fs.writeFileSync(path.join(src, "tf-sl.sh"), "#!/usr/bin/env bash\n");
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(checkout, { recursive: true, force: true });
  });
  return {
    checkoutDirectory: checkout,
    cliPath: path.join(src, "cli.js"),
    opencodeSourcePath: path.join(src, "opencode-plugin.js"),
    tfSlSourcePath: path.join(src, "tf-sl.sh"),
    homeDirectory: home,
  };
}

function unavailableClients() {
  return { status: null, stdout: "", stderr: "", error: { code: "ENOENT" } };
}

function makeRecordingClients(behavior) {
  return (command, args) => {
    behavior.calls.push({ command, args });
    return behavior.next(command, args);
  };
}

function configuredClients(command, args) {
  if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
    return { status: 0, stdout: "abc123\n", stderr: "", error: null };
  }
  if (command === "claude") {
    if (args[0] === "plugin" && args[1] === "marketplace") {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
    if (args[0] === "plugin" && args[1] === "list") {
      return { status: 0, stdout: "[]", stderr: "", error: null };
    }
    if (args[0] === "plugin" && (args[1] === "install" || args[1] === "update")) {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
  }
  if (command === "codex") {
    if (args[0] === "plugin" && args[1] === "marketplace") {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
  }
  throw new Error(`unexpected client command: ${command} ${args.join(" ")}`);
}

function matchingHashAlreadyInstalledClients(command, args) {
  if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
    return { status: 0, stdout: "abc123\n", stderr: "", error: null };
  }
  if (command === "claude") {
    if (args[0] === "plugin" && args[1] === "marketplace") {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
    if (args[0] === "plugin" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([{ id: "taskferry@taskferry" }]), stderr: "", error: null };
    }
  }
  if (command === "codex") {
    if (args[0] === "plugin" && args[1] === "marketplace") {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
  }
  throw new Error(`unexpected client command: ${command} ${args.join(" ")}`);
}

function differentHashAlreadyInstalledClients(command, args) {
  if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
    return { status: 0, stdout: "def456\n", stderr: "", error: null };
  }
  if (command === "claude") {
    if (args[0] === "plugin" && args[1] === "marketplace") {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
    if (args[0] === "plugin" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([{ id: "taskferry@taskferry" }]), stderr: "", error: null };
    }
    if (args[0] === "plugin" && args[1] === "uninstall") {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
    if (args[0] === "plugin" && args[1] === "install") {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
  }
  if (command === "codex") {
    if (args[0] === "plugin" && args[1] === "marketplace") {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
  }
  throw new Error(`unexpected client command: ${command} ${args.join(" ")}`);
}

function gitFailsAlreadyInstalledClients(command, args) {
  if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
    return { status: 128, stdout: "", stderr: "fatal: not a git repository", error: null };
  }
  if (command === "claude") {
    if (args[0] === "plugin" && args[1] === "marketplace") {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
    if (args[0] === "plugin" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([{ id: "taskferry@taskferry" }]), stderr: "", error: null };
    }
    if (args[0] === "plugin" && args[1] === "update") {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
  }
  if (command === "codex") {
    if (args[0] === "plugin" && args[1] === "marketplace") {
      return { status: 0, stdout: "", stderr: "", error: null };
    }
  }
  throw new Error(`unexpected client command: ${command} ${args.join(" ")}`);
}

test("installs dependencies, the CLI, the OpenCode plugin, and the statusline script", (t) => {
  const fixture = makeFixture(t);
  const npmCalls = [];
  const commandCalls = [];
  const tracking = { calls: commandCalls, next: unavailableClients };
  const result = runSetup({
    ...fixture,
    env: { PATH: path.join(fixture.homeDirectory, ".local", "bin") },
    runNpmInstall: (directory) => { npmCalls.push(directory); },
    runCommand: makeRecordingClients(tracking),
  });

  assert.deepEqual(npmCalls, [fixture.checkoutDirectory]);
  assert.equal(fs.realpathSync(result.cli.path), fixture.cliPath);
  assert.equal(fs.realpathSync(result.opencode.path), fixture.opencodeSourcePath);
  assert.equal(fs.realpathSync(result.statusline.path), fixture.tfSlSourcePath);
  assert.equal(result.path, "available");
  assert.deepEqual(result.integrations, {
    claude: { status: "unavailable" },
    codex: { status: "unavailable" },
  });
});

test("reports the PATH command when ~/.local/bin is absent", (t) => {
  const fixture = makeFixture(t);
  const result = runSetup({ ...fixture, env: { PATH: "/usr/bin" }, runCommand: unavailableClients });
  assert.equal(result.path, "missing");
  assert.equal(result.pathInstruction, 'export PATH="$HOME/.local/bin:$PATH"');
});

test("refuses to replace an unrelated executable", (t) => {
  const fixture = makeFixture(t);
  const destination = path.join(fixture.homeDirectory, ".local", "bin", "taskferry");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, "unrelated");
  assert.throws(() => runSetup({ ...fixture, runCommand: unavailableClients }), /refusing to replace/);
});

test("installs Claude and reports the Codex desktop step", (t) => {
  const fixture = makeFixture(t);
  const commandCalls = [];
  const result = runSetup({
    ...fixture,
    runCommand: makeRecordingClients({ calls: commandCalls, next: configuredClients }),
  });
  assert.equal(result.integrations.claude.status, "installed");
  assert.equal(result.integrations.codex.status, "desktop-install-required");
  assert.match(result.integrations.codex.next, /Codex desktop/);
});

test("rejects Windows before npm, links, or client commands", (t) => {
  const fixture = makeFixture(t);
  const npmCalls = [];
  const commandCalls = [];
  assert.throws(
    () => runSetup({
      ...fixture,
      platform: "win32",
      runNpmInstall: (directory) => { npmCalls.push(directory); },
      runCommand: makeRecordingClients({ calls: commandCalls, next: unavailableClients }),
    }),
    /Unix domain sockets/,
  );
  assert.equal(npmCalls.length, 0);
  assert.equal(commandCalls.length, 0);
});

test("rerun replaces the existing managed symlinks without throwing", (t) => {
  const fixture = makeFixture(t);
  const env = { PATH: path.join(fixture.homeDirectory, ".local", "bin") };
  const first = runSetup({ ...fixture, env, runCommand: unavailableClients });
  const second = runSetup({ ...fixture, env, runCommand: unavailableClients });

  assert.equal(fs.realpathSync(second.cli.path), fixture.cliPath);
  assert.equal(fs.realpathSync(second.opencode.path), fixture.opencodeSourcePath);
  assert.equal(fs.realpathSync(second.statusline.path), fixture.tfSlSourcePath);
  assert.equal(second.cli.path, first.cli.path);
  assert.equal(second.opencode.path, first.opencode.path);
  assert.equal(second.statusline.path, first.statusline.path);
});

test("first install writes the hash state file", (t) => {
  const fixture = makeFixture(t);
  const commandCalls = [];
  const result = runSetup({
    ...fixture,
    env: {},
    runCommand: makeRecordingClients({ calls: commandCalls, next: configuredClients }),
  });
  assert.equal(result.integrations.claude.status, "installed");

  const hashFile = path.join(fixture.homeDirectory, ".local", "state", "taskferry", "claude-plugin-hash");
  assert.equal(fs.readFileSync(hashFile, "utf8").trim(), "abc123");
});

test("skips re-install when stored hash matches current HEAD", (t) => {
  const fixture = makeFixture(t);

  const hashFile = path.join(fixture.homeDirectory, ".local", "state", "taskferry", "claude-plugin-hash");
  fs.mkdirSync(path.dirname(hashFile), { recursive: true });
  fs.writeFileSync(hashFile, "abc123\n");

  const commandCalls = [];
  const result = runSetup({
    ...fixture,
    env: {},
    runCommand: makeRecordingClients({ calls: commandCalls, next: matchingHashAlreadyInstalledClients }),
  });
  assert.equal(result.integrations.claude.status, "installed");

  const hasUninstallOrInstall = commandCalls.some(
    (c) => c.command === "claude" && ["uninstall", "install", "update"].includes(c.args[1]),
  );
  assert.equal(hasUninstallOrInstall, false, "unexpected uninstall/install/update call");
});

test("re-installs when stored hash differs or is absent", (t) => {
  const fixture = makeFixture(t);

  const commandCalls = [];
  const result = runSetup({
    ...fixture,
    env: {},
    runCommand: makeRecordingClients({ calls: commandCalls, next: differentHashAlreadyInstalledClients }),
  });
  assert.equal(result.integrations.claude.status, "installed");

  const uninstallIdx = commandCalls.findIndex(
    (c) => c.command === "claude" && c.args[0] === "plugin" && c.args[1] === "uninstall",
  );
  const installIdx = commandCalls.findIndex(
    (c) => c.command === "claude" && c.args[0] === "plugin" && c.args[1] === "install",
  );
  assert.notEqual(uninstallIdx, -1, "uninstall was not called");
  assert.notEqual(installIdx, -1, "install was not called");
  assert.ok(uninstallIdx < installIdx, "uninstall must precede install");

  const hashFile = path.join(fixture.homeDirectory, ".local", "state", "taskferry", "claude-plugin-hash");
  assert.equal(fs.readFileSync(hashFile, "utf8").trim(), "def456");
});

test("falls back to claude plugin update when git rev-parse HEAD fails", (t) => {
  const fixture = makeFixture(t);

  const commandCalls = [];
  const result = runSetup({
    ...fixture,
    env: {},
    runCommand: makeRecordingClients({ calls: commandCalls, next: gitFailsAlreadyInstalledClients }),
  });
  assert.equal(result.integrations.claude.status, "installed");

  const updateCall = commandCalls.find(
    (c) => c.command === "claude" && c.args[0] === "plugin" && c.args[1] === "update",
  );
  assert.notEqual(updateCall, undefined, "claude plugin update was not called");

  const hashFile = path.join(fixture.homeDirectory, ".local", "state", "taskferry", "claude-plugin-hash");
  assert.ok(!fs.existsSync(hashFile), "hash file should not exist after git failure");
});

test("stripJsonComments strips // and /* */ comments but leaves // inside string values untouched", () => {
  const input = `{
  "url": "https://example.com/api/v1//endpoint",
  "comment": "/* this is not a comment */",
  "real": 42 // real comment
  /* block comment */
}`;
  const result = stripJsonComments(input);
  const parsed = JSON.parse(result);
  assert.equal(parsed.url, "https://example.com/api/v1//endpoint");
  assert.equal(parsed.comment, "/* this is not a comment */");
  assert.equal(parsed.real, 42);
});

test("stripJsonComments strips a block comment", () => {
  const result = stripJsonComments('{ "a": 1 /* remove me */ }');
  assert.equal(JSON.parse(result).a, 1);
});

test("checkOpencodePlaywrightIsolation returns isolated true when --isolated is present", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
    mcp: { playwright: { command: ["npx", "@anthropic/mcp-server-playwright", "--isolated"] } },
  }));
  const result = checkOpencodePlaywrightIsolation(home, {});
  assert.equal(result.checked, true);
  assert.equal(result.isolated, true);
});

test("checkOpencodePlaywrightIsolation returns isolated false when --isolated is missing", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
    mcp: { playwright: { command: ["npx", "@anthropic/mcp-server-playwright"] } },
  }));
  const result = checkOpencodePlaywrightIsolation(home, {});
  assert.equal(result.checked, true);
  assert.equal(result.isolated, false);
});

test("checkOpencodePlaywrightIsolation returns checked false when no config files exist", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = checkOpencodePlaywrightIsolation(home, {});
  assert.equal(result.checked, false);
  assert.match(result.reason, /no opencode config/);
});

test("checkOpencodePlaywrightIsolation prefers .jsonc over .json when both exist and first has the key", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.jsonc"), JSON.stringify({
    mcp: { playwright: { command: ["npx", "@anthropic/mcp-server-playwright", "--isolated"] } },
  }));
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
    mcp: { playwright: { command: ["npx", "@anthropic/mcp-server-playwright"] } },
  }));
  const result = checkOpencodePlaywrightIsolation(home, {});
  assert.equal(result.path, path.join(configDir, "opencode.jsonc"));
  assert.equal(result.isolated, true);
});

test("checkOpencodePlaywrightIsolation falls through to .json when .jsonc has the key but reports isolated false", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.jsonc"), JSON.stringify({
    mcp: { playwright: { command: ["npx", "@anthropic/mcp-server-playwright"] } },
  }));
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
    mcp: { playwright: { command: ["npx", "@anthropic/mcp-server-playwright", "--isolated"] } },
  }));
  const result = checkOpencodePlaywrightIsolation(home, {});
  assert.equal(result.path, path.join(configDir, "opencode.jsonc"));
  assert.equal(result.isolated, false);
});

test("checkOpencodePlaywrightIsolation returns checked false on malformed JSON without throwing", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.json"), "not valid json {{{");
  const result = checkOpencodePlaywrightIsolation(home, {});
  assert.equal(result.checked, false);
  assert.match(result.reason, /failed to parse/);
});

test("checkOpencodePlaywrightIsolation uses XDG_CONFIG_HOME when set", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  const xdgConfig = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-xdg-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(xdgConfig, { recursive: true, force: true });
  });
  const configDir = path.join(xdgConfig, "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
    mcp: { playwright: { command: ["npx", "@anthropic/mcp-server-playwright", "--isolated"] } },
  }));
  const result = checkOpencodePlaywrightIsolation(home, { XDG_CONFIG_HOME: xdgConfig });
  assert.equal(result.isolated, true);
});

test("ensureOpencodePlaywrightIsolation adds --isolated when missing from opencode.json", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
    mcp: { playwright: { command: ["npx", "@anthropic/mcp-server-playwright"] } },
  }));
  const result = ensureOpencodePlaywrightIsolation(home, {});
  assert.equal(result.changed, true);
  const written = JSON.parse(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8"));
  assert.ok(written.mcp.playwright.command.includes("--isolated"));
});

test("ensureOpencodePlaywrightIsolation is no-op when --isolated is already present", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
    mcp: { playwright: { command: ["npx", "@anthropic/mcp-server-playwright", "--isolated"] } },
  }));
  const before = fs.readFileSync(path.join(configDir, "opencode.json"), "utf8");
  const result = ensureOpencodePlaywrightIsolation(home, {});
  assert.equal(result.changed, false);
  const after = fs.readFileSync(path.join(configDir, "opencode.json"), "utf8");
  assert.equal(after, before);
});

test("ensureOpencodePlaywrightIsolation ignores .jsonc entirely — never touches it", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.jsonc"), JSON.stringify({
    mcp: { playwright: { command: ["npx", "@anthropic/mcp-server-playwright"] } },
  }));
  const before = fs.readFileSync(path.join(configDir, "opencode.jsonc"), "utf8");
  const result = ensureOpencodePlaywrightIsolation(home, {});
  assert.equal(result.changed, false);
  assert.match(result.reason, /no writable opencode\.json/);
  const after = fs.readFileSync(path.join(configDir, "opencode.jsonc"), "utf8");
  assert.equal(after, before);
});

test("ensureOpencodePlaywrightIsolation is no-op on malformed opencode.json", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.json"), "not valid json {{{");
  const before = fs.readFileSync(path.join(configDir, "opencode.json"), "utf8");
  const result = ensureOpencodePlaywrightIsolation(home, {});
  assert.equal(result.changed, false);
  assert.match(result.reason, /failed to parse/);
  const after = fs.readFileSync(path.join(configDir, "opencode.json"), "utf8");
  assert.equal(after, before);
});

test("checkClaudeCodePlaywrightIsolation returns isolated true via referenced config", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, "playwright-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ browser: { isolated: true } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { playwright: { args: ["npx", "@anthropic/mcp-server-playwright", "--config", configPath] } },
  }));
  const result = checkClaudeCodePlaywrightIsolation(home);
  assert.equal(result.checked, true);
  assert.equal(result.isolated, true);
  assert.equal(result.path, configPath);
});

test("checkClaudeCodePlaywrightIsolation returns isolated false when --config is missing", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { playwright: { args: ["npx", "@anthropic/mcp-server-playwright"] } },
  }));
  const result = checkClaudeCodePlaywrightIsolation(home);
  assert.equal(result.checked, true);
  assert.equal(result.isolated, false);
  assert.match(result.reason, /no --config/);
});

test("checkClaudeCodePlaywrightIsolation returns isolated false when referenced config file is missing", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, "nonexistent.json");
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { playwright: { args: ["npx", "@anthropic/mcp-server-playwright", "--config", configPath] } },
  }));
  const result = checkClaudeCodePlaywrightIsolation(home);
  assert.equal(result.checked, true);
  assert.equal(result.isolated, false);
  assert.equal(result.path, configPath);
  assert.match(result.reason, /does not exist/);
});

test("checkClaudeCodePlaywrightIsolation returns checked false when .claude.json does not exist", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = checkClaudeCodePlaywrightIsolation(home);
  assert.equal(result.checked, false);
  assert.match(result.reason, /~\/\.claude\.json not found/);
});

test("checkClaudeCodePlaywrightIsolation returns checked false when no playwright entry", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
  const result = checkClaudeCodePlaywrightIsolation(home);
  assert.equal(result.checked, false);
  assert.match(result.reason, /no playwright/);
});

test("ensureClaudeCodePlaywrightIsolation patches browser.isolated: true into config", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, "playwright-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ browser: { headless: true } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { playwright: { args: ["npx", "@anthropic/mcp-server-playwright", "--config", configPath] } },
  }));
  const result = ensureClaudeCodePlaywrightIsolation(home);
  assert.equal(result.changed, true);
  assert.equal(result.path, configPath);
  const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(written.browser.isolated, true);
  assert.equal(written.browser.headless, true);
});

test("ensureClaudeCodePlaywrightIsolation is no-op when already isolated", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, "playwright-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ browser: { isolated: true, headless: true } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { playwright: { args: ["npx", "@anthropic/mcp-server-playwright", "--config", configPath] } },
  }));
  const before = fs.readFileSync(configPath, "utf8");
  const result = ensureClaudeCodePlaywrightIsolation(home);
  assert.equal(result.changed, false);
  const after = fs.readFileSync(configPath, "utf8");
  assert.equal(after, before);
});

test("ensureClaudeCodePlaywrightIsolation does not create or touch ~/.claude.json when no --config reference", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-mcp-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { playwright: { args: ["npx", "@anthropic/mcp-server-playwright"] } },
  }));
  const before = fs.readFileSync(path.join(home, ".claude.json"), "utf8");
  const result = ensureClaudeCodePlaywrightIsolation(home);
  assert.equal(result.changed, false);
  assert.match(result.reason, /no --config/);
  const after = fs.readFileSync(path.join(home, ".claude.json"), "utf8");
  assert.equal(after, before);
});

test("runSetup repairs a non-isolated opencode.json", (t) => {
  const fixture = makeFixture(t);
  const configDir = path.join(fixture.homeDirectory, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
    mcp: { playwright: { command: ["npx", "@anthropic/mcp-server-playwright"] } },
  }));
  const result = runSetup({ ...fixture, runCommand: unavailableClients });
  assert.deepEqual(result.mcpIsolation.opencode, { changed: true, path: path.join(configDir, "opencode.json") });
  const written = JSON.parse(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8"));
  assert.ok(written.mcp.playwright.command.includes("--isolated"));
});

test("runSetup repairs a non-isolated referenced Claude Code config file", (t) => {
  const fixture = makeFixture(t);
  const configPath = path.join(fixture.homeDirectory, "playwright-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ browser: { headless: true } }));
  fs.writeFileSync(path.join(fixture.homeDirectory, ".claude.json"), JSON.stringify({
    mcpServers: { playwright: { args: ["npx", "@anthropic/mcp-server-playwright", "--config", configPath] } },
  }));
  const result = runSetup({ ...fixture, runCommand: unavailableClients });
  assert.equal(result.mcpIsolation.claudeCode.changed, true);
  assert.equal(result.mcpIsolation.claudeCode.path, configPath);
  const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(written.browser.isolated, true);
});

test("runSetup leaves an already-isolated setup untouched", (t) => {
  const fixture = makeFixture(t);
  const configDir = path.join(fixture.homeDirectory, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
    mcp: { playwright: { command: ["npx", "@anthropic/mcp-server-playwright", "--isolated"] } },
  }));
  const configPath = path.join(fixture.homeDirectory, "playwright-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ browser: { isolated: true } }));
  fs.writeFileSync(path.join(fixture.homeDirectory, ".claude.json"), JSON.stringify({
    mcpServers: { playwright: { args: ["npx", "@anthropic/mcp-server-playwright", "--config", configPath] } },
  }));
  const result = runSetup({ ...fixture, runCommand: unavailableClients });
  assert.equal(result.mcpIsolation.opencode.changed, false);
  assert.equal(result.mcpIsolation.claudeCode.changed, false);
});

test("runSetup leaves a .jsonc-only setup untouched — asserts bytes unchanged", (t) => {
  const fixture = makeFixture(t);
  const configDir = path.join(fixture.homeDirectory, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  const jsoncContent = `{
  // developer comment
  "mcp": {
    "playwright": {
      "command": ["npx", "@anthropic/mcp-server-playwright"]
    }
  }
}`;
  fs.writeFileSync(path.join(configDir, "opencode.jsonc"), jsoncContent);
  const before = fs.readFileSync(path.join(configDir, "opencode.jsonc"), "utf8");
  runSetup({ ...fixture, runCommand: unavailableClients });
  const after = fs.readFileSync(path.join(configDir, "opencode.jsonc"), "utf8");
  assert.equal(after, before);
});
