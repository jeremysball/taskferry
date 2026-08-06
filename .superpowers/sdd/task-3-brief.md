### Task 3: `piExecutor().normalizeLogEvent` — the verified event mapping

**Files:**
- Modify: `src/executor.js`
- Modify: `src/executor.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `piNormalizeLogEvent(parsed)`, referenced by `piExecutor()` from Task 2.

- [ ] **Step 1: Implement `piNormalizeLogEvent` in `src/executor.js`**

```js
/**
 * Maps one line of pi's `--mode json` event stream to taskferry's canonical
 * NDJSON shape. Returns null for events with no narration/result equivalent
 * (pure noise from taskferry's perspective).
 * @param {unknown} parsed
 * @returns {unknown|null}
 */
function piNormalizeLogEvent(parsed) {
  const evt = /** @type {Record<string, unknown>} */ (parsed);
  switch (evt.type) {
    case "session":
      return typeof evt.id === "string" ? { sessionID: evt.id } : null;

    case "message_update": {
      const inner = /** @type {Record<string, unknown>} */ (evt.assistantMessageEvent);
      if (inner?.type !== "text_start" && inner?.type !== "text_delta") return null;
      const message = /** @type {Record<string, unknown>} */ (evt.message);
      const messageID = typeof message?.responseId === "string" ? message.responseId : "__unknown_message__";
      // text_start carries no delta (content hasn't started yet); only
      // text_delta carries the incremental token(s) to accumulate.
      const text = inner.type === "text_delta" && typeof inner.delta === "string" ? inner.delta : "";
      if (inner.type === "text_start") return null; // nothing to emit yet -- text_delta carries all real content
      return { type: "text", part: { type: "text", text, messageID } };
    }

    case "tool_execution_end": {
      const toolName = typeof evt.toolName === "string" ? evt.toolName : "unknown";
      const args = evt.args;
      const result = /** @type {Record<string, unknown>} */ (evt.result);
      const outputText = Array.isArray(result?.content)
        ? result.content.filter((c) => c?.type === "text").map((c) => c.text).join("")
        : "";
      return {
        type: "tool_use",
        part: {
          type: "tool",
          tool: toolName,
          state: { input: args, output: outputText || undefined },
        },
      };
    }

    case "agent_end": {
      const messages = Array.isArray(evt.messages) ? evt.messages : [];
      let lastAssistant = null;
      for (const m of messages) {
        if (m && m.role === "assistant") lastAssistant = m;
      }
      if (!lastAssistant) return null;
      if (lastAssistant.stopReason === "error") {
        return {
          type: "error",
          message: typeof lastAssistant.errorMessage === "string" ? lastAssistant.errorMessage : "pi agent error",
          error: { name: "pi_error", data: { message: typeof lastAssistant.errorMessage === "string" ? lastAssistant.errorMessage : "pi agent error" } },
        };
      }
      const messageID = typeof lastAssistant.responseId === "string" ? lastAssistant.responseId : "__unknown_message__";
      return {
        type: "step_finish",
        part: {
          type: "step-finish",
          reason: "stop",
          messageID,
          tokens: lastAssistant.usage,
          cost: lastAssistant.usage?.cost?.total ?? null,
        },
      };
    }

    // Noise, dropped: thinking_* sub-events (thinking_start/delta/end),
    // agent_start, turn_start/turn_end, message_start/message_end (both
    // user and assistant -- text already streams via message_update's
    // text_delta), tool_execution_start (superseded by tool_execution_end,
    // see plan's Verified Findings #2), tool_execution_update (intermediate
    // progress, no narration equivalent for either executor today).
    default:
      return null;
  }
}
```

Note the `message_update`/`text_start`/`text_delta` branch: `text_start`'s own `contentIndex` transition carries no text yet (verified: real `text_start` events have no `delta` field, only `partial`, which is *cumulative* content — using it would double-count against the following `text_delta` events). Only `text_delta`'s `delta` field is the correct incremental source, so `text_start` returns `null` and only `text_delta` produces a `text` event — this matches how `readNarration`'s `textByMessageId` accumulation already expects a stream of small incremental `text` events to `.join("")`.

- [ ] **Step 2: Wire `normalizeLogEvent: piNormalizeLogEvent` into `piExecutor()`**

In the object returned by `piExecutor()` (from Task 2), replace the `normalizeLogEvent: piNormalizeLogEvent, // Task 3` placeholder — it should already read exactly that after Task 2 Step 1; confirm the reference resolves now that the function is defined above it in the same file (move `piNormalizeLogEvent`'s definition above `piExecutor()` in the file if it isn't already, since it's referenced during the object literal's construction).

- [ ] **Step 3: Add fixture-driven tests for `piNormalizeLogEvent`**

```js
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
```

- [ ] **Step 4: Run tests**

Run: `node --test src/executor.test.js`
Expected: PASS, all tests in the file (both `opencodeExecutor()` and `piExecutor()` describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/executor.js src/executor.test.js
git commit -m "feat(executor): implement piExecutor's normalizeLogEvent against verified pi event shapes"
```

---

