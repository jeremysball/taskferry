import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./commands.js";
import { UsageError } from "./args.js";

// -- Constants --------------------------------------------------------------

// RPC method names hit by the tests below. Mirrored from src/commands.js's
// dispatch table; using the same strings here keeps the assertions readable.
const SYSTEM_HEALTH_METHOD = "system.health";
const TASK_ADVISOR_METHOD = "task.advisor";
const TASK_DISPATCH_METHOD = "task.dispatch";
const TASK_LIST_METHOD = "task.list";
const TASK_STATUS_METHOD = "task.status";
const TASK_TAIL_METHOD = "task.tail";

// Event/method type strings the tests assemble by hand.
const TASK_STATE_EVENT_TYPE = "task.state";

// Standard "healthy" system.health response used by every doctor test that
// only cares about the integrations/warnings shape.
const SYSTEM_HEALTH_OK = { healthy: true, pid: 1 };

// Stable task start timestamp used in the leanStatus projections.
const TASK_STARTED_AT = "2026-07-17T00:00:00.000Z";

// mkdtempSync prefix per test category. Each prefix is unique so a leaked
// tmp dir is trivially attributable to its owning test (and t.after(rm) is
// scoped to that one dir).
const TASKFERRY_TEST_TMP_PREFIX = "taskferry-commands-test-";
const MUST_NOT_REACH_DAEMON_MESSAGE = "must not reach the daemon";
const SESS_1_TRANSCRIPT_FILENAME = "sess-1.jsonl";
const TASKFERRY_DOCTOR_HOME_PREFIX = "taskferry-doctor-home-";
const TASKFERRY_DOCTOR_STATS_HOME_PREFIX = "taskferry-doctor-stats-home-";
const TASKFERRY_DOCTOR_STATS_EMPTY_PREFIX = "taskferry-doctor-stats-empty-";
const TASKFERRY_ADVISOR_HOME_PREFIX = "taskferry-advisor-home-";

// What `claude plugin list --json` returns when the taskferry plugin is
// installed -- reused across every doctor test that exercises the happy
// path so the integration check resolves to "installed: true".
const CLAUDE_PLUGIN_INSTALLED_STDOUT = JSON.stringify([{ id: "taskferry@taskferry" }]);
const CLAUDE_PLUGIN_INSTALLED_RESULT = { status: 0, stdout: CLAUDE_PLUGIN_INSTALLED_STDOUT, stderr: "", error: null };

// Stable path used in the status-hint tests where the test doesn't care about
// the actual directory contents, only the resume hint's quoting/path interpolation.
const STATUS_HINT_PROJECT_DIR = "/workspace/project";

// Playwright MCP command basename reused across the isolation tests, both for
// the "isolated" and "not isolated" config paths.
const PLAYWRIGHT_MCP_BASE_COMMAND = ["npx", "@anthropic/mcp-server-playwright"];

// -- Helpers ----------------------------------------------------------------

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkTmpRoot(prefix) {
  return fs.realpathSync(mkTmpDir(prefix));
}

