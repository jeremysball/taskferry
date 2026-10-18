export const TOOL_EVENT_TRUNCATE_CHARS = 500;

/**
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function truncateForNarration(text, max = TOOL_EVENT_TRUNCATE_CHARS) {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

/**
 * @param {{tool?: string, state?: {input?: unknown, output?: unknown}}} part
 * @returns {string}
 */
export function formatToolEventForNarration(part) {
  const input = part.state?.input;
  const inputText = typeof input === "string" ? input : JSON.stringify(input ?? {});
  const output = part.state?.output;
  const label = `[tool:${part.tool || "unknown"}]`;
  const inputPart = truncateForNarration(inputText);
  if (typeof output !== "string" || !output) return `${label} ${inputPart}`;
  return `${label} ${inputPart} -> ${truncateForNarration(output)}`;
}

/** @param {string} text @param {number} maxChars @param {number} maxLines */
function quotedOutputTail(text, maxChars, maxLines) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const lines = normalized.split("\n");
  const chars = Array.from(lines.slice(-maxLines).join("\n"));
  const truncated = lines.length > maxLines || chars.length > maxChars;
  return JSON.stringify(`${truncated ? "…[truncated]\n" : ""}${chars.slice(-maxChars).join("")}`);
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  return value && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** @param {Record<string, unknown>} state */
function tailFields(state) {
  const output = record(state.output),
    metadata = record(state.metadata);
  return {
    stdout: [output.stdout, state.stdout, metadata.stdout].find((value) => typeof value === "string"),
    stderr: [output.stderr, state.stderr, metadata.stderr].find((value) => typeof value === "string"),
    exit: [output.exitCode, output.exit, state.exitCode, metadata.exitCode, metadata.exit].find((value) => Number.isInteger(value)),
  };
}

/** @param {unknown} value @param {number} chars @param {number} lines */
function streamTail(value, chars, lines) {
  return typeof value === "string" ? quotedOutputTail(value, chars, lines) : "unavailable";
}

/** @param {unknown} value */
function tailArgs(value) {
  return value === undefined ? "unavailable" : truncateForNarration(JSON.stringify(value));
}

/**
 * Deterministic display of supplied executor fields; combined output is never
 * guessed to be separate streams or a successful exit.
 * @param {{tool?: string, state?: Record<string, unknown>}} part
 * @param {boolean} [running]
 */
export function formatToolEventForTail(part, running = false) {
  const state = part.state ?? {},
    { stdout, stderr, exit } = tailFields(state);
  const args = tailArgs(state.input);
  const tool = JSON.stringify(part.tool || "unknown").slice(1, -1);
  const fields = [`[TOOL] ${tool} :: args=${args}`, `stdout=${streamTail(stdout, 500, 3)}`, `stderr=${streamTail(stderr, 1000, 8)}`];
  if (typeof state.output === "string") fields.push(`combined=${quotedOutputTail(state.output, 500, 3)}`);
  if (typeof state.error === "string") fields.push(`error=${quotedOutputTail(state.error, 1000, 8)}`);
  fields.push(`exit=${exit ?? "unavailable"}`, `state=${running ? "running" : (state.status ?? "unavailable")}`);
  return fields.join(" :: ");
}

/** @param {any} event */
function tailEvent(event) {
  if (event?.type === "text" && typeof event.part?.text === "string") return event.part.text;
  if (event?.type === "tool_use" && event.part?.type === "tool") return formatToolEventForTail(event.part);
  if (event?.type === "tool_progress" && event.part?.type === "tool-progress") return formatToolEventForTail(event.part, true);
  return "";
}

/** @param {string} line */
function parseTailLine(line) {
  try {
    return tailEvent(JSON.parse(line));
  } catch {
    return "";
  } // A bounded read can start or end inside an NDJSON record.
}

/** @param {string} raw */
export function formatTailActivity(raw) {
  return raw.split("\n").map(parseTailLine).filter(Boolean).join("\n\n");
}
