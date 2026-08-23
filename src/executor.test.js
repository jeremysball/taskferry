import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { opencodeExecutor, piExecutor, resolveExecutor } from "./executor.js";
const PI_MODEL = "minimax/MiniMax-M2.7";
const PI_MODEL_SHORT = "MiniMax-M2.7";
const PROVIDER_FLAG = "--provider";
const OPENAI_MODEL = "openai/gpt-5.6-luna";
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
const DISPATCH_PROMPT = "do the thing";
const OPENCODE_CONFIG_DIR = "/home/user/.config/opencode";
const OPENCODE_JSONC = "opencode.jsonc";
// Per-task data home (issue #501): each dispatch gets its own opencode data
// dir, so concurrent dispatches never contend on one opencode.db.
const TASK_ID = "oc_task1";
const SANDBOXED_DATA_HOME = `${DATA_DIR}/opencode-data/${TASK_ID}`;
const SANDBOXED_CONFIG_HOME = `${SANDBOXED_DATA_HOME}/config`;
const SANDBOXED_CONFIG_DIR = `${SANDBOXED_CONFIG_HOME}/opencode`;
const OPENCODE_JSONC_DEST = `${SANDBOXED_CONFIG_DIR}/opencode.jsonc`;
const PLUGINS_DEST = `${SANDBOXED_CONFIG_DIR}/plugins`;
const PI_EXTENSIONS = "/custom/pi/extensions";
const PI_SESSIONS_FOO_DIR = "/custom/pi/sessions/--home-user-projects-foo--";
const OPENCODE_AUTH = "/home/user/.local/share/opencode/auth.json";





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
    assert.deepEqual(ex.buildSpawnArgs({ isSummary: false, model: "gpt-4o", launchDirectory: "/work", promptFilePath: "/p", prompt: "huge", sessionId: null }), ["--model", "gpt-4o", "--mode", "json", "-p", "Follow the instructions in the attached prompt file exactly.", "@/p"]);
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