function fakeIo({ isTTY } = {}) {
  const stdout = [];
  return { stdout: { write: (chunk) => stdout.push(chunk) ,  isTTY}, lines: stdout };
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

// Doctor tests all want the same fake client shape: a `system.health` reply
// and a "throw on any other method" fallback. Extra per-test overrides go
// in `extra` (method name -> response).
function fakeDoctorClient(extra = {}) {
  const client = fakeClient();
  client.request = async (method) => {
    if (method === SYSTEM_HEALTH_METHOD) return SYSTEM_HEALTH_OK;
    if (Object.prototype.hasOwnProperty.call(extra, method)) return extra[method];
    throw new Error(`unexpected request: ${method}`);
  };
  return client;
}

// Returns a runShellCommand stub that always pretends the taskferry plugin is
// installed (the same JSON-encoded list shape). Doctor tests that want to
// exercise the "installed" path reuse this; tests that need a different reply
// pass a `command -> result` map.
function pluginInstalledShellCommand(overrides = {}) {
  return (command) => overrides[command] ?? CLAUDE_PLUGIN_INSTALLED_RESULT;
}

function deliverState({ deliver, sequence, taskId, directory, status, previousStatus, activity }) {
  deliver({ type: TASK_STATE_EVENT_TYPE,  sequence,  taskId,  directory,  status,  previousStatus,  activity });
}

test("wait --summarize streams summaries then returns the same shape as plain wait", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let deliver;
  let currentStatus = "running";
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  client.request = async (method) => {
    if (method === TASK_STATUS_METHOD) {
      return currentStatus === "running"
        ? { directory: root, status: currentStatus }
        : {
            id: "oc_5",
            status: currentStatus,
            startedAt: TASK_STARTED_AT,
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

  const pending = runCommand("wait", { taskId: "oc_5", timeoutMs: void 0, tailChars: void 0, full: false, summarize: true }, { client, io });

  await new Promise((resolve) => setImmediate(resolve));

  deliverState({ sequence: 1,  taskId: "oc_5",  directory: root,  status: "running",  activity: "reading files" ,  deliver});
  currentStatus = "done";
  deliverState({ sequence: 2,  taskId: "oc_5",  directory: root,  status: "done" ,  deliver});

  const result = await pending;
  assert.equal(result.id, "oc_5");
  assert.equal(result.status, "done");
  assert.equal(io.lines.length, 2, "both the running and done events should print");
  assert.equal(client.closed.value, false, "wait must not close the client itself; cli.js closes it");
  assert.deepEqual(result, {
    id: "oc_5",
    status: "done",
    startedAt: TASK_STARTED_AT,
    exitCode: 0,
    signal: null,
    next: 'Run taskferry result with task id "oc_5" to see the final message; pass --full here for directory/model/log path details',
  });
});

test("wait --summarize resolves immediately for an already-settled task instead of hanging", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const client = fakeClient({
    onSubscribe: () => {
      // No terminal event will ever be delivered on this subscription: the task
      // was already terminal before the subscribe call, so nothing broadcasts.
    },
  });
  client.request = async (method, params) => {
    if (method === TASK_STATUS_METHOD) {
      return {
        id: params.taskId,
        status: "done",
        startedAt: TASK_STARTED_AT,
        exitCode: 0,
        signal: null,
        directory: root,
      };
    }
    throw new Error(`unexpected request: ${method}`);
  };
  const io = fakeIo();

  const result = await runCommand("wait", { taskId: "oc_6", timeoutMs: void 0, tailChars: void 0, full: false, summarize: true }, { client, io });

  assert.equal(result.id, "oc_6");
  assert.equal(result.status, "done");
});

test("wait --summarize skips the trailing task.status RPC on abort and reports the last known state", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const controller = new AbortController();
  let deliver;
  let statusCalls = 0;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  client.request = async (method, params) => {
    if (method === TASK_STATUS_METHOD) {
      statusCalls++;
      return { id: params.taskId, status: "running", startedAt: TASK_STARTED_AT, directory: root };
    }
    throw new Error(`unexpected request: ${method}`);
  };
  const io = fakeIo();

  const pending = runCommand("wait", { taskId: "oc_8", timeoutMs: void 0, tailChars: void 0, full: false, summarize: true }, { signal: controller.signal ,  client,  io});

  await new Promise((resolve) => setImmediate(resolve));
  deliverState({ sequence: 1,  taskId: "oc_8",  directory: root,  status: "running",  activity: "reading files" ,  deliver});
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
      assert.equal(method, TASK_STATUS_METHOD);
      assert.equal(params.taskId, "oc_7");
      return {
        id: "oc_7",
        status: "crashed",
        directory: STATUS_HINT_PROJECT_DIR,
        sessionId: "ses_abc123",
        startedAt: TASK_STARTED_AT,
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
      directory: STATUS_HINT_PROJECT_DIR,
      sessionId: null,
      startedAt: TASK_STARTED_AT,
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
      directory: STATUS_HINT_PROJECT_DIR,
      sessionId: "ses_should_be_ignored",
      startedAt: TASK_STARTED_AT,
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

test("list resolves its default directory via resolveWorkspaceRoot when --directory is omitted", async () => {
  const cwd = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const resolvedRoot = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let calledWith;
  const resolveWorkspaceRootFn = (dir) => { calledWith = dir; return resolvedRoot; };
  const client = { request: async (method, params) => {
    assert.equal(method, TASK_LIST_METHOD);
    assert.equal(params.directory, resolvedRoot);
    return { counts: {}, tasks: [] };
  } };
  await runCommand("list", { directory: void 0, all: false, limit: void 0 }, { resolveWorkspaceRoot: resolveWorkspaceRootFn ,  client,  cwd});
  assert.equal(calledWith, cwd);
});

test("home/context resolve their default directory via resolveWorkspaceRoot when --directory is omitted", async () => {
  const cwd = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const resolvedRoot = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const resolveWorkspaceRootFn = () => resolvedRoot;
  let seenDirectory;
  const clientFor = (method) => ({ request: async (m, params) => {
    assert.equal(m, method);
    seenDirectory = params.directory;
    return method === TASK_LIST_METHOD ? { counts: {}, tasks: [] } : {};
  } });

  await runCommand("home", { directory: void 0 }, { client: clientFor(TASK_LIST_METHOD),  resolveWorkspaceRoot: resolveWorkspaceRootFn,  cwd });
  assert.equal(seenDirectory, resolvedRoot);

  await runCommand("context", { directory: void 0, format: "toon" }, { client: clientFor("task.context"),  resolveWorkspaceRoot: resolveWorkspaceRootFn,  cwd });
  assert.equal(seenDirectory, resolvedRoot);
});

test("home passes an unbounded limit into projectList so homeView sees the true total (regression: double-truncation would silently drop the real count and reveal hint)", async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), TASKFERRY_TEST_TMP_PREFIX)));
  const tasks = Array.from({ length: 805 }, (_, i) => ({ id: `t${i}`, status: "done", model: "x", startedAt: "2026-01-01T00:00:00.000Z" }));
  const client = { request: async () => ({ directory: cwd, counts: { queued: 0, running: 0, done: 805, crashed: 0, cancelled: 0, unknown: 0 }, tasks }) };
  const result = await runCommand("home", { directory: cwd }, { client, cwd, resolveWorkspaceRoot: () => cwd });
  assert.equal(result.tasks.length, 30);
  assert.deepEqual(result.next.slice(-1), ["Run taskferry list --limit 805 for all 805 tasks"]);
});

