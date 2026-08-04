import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./args.js";
import { loadConfig } from "./config.js";

// Default budget for advisor's auto-attached context: ~30k tokens, well
// under any provider's context window even after the canned prompt and the
// caller's own --prompt are added on top.
const DEFAULT_ADVISOR_CONTEXT_CHARS = 120000;

/**
 * Resolve the effective advisor context budget: explicit env var override,
 * then the config file's `advisorContextChars`, then the built-in default.
 * Mirrors resolveWaitDefaultTimeoutMs()'s resolution order.
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
export function resolveAdvisorContextChars(env) {
  const envChars = Number(env.TASKFERRY_ADVISOR_CONTEXT_CHARS);
  if (Number.isFinite(envChars) && envChars > 0) return envChars;
  const configChars = Number(loadConfig({ env }).advisorContextChars);
  return Number.isFinite(configChars) && configChars > 0 ? configChars : DEFAULT_ADVISOR_CONTEXT_CHARS;
}

/**
 * The Claude Code project-directory slug for a given absolute cwd: the path
 * with every separator replaced by "-" (e.g. "/workspace/taskferry" ->
 * "-workspace-taskferry"), matching the convention Claude Code itself uses
 * under ~/.claude/projects/.
 * @param {string} cwd
 * @returns {string}
 */
function claudeProjectSlug(cwd) {
  return cwd.split(path.sep).join("-");
}

/**
 * @param {string} homeDirectory
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {string}
 */
export function claudeTranscriptPath(homeDirectory, cwd, sessionId) {
  return path.join(homeDirectory, ".claude", "projects", claudeProjectSlug(cwd), `${sessionId}.jsonl`);
}

// Raw transcript bytes are dominated by non-dialogue noise (thinking blocks,
// tool_use calls, tool_result dumps) that extractTranscriptText() filters
// out, so the tail read has to pull in more raw bytes than `maxChars` to
// have a good chance of finding `maxChars` worth of real user/assistant
// text. EXTRACT_TAIL_BYTES_CAP is a hard ceiling independent of the budget,
// so a large `maxChars` can't defeat the bound and read the whole file.
const EXTRACT_TAIL_BYTES_MULTIPLIER = 8;
const EXTRACT_TAIL_BYTES_CAP = 16 * 1024 * 1024;
// A single JSONL line (one turn) can run to a few KB even in an ordinary
// transcript; without a floor, a small `maxChars` (or a short/near-empty
// file) could bound the read to fewer bytes than one whole line, silently
// discarding it as the "possibly truncated" leading fragment.
const EXTRACT_TAIL_BYTES_FLOOR = 4096;

/**
 * Reads a bounded tail of `filePath` and splits it into lines, dropping the
 * leading fragment when the tail read didn't start at byte 0 (it may have
 * landed mid-line).
 * @param {string} filePath
 * @param {number} maxChars
 * @returns {string[]}
 */
function readTranscriptTailLines(filePath, maxChars) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(
      `advisor could not read the Claude session transcript at ${filePath}: ${message}`,
      "CLAUDE_CODE_SESSION_ID was set but its transcript file wasn't readable -- --prompt does not skip auto-context (it's prepended to it), so this still fails even with --prompt set; unset CLAUDE_CODE_SESSION_ID for this call, or check the transcript path"
    );
  }
  const readBytes = Math.min(size, Math.max(EXTRACT_TAIL_BYTES_FLOOR, Math.min(maxChars * EXTRACT_TAIL_BYTES_MULTIPLIER, EXTRACT_TAIL_BYTES_CAP)));
  const buffer = Buffer.alloc(readBytes);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, readBytes, size - readBytes);
  } finally {
    fs.closeSync(fd);
  }
  let raw = buffer.toString("utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw.split("\n");
  // A tail read that didn't start at byte 0 may have landed mid-line;
  // that leading fragment isn't valid JSON on its own and would otherwise
  // just be silently dropped by the parse-error skip below anyway, but
  // dropping it explicitly avoids relying on that as the mechanism.
  if (readBytes < size) lines.shift();
  return lines;
}

/**
 * Extracts the plain-text content of a transcript entry's `message.content`,
 * whether it's a plain string or a content-block array. Returns `undefined`
 * for any other shape.
 * @param {unknown} content
 * @returns {string|undefined}
 */
function transcriptEntryContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return undefined;
}