describe("opencodeExecutor()", () => {
  test("id/taskIdPrefix/errorBucketPrefix", () => {
    const ex = opencodeExecutor();
    assert.equal(ex.id, "opencode");
    assert.equal(ex.taskIdPrefix, "oc");
    assert.equal(ex.errorBucketPrefix, "opencode");
  });

  test("buildSpawnArgs: plain dispatch", () => {
    const ex = opencodeExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: OPENAI_MODEL, variant: null,
      launchDirectory: "/work/dir", promptFilePath: null, prompt: DISPATCH_PROMPT, sessionId: null,
    });
    assert.deepEqual(args, ["run", "--dir", "/work/dir", "--auto", "--format", "json", "-m", OPENAI_MODEL, "--", DISPATCH_PROMPT]);
  });

  test("buildSpawnArgs: dispatch with variant and session resume", () => {
    const ex = opencodeExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: OPENAI_MODEL, variant: "high",
      launchDirectory: "/work/dir", promptFilePath: null, prompt: DISPATCH_PROMPT, sessionId: "ses_1",
    });
    assert.deepEqual(args, ["run", "--dir", "/work/dir", "--auto", "--format", "json", "-m", OPENAI_MODEL, "--continue", "--session", "ses_1", "--variant", "high", "--", DISPATCH_PROMPT]);
  });

  test("buildSpawnArgs: prompt routed through a file", () => {
    const ex = opencodeExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: OPENAI_MODEL, variant: null,
      launchDirectory: "/work/dir", promptFilePath: "/state/prompts/t1.prompt.txt", prompt: "huge prompt", sessionId: null,
    });
    assert.deepEqual(args, ["run", "--dir", "/work/dir", "--auto", "--format", "json", "-m", OPENAI_MODEL, "-f", "/state/prompts/t1.prompt.txt", "--", "Follow the instructions in the attached prompt file exactly."]);
  });

  test("buildSpawnArgs: summary launch", () => {
    const ex = opencodeExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: true, model: "opencode/mimo-v2.5-free", launchDirectory: "/state/summaries",
      snapshotPath: "/state/summaries/oc_1.json", prompt: "", sessionId: null,
    });
    assert.deepEqual(args, [
      "run", "--dir", "/state/summaries", "--pure", "--format", "json", "-m", "opencode/mimo-v2.5-free",
      "-f", "/state/summaries/oc_1.json", "--", ex.buildSummaryPrompt(),
    ]);
  });

  test("normalizeLogEvent is the identity function", () => {
    const ex = opencodeExecutor();
    const evt = { type: "text", part: { text: "hi", messageID: "m1" } };
    assert.equal(ex.normalizeLogEvent(evt), evt);
  });

  test("resolveExecutor: undefined and \"pi\" both resolve to piExecutor", () => {
    assert.equal(resolveExecutor(undefined).id, "pi");
    assert.equal(resolveExecutor("pi").id, "pi");
  });

  test("resolveExecutor: \"opencode\" resolves to opencodeExecutor", () => {
    assert.equal(resolveExecutor("opencode").id, "opencode");
  });

  test("binaryName is \"opencode\" so startTask can spawn the right CLI", () => {
    assert.equal(opencodeExecutor().binaryName, "opencode");
  });

  test("resolveExecutor: unknown name throws", () => {
    assert.throws(() => resolveExecutor("bogus"), /unknown executor: bogus/);
  });

  describe("opencodeExecutor().listModelVariantsFn", () => {
    const FLASH_FREE_MODEL = "opencode/deepseek-v4-flash-free";
    const FIXTURE = [
      FLASH_FREE_MODEL,
      '{"id":"deepseek-v4-flash-free","variants":{"low":{"reasoningEffort":"low"},"high":{"reasoningEffort":"high"},"max":{"reasoningEffort":"max"}}}',
      "opencode/no-variants-model",
      '{"id":"no-variants-model","variants":{}}',
      "minimax/MiniMax-M3",
      '{"id":"MiniMax-M3","variants":{"none":{"thinking":{"type":"disabled"}},"thinking":{"thinking":{"type":"enabled","budgetTokens":16000}}}}',
      "openrouter/openai/gpt-5.6-luna",
      '{"id":"gpt-5.6-luna","variants":{"low":{"reasoningEffort":"low"},"high":{"reasoningEffort":"high"}}}',
    ].join("\n");

    test("parses provider/model blocks into an ordered variant-key map", async () => {
      const ex = opencodeExecutor();
      const result = await ex.listModelVariantsFn(process.env, { execFileFn: async () => ({ stdout: FIXTURE, stderr: "" }) });
      assert.deepEqual(result.get(FLASH_FREE_MODEL), ["low", "high", "max"]);
      assert.deepEqual(result.get("minimax/MiniMax-M3"), ["none", "thinking"]);
    });

    test("parses multi-slash provider/subprovider/model ids (openrouter format)", async () => {
      const ex = opencodeExecutor();
      const result = await ex.listModelVariantsFn(process.env, { execFileFn: async () => ({ stdout: FIXTURE, stderr: "" }) });
      assert.deepEqual(result.get("openrouter/openai/gpt-5.6-luna"), ["low", "high"]);
    });

    test("omits models with no variants from the map", async () => {
      const ex = opencodeExecutor();
      const result = await ex.listModelVariantsFn(process.env, { execFileFn: async () => ({ stdout: FIXTURE, stderr: "" }) });
      assert.equal(result.has("opencode/no-variants-model"), false);
    });

    test("skips a malformed JSON block instead of throwing", async () => {
      const ex = opencodeExecutor();
      const malformed = "opencode/broken-model\n{not valid json\n" + FLASH_FREE_MODEL + "\n" + FIXTURE.split("\n")[1];
      const result = await ex.listModelVariantsFn(process.env, { execFileFn: async () => ({ stdout: malformed, stderr: "" }) });
      assert.equal(result.has("opencode/broken-model"), false);
      assert.deepEqual(result.get(FLASH_FREE_MODEL), ["low", "high", "max"]);
    });
  });
});