test("advisor does NOT resolve via resolveWorkspaceRoot (regression test mirroring the dispatch one)", async () => {
  // advisor is grouped with dispatch at the args/cli/commands layers
  // because tasks.js's advisor() forwards its directory straight into
  // dispatch(), which uses it as both the bwrap sandbox root and the
  // worker's spawn cwd -- so widening advisor's default to the
  // workspace root would silently expand its sandbox from "the cwd
  // you ran it in" to "the whole repo root".
  const cwd = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let called = false;
  const resolveWorkspaceRootFn = () => { called = true; return mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX); };
  let seenDirectory;
  const client = { request: async (method, params) => {
    assert.equal(method, TASK_ADVISOR_METHOD);
    seenDirectory = params.directory;
    return { status: "done", message: "advice" };
  } };

  await runCommand("advisor", { directory: void 0, prompt: "p", model: "m" }, { client, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn, env: {} });

  assert.equal(called, false, "advisor must never consult resolveWorkspaceRoot");
  assert.equal(seenDirectory, cwd);
});

test("watch resolves its default directory via resolveWorkspaceRoot when --directory and --task-id are both omitted", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const cwd = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const resolveWorkspaceRootFn = (dir) => { assert.equal(dir, cwd); return root; };
  const controller = new AbortController();
  let subscribedDirectory;
  const client = fakeClient({
    onSubscribe: (params, _onEvent) => {
      subscribedDirectory = params.directory;
      controller.abort();
    },
  });
  const io = fakeIo();

  await runCommand("watch", { directory: void 0, format: "toon", summaries: false, taskId: void 0 }, { signal: controller.signal,  resolveWorkspaceRoot: resolveWorkspaceRootFn,  client,  io,  cwd });

  assert.equal(subscribedDirectory, root);
});

test("dispatch does NOT resolve via resolveWorkspaceRoot (regression test pinning the launch-directory behavior as unchanged)", async () => {
  const cwd = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let called = false;
  const resolveWorkspaceRootFn = () => { called = true; return mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX); };
  let seenDirectory;
  const client = { request: async (method, params) => {
    assert.equal(method, TASK_DISPATCH_METHOD);
    seenDirectory = params.directory;
    return { id: "oc_1", status: "queued" };
  } };
  const checkSkills = () => {};

  await runCommand("dispatch", { directory: void 0, prompt: "p" }, { resolveWorkspaceRoot: resolveWorkspaceRootFn,  checkSkills,  client,  cwd });

  assert.equal(called, false, "dispatch must never consult resolveWorkspaceRoot");
  assert.equal(seenDirectory, cwd);
});

test("doctor has no warnings when the claude plugin is installed", async (t) => {
  const home = mkTmpDir(TASKFERRY_DOCTOR_HOME_PREFIX);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeDoctorClient();
  const runShellCommand = pluginInstalledShellCommand();

  const result = await runCommand("doctor", {}, { homeDirectory: home, env: {}, client, runShellCommand });

  assert.deepEqual(result.integrations, {
    claude: { installed: true },
    playwrightMcpIsolation: { opencode: { checked: false, reason: "no opencode config with a playwright MCP entry found" }, claudeCode: { checked: false, reason: "~/.claude.json not found" } },
  });
  assert.equal(result.warnings, void 0);
});

test("doctor warns when bwrap is not installed on Linux", async (t) => {
  const home = mkTmpDir(TASKFERRY_DOCTOR_HOME_PREFIX);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeDoctorClient();
  const runShellCommand = pluginInstalledShellCommand({ bwrap: { status: null, stdout: "", stderr: "", error: { code: "ENOENT" } } });

  const result = await runCommand("doctor", {}, { homeDirectory: home, env: {}, platform: "linux", client, runShellCommand });

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /bwrap is not installed/);
  assert.match(result.warnings[0], /TASKFERRY_DISABLE_SANDBOX/);
  assert.equal(result.info, void 0);
});

