import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./commands.js";

function fakeIo({ isTTY } = {}) {
  const stdout = [];
  return { stdout: { isTTY, write: (chunk) => stdout.push(chunk) }, lines: stdout };
}

function fakeClient({ onSubscribe } = {}) {
  const closed = { value: false };
  return {
    closed,
    async request() {
      throw new Error("request() not stubbed for this test");
    },
    async subscribe(params, onEvent) {
      if (onSubscribe) onSubscribe(params, onEvent);
      return "sub-1";
    },
    close() {
      closed.value = true;
    },
  };
}

test("watch prints each event through formatWatchEvent and resolves on abort", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const controller = new AbortController();
  let deliver;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  const io = fakeIo();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: false }, {
    client,
    io,
    signal: controller.signal,
    cwd: root,
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_1", directory: root, status: "running" });
  controller.abort();
  const result = await pending;

  assert.equal(result.directory, root);
  assert.equal(result.watching, false);
  assert.equal(io.lines.length, 1);
  assert.match(io.lines[0], /oc_1/);
});

test("watch colors the status only when stdout is a TTY", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const controller = new AbortController();
  let deliver;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  const io = fakeIo({ isTTY: true });

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: false }, {
    client,
    io,
    signal: controller.signal,
    cwd: root,
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_1", directory: root, status: "done", previousStatus: "running" });
  controller.abort();
  await pending;

  assert.ok(io.lines[0].includes("\x1b[32mdone\x1b[0m"));
});

test("watch never colors ndjson output even when stdout is a TTY", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const controller = new AbortController();
  let deliver;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  const io = fakeIo({ isTTY: true });

  const pending = runCommand("watch", { directory: root, format: "ndjson", summaries: false }, {
    client,
    io,
    signal: controller.signal,
    cwd: root,
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_1", directory: root, status: "done", previousStatus: "running" });
  controller.abort();
  await pending;

  assert.ok(!io.lines[0].includes("\x1b["));
});

test("watch collapses a multi-line activity event to exactly one written line", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const controller = new AbortController();
  let deliver;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  const io = fakeIo();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: true }, {
    client,
    io,
    signal: controller.signal,
    cwd: root,
  });

  deliver({
    sequence: 1,
    type: "task.activity",
    taskId: "oc_1",
    directory: root,
    status: "running",
    activity: "Inspecting the server\nchecking Playwright logs\nand env vars",
  });
  controller.abort();
  await pending;

  assert.equal(io.lines.length, 1);
  assert.equal((io.lines[0].match(/\n/g) || []).length, 1);
  assert.match(io.lines[0], /oc_1/);
  assert.match(io.lines[0], /Inspecting the server checking Playwright logs and env vars/);
});

test("watch --task-id filters events to one task and exits on its terminal event", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let deliver;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  const io = fakeIo();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: false, taskId: "oc_1" }, {
    client,
    io,
    cwd: root,
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_2", directory: root, status: "running" });
  deliver({ sequence: 2, type: "task.state", taskId: "oc_1", directory: root, status: "running" });
  deliver({ sequence: 3, type: "task.state", taskId: "oc_1", directory: root, status: "done" });

  const result = await pending;
  assert.equal(result.watching, false);
  assert.equal(io.lines.length, 2, "only the matching task's events should print");
  assert.match(io.lines[0], /oc_1/);
  assert.match(io.lines[0], /running/);
  assert.match(io.lines[1], /oc_1/);
  assert.match(io.lines[1], /done/);
});

test("watch --task-id resolves --directory from the task when omitted, and exits without abort", async () => {
  const fromTask = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let deliver;
  const client = fakeClient({
    onSubscribe: (params, onEvent) => {
      deliver = onEvent;
      assert.equal(params.directory, fromTask);
    },
  });
  client.request = async (method, params) => {
    assert.equal(method, "task.status");
    assert.equal(params.taskId, "oc_9");
    return { directory: fromTask };
  };
  const io = fakeIo();

  const pending = runCommand("watch", { directory: undefined, format: "toon", summaries: false, taskId: "oc_9" }, {
    client,
    io,
    cwd: elsewhere,
  });

  await new Promise((resolve) => setImmediate(resolve));

  deliver({ sequence: 1, type: "task.state", taskId: "oc_9", directory: fromTask, status: "crashed" });
  const result = await pending;

  assert.equal(result.event.status, "crashed");
  assert.equal(client.closed.value, true);
});