describe("opencodeExecutor().sandboxAuthFile (auth and config binds)", () => {

  test("sandboxAuthFile: binds real auth.json when present", () => {
    const ex = opencodeExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
      existsFn: (p) => p === OPENCODE_AUTH,
      lstatFn: () => ({ isSymbolicLink: () => false }),
    });
    assert.deepEqual(result, {
      extraRoBinds: [[OPENCODE_AUTH, `${SANDBOXED_DATA_HOME}/opencode/auth.json`]],
      sandboxedDataHome: SANDBOXED_DATA_HOME,
      // XDG_CONFIG_HOME is redirected unconditionally, whether or not the user
      // has a real opencode config to bind in: opencode writes its own
      // .gitignore there on boot and the real ~/.config is read-only in the
      // sandbox.
      sandboxEnv: { XDG_DATA_HOME: SANDBOXED_DATA_HOME, XDG_CONFIG_HOME: SANDBOXED_CONFIG_HOME },
    });
  });

  test("sandboxAuthFile: drops a symlinked auth.json instead of ro-binding its target", () => {
    const ex = opencodeExecutor();
    const realAuthFile = OPENCODE_AUTH;
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
      existsFn: (p) => p === realAuthFile,
      // A planted symlink at auth.json (e.g. -> ~/.ssh/authorized_keys):
      // binding it would ro-bind the target into the sandbox, so it must be
      // dropped exactly like a symlinked config entry.
      lstatFn: () => ({ isSymbolicLink: () => true }),
    });
    assert.deepEqual(result.extraRoBinds, []);
  });

  test("sandboxAuthFile: ro-binds the real config dir's entries, skipping the .gitignore opencode rewrites on boot", () => {
    const ex = opencodeExecutor();
    const realConfigDir = OPENCODE_CONFIG_DIR;
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
      existsFn: (p) => p === realConfigDir,
      readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "plugins", ".gitignore"] : []),
      lstatFn: () => ({ isSymbolicLink: () => false }),
    });
    assert.deepEqual(result.extraRoBinds, [
      [`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST],
      [`${realConfigDir}/plugins`, PLUGINS_DEST],
    ]);
  });

  test("sandboxAuthFile: resolves a symlinked config entry to its real target and ro-binds that target (dotfiles-managed setup)", () => {
    const ex = opencodeExecutor();
    const realConfigDir = OPENCODE_CONFIG_DIR;
    const resolvedPlanted = "/home/user/.dotfiles/opencode/planted-link";
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
      existsFn: (p) => p === realConfigDir,
      readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "plugins", "planted-link"] : []),
      // planted-link is a dotfiles symlink (e.g. -> ~/.dotfiles/...): it must
      // be resolved and the real target bound read-only at the same
      // sandboxed destination, not dropped.
      lstatFn: (p) => {
        if (p === `${realConfigDir}/planted-link`) return { isSymbolicLink: () => true };
        if (p === resolvedPlanted) return { isSymbolicLink: () => false, isFile: () => true, nlink: 1 };
        return { isSymbolicLink: () => false };
      },
      realpathFn: (p) => {
        if (p === `${realConfigDir}/planted-link`) return resolvedPlanted;
        throw new Error(`unexpected realpath ${p}`);
      },
    });
    assert.deepEqual(result.extraRoBinds, [
      [`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST],
      [`${realConfigDir}/plugins`, PLUGINS_DEST],
      [resolvedPlanted, `${SANDBOXED_CONFIG_DIR}/planted-link`],
    ]);
  });

  test("sandboxAuthFile: symlinked config file (opencode.jsonc) resolves to its real dotfiles target", () => {
    const ex = opencodeExecutor();
    const realConfigDir = OPENCODE_CONFIG_DIR;
    const realTarget = "/home/user/.dotfiles/.config/opencode/opencode.jsonc";
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
      existsFn: (p) => p === realConfigDir,
      readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC] : []),
      lstatFn: (p) => {
        if (p === `${realConfigDir}/${OPENCODE_JSONC}`) return { isSymbolicLink: () => true };
        if (p === realTarget) return { isSymbolicLink: () => false, isFile: () => true, nlink: 1 };
        return { isSymbolicLink: () => false };
      },
      realpathFn: (p) => {
        if (p === `${realConfigDir}/${OPENCODE_JSONC}`) return realTarget;
        throw new Error(`unexpected realpath ${p}`);
      },
    });
    assert.deepEqual(result.extraRoBinds, [[realTarget, OPENCODE_JSONC_DEST]]);
  });

  test("sandboxAuthFile: dangling/broken symlinked config entry fails closed (no crash, entry skipped, other entries still bound)", () => {
    const ex = opencodeExecutor();
    const realConfigDir = OPENCODE_CONFIG_DIR;
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
      existsFn: (p) => p === realConfigDir,
      readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "dangling-link"] : []),
      lstatFn: (p) => {
        if (p === `${realConfigDir}/dangling-link`) return { isSymbolicLink: () => true };
        return { isSymbolicLink: () => false };
      },
      realpathFn: (p) => {
        if (p === `${realConfigDir}/dangling-link`) {
          const err = new Error("ENOENT: no such file or directory, realpath");
          err.code = "ENOENT";
          throw err;
        }
        throw new Error(`unexpected realpath ${p}`);
      },
    });
    assert.deepEqual(result.extraRoBinds, [[`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST]]);
  });

  test("sandboxAuthFile: drops a config entry whose lstat fails, binding nothing it couldn't verify", () => {
    const ex = opencodeExecutor();
    const realConfigDir = OPENCODE_CONFIG_DIR;
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
      existsFn: (p) => p === realConfigDir,
      readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "vanished-entry"] : []),
      lstatFn: (p) => {
        if (p === `${realConfigDir}/vanished-entry`) throw new Error("ENOENT");
        return { isSymbolicLink: () => false };
      },
    });
    assert.deepEqual(result.extraRoBinds, [
      [`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST],
    ]);
  });
});