test("doctor has no sandbox warning or info when bwrap is installed on Linux", async (t) => {
  const home = mkTmpDir(TASKFERRY_DOCTOR_HOME_PREFIX);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeDoctorClient();
  const runShellCommand = pluginInstalledShellCommand({ bwrap: { status: 0, stdout: "bubblewrap 0.11.2\n", stderr: "", error: null } });

  const result = await runCommand("doctor", {}, { homeDirectory: home, env: {}, platform: "linux", client, runShellCommand });

  assert.equal(result.warnings, void 0);
  assert.equal(result.info, void 0);
});

test("doctor adds an informational note instead of a bwrap check on non-Linux platforms", async (t) => {
  const home = mkTmpDir(TASKFERRY_DOCTOR_HOME_PREFIX);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeDoctorClient();
  const runShellCommand = (command) => {
    assert.notEqual(command, "bwrap");
    return CLAUDE_PLUGIN_INSTALLED_RESULT;
  };

  const result = await runCommand("doctor", {}, { homeDirectory: home, env: {}, platform: "darwin", client, runShellCommand });

  assert.equal(result.warnings, void 0);
  assert.equal(result.info.length, 1);
  assert.match(result.info[0], /only available on Linux/);
});

test("dispatch forwards executor to the RPC payload when set", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let captured;
  const client = {
    request: async (method, params) => {
      captured = { method, params };
      return { id: "oc_1" };
    },
  };

  await runCommand("dispatch", { prompt: "hi", directory: root, executor: "pi" }, { client, cwd: root, checkSkills: () => {} });

  assert.equal(captured.method, TASK_DISPATCH_METHOD);
  assert.equal(captured.params.executor, "pi");
});

test("advisor forwards executor to the RPC payload when set", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let captured;
  const client = {
    request: async (method, params) => {
      captured = { method, params };
      return { status: "done", message: "advice" };
    },
  };

  await runCommand("advisor", { prompt: "hi", directory: root, model: "m", executor: "pi" }, { client, cwd: root, env: {} });

  assert.equal(captured.method, TASK_ADVISOR_METHOD);
  assert.equal(captured.params.executor, "pi");
});

test("dispatch forwards noSandbox to the RPC payload when set", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let capturedParams;
  const client = {
    request: async (_method, params) => {
      capturedParams = params;
      return { id: "oc_1" };
    },
  };
  await runCommand("dispatch", { prompt: "hi", directory: root, noSandbox: true }, { client, cwd: root, checkSkills: () => {} });
  assert.equal(capturedParams.noSandbox, true);
});

test("dispatch omits noSandbox from the RPC payload when not set", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let capturedParams;
  const client = {
    request: async (_method, params) => {
      capturedParams = params;
      return { id: "oc_1" };
    },
  };
  await runCommand("dispatch", { prompt: "hi", directory: root }, { client, cwd: root, checkSkills: () => {} });
  assert.equal("noSandbox" in capturedParams, false);
});

test("dispatch forwards the caller's env to the RPC payload", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let capturedParams;
  const client = {
    request: async (_method, params) => {
      capturedParams = params;
      return { id: "oc_1" };
    },
  };
  const injectedEnv = { FOO: "bar" };
  await runCommand("dispatch", { prompt: "hi", directory: root }, { client, cwd: root, env: injectedEnv, checkSkills: () => {} });
  assert.deepEqual(capturedParams.env, injectedEnv);
});

test("dispatch no longer forwards keySlot", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let capturedParams;
  const client = {
    request: async (_method, params) => {
      capturedParams = params;
      return { id: "oc_1" };
    },
  };
  await runCommand("dispatch", { prompt: "hi", directory: root, keySlot: "primary" }, { client, cwd: root, checkSkills: () => {} });
  assert.equal("keySlot" in capturedParams, false);
});

test("advisor forwards the caller's env to the RPC payload", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let capturedParams;
  const client = {
    request: async (_method, params) => {
      capturedParams = params;
      return { status: "done", message: "advice" };
    },
  };
  // `injectedEnv` deliberately has neither CLAUDE_CODE_SESSION_ID nor
  // TASKFERRY_TASK_ID set, so it doubles as the "no context source" case
  // here -- this is the safe ambient for the auto-context resolver.
  const injectedEnv = { FOO: "bar" };
  await runCommand("advisor", { prompt: "hi", directory: root, model: "m" }, { cwd: root,  env: injectedEnv ,  client});
  assert.deepEqual(capturedParams.env, injectedEnv);
});

