import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { piExecutor, resolveExecutor, PROMPT_FILE_INSTRUCTION } from "./executor.js";
const PI_MODEL = "minimax/MiniMax-M2.7";
const PI_MODEL_SHORT = "MiniMax-M2.7";
const PROVIDER_FLAG = "--provider";
const HOME_DIR = "/home/user";
const DATA_DIR = "/state/run";
const PI_AGENT_DIR = "/custom/pi";
const PI_AUTH = "/custom/pi/auth.json";
const PI_DATA_AUTH = "/state/run/pi-data/auth.json";
const PI_SESSIONS = "/custom/pi/sessions";
const SESSION_ID_PREFIX = "019f90ea-1234-70e0-98dc-6847db316eb4";
const LAUNCH_DIR_FOO = "/home/user/projects/foo";
const SESSION_FILE = "2026-07-23T21-42-41-761Z_019f90ea-1234-70e0-98dc-6847db316eb4.jsonl";
const RATE_LIMIT_MESSAGE = "rate limit exceeded";
const _PROMPT_FILE = "/state/prompts/t1.prompt.txt";
const _OPENCODE_CONFIG_DIR = "/home/user/.config/opencode";
const TASK_ID = "oc_task1";
const PI_EXTENSIONS = "/custom/pi/extensions";
const PI_SESSIONS_FOO_DIR = "/custom/pi/sessions/--home-user-projects-foo--";

describe("piExecutor()", () => {

  test("exposes pi identity and defaults", () => {
    const ex = piExecutor();
    assert.equal(ex.id, "pi");
    assert.equal(ex.taskIdPrefix, "pi");
    assert.equal(ex.errorBucketPrefix, "pi");
  });

  test("buildSpawnArgs splits provider/model and supports session", () => {
    const ex = piExecutor();
    assert.deepEqual(ex.buildSpawnArgs({ isSummary: false, model: PI_MODEL, launchDirectory: "/work", promptFilePath: null, prompt: "hi", sessionId: "ses" }), [PROVIDER_FLAG, "minimax", "--model", PI_MODEL_SHORT, "--mode", "json", "--continue", "--session", "ses", "-p", "hi"]);
    assert.deepEqual(ex.buildSpawnArgs({ isSummary: false, model: "gpt-4o", launchDirectory: "/work", promptFilePath: "/p", prompt: "huge", sessionId: null }), ["--model", "gpt-4o", "--mode", "json", "-p", PROMPT_FILE_INSTRUCTION, "@/p"]);
  });

  test("buildSpawnArgs maps --variant to pi's --thinking flag, dispatch only", () => {
    const ex = piExecutor();
    assert.deepEqual(
      ex.buildSpawnArgs({ isSummary: false, model: PI_MODEL, launchDirectory: "/work", promptFilePath: null, prompt: "hi", sessionId: null, variant: "high" }),
      [PROVIDER_FLAG, "minimax", "--model", PI_MODEL_SHORT, "--mode", "json", "--thinking", "high", "-p", "hi"]
    );
    assert.deepEqual(
      ex.buildSpawnArgs({ isSummary: true, model: PI_MODEL, launchDirectory: "/work", snapshotPath: "/s.json", prompt: "", sessionId: null, variant: "high" }),
      [PROVIDER_FLAG, "minimax", "--model", PI_MODEL_SHORT, "--mode", "json", "-p", ex.buildSummaryPrompt(), "@/s.json"]
    );
  });

  test("buildSpawnArgs uses snapshot attachment for summaries", () => {
    const ex = piExecutor();
    assert.deepEqual(ex.buildSpawnArgs({ isSummary: true, model: PI_MODEL, launchDirectory: "/work", snapshotPath: "/s.json", prompt: "", sessionId: null }), [PROVIDER_FLAG, "minimax", "--model", PI_MODEL_SHORT, "--mode", "json", "-p", ex.buildSummaryPrompt(), "@/s.json"]);
  });

  test("listModelsFn normalizes pi's padded table output from stderr", async () => {
    const table = "Provider Model\nminimax  MiniMax-M2.7  extra\nopenai  gpt-4o\n\n";
    const ex = piExecutor({ execFileFn: async () => ({ stdout: "", stderr: table }) });
    assert.equal(await ex.listModelsFn({}), "minimax/MiniMax-M2.7\nopenai/gpt-4o");
  });

  test("resolveExecutor resolves pi to a pi executor", () => {
    assert.equal(resolveExecutor("pi").id, "pi");
  });

  test("binaryName is \"pi\" so startTask can spawn the right CLI", () => {
    assert.equal(piExecutor().binaryName, "pi");
  });
});