/**
 * Parses one JSONL line into a "type: text" turn, or `null` when the line is
 * malformed, isn't a user/assistant entry, or has no text content.
 * @param {string} line
 * @returns {string|null}
 */
function parseTranscriptTurn(line) {
  if (!line) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || (entry.type !== "user" && entry.type !== "assistant")) return null;
  const text = transcriptEntryContentText(entry.message?.content);
  return text ? `${entry.type}: ${text}` : null;
}

/**
 * Reads a Claude Code session transcript and extracts just the plain-text
 * user and assistant turns, dropping thinking blocks, tool_use calls, and
 * raw tool_result/toolUseResult dumps -- the bulk of a transcript's bytes,
 * and mostly noise for advisor's job of critiquing a decision in flight.
 * Reads only a bounded tail of the file (see EXTRACT_TAIL_BYTES_MULTIPLIER)
 * rather than the whole thing, since a real transcript can be hundreds of
 * MB. Malformed lines -- including the leading line the tail read may have
 * truncated mid-write -- are skipped rather than failing the whole read.
 * Returns the last `maxChars` Unicode code points of the extracted text.
 * @param {string} filePath
 * @param {number} maxChars
 * @returns {string}
 */
export function extractTranscriptText(filePath, maxChars) {
  const lines = readTranscriptTailLines(filePath, maxChars);
  const turns = lines.map(parseTranscriptTurn).filter((turn) => turn !== null);
  const joined = turns.join("\n\n");
  const codePoints = Array.from(joined);
  return codePoints.length > maxChars ? codePoints.slice(-maxChars).join("") : joined;
}

const ADVISOR_TAIL_CHARS_CAP = 131072;

export const ADVISOR_CANNED_PROMPT = `You are an advisor reviewing the in-progress work of a cheaper dispatcher agent. The text that follows is a tail of its session log: its current task, what it has read, what it has decided, and what it is about to do next. Treat it as suspect, not as a draft to refine.

Your reply goes directly back to that autonomous agent mid-task; it will not be read by a human first. Do not summarize what the ferry did and do not validate its choices for politeness. Push back.

Interrogate its assumptions: list each one the ferry is acting on without verifying, and say whether it is load-bearing. Hunt for blind spots: what did it not read, not run, not check, and where is a known foot-gun pattern it is about to step on (silent error swallow, mock-green-real-fail, off-by-one on the boundary it is touching, an unverified config default). Propose concrete alternatives: for each decision it is about to lock in, name at least one it has not considered, with the file and approximate line, not just an abstraction. Rank so the single highest-leverage change comes first.

Format: bulleted, terse, no preamble, no closing summary. Short sentences. Reference code as \`path/to/file.js:NNN\`. Prefer "should" and "must" over "you might consider." If there is nothing material to add, reply \`no change, proceed\` and stop.`;

/**
 * Resolves advisor's auto-attached context: a Claude session transcript
 * tail when CLAUDE_CODE_SESSION_ID is set (this call came directly from a
 * Claude Code session), else the calling ferry's own task.tail when
 * TASKFERRY_TASK_ID is set (this call came from inside a taskferry-spawned
 * worker), else null (no source available).
 * @param {object} params
 * @param {{request: (method: string, params: object) => Promise<any>}} params.client
 * @param {NodeJS.ProcessEnv} params.env
 * @param {string} params.cwd
 * @param {string} params.homeDirectory
 * @returns {Promise<{source: string, text: string} | null>}
 */
export async function gatherAdvisorContext({ client, env, cwd, homeDirectory }) {
  const budget = resolveAdvisorContextChars(env);
  if (env.CLAUDE_CODE_SESSION_ID) {
    const transcriptPath = claudeTranscriptPath(homeDirectory, cwd, env.CLAUDE_CODE_SESSION_ID);
    const text = extractTranscriptText(transcriptPath, budget);
    // A transcript made up entirely of thinking/tool_use/tool_result entries
    // (no user/assistant text) extracts to "" -- treat that the same as "no
    // source available" rather than returning a truthy-but-empty object that
    // would silently bypass the no-context UsageError below.
    return text ? { source: "claude-session", text } : null;
  }
  if (env.TASKFERRY_TASK_ID) {
    const tailed = await client.request("task.tail", { taskId: env.TASKFERRY_TASK_ID, chars: Math.min(budget, ADVISOR_TAIL_CHARS_CAP) });
    const text = tailed.text === "none observed yet" ? "" : tailed.text;
    return text ? { source: "ferry-log", text } : null;
  }
  return null;
}
