// A local, keyless OpenAI-compatible endpoint used by the integration smoke
// tests (`npm run test:integration`) so CI never depends on a live model
// provider. The daemon still spawns the real `opencode` CLI through the real
// bwrap sandbox -- only the HTTP endpoint the CLI talks to is faked. The
// mocked-away surface is provider availability (billing state, quotas, model
// renames); everything taskferry itself owns (dispatch, daemon, sandbox,
// spawn, NDJSON parse, settlement, kill-group teardown) still runs for real.
//
// The delay contract is the model id, not the prompt text: `mockllm/pong`
// replies immediately; `mockllm/delay<n>` withholds its streamed response
// for n seconds, so the worker sits blocked on the HTTP response while
// `taskferry cancel` / `wait`-timeout race a genuinely running process.
// Encoding it in the id (rather than sniffing the prompt for `sleep <n>`)
// keeps the coupling visible in the dispatch command that depends on it.
//
// The mock reports deterministic token usage (and the provider config
// carries a nonzero cost table) so the real token/cost accounting path --
// opencode's usage parse -> NDJSON step_finish -> taskferry's tokens/cost
// fields -- is exercised end-to-end, and `smoke-test.js` asserts it.
//
// Wire it in via `mockLlmConfigContent(port)`: an `OPENCODE_CONFIG_CONTENT`
// value declaring a `mockllm` provider whose baseURL targets the ephemeral
// port (the docs' custom-provider / LM Studio shape: npm
// `@ai-sdk/openai-compatible` + options.baseURL + models map). The daemon
// forwards the CLI's full env into each sandbox, so the config reaches the
// worker with no extra plumbing.
import http from "node:http";

const SLEEP_MODEL_PATTERN = /^delay(\d{1,3})$/;
const CHAT_COMPLETION_CHUNK = "chat.completion.chunk";

/**
 * Parse the delay out of a mock model id: "pong" -> 0, "delay60" -> 60000.
 * Out-of-range n is clamped to [0, 300] seconds so a typo can't park a CI
 * job longer than the run timeout it would blow anyway.
 * @param {unknown} modelId
 * @returns {number} milliseconds
 */
export function delayMsForModel(modelId) {
  if (typeof modelId !== "string") return 0;
  const m = SLEEP_MODEL_PATTERN.exec(modelId);
  if (!m) return 0;
  return Math.min(Math.max(Number(m[1]), 0), 300) * 1000;
}

/**
 * Deterministic stand-in for a provider's token accounting: input tokens
 * scale with the request size, output is fixed, and a reasoning channel is
 * reported so `reasoning`-capable parsing sees a realistic shape. Must match
 * what opencode's ai-sdk openai-compatible usage parse expects (the
 * prompt_tokens_details / completion_tokens_details nesting).
 * @param {number} requestBytes
 */
function usageFor(requestBytes) {
  const promptTokens = Math.max(1, Math.ceil(requestBytes / 4));
  const completionTokens = 9;
  const reasoningTokens = 6;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: reasoningTokens },
  };
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function streamChunks(model, usage, created = Math.floor(Date.now() / 1000)) {
  const base = { id: `chatcmpl-mock-${created}`, created, model };
  return [
    { ...base, object: CHAT_COMPLETION_CHUNK, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "mock reasoning trace" }, finish_reason: null }] },
    { ...base, object: CHAT_COMPLETION_CHUNK, choices: [{ index: 0, delta: { content: "PONG" }, finish_reason: null }] },
    { ...base, object: CHAT_COMPLETION_CHUNK, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    // OpenAI's stream usage convention: a final chunk carrying usage with no
    // choices, requested via stream_options.include_usage (which the AI SDK
    // sets). Emitted unconditionally -- harmless to parsers that ignore it.
    { ...base, object: CHAT_COMPLETION_CHUNK, choices: [], usage },
  ];
}