test("advisor fails fast with no --prompt and no context source in env", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const client = { request: async () => { throw new Error(MUST_NOT_REACH_DAEMON_MESSAGE); } };

  await assert.rejects(
    runCommand("advisor", { directory: root, model: "m" }, { client, cwd: root, env: {} }),
    (err) => err instanceof UsageError && /no context source/.test(err.message)
  );
});

test("advisor auto-attaches a Claude session transcript tail when CLAUDE_CODE_SESSION_ID is set and no --prompt is given", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const home = mkTmpDir(TASKFERRY_ADVISOR_HOME_PREFIX);
  const slug = root.split(path.sep).join("-");
  const projectDir = path.join(home, ".claude", "projects", slug);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, SESS_1_TRANSCRIPT_FILENAME), '{"type":"user","message":{"role":"user","content":"do the thing"}}\n');

  let capturedPrompt;
  const client = { request: async (_method, params) => { capturedPrompt = params.prompt; return { status: "done", message: "advice" }; } };

  await runCommand("advisor", { directory: root, model: "m" }, { client, cwd: root, homeDirectory: home, env: { CLAUDE_CODE_SESSION_ID: "sess-1" } });

  assert.match(capturedPrompt, /do the thing/);
  assert.match(capturedPrompt, /attached context \(claude-session/);
});

test("advisor fails fast when the transcript exists but extracts to no user/assistant text, instead of silently sending empty context", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), TASKFERRY_TEST_TMP_PREFIX)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-home-"));
  const slug = root.split(path.sep).join("-");
  const projectDir = path.join(home, ".claude", "projects", slug);
  fs.mkdirSync(projectDir, { recursive: true });
  // Entirely tool_use/thinking -- no user/assistant text turns to extract.
  fs.writeFileSync(path.join(projectDir, SESS_1_TRANSCRIPT_FILENAME), '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}\n');

  const client = { request: async () => { throw new Error(MUST_NOT_REACH_DAEMON_MESSAGE); } };

  await assert.rejects(
    runCommand("advisor", { directory: root, model: "m" }, { client, cwd: root, homeDirectory: home, env: { CLAUDE_CODE_SESSION_ID: "sess-1" } }),
    (err) => err instanceof UsageError && /no context source found/.test(err.message)
  );
});

test("advisor fails fast when CLAUDE_CODE_SESSION_ID is set but the transcript file is missing", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const home = mkTmpDir(TASKFERRY_ADVISOR_HOME_PREFIX);
  const client = { request: async () => { throw new Error(MUST_NOT_REACH_DAEMON_MESSAGE); } };

  await assert.rejects(
    runCommand("advisor", { directory: root, model: "m" }, { client, cwd: root, homeDirectory: home, env: { CLAUDE_CODE_SESSION_ID: "sess-missing" } }),
    (err) => err instanceof UsageError && /transcript/.test(err.message)
  );
});

test("advisor fetches its own task.tail when TASKFERRY_TASK_ID is set and no --prompt is given", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let capturedPrompt;
  const client = {
    request: async (method, params) => {
      if (method === TASK_TAIL_METHOD) {
        assert.equal(params.taskId, "oc_self");
        return { taskId: "oc_self", status: "running", text: "ferry log tail text", textTotalChars: 20, truncated: false };
      }
      capturedPrompt = params.prompt;
      return { status: "done", message: "advice" };
    },
  };

  await runCommand("advisor", { directory: root, model: "m" }, { client, cwd: root, env: { TASKFERRY_TASK_ID: "oc_self" } });

  assert.match(capturedPrompt, /ferry log tail text/);
  assert.match(capturedPrompt, /attached context \(ferry-log/);
});

test("advisor with an explicit --prompt still attaches context when a source is available", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let capturedPrompt;
  const client = {
    request: async (method, params) => {
      if (method === TASK_TAIL_METHOD) return { taskId: "oc_self", status: "running", text: "ferry log tail text", textTotalChars: 20, truncated: false };
      capturedPrompt = params.prompt;
      return { status: "done", message: "advice" };
    },
  };

  await runCommand("advisor", { directory: root, model: "m", prompt: "also check the retry logic" }, { client, cwd: root, env: { TASKFERRY_TASK_ID: "oc_self" } });

  assert.match(capturedPrompt, /ferry log tail text/);
  assert.match(capturedPrompt, /also check the retry logic/);
});

test("advisor with an explicit --prompt and no context source sends the canned prompt plus the caller's prompt only", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let capturedPrompt;
  const client = { request: async (_method, params) => { capturedPrompt = params.prompt; return { status: "done", message: "advice" }; } };

  await runCommand("advisor", { directory: root, model: "m", prompt: "just answer this" }, { client, cwd: root, env: {} });

  assert.match(capturedPrompt, /just answer this/);
  assert.doesNotMatch(capturedPrompt, /attached context/);
});

