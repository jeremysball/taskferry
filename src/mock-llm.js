// A local, keyless OpenAI-compatible endpoint used by the integration smoke
// tests (`npm run test:integration`) so CI never depends on a live model
// provider. The daemon still spawns the real `opencode` CLI through the real
// bwrap sandbox -- only the HTTP endpoint the CLI talks to is faked. The
// mocked-away surface is provider availability (billing state, quotas, model
// renames); everything taskferry itself owns (dispatch, daemon, sandbox,
// spawn, NDJSON parse, settlement, kill-group teardown) still runs for real.
//
// The delay contract keeps the long-running cases genuinely long-running
// without asking a model to cooperate: the smoke-test prompts contain
// `sleep <n>`, and the mock withholds its streamed response for n seconds,
// so the worker sits in-flight (blocked on the HTTP response) while
// `taskferry cancel` / `wait`-timeout race against a real process group.
//
// Wire it in via `mockLlmConfigContent(port)`: an `OPENCODE_CONFIG_CONTENT`
// value declaring a `mockllm` provider whose baseURL targets the ephemeral
// port (the docs' custom-provider / LM Studio shape: npm
// `@ai-sdk/openai-compatible` + options.baseURL + models map). The daemon
// forwards the CLI's full env into each sandbox, so the config reaches the
// worker with no extra plumbing.
import http from "node:http";

const SLEEP_PATTERN = /sleep\s+(\d+)/i;

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

function contentText(content) {
  if (typeof content === "string") return content;
  let last;
  if (Array.isArray(content)) {
    for (const part of content) {
      const text = /** @type {{text?: unknown}} */ (part)?.text;
      if (typeof text === "string") last = text;
    }
  }
  return last;
}

/**
 * Decide how long to withhold the response and what to say, from the last
 * message text in the chat-completions body.
 * @param {unknown} body parsed JSON request body
 * @returns {{delayMs: number, content: string}}
 */
export function replyForRequest(body) {
  const messages = Array.isArray(/** @type {{messages?: unknown}} */ (body).messages)
    ? /** @type {Array<{content?: unknown}>} */ (/** @type {{messages: unknown[]}} */ (body).messages)
    : [];
  let prompt = "";
  for (const msg of messages) {
    const text = contentText(msg?.content);
    if (text !== undefined) prompt = text;
  }
  const sleep = SLEEP_PATTERN.exec(prompt);
  if (sleep) {
    const seconds = Math.min(Math.max(Number(sleep[1]), 0), 300);
    return { delayMs: seconds * 1000, content: "SLEEP_DONE" };
  }
  return { delayMs: 0, content: "PONG" };
}

function streamChunks(model, content, created = Math.floor(Date.now() / 1000)) {
  const base = { id: `chatcmpl-mock-${created}`, created, model };
  return [
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function streamCompletion(res, model, content) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const chunk of streamChunks(model, content)) {
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
  const { delayMs, content } = replyForRequest(body);
  const model = typeof body.model === "string" ? body.model : "pong";
  const timer = setTimeout(() => {
    pending.delete(timer);
    if (!res.writableEnded && !res.destroyed) streamCompletion(res, model, content);
  }, delayMs);
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

/**
 * The `OPENCODE_CONFIG_CONTENT` value pointing a `mockllm` provider at
 * `port`. `agent.title.disable` is kept from the pre-existing workflow
 * setting: the session-naming agent would otherwise fire a second request
 * per session that nothing in a headless smoke test ever reads.
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
        models: { pong: { name: "Mock Pong", limit: { context: 32000, output: 4096 } } },
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