function completionBody(model, usage, created = Math.floor(Date.now() / 1000)) {
  return {
    id: `chatcmpl-mock-${created}`,
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "PONG" }, finish_reason: "stop" }],
    created,
    model,
    usage,
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function streamCompletion(res, model, usage) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const chunk of streamChunks(model, usage)) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {Set<ReturnType<typeof setTimeout>>} pending
 */
async function handleRequest(req, res, pending) {
  const text = await readBody(req);
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    sendJson(res, 200, { object: "list", data: [{ id: "pong", object: "model" }] });
    return;
  }
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    sendJson(res, 404, { error: { message: `mock-llm: no route for ${req.method} ${req.url}` } });
    return;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    sendJson(res, 400, { error: { message: "mock-llm: malformed JSON body" } });
    return;
  }
  const model = typeof body.model === "string" ? body.model : "pong";
  const usage = usageFor(Buffer.byteLength(text));
  const timer = setTimeout(() => {
    pending.delete(timer);
    if (res.writableEnded || res.destroyed) return;
    if (body.stream) streamCompletion(res, model, usage);
    else sendJson(res, 200, completionBody(model, usage));
  }, delayMsForModel(model));
  pending.add(timer);
}

/**
 * Starts the mock server on an ephemeral loopback port.
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startMockLlm() {
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const pending = new Set();
  const server = http.createServer((req, res) => {
    handleRequest(req, res, pending).catch(() => res.destroy());
  });
  const port = await listenOnEphemeralLoopback(server);
  return { port, close: () => closeServer(server, pending) };
}

/**
 * @param {import("node:http").Server} server
 * @returns {Promise<number>}
 */
function listenOnEphemeralLoopback(server) {
  return new Promise((resolve, reject) => {
    const onError = (/** @type {Error} */ err) => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (address && typeof address !== "string") resolve(address.port);
      else reject(new Error("mock-llm: failed to bind an ephemeral port"));
    });
  });
}

/**
 * @param {import("node:http").Server} server
 * @param {Set<ReturnType<typeof setTimeout>>} pending
 */
async function closeServer(server, pending) {
  for (const t of pending) clearTimeout(t);
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

// Every model id a smoke test dispatches must be declared here: opencode
// resolves `-m mockllm/<id>` against the config's model map, and an
// undeclared id fails before any request leaves the CLI. The mock's delay
// parse accepts any `delay<n>`; this roster only covers what the suite uses.
const MOCK_MODELS = {
  pong: { name: "Mock Pong" },
  delay30: { name: "Mock Delay 30" },
  delay60: { name: "Mock Delay 60" },
};

/**
 * The `OPENCODE_CONFIG_CONTENT` value pointing a `mockllm` provider at
 * `port`. `agent.title.disable` is kept from the pre-existing workflow
 * setting: the session-naming agent would otherwise fire a second request
 * per session that nothing in a headless smoke test ever reads. The nonzero
 * cost table is what lets the integration leg assert real cost arithmetic,
 * not just token counts.
 * @param {number} port
 * @returns {string}
 */
export function mockLlmConfigContent(port) {
  return JSON.stringify({
    provider: {
      mockllm: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock LLM",
        options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "mock-key" },
        models: Object.fromEntries(
          Object.entries(MOCK_MODELS).map(([id, info]) => [
            id,
            {
              ...info,
              limit: { context: 32000, output: 4096 },
              cost: { input: 0.1, output: 0.2, cache: { read: 0, write: 0 } },
            },
          ]),
        ),
      },
    },
    agent: { title: { disable: true } },
  });
}

// `node src/mock-llm.js --serve`: standalone server mode used by the smoke
// tests via `startMockLlmProcess()` -- the server must not share the smoke
// script's event loop because `execFileSync` blocks it for exactly as long
// as the worker is waiting for a reply.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv.includes("--serve")) {
  const { port } = await startMockLlm();
  process.stdout.write(`MOCK_PORT=${port}\n`);
  setInterval(() => {}, 1 << 30);
}