test("wait --summarize streams summaries then returns the same shape as plain wait", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let deliver;
  let currentStatus = "running";
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  client.request = async (method) => {
    if (method === "task.status") {
      return currentStatus === "running"
        ? { directory: root, status: currentStatus }
        : {
            id: "oc_5",
            status: currentStatus,
            startedAt: "2026-07-17T00:00:00.000Z",
            exitCode: 0,
            signal: null,
            directory: root,
            model: "anthropic/claude-3",
            prompt: "summarize the latest activity",
          };
    }
    throw new Error(`unexpected request: ${method}`);
  };
  const io = fakeIo();

  const pending = runCommand("wait", { taskId: "oc_5", timeoutMs: undefined, tailChars: undefined, full: false, summarize: true }, {
    client,
    io,
  });

  await new Promise((resolve) => setImmediate(resolve));

  deliver({ sequence: 1, type: "task.state", taskId: "oc_5", directory: root, status: "running", activity: "reading files" });
  currentStatus = "done";
  deliver({ sequence: 2, type: "task.state", taskId: "oc_5", directory: root, status: "done" });

  const result = await pending;
  assert.equal(result.id, "oc_5");
  assert.equal(result.status, "done");
  assert.equal(io.lines.length, 2, "both the running and done events should print");
  assert.equal(client.closed.value, false, "wait must not close the client itself; cli.js closes it");
  assert.deepEqual(result, {
    id: "oc_5",
    status: "done",
    startedAt: "2026-07-17T00:00:00.000Z",
    exitCode: 0,
    signal: null,
    next: 'Run taskferry result with task id "oc_5" to see the final message; pass --full here for directory/model/log path details',
  });
});

test("wait --summarize resolves immediately for an already-settled task instead of hanging", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const client = fakeClient({
    onSubscribe: () => {
      // No terminal event will ever be delivered on this subscription: the task
      // was already terminal before the subscribe call, so nothing broadcasts.
    },
  });
  client.request = async (method, params) => {
    if (method === "task.status") {
      return {
        id: params.taskId,
        status: "done",
        startedAt: "2026-07-17T00:00:00.000Z",
        exitCode: 0,
        signal: null,
        directory: root,
      };
    }
    throw new Error(`unexpected request: ${method}`);
  };
  const io = fakeIo();

  const result = await runCommand("wait", { taskId: "oc_6", timeoutMs: undefined, tailChars: undefined, full: false, summarize: true }, {
    client,
    io,
  });

  assert.equal(result.id, "oc_6");
  assert.equal(result.status, "done");
});

test("wait --summarize skips the trailing task.status RPC on abort and reports the last known state", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const controller = new AbortController();
  let deliver;
  let statusCalls = 0;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  client.request = async (method, params) => {
    if (method === "task.status") {
      statusCalls++;
      return { id: params.taskId, status: "running", startedAt: "2026-07-17T00:00:00.000Z", directory: root };
    }
    throw new Error(`unexpected request: ${method}`);
  };
  const io = fakeIo();

  const pending = runCommand("wait", { taskId: "oc_8", timeoutMs: undefined, tailChars: undefined, full: false, summarize: true }, {
    client,
    io,
    signal: controller.signal,
  });

  await new Promise((resolve) => setImmediate(resolve));
  deliver({ sequence: 1, type: "task.state", taskId: "oc_8", directory: root, status: "running", activity: "reading files" });
  const callsBeforeAbort = statusCalls;
  controller.abort();

  const result = await pending;
  assert.equal(result.id, "oc_8");
  assert.equal(result.status, "running");
  assert.equal(statusCalls, callsBeforeAbort, "no additional task.status RPC should fire after abort");
});