test("advisor --summarize-context condenses the gathered context via a dispatch+wait+result round trip", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const calls = [];
  let capturedPrompt;
  const client = {
    request: async (method, params) => {
      calls.push(method);
      if (method === TASK_TAIL_METHOD) return { taskId: "oc_self", status: "running", text: "verbose ferry log text", textTotalChars: 20, truncated: false };
      if (method === TASK_DISPATCH_METHOD) return { id: "oc_summarizer", status: "queued" };
      if (method === "task.wait") return { id: "oc_summarizer", status: "done" };
      if (method === "task.result") return { message: "condensed summary" };
      capturedPrompt = params.prompt;
      return { status: "done", message: "advice" };
    },
  };

  await runCommand("advisor", { directory: root, model: "m", summarizeContext: true }, { client, cwd: root, env: { TASKFERRY_TASK_ID: "oc_self" } });

  assert.deepEqual(calls, [TASK_TAIL_METHOD, TASK_DISPATCH_METHOD, "task.wait", "task.result", TASK_ADVISOR_METHOD]);
  assert.match(capturedPrompt, /condensed summary/);
  assert.match(capturedPrompt, /attached context \(summarized ferry-log/);
  assert.doesNotMatch(capturedPrompt, /verbose ferry log text/);
});

test("advisor --summarize-context falls back to the raw text when the condense dispatch fails", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let capturedPrompt;
  const client = {
    request: async (method, params) => {
      if (method === TASK_TAIL_METHOD) return { taskId: "oc_self", status: "running", text: "verbose ferry log text", textTotalChars: 20, truncated: false };
      if (method === TASK_DISPATCH_METHOD) throw new Error("daemon unavailable");
      capturedPrompt = params.prompt;
      return { status: "done", message: "advice" };
    },
  };

  await runCommand("advisor", { directory: root, model: "m", summarizeContext: true }, { client, cwd: root, env: { TASKFERRY_TASK_ID: "oc_self" } });

  assert.match(capturedPrompt, /verbose ferry log text/);
  assert.match(capturedPrompt, /attached context \(ferry-log/);
});

test("summary forwards the caller's env to the RPC payload", async () => {
  let capturedParams;
  const client = {
    request: async (_method, params) => {
      capturedParams = params;
      return { sourceTaskId: "t1", summary: "done" };
    },
  };
  const injectedEnv = { FOO: "bar" };
  await runCommand("summary", { taskId: "t1" }, { env: injectedEnv ,  client});
  assert.deepEqual(capturedParams.env, injectedEnv);
});

test("summary --mode activity omits env from the RPC payload (protocol rejects env + mode activity)", async () => {
  let capturedParams;
  const client = {
    request: async (_method, params) => {
      capturedParams = params;
      return { sourceTaskId: "t1", summary: "activity summary" };
    },
  };
  const injectedEnv = { FOO: "bar" };
  await runCommand("summary", { taskId: "t1", mode: "activity" }, { env: injectedEnv ,  client});
  assert.equal(capturedParams.env, void 0, "activity-mode summary must not carry env");
  assert.equal(capturedParams.mode, "activity");
});

test("summary --mode report still forwards the caller's env to the RPC payload", async () => {
  let capturedParams;
  const client = {
    request: async (_method, params) => {
      capturedParams = params;
      return { sourceTaskId: "t1", summary: "report summary" };
    },
  };
  const injectedEnv = { FOO: "bar" };
  await runCommand("summary", { taskId: "t1", mode: "report" }, { env: injectedEnv ,  client});
  assert.deepEqual(capturedParams.env, injectedEnv);
  // mode "report" is the args-layer default; commands.js only emits the mode
  // field on the wire when it differs from that default (i.e. "activity").
  assert.equal("mode" in capturedParams, false);
});

test("dispatch refuses to run when the generated skill copies are stale", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  const client = {
    request: async () => {
      throw new Error("task.dispatch should not be called when skill:check fails");
    },
  };
  const checkSkills = () => {
    throw new Error("stale generated skill copies: integrations/claude/skills/using-taskferry/SKILL.md");
  };
  await assert.rejects(
    () => runCommand("dispatch", { prompt: "hi", directory: root }, { cwd: root,  client,  checkSkills }),
    /taskferry's own skill files are out of sync/
  );
});

test("dispatch proceeds normally when the generated skill copies are in sync", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let checkSkillsCalled = false;
  const checkSkills = () => {
    checkSkillsCalled = true;
  };
  const client = {
    request: async () => ({ id: "oc_1" }),
  };
  const result = await runCommand("dispatch", { prompt: "hi", directory: root }, { cwd: root,  client,  checkSkills });
  assert.equal(checkSkillsCalled, true);
  assert.equal(result.id, "oc_1");
});