describe("piExecutor().sandboxAuthFile (auth and extension binds)", () => {

  test("sandboxAuthFile binds auth and overrides pi data directory", () => {
    const ex = piExecutor();
    assert.deepEqual(ex.sandboxAuthFile({ homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR }, existsFn: (p) => p === PI_AUTH, lstatFn: () => ({ isSymbolicLink: () => false }) }), {
      extraRoBinds: [[PI_AUTH, PI_DATA_AUTH]],
      extraRwPairBinds: [],
      sandboxedDataHome: "/state/run/pi-data",
      sandboxEnv: { PI_CODING_AGENT_DIR: "/state/run/pi-data" },
    });
  });

  test("sandboxAuthFile falls back to ~/.pi/agent", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({ homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {}, existsFn: (p) => p === "/home/user/.pi/agent/auth.json", lstatFn: () => ({ isSymbolicLink: () => false }) });
    assert.deepEqual(result.extraRoBinds, [["/home/user/.pi/agent/auth.json", PI_DATA_AUTH]]);
  });

  test("sandboxAuthFile also binds the real extensions directory read-only, so custom-registered providers still resolve inside the sandbox", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: (p) => p === PI_AUTH || p === PI_EXTENSIONS,
      lstatFn: () => ({ isSymbolicLink: () => false }),
    });
    assert.deepEqual(result.extraRoBinds, [
      [PI_AUTH, PI_DATA_AUTH],
      [PI_EXTENSIONS, "/state/run/pi-data/extensions"],
    ]);
  });

  test("sandboxAuthFile omits the extensions bind when the real extensions directory doesn't exist", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({ homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR }, existsFn: (p) => p === PI_AUTH, lstatFn: () => ({ isSymbolicLink: () => false }) });
    assert.deepEqual(result.extraRoBinds, [[PI_AUTH, PI_DATA_AUTH]]);
  });

  test("sandboxAuthFile drops a symlinked auth.json instead of ro-binding its target", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: (p) => p === PI_AUTH || p === PI_EXTENSIONS,
      // auth.json is a planted symlink (say, at ~/.ssh/config): binding it
      // would ro-bind the link target into the sandbox, so it is dropped
      // while the plain extensions dir still binds.
      lstatFn: (p) => ({ isSymbolicLink: () => p === PI_AUTH }),
    });
    assert.deepEqual(result.extraRoBinds, [
      [PI_EXTENSIONS, "/state/run/pi-data/extensions"],
    ]);
  });

  test("sandboxAuthFile drops a symlinked extensions dir instead of ro-binding its target", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: (p) => p === PI_AUTH || p === PI_EXTENSIONS,
      lstatFn: (p) => ({ isSymbolicLink: () => p === PI_EXTENSIONS }),
    });
    // The auth bind survives; the symlinked extensions dir is skipped.
    assert.deepEqual(result.extraRoBinds, [
      [PI_AUTH, PI_DATA_AUTH],
    ]);
  });
});