test("status surfaces a resume hint when a crashed task has a salvageable sessionId", async () => {
  const client = {
    request: async (method, params) => {
      assert.equal(method, "task.status");
      assert.equal(params.taskId, "oc_7");
      return {
        id: "oc_7",
        status: "crashed",
        directory: "/workspace/project",
        sessionId: "ses_abc123",
        startedAt: "2026-07-17T00:00:00.000Z",
        exitCode: 1,
        signal: null,
        failureReason: "rate_limited",
      };
    },
  };
  const result = await runCommand("status", { taskId: "oc_7", full: false }, { client });
  assert.equal(
    result.next,
    'Session \'ses_abc123\' may be salvageable; resume with taskferry dispatch --session-id \'ses_abc123\' --directory \'/workspace/project\' --prompt "<continuation prompt>"'
  );
});

test("status keeps the generic hint for a crashed task with no sessionId", async () => {
  const client = {
    request: async () => ({
      id: "oc_8",
      status: "crashed",
      directory: "/workspace/project",
      sessionId: null,
      startedAt: "2026-07-17T00:00:00.000Z",
      exitCode: 1,
      signal: null,
      failureReason: "authentication_failed",
    }),
  };
  const result = await runCommand("status", { taskId: "oc_8", full: false }, { client });
  assert.equal(
    result.next,
    'Run taskferry result with task id "oc_8" to see the final message; pass --full here for directory/model/log path details'
  );
});

test("status keeps the running-task hint unaffected by the crashed-path change", async () => {
  const client = {
    request: async () => ({
      id: "oc_9",
      status: "running",
      directory: "/workspace/project",
      sessionId: "ses_should_be_ignored",
      startedAt: "2026-07-17T00:00:00.000Z",
      exitCode: null,
      signal: null,
    }),
  };
  const result = await runCommand("status", { taskId: "oc_9", full: false }, { client });
  assert.equal(
    result.next,
    'Run taskferry wait or taskferry status with task id "oc_9" to check progress; pass --full for directory/model/log path details'
  );
});

test("watch --task-id resolves immediately for an already-settled task instead of hanging", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const client = fakeClient({
    onSubscribe: () => {
      // No terminal event will ever be delivered: the task was already terminal
      // before the subscription registered.
    },
  });
  client.request = async (method, params) => {
    if (method === "task.status") {
      return { id: params.taskId, status: "crashed", directory: root };
    }
    throw new Error(`unexpected request: ${method}`);
  };
  const io = fakeIo();

  const result = await runCommand("watch", { directory: undefined, format: "toon", summaries: false, taskId: "oc_7" }, {
    client,
    io,
    cwd: root,
  });

  assert.equal(result.event.status, "crashed");
  assert.equal(client.closed.value, true);
});

test("doctor has no warnings when the claude plugin is installed", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeClient();
  client.request = async (method) => {
    if (method === "system.health") return { healthy: true, pid: 1 };
    throw new Error(`unexpected request: ${method}`);
  };
  const runShellCommand = () => ({
    status: 0,
    stdout: JSON.stringify([{ id: "taskferry@taskferry" }]),
    stderr: "",
    error: undefined,
  });

  const result = await runCommand("doctor", {}, { client, homeDirectory: home, env: {}, runShellCommand });

  assert.deepEqual(result.integrations, {
    claude: { installed: true },
    playwrightMcpIsolation: { opencode: { checked: false, reason: "no opencode config with a playwright MCP entry found" }, claudeCode: { checked: false, reason: "~/.claude.json not found" } },
  });
  assert.equal(result.warnings, undefined);
});

