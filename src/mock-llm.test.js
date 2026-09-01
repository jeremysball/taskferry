import assert from "node:assert/strict";
import test from "node:test";
import { delayMsForModel, mockLlmConfigContent, startMockLlm } from "./mock-llm.js";

test("delayMsForModel()", async (t) => {
  await t.test("pong replies immediately", () => {
    assert.equal(delayMsForModel("pong"), 0);
  });
  await t.test("delay<n> parses seconds", () => {
    assert.equal(delayMsForModel("delay30"), 30000);
    assert.equal(delayMsForModel("delay60"), 60000);
    assert.equal(delayMsForModel("delay1"), 1000);
  });
  await t.test("clamps absurd values", () => {
    assert.equal(delayMsForModel("delay999"), 300000);
  });
  await t.test("anything else replies immediately", () => {
    assert.equal(delayMsForModel("not-a-delay"), 0);
    assert.equal(delayMsForModel(undefined), 0);
  });
});

test("mock provider endpoint", async (t) => {
  const { port, close } = await startMockLlm();
  t.after(close);
  const base = `http://127.0.0.1:${port}/v1`;
  const chatBody = (extra = {}) =>
    JSON.stringify({
      model: "pong",
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    });

  await t.test("streaming completion yields PONG plus nonzero usage", async () => {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody({ stream: true, stream_options: { include_usage: true } }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const raw = await res.text();
    assert.ok(raw.endsWith("data: [DONE]\n\n"));
    const events = raw
      .split("\n\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice("data: ".length)));
    const content = events.find((e) => e.choices?.[0]?.delta?.content);
    assert.equal(content?.choices?.[0]?.delta?.content, "PONG");
    const reasoning = events.find((e) => e.choices?.[0]?.delta?.reasoning_content);
    assert.ok(reasoning?.choices?.[0]?.delta?.reasoning_content);
    const usage = events.find((e) => e.usage)?.usage;
    assert.ok(usage.prompt_tokens > 0, "input tokens must be nonzero for the usage-parse path to be exercised");
    assert.equal(usage.completion_tokens, 9);
    assert.equal(usage.total_tokens, usage.prompt_tokens + 9);
    assert.equal(usage.completion_tokens_details.reasoning_tokens, 6);
    assert.equal(usage.prompt_tokens_details.cached_tokens, 0);
  });

  await t.test("input tokens scale with request size", async () => {
    const small = await (await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody({ stream: false }),
    })).json();
    const big = await (await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody({ stream: false, messages: [{ role: "user", content: "x".repeat(4000) }] }),
    })).json();
    assert.equal(small.choices[0].message.content, "PONG");
    assert.ok(big.usage.prompt_tokens > small.usage.prompt_tokens);
  });

  await t.test("GET /models lists pong", async () => {
    const res = await fetch(`${base}/models`);
    const body = await res.json();
    assert.deepEqual(body.data.map((m) => m.id), ["pong"]);
  });

  await t.test("unknown routes 404 rather than hanging", async () => {
    const res = await fetch(`${base}/nope`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404);
  });
});

test("mockLlmConfigContent()", async (t) => {
  await t.test("declares every model id the smoke suite dispatches", () => {
    const cfg = JSON.parse(mockLlmConfigContent(4321));
    const models = cfg.provider.mockllm.models;
    for (const id of ["pong", "delay30", "delay60"]) {
      assert.ok(models[id], `model "${id}" must be declared for opencode to resolve -m mockllm/${id}`);
      assert.ok(models[id].cost.input > 0, `model "${id}" needs a nonzero cost table for cost-arithmetic coverage`);
    }
  });
  await t.test("points at the given port and keeps title disabled", () => {
    const cfg = JSON.parse(mockLlmConfigContent(4321));
    assert.equal(cfg.provider.mockllm.options.baseURL, "http://127.0.0.1:4321/v1");
    assert.equal(cfg.agent.title.disable, true);
  });
});