describe("piExecutor().sandboxAuthFile (catalog binds)", () => {

  test("sandboxAuthFile resolves a symlinked models.json to its real target instead of dropping it", () => {
    const ex = piExecutor();
    const PI_MODELS = "/custom/pi/models.json";
    const PI_MODELS_REAL = "/dotfiles/pi/agent/models.json";
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      taskId: TASK_ID,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: (p) => p === PI_MODELS,
      lstatFn: (p) => ({ isSymbolicLink: () => p === PI_MODELS }),
      realpathFn: () => PI_MODELS_REAL,
    });
    // A dotfiles-managed models.json is a symlink; issue #563: the old
    // strict skip-symlink behavior dropped it, so every catalog-backed
    // provider (ollama, meta, colab, nanogpt) was "Unknown provider".
    assert.deepEqual(result.extraRoBinds, [
      [PI_MODELS_REAL, "/state/run/pi-data/models.json"],
    ]);
  });

  test("sandboxAuthFile binds a regular (non-symlink) models.json as-is", () => {
    const ex = piExecutor();
    const PI_MODELS = "/custom/pi/models.json";
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      taskId: TASK_ID,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: (p) => p === PI_MODELS,
      lstatFn: () => ({ isSymbolicLink: () => false }),
      realpathFn: (p) => p,
    });
    assert.deepEqual(result.extraRoBinds, [
      [PI_MODELS, "/state/run/pi-data/models.json"],
    ]);
  });
});

describe("piExecutor().sandboxAuthFile (single session bind)", () => {

  test("sandboxAuthFile binds the single resumed session file read-write (not the whole sessions directory), scoping pi writes to that one session only", () => {
    const ex = piExecutor();
    const realSessionsDir = PI_SESSIONS;
    const realSafePathDir = `${realSessionsDir}/--home-user-projects-foo--`;
    const realSessionFile = `${realSafePathDir}/2026-07-23T21-42-41-761Z_019f90ea-1234-70e0-98dc-6847db316eb4.jsonl`;
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: (p) => p === PI_AUTH || p === realSessionsDir,
      statFn: (p) => (p === realSessionsDir ? { isDirectory: () => true } : null),
      readdirFn: (p) => (p === realSafePathDir ? [realSessionFile.split("/").pop()] : []),
      lstatFn: () => ({ isSymbolicLink: () => false }),
      sessionId: SESSION_ID_PREFIX,
      launchDirectory: LAUNCH_DIR_FOO,
    });
    assert.deepEqual(result.extraRoBinds, [[PI_AUTH, PI_DATA_AUTH]]);
    // The bind is the SINGLE resumed session file mapped onto the matching
    // path inside the sandboxed sessions tree -- not the whole `sessions/`
    // directory, which would have let the worker tamper with every other
    // session in the user's pi history.
    assert.deepEqual(result.extraRwPairBinds, [
      [realSessionFile, "/state/run/pi-data/sessions/--home-user-projects-foo--/2026-07-23T21-42-41-761Z_019f90ea-1234-70e0-98dc-6847db316eb4.jsonl"],
    ]);
  });

  test("sandboxAuthFile matches a sessionId prefix to a session file under the per-cwd encoded subdirectory", () => {
    const ex = piExecutor();
    const realSafePathDir = PI_SESSIONS_FOO_DIR;
    const realSessionFile = `${realSafePathDir}/2026-07-23T21-42-41-761Z_019f90ea-1234-70e0-98dc-6847db316eb4.jsonl`;
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: () => true,
      statFn: (p) => (p === PI_SESSIONS ? { isDirectory: () => true } : null),
      readdirFn: (p) => (p === realSafePathDir ? [SESSION_FILE] : []),
      lstatFn: () => ({ isSymbolicLink: () => false }),
      // A UUID prefix -- pi's own --session <id> resolver accepts the same.
      sessionId: "019f90ea",
      launchDirectory: LAUNCH_DIR_FOO,
    });
    assert.equal(result.extraRwPairBinds.length, 1);
    assert.equal(result.extraRwPairBinds[0][0], realSessionFile);
    assert.equal(result.extraRwPairBinds[0][1], "/state/run/pi-data/sessions/--home-user-projects-foo--/2026-07-23T21-42-41-761Z_019f90ea-1234-70e0-98dc-6847db316eb4.jsonl");
  });

  test("sandboxAuthFile binds a literal session file path verbatim when sessionId looks like a path (no readdir scan)", () => {
    const ex = piExecutor();
    const literalSessionPath = "/custom/pi/sessions/--home-user-projects-bar--/manual-session.jsonl";
    const readdirCalls = [];
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: () => true,
      statFn: () => ({ isDirectory: () => true }),
      readdirFn: (p) => { readdirCalls.push(p); return []; },
      lstatFn: () => ({ isSymbolicLink: () => false }),
      sessionId: literalSessionPath,
      launchDirectory: "/home/user/projects/bar",
    });
    assert.deepEqual(result.extraRwPairBinds, [[literalSessionPath, "/state/run/pi-data/sessions/--home-user-projects-bar--/manual-session.jsonl"]]);
    // A path-shaped sessionId must not trigger a readdir of the per-cwd
    // subdirectory -- pi treats it as a literal path, no lookup needed.
    assert.equal(readdirCalls.length, 0);
  });

  test("sandboxAuthFile drops a symlinked resumed session file (prefix match), so the read-write bind never exposes the link target", () => {
    const ex = piExecutor();
    const realSafePathDir = PI_SESSIONS_FOO_DIR;
    const realSessionFile = `${realSafePathDir}/2026-07-23T21-42-41-761Z_019f90ea-1234-70e0-98dc-6847db316eb4.jsonl`;
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: () => true,
      statFn: () => ({ isDirectory: () => true }),
      readdirFn: (p) => (p === realSafePathDir ? [SESSION_FILE] : []),
      // The matched session file is a symlink pointing elsewhere: a resumed
      // session bind is read-write, so binding it would hand the worker
      // write access to the link's target. Fail closed: bind nothing.
      lstatFn: (p) => ({ isSymbolicLink: () => p === realSessionFile }),
      sessionId: "019f90ea",
      launchDirectory: LAUNCH_DIR_FOO,
    });
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile drops a symlinked literal-path session file (path-shaped sessionId)", () => {
    const ex = piExecutor();
    const literalSessionPath = "/custom/pi/sessions/--home-user-projects-bar--/manual-session.jsonl";
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: () => true,
      statFn: () => ({ isDirectory: () => true }),
      readdirFn: () => [],
      lstatFn: (p) => ({ isSymbolicLink: () => p === literalSessionPath }),
      sessionId: literalSessionPath,
      launchDirectory: "/home/user/projects/bar",
    });
    assert.deepEqual(result.extraRwPairBinds, []);
  });
});