describe("opencodeExecutor().sandboxAuthFile (symlink and hardlink guard behavior)", () => {

  test("sandboxAuthFile: skips the whole config loop when the config dir itself is a symlink (per-entry guards would all pass otherwise)", () => {
    const ex = opencodeExecutor();
    const realConfigDir = OPENCODE_CONFIG_DIR;
    const readdirCalls = [];
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
      existsFn: (p) => p === realConfigDir,
      readdirFn: (p) => { readdirCalls.push(p); return [OPENCODE_JSONC, "plugins"]; },
      // existsFn/readdirFn follow the symlinked dir, so every entry inside
      // would pass the per-entry lstat guard while the whole tree points
      // elsewhere; the dir itself must be lstat-checked and treated as
      // absent when it is a symlink.
      lstatFn: (p) => ({ isSymbolicLink: () => p === realConfigDir }),
    });
    assert.deepEqual(result.extraRoBinds, []);
    assert.deepEqual(readdirCalls, [], "readdirFn must not be called on a symlinked config dir");
  });

  test("sandboxAuthFile: drops a hardlinked config entry (nlink > 1), which the isSymbolicLink check alone cannot see", () => {
    const ex = opencodeExecutor();
    const realConfigDir = OPENCODE_CONFIG_DIR;
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
      existsFn: (p) => p === realConfigDir,
      readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "hardlinked-secret"] : []),
      // Not a symlink -- a plain fs.Stats-shaped object whose nlink reveals
      // the inode is reachable under a second name on the host. The lstat
      // guard must reject it without rejecting regular entries.
      lstatFn: (p) => {
        if (p === `${realConfigDir}/hardlinked-secret`) {
          return { isSymbolicLink: () => false, isFile: () => true, nlink: 2 };
        }
        return { isSymbolicLink: () => false, isFile: () => true, nlink: 1 };
      },
    });
    assert.deepEqual(result.extraRoBinds, [
      [`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST],
    ]);
  });

  test("sandboxAuthFile: keeps a directory entry whose nlink > 1 (a dir's nlink counts its subdirectories; dirs cannot be hardlinked)", () => {
    const ex = opencodeExecutor();
    const realConfigDir = OPENCODE_CONFIG_DIR;
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
      existsFn: (p) => p === realConfigDir,
      readdirFn: (p) => (p === realConfigDir ? ["plugins"] : []),
      lstatFn: () => ({ isSymbolicLink: () => false, isFile: () => false, nlink: 5 }),
    });
    assert.deepEqual(result.extraRoBinds, [
      [`${realConfigDir}/plugins`, PLUGINS_DEST],
    ]);
  });

  test("sandboxAuthFile: a null-returning lstatFn (the statFn seam's null-on-failure convention) fails closed instead of crashing", () => {
    const ex = opencodeExecutor();
    const realConfigDir = OPENCODE_CONFIG_DIR;
    const result = ex.sandboxAuthFile({
      homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
      existsFn: (p) => p === realConfigDir,
      readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "plugins"] : []),
      // Returns null (entry could not be statted) for everything -- a
      // pre-fix version threw a TypeError on entryStat.isSymbolicLink().
      lstatFn: () => null,
    });
    assert.deepEqual(result.extraRoBinds, []);
  });

  test("sandboxAuthFile: a successfully resolved symlinked config entry does not warn (the resolved target is bound, not skipped)", () => {
    const ex = opencodeExecutor();
    const realConfigDir = OPENCODE_CONFIG_DIR;
    const resolvedPlanted = "/home/user/.dotfiles/opencode/planted-link";
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const result = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realConfigDir,
        readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "planted-link"] : []),
        lstatFn: (p) => {
          if (p === `${realConfigDir}/planted-link`) return { isSymbolicLink: () => true };
          if (p === resolvedPlanted) return { isSymbolicLink: () => false, isFile: () => true, nlink: 1 };
          return { isSymbolicLink: () => false };
        },
        realpathFn: (p) => {
          if (p === `${realConfigDir}/planted-link`) return resolvedPlanted;
          throw new Error(`unexpected realpath ${p}`);
        },
      });
      assert.deepEqual(result.extraRoBinds, [
        [`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST],
        [resolvedPlanted, `${SANDBOXED_CONFIG_DIR}/planted-link`],
      ]);
      assert.equal(warned, "", "a successfully resolved symlink must not warn -- the bind succeeds");
      assert.ok(!warned.includes("opencode.jsonc"), "a bound entry must not be warned about");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("sandboxAuthFile: dangling symlink whose realpath throws ENOENT is skipped silently (no warning), other entries still bound", () => {
    const ex = opencodeExecutor();
    const realConfigDir = OPENCODE_CONFIG_DIR;
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const result = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realConfigDir,
        readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "dangling-link"] : []),
        lstatFn: (p) => {
          if (p === `${realConfigDir}/dangling-link`) return { isSymbolicLink: () => true };
          return { isSymbolicLink: () => false };
        },
        realpathFn: (p) => {
          if (p === `${realConfigDir}/dangling-link`) {
            const err = new Error("ENOENT: no such file or directory, realpath");
            err.code = "ENOENT";
            throw err;
          }
          throw new Error(`unexpected realpath ${p}`);
        },
      });
      assert.deepEqual(result.extraRoBinds, [[`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST]]);
      assert.equal(warned, "", "ENOENT on realpath must be silent, same as ENOENT on lstat");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("sandboxAuthFile: symlink whose realpath throws non-ENOENT (EACCES) warns and is skipped, other entries still bound", () => {
    const ex = opencodeExecutor();
    const realConfigDir = OPENCODE_CONFIG_DIR;
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const result = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realConfigDir,
        readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "forbidden-link"] : []),
        lstatFn: (p) => {
          if (p === `${realConfigDir}/forbidden-link`) return { isSymbolicLink: () => true };
          return { isSymbolicLink: () => false };
        },
        realpathFn: (p) => {
          if (p === `${realConfigDir}/forbidden-link`) {
            const err = new Error("EACCES: permission denied, realpath");
            err.code = "EACCES";
            throw err;
          }
          throw new Error(`unexpected realpath ${p}`);
        },
      });
      assert.deepEqual(result.extraRoBinds, [[`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST]]);
      assert.match(warned, /warning: could not resolve symlink .*forbidden-link \(EACCES: permission denied/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("sandboxAuthFile: swallows ENOENT silently (a vanished entry is an ordinary race) but warns on non-ENOENT lstat failures like EACCES", () => {
    const ex = opencodeExecutor();
    const realConfigDir = OPENCODE_CONFIG_DIR;
    const originalWrite = process.stderr.write;
    let warned = "";
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const silentResult = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realConfigDir,
        readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "vanished"] : []),
        // Real lstatSync ENOENT errors carry err.code === "ENOENT".
        lstatFn: (p) => {
          if (p === `${realConfigDir}/vanished`) {
            const err = new Error("ENOENT: no such file or directory, lstat");
            err.code = "ENOENT";
            throw err;
          }
          return { isSymbolicLink: () => false };
        },
      });
      assert.deepEqual(silentResult.extraRoBinds, [
        [`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST],
      ]);
      assert.equal(warned, "", "a plain ENOENT must not warn -- it is an ordinary exists/lstat race, not a diagnostic");

      const eaccesResult = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realConfigDir,
        readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "forbidden-entry"] : []),
        // EACCES means the entry is unverifiable for a real reason (bad
        // permissions, a dead mount) -- the bind is still skipped (fail
        // closed), but the user must hear about it.
        lstatFn: (p) => {
          if (p === `${realConfigDir}/forbidden-entry`) {
            const err = new Error("EACCES: permission denied, lstat");
            err.code = "EACCES";
            throw err;
          }
          return { isSymbolicLink: () => false };
        },
      });
      assert.deepEqual(eaccesResult.extraRoBinds, [
        [`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST],
      ]);
      assert.match(warned, /warning: could not verify .*forbidden-entry is not a symlink \(EACCES: permission denied/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("sandboxAuthFile: no bind when auth.json is missing", () => {
    const ex = opencodeExecutor();
    const result = ex.sandboxAuthFile({ homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {}, existsFn: () => false });
    assert.deepEqual(result.extraRoBinds, []);
  });
});

test("piExecutor() has no listModelVariantsFn -- pi needs no variant table", () => {
  assert.equal(piExecutor().listModelVariantsFn, undefined);
});