test("doctor warns when opencode playwright MCP is checked and not isolated", async (t) => {
  const home = mkTmpDir(TASKFERRY_DOCTOR_HOME_PREFIX);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
    mcp: { playwright: { command: PLAYWRIGHT_MCP_BASE_COMMAND } },
  }));
  const client = fakeDoctorClient();
  const runShellCommand = pluginInstalledShellCommand();

  const result = await runCommand("doctor", {}, { homeDirectory: home, env: {}, client, runShellCommand });

  assert.deepEqual(result.integrations.claude, { installed: true });
  assert.equal(result.integrations.playwrightMcpIsolation.opencode.checked, true);
  assert.equal(result.integrations.playwrightMcpIsolation.opencode.isolated, false);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Playwright MCP for opencode is not isolated/);
  assert.match(result.warnings[0], /SIGKILL/);
});

test("doctor warns when claude code playwright MCP is checked and not isolated", async (t) => {
  const home = mkTmpDir(TASKFERRY_DOCTOR_HOME_PREFIX);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, "playwright-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ browser: { isolated: false } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { playwright: { args: [...PLAYWRIGHT_MCP_BASE_COMMAND, "--config", configPath] } },
  }));
  const client = fakeDoctorClient();
  const runShellCommand = pluginInstalledShellCommand();

  const result = await runCommand("doctor", {}, { homeDirectory: home, env: {}, client, runShellCommand });

  assert.equal(result.integrations.playwrightMcpIsolation.claudeCode.checked, true);
  assert.equal(result.integrations.playwrightMcpIsolation.claudeCode.isolated, false);
  const mcpWarning = result.warnings.find((w) => w.includes("Claude Code"));
  assert.notEqual(mcpWarning, void 0);
  assert.match(mcpWarning, /Playwright MCP for Claude Code is not isolated/);
  assert.match(mcpWarning, /SIGKILL/);
});

test("doctor emits no MCP warning when checked: false for both sides", async (t) => {
  const home = mkTmpDir(TASKFERRY_DOCTOR_HOME_PREFIX);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeDoctorClient();
  const runShellCommand = pluginInstalledShellCommand();

  const result = await runCommand("doctor", {}, { homeDirectory: home, env: {}, client, runShellCommand });

  assert.equal(result.warnings, void 0);
  assert.equal(result.integrations.playwrightMcpIsolation.opencode.checked, false);
  assert.equal(result.integrations.playwrightMcpIsolation.claudeCode.checked, false);
});

test("doctor integrations.playwrightMcpIsolation shape is present when both sides are isolated", async (t) => {
  const home = mkTmpDir(TASKFERRY_DOCTOR_HOME_PREFIX);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
    mcp: { playwright: { command: [...PLAYWRIGHT_MCP_BASE_COMMAND, "--isolated"] } },
  }));
  const cConfigPath = path.join(home, "cc-playwright.json");
  fs.writeFileSync(cConfigPath, JSON.stringify({ browser: { isolated: true } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { playwright: { args: [...PLAYWRIGHT_MCP_BASE_COMMAND, "--config", cConfigPath] } },
  }));
  const client = fakeDoctorClient();
  const runShellCommand = pluginInstalledShellCommand();

  const result = await runCommand("doctor", {}, { homeDirectory: home, env: {}, client, runShellCommand });

  assert.equal(result.warnings, void 0);
  assert.equal(result.integrations.playwrightMcpIsolation.opencode.checked, true);
  assert.equal(result.integrations.playwrightMcpIsolation.opencode.isolated, true);
  assert.equal(result.integrations.playwrightMcpIsolation.claudeCode.checked, true);
  assert.equal(result.integrations.playwrightMcpIsolation.claudeCode.isolated, true);
});

test("doctor --stats calls task.list and returns computeDoctorStats() output, skipping env checks", async (_t) => {
  const home = mkTmpDir(TASKFERRY_DOCTOR_STATS_HOME_PREFIX);
  let calledMethod;
  const client = {
    request: async (method, params) => {
      calledMethod = method;
      assert.deepEqual(params, {});
      return {
        counts: { queued: 0, running: 0, done: 1, crashed: 1, cancelled: 0, unknown: 0 },
        tasks: [
          { id: "a", status: "done", model: "m1", startedAt: "2026-08-01T10:00:00.000Z", failureReason: null },
          { id: "b", status: "crashed", model: "m1", startedAt: "2026-08-01T11:00:00.000Z", failureReason: "no_output_timeout" },
        ],
      };
    },
  };
  const runShellCommand = async () => ({ stdout: "", stderr: "", code: 0 });

  const result = await runCommand("doctor", { stats: true }, { homeDirectory: home, env: {}, client, runShellCommand });

  assert.equal(calledMethod, TASK_LIST_METHOD);
  assert.ok(Array.isArray(result.byModel));
  assert.equal(result.byModel[0].model, "m1");
  assert.equal(result.byModel[0].dispatches, 2);
  assert.equal(result.integrations, void 0);
  assert.equal(result.warnings, void 0);
});