describe("piExecutor().sandboxAuthFile (session bind guards)", () => {

  test("sandboxAuthFile omits the sessions bind when no sessionId was given (fresh dispatch, not a resume)", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: (p) => p === PI_AUTH || p === PI_SESSIONS,
      lstatFn: () => ({ isSymbolicLink: () => false }),
      // no sessionId -- a fresh dispatch, not a resume.
    });
    assert.deepEqual(result.extraRoBinds, [[PI_AUTH, PI_DATA_AUTH]]);
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile omits the sessions bind when the real sessions directory doesn't exist", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({ homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR }, existsFn: (p) => p === PI_AUTH, lstatFn: () => ({ isSymbolicLink: () => false }) });
    assert.deepEqual(result.extraRoBinds, [[PI_AUTH, PI_DATA_AUTH]]);
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile omits the sessions bind when the per-cwd subdirectory has no matching session file", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: () => true,
      statFn: () => ({ isDirectory: () => true }),
      readdirFn: () => ["unrelated.jsonl"], // No file with this sessionId prefix.
      lstatFn: () => ({ isSymbolicLink: () => false }),
      sessionId: "nonexistent",
      launchDirectory: LAUNCH_DIR_FOO,
    });
    // Better to bind nothing than to bind the wrong file: a wrong-file bind
    // would let the worker persist resume state into someone else's session.
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile omits the sessions bind when the per-cwd subdirectory has multiple matching session files (ambiguous prefix)", () => {
    const ex = piExecutor();
    const realSafePathDir = PI_SESSIONS_FOO_DIR;
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: () => true,
      statFn: () => ({ isDirectory: () => true }),
      readdirFn: (p) => (
        p === realSafePathDir
          ? [
              SESSION_FILE,
              "2026-07-24T09-00-00-000Z_019f90ea-9999-70e0-98dc-6847db316eb4.jsonl",
            ]
          : []
      ),
      lstatFn: () => ({ isSymbolicLink: () => false }),
      // A short prefix matches two distinct files -- pi's own resolver
      // surfaces "no session found matching..." to the user. We can't do
      // that from here, and a guess would write to the wrong file.
      sessionId: "019f90ea",
      launchDirectory: LAUNCH_DIR_FOO,
    });
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile omits the sessions bind when the real sessions path exists but isn't a directory (isDirectory guard)", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: (p) => p === PI_AUTH || p === PI_SESSIONS,
      lstatFn: () => ({ isSymbolicLink: () => false }),
      // existsFn lies and says the path is there, but statFn reports it as
      // a stray non-directory file (e.g. a stale symlink to a regular file).
      statFn: (p) => (p === PI_SESSIONS ? { isDirectory: () => false } : null),
      sessionId: SESSION_ID_PREFIX,
      launchDirectory: LAUNCH_DIR_FOO,
    });
    // A bwrap --bind of a non-directory file at the destination directory
    // path would fail; the right answer is to skip the bind entirely.
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile omits the sessions bind when statFn throws on the real sessions path", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: (p) => p === PI_AUTH || p === PI_SESSIONS,
      lstatFn: () => ({ isSymbolicLink: () => false }),
      statFn: () => { throw new Error("EACCES"); },
      sessionId: SESSION_ID_PREFIX,
      launchDirectory: LAUNCH_DIR_FOO,
    });
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile omits the sessions bind when readdirFn throws on the per-cwd subdirectory", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: () => true,
      statFn: () => ({ isDirectory: () => true }),
      readdirFn: () => { throw new Error("EACCES"); },
      lstatFn: () => ({ isSymbolicLink: () => false }),
      sessionId: SESSION_ID_PREFIX,
      launchDirectory: LAUNCH_DIR_FOO,
    });
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile computes the per-cwd encoded subdirectory exactly like pi's getDefaultSessionDir does", () => {
    // Encoded the same way pi's core/session-manager.js getDefaultSessionDir
    // does: `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`.
    // A drift here silently breaks every resume by looking in the wrong
    // directory inside the sandbox, so we pin it via a spy on readdirFn.
    const ex = piExecutor();
    const seenPaths = [];
    const realSafePathDir = "/custom/pi/sessions/--var-folders-abc-T-project--";
    ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      spawnEnv: { PI_CODING_AGENT_DIR: PI_AGENT_DIR },
      existsFn: () => true,
      statFn: () => ({ isDirectory: () => true }),
      readdirFn: (p) => { seenPaths.push(p); return p === realSafePathDir ? [SESSION_FILE] : []; },
      lstatFn: () => ({ isSymbolicLink: () => false }),
      sessionId: SESSION_ID_PREFIX,
      launchDirectory: "/var/folders/abc/T/project",
    });
    // Leading slash is stripped and inner slashes are dashed -- same as pi.
    assert.ok(seenPaths.includes(realSafePathDir), `expected readdirFn to be called with ${realSafePathDir}, got ${JSON.stringify(seenPaths)}`);
  });
});

