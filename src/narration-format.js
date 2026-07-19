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
