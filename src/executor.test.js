import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { opencodeExecutor, piExecutor, resolveExecutor } from "./executor.js";



describe("piExecutor()", () => {
  test("exposes pi identity and defaults", () => {
    const ex = piExecutor();
    assert.equal(ex.id, "pi");
    assert.equal(ex.taskIdPrefix, "pi");
    assert.equal(ex.errorBucketPrefix, "pi");
    assert.equal(ex.defaultModel, "minimax/MiniMax-M2.7");
  });

  test("buildSpawnArgs splits provider/model and supports session", () => {
    const ex = piExecutor();
    assert.deepEqual(ex.buildSpawnArgs({ isSummary: false, model: "minimax/MiniMax-M2.7", launchDirectory: "/work", promptFilePath: null, prompt: "hi", sessionId: "ses" }), ["--provider", "minimax", "--model", "MiniMax-M2.7", "--mode", "json", "--continue", "--session", "ses", "-p", "hi"]);
    assert.deepEqual(ex.buildSpawnArgs({ isSummary: false, model: "gpt-4o", launchDirectory: "/work", promptFilePath: "/p", prompt: "huge", sessionId: null }), ["--model", "gpt-4o", "--mode", "json", "-p", "Follow the instructions in the attached prompt file exactly.", "@/p"]);
  });

  test("buildSpawnArgs maps --variant to pi's --thinking flag, dispatch only", () => {
    const ex = piExecutor();
    assert.deepEqual(
      ex.buildSpawnArgs({ isSummary: false, model: "minimax/MiniMax-M2.7", launchDirectory: "/work", promptFilePath: null, prompt: "hi", sessionId: null, variant: "high" }),
      ["--provider", "minimax", "--model", "MiniMax-M2.7", "--mode", "json", "--thinking", "high", "-p", "hi"]
    );
    assert.deepEqual(
      ex.buildSpawnArgs({ isSummary: true, model: "minimax/MiniMax-M2.7", launchDirectory: "/work", snapshotPath: "/s.json", prompt: "", sessionId: null, variant: "high" }),
      ["--provider", "minimax", "--model", "MiniMax-M2.7", "--mode", "json", "-p", ex.buildSummaryPrompt(), "@/s.json"]
    );
  });

  test("buildSpawnArgs uses snapshot attachment for summaries", () => {
    const ex = piExecutor();
    assert.deepEqual(ex.buildSpawnArgs({ isSummary: true, model: "minimax/MiniMax-M2.7", launchDirectory: "/work", snapshotPath: "/s.json", prompt: "", sessionId: null }), ["--provider", "minimax", "--model", "MiniMax-M2.7", "--mode", "json", "-p", ex.buildSummaryPrompt(), "@/s.json"]);
  });

  test("listModelsFn normalizes pi's padded table output from stderr", async () => {
    const table = "Provider Model\nminimax  MiniMax-M2.7  extra\nopenai  gpt-4o\n\n";
    const ex = piExecutor({ execFileFn: async () => ({ stdout: "", stderr: table }) });
    assert.equal(await ex.listModelsFn({}), "minimax/MiniMax-M2.7\nopenai/gpt-4o");
  });

  test("sandboxAuthFile binds auth and overrides pi data directory", () => {
    const ex = piExecutor();
    assert.deepEqual(ex.sandboxAuthFile({ homeDir: "/home/user", dataDir: "/state/run", spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" }, existsFn: (p) => p === "/custom/pi/auth.json" }), {
      extraRoBinds: [["/custom/pi/auth.json", "/state/run/pi-data/auth.json"]],
      extraRwPairBinds: [],
      sandboxedDataHome: "/state/run/pi-data",
      sandboxEnv: { PI_CODING_AGENT_DIR: "/state/run/pi-data" },
    });
  });

  test("resolveExecutor resolves pi to a pi executor", () => {
    assert.equal(resolveExecutor("pi").id, "pi");
  });

  test("binaryName is \"pi\" so startTask can spawn the right CLI", () => {
    assert.equal(piExecutor().binaryName, "pi");
  });

  test("sandboxAuthFile falls back to ~/.pi/agent", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({ homeDir: "/home/user", dataDir: "/state/run", spawnEnv: {}, existsFn: (p) => p === "/home/user/.pi/agent/auth.json" });
    assert.deepEqual(result.extraRoBinds, [["/home/user/.pi/agent/auth.json", "/state/run/pi-data/auth.json"]]);
  });

  test("sandboxAuthFile also binds the real extensions directory read-only, so custom-registered providers still resolve inside the sandbox", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: "/home/user",
      dataDir: "/state/run",
      spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" },
      existsFn: (p) => p === "/custom/pi/auth.json" || p === "/custom/pi/extensions",
    });
    assert.deepEqual(result.extraRoBinds, [
      ["/custom/pi/auth.json", "/state/run/pi-data/auth.json"],
      ["/custom/pi/extensions", "/state/run/pi-data/extensions"],
    ]);
  });

  test("sandboxAuthFile omits the extensions bind when the real extensions directory doesn't exist", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({ homeDir: "/home/user", dataDir: "/state/run", spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" }, existsFn: (p) => p === "/custom/pi/auth.json" });
    assert.deepEqual(result.extraRoBinds, [["/custom/pi/auth.json", "/state/run/pi-data/auth.json"]]);
  });

  test("sandboxAuthFile binds the single resumed session file read-write (not the whole sessions directory), scoping pi writes to that one session only", () => {
    const ex = piExecutor();
    const realSessionsDir = "/custom/pi/sessions";
    const realSafePathDir = `${realSessionsDir}/--home-user-projects-foo--`;
    const realSessionFile = `${realSafePathDir}/2026-07-23T21-42-41-761Z_019f90ea-1234-70e0-98dc-6847db316eb4.jsonl`;
    const result = ex.sandboxAuthFile({
      homeDir: "/home/user",
      dataDir: "/state/run",
      spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" },
      existsFn: (p) => p === "/custom/pi/auth.json" || p === realSessionsDir,
      statFn: (p) => (p === realSessionsDir ? { isDirectory: () => true } : null),
      readdirFn: (p) => (p === realSafePathDir ? [realSessionFile.split("/").pop()] : []),
      sessionId: "019f90ea-1234-70e0-98dc-6847db316eb4",
      launchDirectory: "/home/user/projects/foo",
    });
    assert.deepEqual(result.extraRoBinds, [["/custom/pi/auth.json", "/state/run/pi-data/auth.json"]]);
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
    const realSafePathDir = "/custom/pi/sessions/--home-user-projects-foo--";
    const realSessionFile = `${realSafePathDir}/2026-07-23T21-42-41-761Z_019f90ea-1234-70e0-98dc-6847db316eb4.jsonl`;
    const result = ex.sandboxAuthFile({
      homeDir: "/home/user",
      dataDir: "/state/run",
      spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" },
      existsFn: () => true,
      statFn: (p) => (p === "/custom/pi/sessions" ? { isDirectory: () => true } : null),
      readdirFn: (p) => (p === realSafePathDir ? ["2026-07-23T21-42-41-761Z_019f90ea-1234-70e0-98dc-6847db316eb4.jsonl"] : []),
      // A UUID prefix -- pi's own --session <id> resolver accepts the same.
      sessionId: "019f90ea",
      launchDirectory: "/home/user/projects/foo",
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
      homeDir: "/home/user",
      dataDir: "/state/run",
      spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" },
      existsFn: () => true,
      statFn: () => ({ isDirectory: () => true }),
      readdirFn: (p) => { readdirCalls.push(p); return []; },
      sessionId: literalSessionPath,
      launchDirectory: "/home/user/projects/bar",
    });
    assert.deepEqual(result.extraRwPairBinds, [[literalSessionPath, "/state/run/pi-data/sessions/--home-user-projects-bar--/manual-session.jsonl"]]);
    // A path-shaped sessionId must not trigger a readdir of the per-cwd
    // subdirectory -- pi treats it as a literal path, no lookup needed.
    assert.equal(readdirCalls.length, 0);
  });

  test("sandboxAuthFile omits the sessions bind when a literal session file path doesn't exist on the host", () => {
    const ex = piExecutor();
    const literalSessionPath = "/custom/pi/sessions/--home-user-projects-bar--/missing-session.jsonl";
    const result = ex.sandboxAuthFile({
      homeDir: "/home/user",
      dataDir: "/state/run",
      spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" },
      // existsFn says everything else is real, but not this specific file --
      // bwrap's plain --bind hard-fails the sandbox launch if the source is
      // missing, so this must be caught here rather than left to bwrap.
      existsFn: (p) => p !== literalSessionPath,
      statFn: () => ({ isDirectory: () => true }),
      sessionId: literalSessionPath,
      launchDirectory: "/home/user/projects/bar",
    });
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile omits the sessions bind when no sessionId was given (fresh dispatch, not a resume)", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: "/home/user",
      dataDir: "/state/run",
      spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" },
      existsFn: (p) => p === "/custom/pi/auth.json" || p === "/custom/pi/sessions",
      // no sessionId -- a fresh dispatch, not a resume.
    });
    assert.deepEqual(result.extraRoBinds, [["/custom/pi/auth.json", "/state/run/pi-data/auth.json"]]);
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile omits the sessions bind when the real sessions directory doesn't exist", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({ homeDir: "/home/user", dataDir: "/state/run", spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" }, existsFn: (p) => p === "/custom/pi/auth.json" });
    assert.deepEqual(result.extraRoBinds, [["/custom/pi/auth.json", "/state/run/pi-data/auth.json"]]);
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile omits the sessions bind when the per-cwd subdirectory has no matching session file", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: "/home/user",
      dataDir: "/state/run",
      spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" },
      existsFn: () => true,
      statFn: () => ({ isDirectory: () => true }),
      readdirFn: () => ["unrelated.jsonl"], // No file with this sessionId prefix.
      sessionId: "nonexistent",
      launchDirectory: "/home/user/projects/foo",
    });
    // Better to bind nothing than to bind the wrong file: a wrong-file bind
    // would let the worker persist resume state into someone else's session.
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile omits the sessions bind when the per-cwd subdirectory has multiple matching session files (ambiguous prefix)", () => {
    const ex = piExecutor();
    const realSafePathDir = "/custom/pi/sessions/--home-user-projects-foo--";
    const result = ex.sandboxAuthFile({
      homeDir: "/home/user",
      dataDir: "/state/run",
      spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" },
      existsFn: () => true,
      statFn: () => ({ isDirectory: () => true }),
      readdirFn: (p) => (
        p === realSafePathDir
          ? [
              "2026-07-23T21-42-41-761Z_019f90ea-1234-70e0-98dc-6847db316eb4.jsonl",
              "2026-07-24T09-00-00-000Z_019f90ea-9999-70e0-98dc-6847db316eb4.jsonl",
            ]
          : []
      ),
      // A short prefix matches two distinct files -- pi's own resolver
      // surfaces "no session found matching..." to the user. We can't do
      // that from here, and a guess would write to the wrong file.
      sessionId: "019f90ea",
      launchDirectory: "/home/user/projects/foo",
    });
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile omits the sessions bind when the real sessions path exists but isn't a directory (isDirectory guard)", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: "/home/user",
      dataDir: "/state/run",
      spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" },
      existsFn: (p) => p === "/custom/pi/auth.json" || p === "/custom/pi/sessions",
      // existsFn lies and says the path is there, but statFn reports it as
      // a stray non-directory file (e.g. a stale symlink to a regular file).
      statFn: (p) => (p === "/custom/pi/sessions" ? { isDirectory: () => false } : null),
      sessionId: "019f90ea-1234-70e0-98dc-6847db316eb4",
      launchDirectory: "/home/user/projects/foo",
    });
    // A bwrap --bind of a non-directory file at the destination directory
    // path would fail; the right answer is to skip the bind entirely.
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile omits the sessions bind when statFn throws on the real sessions path", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: "/home/user",
      dataDir: "/state/run",
      spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" },
      existsFn: (p) => p === "/custom/pi/auth.json" || p === "/custom/pi/sessions",
      statFn: () => { throw new Error("EACCES"); },
      sessionId: "019f90ea-1234-70e0-98dc-6847db316eb4",
      launchDirectory: "/home/user/projects/foo",
    });
    assert.deepEqual(result.extraRwPairBinds, []);
  });

  test("sandboxAuthFile omits the sessions bind when readdirFn throws on the per-cwd subdirectory", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: "/home/user",
      dataDir: "/state/run",
      spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" },
      existsFn: () => true,
      statFn: () => ({ isDirectory: () => true }),
      readdirFn: () => { throw new Error("EACCES"); },
      sessionId: "019f90ea-1234-70e0-98dc-6847db316eb4",
      launchDirectory: "/home/user/projects/foo",
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
      homeDir: "/home/user",
      dataDir: "/state/run",
      spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" },
      existsFn: () => true,
      statFn: () => ({ isDirectory: () => true }),
      readdirFn: (p) => { seenPaths.push(p); return p === realSafePathDir ? ["2026-07-23T21-42-41-761Z_019f90ea-1234-70e0-98dc-6847db316eb4.jsonl"] : []; },
      sessionId: "019f90ea-1234-70e0-98dc-6847db316eb4",
      launchDirectory: "/var/folders/abc/T/project",
    });
    // Leading slash is stripped and inner slashes are dashed -- same as pi.
    assert.ok(seenPaths.includes(realSafePathDir), `expected readdirFn to be called with ${realSafePathDir}, got ${JSON.stringify(seenPaths)}`);
  });
});