test("doctor warns when bwrap is not installed on Linux", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeClient();
  client.request = async (method) => {
    if (method === "system.health") return { healthy: true, pid: 1 };
    throw new Error(`unexpected request: ${method}`);
  };
  const runShellCommand = (command) => {
    if (command === "bwrap") return { status: null, stdout: "", stderr: "", error: { code: "ENOENT" } };
    return { status: 0, stdout: JSON.stringify([{ id: "taskferry@taskferry" }]), stderr: "", error: undefined };
  };

  const result = await runCommand("doctor", {}, { client, homeDirectory: home, env: {}, runShellCommand, platform: "linux" });

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /bwrap is not installed/);
  assert.match(result.warnings[0], /TASKFERRY_DISABLE_SANDBOX/);
  assert.equal(result.info, undefined);
});

test("doctor has no sandbox warning or info when bwrap is installed on Linux", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeClient();
  client.request = async (method) => {
    if (method === "system.health") return { healthy: true, pid: 1 };
    throw new Error(`unexpected request: ${method}`);
  };
  const runShellCommand = (command) => {
    if (command === "bwrap") return { status: 0, stdout: "bubblewrap 0.11.2\n", stderr: "", error: undefined };
    return { status: 0, stdout: JSON.stringify([{ id: "taskferry@taskferry" }]), stderr: "", error: undefined };
  };

  const result = await runCommand("doctor", {}, { client, homeDirectory: home, env: {}, runShellCommand, platform: "linux" });

  assert.equal(result.warnings, undefined);
  assert.equal(result.info, undefined);
});

test("doctor adds an informational note instead of a bwrap check on non-Linux platforms", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeClient();
  client.request = async (method) => {
    if (method === "system.health") return { healthy: true, pid: 1 };
    throw new Error(`unexpected request: ${method}`);
  };
  const runShellCommand = (command) => {
    assert.notEqual(command, "bwrap");
    return { status: 0, stdout: JSON.stringify([{ id: "taskferry@taskferry" }]), stderr: "", error: undefined };
  };

  const result = await runCommand("doctor", {}, { client, homeDirectory: home, env: {}, runShellCommand, platform: "darwin" });

  assert.equal(result.warnings, undefined);
  assert.equal(result.info.length, 1);
  assert.match(result.info[0], /only available on Linux/);
});

test("dispatch forwards noSandbox to the RPC payload when set", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let capturedParams;
  const client = {
    request: async (method, params) => {
      capturedParams = params;
      return { id: "oc_1" };
    },
  };
  await runCommand("dispatch", { prompt: "hi", directory: root, noSandbox: true }, { client, cwd: root });
  assert.equal(capturedParams.noSandbox, true);
});

test("dispatch omits noSandbox from the RPC payload when not set", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let capturedParams;
  const client = {
    request: async (method, params) => {
      capturedParams = params;
      return { id: "oc_1" };
    },
  };
  await runCommand("dispatch", { prompt: "hi", directory: root }, { client, cwd: root });
  assert.equal("noSandbox" in capturedParams, false);
});

test("dispatch refuses to run when the generated skill copies are stale", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const client = {
    request: async () => {
      throw new Error("task.dispatch should not be called when skill:check fails");
    },
  };
  const checkSkills = () => {
    throw new Error("stale generated skill copies: integrations/claude/skills/using-taskferry/SKILL.md");
  };
  await assert.rejects(
    () => runCommand("dispatch", { prompt: "hi", directory: root }, { client, cwd: root, checkSkills }),
    /taskferry's own skill files are out of sync/
  );
});

test("dispatch proceeds normally when the generated skill copies are in sync", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let checkSkillsCalled = false;
  const checkSkills = () => {
    checkSkillsCalled = true;
  };
  const client = {
    request: async () => ({ id: "oc_1" }),
  };
  const result = await runCommand("dispatch", { prompt: "hi", directory: root }, { client, cwd: root, checkSkills });
  assert.equal(checkSkillsCalled, true);
  assert.equal(result.id, "oc_1");
});

