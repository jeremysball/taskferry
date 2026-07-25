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
    assert.deepEqual(ex.sandboxAuthFile({ homeDir: "/home/user", runtimeDir: "/state/run", spawnEnv: { PI_CODING_AGENT_DIR: "/custom/pi" }, existsFn: (p) => p === "/custom/pi/auth.json" }), {
      extraRoBind: ["/custom/pi/auth.json", "/state/run/pi-data/auth.json"],
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

  test("sandboxAuthFile falls back to ~/.pi", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({ homeDir: "/home/user", runtimeDir: "/state/run", spawnEnv: {}, existsFn: (p) => p === "/home/user/.pi/auth.json" });
    assert.deepEqual(result.extraRoBind, ["/home/user/.pi/auth.json", "/state/run/pi-data/auth.json"]);
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
      homeDir: "/home/user", runtimeDir: "/state/run", spawnEnv: {},
      existsFn: (p) => p === "/home/user/.local/share/opencode/auth.json",
    });
    assert.deepEqual(result, {
      extraRoBind: ["/home/user/.local/share/opencode/auth.json", "/state/run/opencode-data/opencode/auth.json"],
      sandboxedDataHome: "/state/run/opencode-data",
      sandboxEnv: { XDG_DATA_HOME: "/state/run/opencode-data" },
    });
  });

  test("sandboxAuthFile: no bind when auth.json is missing", () => {
    const ex = opencodeExecutor();
    const result = ex.sandboxAuthFile({ homeDir: "/home/user", runtimeDir: "/state/run", spawnEnv: {}, existsFn: () => false });
    assert.equal(result.extraRoBind, null);
  });

  test("resolveExecutor: undefined and \"opencode\" both resolve to opencodeExecutor", () => {
    assert.equal(resolveExecutor(undefined).id, "opencode");
    assert.equal(resolveExecutor("opencode").id, "opencode");
  });

  test("binaryName is \"opencode\" so startTask can spawn the right CLI", () => {
    assert.equal(opencodeExecutor().binaryName, "opencode");
  });

  test("resolveExecutor: unknown name throws", () => {
    assert.throws(() => resolveExecutor("bogus"), /unknown executor: bogus/);
  });
});