describe("piExecutor().normalizeLogEvent", () => {
  const ex = piExecutor();

  test("session event maps to {sessionID}", () => {
    const evt = { type: "session", version: 3, id: "019f90ea-1234-70e0-98dc-6847db316eb4", timestamp: "2026-07-23T21:42:41.761Z", cwd: "/tmp" };
    assert.deepEqual(ex.normalizeLogEvent(evt), { sessionID: "019f90ea-1234-70e0-98dc-6847db316eb4" });
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

  test("tool_execution_start and tool_execution_update produce no event", () => {
    assert.equal(ex.normalizeLogEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "echo hi" } }), null);
    assert.equal(ex.normalizeLogEvent({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [] } }), null);
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
        { role: "assistant", stopReason: "error", errorMessage: "rate limit exceeded", responseId: "resp-2" },
      ],
    };
    assert.deepEqual(ex.normalizeLogEvent(evt), {
      type: "error",
      message: "rate limit exceeded",
      error: { name: "pi_error", data: { message: "rate limit exceeded" } },
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
      isSummary: false, model: "openai/gpt-5.6-luna", variant: null,
      launchDirectory: "/work/dir", promptFilePath: null, prompt: "do the thing", sessionId: null,
    });
    assert.deepEqual(args, ["run", "--dir", "/work/dir", "--auto", "--format", "json", "-m", "openai/gpt-5.6-luna", "--", "do the thing"]);
  });

  test("buildSpawnArgs: dispatch with variant and session resume", () => {
    const ex = opencodeExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: "openai/gpt-5.6-luna", variant: "high",
      launchDirectory: "/work/dir", promptFilePath: null, prompt: "do the thing", sessionId: "ses_1",
    });
    assert.deepEqual(args, ["run", "--dir", "/work/dir", "--auto", "--format", "json", "-m", "openai/gpt-5.6-luna", "--continue", "--session", "ses_1", "--variant", "high", "--", "do the thing"]);
  });

  test("buildSpawnArgs: prompt routed through a file", () => {
    const ex = opencodeExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: "openai/gpt-5.6-luna", variant: null,
      launchDirectory: "/work/dir", promptFilePath: "/state/prompts/t1.prompt.txt", prompt: "huge prompt", sessionId: null,
    });
    assert.deepEqual(args, ["run", "--dir", "/work/dir", "--auto", "--format", "json", "-m", "openai/gpt-5.6-luna", "-f", "/state/prompts/t1.prompt.txt", "--", "Follow the instructions in the attached prompt file exactly."]);
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

  test("sandboxAuthFile: binds real auth.json when present", () => {
    const ex = opencodeExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: "/home/user", dataDir: "/state/run", spawnEnv: {},
      existsFn: (p) => p === "/home/user/.local/share/opencode/auth.json",
    });
    assert.deepEqual(result, {
      extraRoBinds: [["/home/user/.local/share/opencode/auth.json", "/state/run/opencode-data/opencode/auth.json"]],
      sandboxedDataHome: "/state/run/opencode-data",
      sandboxEnv: { XDG_DATA_HOME: "/state/run/opencode-data" },
    });
  });

  test("sandboxAuthFile: no bind when auth.json is missing", () => {
    const ex = opencodeExecutor();
    const result = ex.sandboxAuthFile({ homeDir: "/home/user", dataDir: "/state/run", spawnEnv: {}, existsFn: () => false });
    assert.deepEqual(result.extraRoBinds, []);
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
});