test("doctor warns when opencode playwright MCP is checked and not isolated", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
    mcp: { playwright: { command: ["npx", "@anthropic/mcp-server-playwright"] } },
  }));
  const client = fakeClient();
  client.request = async (method) => {
    if (method === "system.health") return { healthy: true, pid: 1 };
    throw new Error(`unexpected request: ${method}`);
  };
  const runShellCommand = () => ({
    status: 0,
    stdout: JSON.stringify([{ id: "taskferry@taskferry" }]),
    stderr: "",
    error: undefined,
  });

  const result = await runCommand("doctor", {}, { client, homeDirectory: home, env: {}, runShellCommand });

  assert.deepEqual(result.integrations.claude, { installed: true });
  assert.equal(result.integrations.playwrightMcpIsolation.opencode.checked, true);
  assert.equal(result.integrations.playwrightMcpIsolation.opencode.isolated, false);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Playwright MCP for opencode is not isolated/);
  assert.match(result.warnings[0], /SIGKILL/);
});

test("doctor warns when claude code playwright MCP is checked and not isolated", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, "playwright-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ browser: { isolated: false } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { playwright: { args: ["npx", "@anthropic/mcp-server-playwright", "--config", configPath] } },
  }));
  const client = fakeClient();
  client.request = async (method) => {
    if (method === "system.health") return { healthy: true, pid: 1 };
    throw new Error(`unexpected request: ${method}`);
  };
  const runShellCommand = () => ({
    status: 0,
    stdout: JSON.stringify([{ id: "taskferry@taskferry" }]),
    stderr: "",
    error: undefined,
  });

  const result = await runCommand("doctor", {}, { client, homeDirectory: home, env: {}, runShellCommand });

  assert.equal(result.integrations.playwrightMcpIsolation.claudeCode.checked, true);
  assert.equal(result.integrations.playwrightMcpIsolation.claudeCode.isolated, false);
  const mcpWarning = result.warnings.find((w) => w.includes("Claude Code"));
  assert.notEqual(mcpWarning, undefined);
  assert.match(mcpWarning, /Playwright MCP for Claude Code is not isolated/);
  assert.match(mcpWarning, /SIGKILL/);
});

test("doctor emits no MCP warning when checked: false for both sides", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeClient();
  client.request = async (method) => {
    if (method === "system.health") return { healthy: true, pid: 1 };
    throw new Error(`unexpected request: ${method}`);
  };
  const runShellCommand = () => ({
    status: 0,
    stdout: JSON.stringify([{ id: "taskferry@taskferry" }]),
    stderr: "",
    error: undefined,
  });

  const result = await runCommand("doctor", {}, { client, homeDirectory: home, env: {}, runShellCommand });

  assert.equal(result.warnings, undefined);
  assert.equal(result.integrations.playwrightMcpIsolation.opencode.checked, false);
  assert.equal(result.integrations.playwrightMcpIsolation.claudeCode.checked, false);
});

test("doctor integrations.playwrightMcpIsolation shape is present when both sides are isolated", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
    mcp: { playwright: { command: ["npx", "@anthropic/mcp-server-playwright", "--isolated"] } },
  }));
  const cConfigPath = path.join(home, "cc-playwright.json");
  fs.writeFileSync(cConfigPath, JSON.stringify({ browser: { isolated: true } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { playwright: { args: ["npx", "@anthropic/mcp-server-playwright", "--config", cConfigPath] } },
  }));
  const client = fakeClient();
  client.request = async (method) => {
    if (method === "system.health") return { healthy: true, pid: 1 };
    throw new Error(`unexpected request: ${method}`);
  };
  const runShellCommand = () => ({
    status: 0,
    stdout: JSON.stringify([{ id: "taskferry@taskferry" }]),
    stderr: "",
    error: undefined,
  });

  const result = await runCommand("doctor", {}, { client, homeDirectory: home, env: {}, runShellCommand });

  assert.equal(result.warnings, undefined);
  assert.equal(result.integrations.playwrightMcpIsolation.opencode.checked, true);
  assert.equal(result.integrations.playwrightMcpIsolation.opencode.isolated, true);
  assert.equal(result.integrations.playwrightMcpIsolation.claudeCode.checked, true);
  assert.equal(result.integrations.playwrightMcpIsolation.claudeCode.isolated, true);
});