describe("piExecutor().normalizeLogEvent", () => {
  const ex = piExecutor();

  test("session event maps to {sessionID}", () => {
    const evt = { type: "session", version: 3, id: SESSION_ID_PREFIX, timestamp: "2026-07-23T21:42:41.761Z", cwd: "/tmp" };
    assert.deepEqual(ex.normalizeLogEvent(evt), { sessionID: SESSION_ID_PREFIX });
  });

  test("text_start produces no event (no delta yet)", () => {
    const evt = {
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
      message: { role: "assistant", responseId: "06b1bce4cdb53b25ebd32ffbbf5c6b83" },
    };
    assert.equal(ex.normalizeLogEvent(evt), null);
  });

  test("text_delta maps to a text event keyed by message.responseId", () => {
    const evt = {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "PONG" },
      message: { role: "assistant", responseId: "06b1bce4cdb53b25ebd32ffbbf5c6b83" },
    };
    assert.deepEqual(ex.normalizeLogEvent(evt), { type: "text", part: { type: "text", text: "PONG", messageID: "06b1bce4cdb53b25ebd32ffbbf5c6b83" } });
  });

  test("thinking_delta and text_end produce no event", () => {
    assert.equal(ex.normalizeLogEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "..." }, message: {} }), null);
    assert.equal(ex.normalizeLogEvent({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "PONG" }, message: {} }), null);
  });

  test("agent_start/turn_start/turn_end produce no event", () => {
    assert.equal(ex.normalizeLogEvent({ type: "agent_start" }), null);
    assert.equal(ex.normalizeLogEvent({ type: "turn_start" }), null);
    assert.equal(ex.normalizeLogEvent({ type: "turn_end", message: {} }), null);
  });

  test("tool_execution_start and tool_execution_update produce a minimal tool_progress heartbeat, not a full tool_use event", () => {
    // Previously these returned null (dropped entirely), so a single
    // long-running tool call produced zero log growth for its whole
    // duration -- only tool_execution_end ever wrote anything. Now they
    // write a minimal marker so the no-output watchdog sees real activity
    // while a slow tool is still in flight, without inflating narration
    // with a full input/output payload the way normalizeToolExecutionEnd's
    // tool_use event does.
    assert.deepEqual(
      ex.normalizeLogEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "echo hi" } }),
      { type: "tool_progress", part: { type: "tool-progress", tool: "bash", toolCallId: "c1" } }
    );
    assert.deepEqual(
      ex.normalizeLogEvent({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [] } }),
      { type: "tool_progress", part: { type: "tool-progress", tool: "bash", toolCallId: "c1" } }
    );
  });

  test("tool_execution_end maps to a single tool_use event with lowercase tool name", () => {
    const evt = {
      type: "tool_execution_end", toolCallId: "call_function_5p8j2prhbb7c_1", toolName: "bash",
      args: { command: "echo hello-from-pi-tool-test" },
      result: { content: [{ type: "text", text: "hello-from-pi-tool-test\n" }] },
      isError: false,
    };
    assert.deepEqual(ex.normalizeLogEvent(evt), {
      type: "tool_use",
      part: { type: "tool", tool: "bash", state: { input: { command: "echo hello-from-pi-tool-test" }, output: "hello-from-pi-tool-test\n" } },
    });
  });

  test("agent_end scans for the last assistant message and emits step_finish with tokens/cost", () => {
    const evt = {
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant", stopReason: "stop", responseId: "resp-1",
          content: [{ type: "text", text: "PONG" }],
          usage: { input: 0, output: 18, cacheRead: 0, cacheWrite: 1507, totalTokens: 1525, cost: { input: 0, output: 0.0000216, cacheRead: 0, cacheWrite: 0.000565125, total: 0.000586725 } },
        },
      ],
    };
    assert.deepEqual(ex.normalizeLogEvent(evt), {
      type: "step_finish",
      part: {
        type: "step-finish", reason: "stop", messageID: "resp-1",
        tokens: { input: 0, output: 18, cacheRead: 0, cacheWrite: 1507, totalTokens: 1525, cost: { input: 0, output: 0.0000216, cacheRead: 0, cacheWrite: 0.000565125, total: 0.000586725 } },
        cost: 0.000586725,
      },
    });
  });

  test("agent_end with a stopReason:\"error\" final message emits a structured error event", () => {
    const evt = {
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", stopReason: "error", errorMessage: RATE_LIMIT_MESSAGE, responseId: "resp-2" },
      ],
    };
    assert.deepEqual(ex.normalizeLogEvent(evt), {
      type: "error",
      message: RATE_LIMIT_MESSAGE,
      error: { name: "pi_error", data: { message: RATE_LIMIT_MESSAGE } },
    });
  });

  test("agent_end with no assistant message produces no event", () => {
    assert.equal(ex.normalizeLogEvent({ type: "agent_end", messages: [{ role: "user", content: [] }] }), null);
  });

  test("unrecognized event types produce no event", () => {
    assert.equal(ex.normalizeLogEvent({ type: "some_future_pi_event", data: {} }), null);
  });
});