test("doctor --stats on a daemon with zero tasks returns empty stats, not garbage", async (_t) => {
  const home = mkTmpDir(TASKFERRY_DOCTOR_STATS_EMPTY_PREFIX);
  const client = {
    request: async () => ({
      counts: { queued: 0, running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0 },
      tasks: "none found (this server process's lifetime)",
    }),
  };
  const runShellCommand = async () => ({ stdout: "", stderr: "", code: 0 });

  const result = await runCommand("doctor", { stats: true }, { homeDirectory: home, env: {}, client, runShellCommand });

  assert.equal(result.statusMix.overall.total, 0);
  assert.deepEqual(result.byModel, []);
  assert.deepEqual(result.failureReasons, []);
});

test("doctor without --stats does not call task.list", async (_t) => {
  const home = mkTmpDir(TASKFERRY_DOCTOR_STATS_HOME_PREFIX);
  const calledMethods = [];
  const client = {
    request: async (method) => {
      calledMethods.push(method);
      return { healthy: true, pid: 1, version: 1 };
    },
  };
  const runShellCommand = async () => ({ stdout: "", stderr: "", code: 0 });

  await runCommand("doctor", {}, { homeDirectory: home, env: {}, client, runShellCommand });

  assert.ok(!calledMethods.includes(TASK_LIST_METHOD));
});

test("accept calls task.accept via the client", async () => {
  let capturedMethod = null;
  let capturedParams = null;
  const client = { request: async (method, params) => { capturedMethod = method; capturedParams = params; return { taskId: "t1", changesetStatus: "accepted", applied: true, checkStatus: "passed" }; } };
  const result = await runCommand("accept", { taskId: "t1" }, { client });
  assert.equal(capturedMethod, "task.accept");
  assert.deepEqual(capturedParams, { taskId: "t1" });
  assert.equal(result.changesetStatus, "accepted");
});

test("accept warns when the accepted changeset had no check gate", async (t) => {
  let warning = "";
  const originalWrite = process.stderr.write;
  t.after(() => { process.stderr.write = originalWrite; });
  process.stderr.write = (chunk) => { warning += String(chunk); return true; };
  const client = {
    request: async () => ({ taskId: "t1", changesetStatus: "accepted", applied: true, checkStatus: "none" }),
  };

  await runCommand("accept", { taskId: "t1" }, { client });

  assert.match(warning, /declares no check command/);
});

test("reject calls task.reject via the client", async () => {
  let capturedMethod = null;
  const client = { request: async (method) => { capturedMethod = method; return { taskId: "t1", changesetStatus: "rejected" }; } };
  const result = await runCommand("reject", { taskId: "t1" }, { client });
  assert.equal(capturedMethod, "task.reject");
  assert.equal(result.changesetStatus, "rejected");
});

test("result --diff requests fields: ['diff']", async () => {
  let capturedParams = null;
  const client = { request: async (_method, params) => { capturedParams = params; return { taskId: "t1", status: "done", diff: "diff --git a/x b/x\n" }; } };
  await runCommand("result", { taskId: "t1", diff: true }, { client });
  assert.deepEqual(capturedParams.fields, ["diff"]);
});

test("dispatch forwards noOverlay to task.dispatch", async () => {
  let capturedParams = null;
  const client = { request: async (_method, params) => { capturedParams = params; return {}; } };
  await runCommand("dispatch", { prompt: "hi", directory: "/tmp", noOverlay: true }, { client, cwd: "/tmp", checkSkills: () => {} });
  assert.equal(capturedParams.noOverlay, true);
});

test("dispatch forwards class to the RPC payload when set", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let capturedParams;
  const client = {
    request: async (_method, params) => {
      capturedParams = params;
      return { id: "oc_1" };
    },
  };
  await runCommand("dispatch", { prompt: "hi", directory: root, class: "implementer" }, { client, cwd: root, checkSkills: () => {} });
  assert.equal(capturedParams.class, "implementer");
});

test("dispatch omits class from the RPC payload when not set", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let capturedParams;
  const client = {
    request: async (_method, params) => {
      capturedParams = params;
      return { id: "oc_1" };
    },
  };
  await runCommand("dispatch", { prompt: "hi", directory: root }, { client, cwd: root, checkSkills: () => {} });
  assert.equal("class" in capturedParams, false);
});

test("advisor forwards class to the RPC payload when set", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let captured;
  const client = {
    request: async (method, params) => {
      captured = { method, params };
      return { status: "done", message: "advice" };
    },
  };
  await runCommand("advisor", { prompt: "hi", directory: root, model: "m", class: "advisor-design" }, { client, cwd: root, env: {} });
  assert.equal(captured.params.class, "advisor-design");
});
