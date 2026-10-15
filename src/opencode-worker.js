import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const API_TIMEOUT_MS = 15000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 1000;

/**
 * Read the complete history (not /context, which hides pre-compaction turns).
 * Pages are newest first; a resumed run stops at its pre-launch watermark.
 * @param {string} sessionID
 * @param {string|null} baseline
 * @param {(route: string) => Promise<any>} readPage
 */
export async function collectSessionResult(sessionID, baseline, readPage) {
  const base = `/api/session/${encodeURIComponent(sessionID)}/message`;
  let route = `${base}?order=desc&limit=${PAGE_LIMIT}`;
  const messages = [];
  const seen = new Set();
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const page = await readPage(route);
    if (!Array.isArray(page.data)) throw new Error("Invalid OpenCode session messages response");
    for (const message of page.data) {
      if (message.id === baseline) return sessionResult(sessionID, messages.reverse());
      if (!seen.has(message.id)) messages.push(message);
      seen.add(message.id);
    }
    const cursor = page.cursor?.next;
    if (!cursor) return finishSessionPages(sessionID, baseline, messages);
    route = `${base}?limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`;
  }
  throw new Error("OpenCode session history exceeded the pagination limit");
}

/** @param {string} sessionID @param {string|null} baseline @param {any[]} messages */
function finishSessionPages(sessionID, baseline, messages) {
  if (baseline) throw new Error("OpenCode resume boundary is missing from session history");
  return sessionResult(sessionID, messages.reverse());
}

/** @param {string} sessionID @param {any[]} messages */
function sessionResult(sessionID, messages) {
  const events = messages.flatMap(message => messageEvents(sessionID, message));
  if (!events.length) throw new Error("OpenCode session has no finalized result for this run");
  const terminal = messages.findLast(message => message.type === "idle");
  const failed = terminal ? terminal.outcome !== "succeeded" : events.some(event => event.type === "error");
  return { type: "taskferry_session_result", sessionID, events, failed };
}

/** @param {string} sessionID @param {any} message @returns {any[]} */
function messageEvents(sessionID, message) {
  const common = { sessionID, timestamp: message.time?.completed ?? message.time?.created ?? Date.now() };
  const events = [];
  if (message.type === "assistant") {
    const text = (message.content ?? []).filter((/** @type {any} */ part) => part.type === "text").map((/** @type {any} */ part) => part.text).join("");
    events.push({ ...common, type: "text", part: { type: "text", messageID: message.id, text } });
  }
  if (["assistant", "compaction"].includes(message.type) && message.tokens) {
    events.push({ ...common, type: "step_finish", part: { messageID: message.id, reason: message.finish ?? "compaction", tokens: message.tokens, cost: message.cost } });
  }
  if (message.error) events.push({ ...common, type: "error", error: sessionError(message.error) });
  return events;
}

/** @param {any} error */
function sessionError(error) {
  return { name: error.type ?? "OpenCodeSessionError", data: { message: error.message ?? JSON.stringify(error) } };
}

/** @param {string} route */
async function readSessionPage(route) {
  const { stdout } = await execFileAsync("opencode", ["api", "--standalone", "get", route], {
    encoding: "utf8", timeout: API_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/** @param {unknown} event */
function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * Runs inside the worker's existing sandbox and data-home. Keep streaming
 * diagnostics, then append one authoritative snapshot before this worker exits.
 * @param {string[]} args
 */
async function runWorker(args) {
  const sessionIndex = args.indexOf("--session");
  let sessionID = sessionIndex < 0 ? null : args[sessionIndex + 1];
  let baseline = null;
  if (sessionID) {
    const page = await readSessionPage(`/api/session/${encodeURIComponent(sessionID)}/message?order=desc&limit=1`);
    baseline = page.data?.[0]?.id ?? null;
  }
  const child = spawn("opencode", args, { stdio: ["ignore", "pipe", "inherit"] });
  let interrupted = false;
  /** @param {NodeJS.Signals} signal */
  const forward = (signal) => { interrupted = true; child.kill(signal); };
  const terminate = () => forward("SIGTERM");
  const interrupt = () => forward("SIGINT");
  process.on("SIGTERM", terminate);
  process.on("SIGINT", interrupt);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    process.stdout.write(`${line}\n`);
    try {
      const event = JSON.parse(line);
      if (typeof event.sessionID === "string") sessionID = event.sessionID;
    } catch { /* Raw diagnostics remain in the stream. */ }
  });
  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  process.removeListener("SIGTERM", terminate);
  process.removeListener("SIGINT", interrupt);
  if (status.signal) {
    process.kill(process.pid, status.signal);
    return;
  }
  process.exitCode = status.code ?? 1;
  if (interrupted) return;
  if (!sessionID) {
    if (process.exitCode === 0) throw new Error("OpenCode exited successfully without a session ID");
    return;
  }
  await finalizeSession(sessionID, baseline);
}

/** @param {string} sessionID @param {string|null} baseline */
async function finalizeSession(sessionID, baseline) {
  try {
    const result = await collectSessionResult(sessionID, baseline, readSessionPage);
    emit(result);
    if (result.failed) {
      result.events.filter(event => event.type === "error").forEach(emit);
      if (process.exitCode === 0) process.exitCode = 1;
    }
  } catch (error) {
    emit({ sessionID, type: "error", error: { name: "OpenCodeSessionResultError", data: { message: `Could not finalize OpenCode session result: ${error instanceof Error ? error.message : String(error)}` } } });
    if (process.exitCode === 0) process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWorker(process.argv.slice(2)).catch((error) => {
    emit({ type: "error", error: { name: "OpenCodeWorkerError", data: { message: error.message } } });
    process.exitCode = 1;
  });
}
