import fs from "node:fs";
import { formatToolEventForNarration } from "./narration-format.js";

/** @typedef {{id: string, status: string, logPath?: string, prompt?: string, promptPreview?: string}} ActivityTask */
/** @typedef {{text: string, narration?: string, outputWatermark: number, sourceLogBytes: number, inputBytes: number}} ActivitySnapshot */
/** @typedef {{activity: string, outputWatermark: number, cached: boolean}} ActivityResult */
/** @typedef {{text: string|null, sessionId: string|null}} SummarizeOutcome */

const ACTIVITY_REFRESH_BYTES = 4096;
export const DEFAULT_SUMMARIZER_TIMEOUT_MS = 360000;
const DEFAULT_ACTIVITY_SNAPSHOT_BYTES = 96 * 1024;
const DEFAULT_ACTIVITY_MAX_CHARS = 4000;

/** @param {Buffer} buffer @param {string} side @returns {string} */
function decodeUtf8(buffer, side) {
  let text = buffer.toString("utf8");
  if (side === "head" && text.endsWith("\ufffd")) text = text.slice(0, -1);
  if (side === "tail" && text.startsWith("\ufffd")) text = text.slice(1);
  return text;
}

/** @param {string} raw @returns {string} */
function narrationFromRaw(raw) {
  const textByMessageId = new Map();
  const order = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "text" && typeof event.part?.text === "string") {
        const messageId = event.part.messageID ?? "__unknown_message__";
        if (!textByMessageId.has(messageId)) {
          textByMessageId.set(messageId, []);
          order.push({ kind: "text", messageId });
        }
        textByMessageId.get(messageId).push(event.part.text);
      } else if (event.type === "tool_use" && event.part?.type === "tool") {
        order.push({ kind: "tool", line: formatToolEventForNarration(event.part) });
      }
    } catch {
      // Logs can contain stderr lines and partial NDJSON records.
    }
  }
  return order.map((entry) => (entry.kind === "text" ? textByMessageId.get(entry.messageId).join("") : entry.line)).join("\n\n");
}

/** @param {string} text @param {number} maxChars @returns {string} */
function boundedText(text, maxChars) {
  return Array.from(text).slice(0, maxChars).join("");
}

/**
 * @param {string|Buffer} raw
 * @param {{maxBytes?: number, maxChars?: number, outputWatermark?: number}} [options]
 */
export function snapshotNarration(raw, { maxBytes = DEFAULT_ACTIVITY_SNAPSHOT_BYTES, maxChars = DEFAULT_ACTIVITY_MAX_CHARS, outputWatermark } = {}) {
  const source = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const watermark = outputWatermark ?? source.byteLength;
  const boundedBytes = Math.max(1, maxBytes);
  let excerpt;
  if (source.byteLength <= boundedBytes) {
    excerpt = decodeUtf8(source, "full");
  } else {
    const firstBytes = Math.ceil(boundedBytes / 2);
    const lastBytes = Math.floor(boundedBytes / 2);
    excerpt = `${decodeUtf8(source.subarray(0, firstBytes), "head")}\n${decodeUtf8(source.subarray(source.byteLength - lastBytes), "tail")}`;
  }
  const narration = boundedText(narrationFromRaw(excerpt), Math.max(1, maxChars));
  return {
    text: narration,
    narration,
    outputWatermark: watermark,
    sourceLogBytes: watermark,
    inputBytes: Buffer.byteLength(excerpt),
  };
}

/**
 * @param {string} logPath
 * @param {{maxBytes?: number, maxChars?: number}} [options]
 */
export function readActivitySnapshot(logPath, options = {}) {
  try {
    const size = fs.statSync(logPath).size;
    const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_ACTIVITY_SNAPSHOT_BYTES);
    const fd = fs.openSync(logPath, "r");
    try {
      if (size <= maxBytes) {
        const buffer = Buffer.alloc(size);
        fs.readSync(fd, buffer, 0, size, 0);
        return snapshotNarration(buffer, { ...options, outputWatermark: size });
      }
      const firstBytes = Math.ceil(maxBytes / 2);
      const lastBytes = Math.floor(maxBytes / 2);
      const first = Buffer.alloc(firstBytes);
      const last = Buffer.alloc(lastBytes);
      fs.readSync(fd, first, 0, firstBytes, 0);
      fs.readSync(fd, last, 0, lastBytes, size - lastBytes);
      return snapshotNarration(Buffer.concat([first, last]), { ...options, outputWatermark: size });
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: "", narration: "", outputWatermark: 0, sourceLogBytes: 0, inputBytes: 0 };
  }
}

// Reads the bytes appended to logPath since `fromOffset`, decodes them through
// the same narration parser used for full snapshots, and returns a snapshot
// whose `outputWatermark` still reflects the full current log size (so the
// activity cache's per-task key shifts on every new chunk) but whose `narration`
// only contains the delta. Used by the summarize path so the second (and later)
// continue-session turn sends just the new narration, not the entire bounded
// excerpt a fresh start would.
// A `fromOffset` >= current size (log rotated or never grew) returns an empty
// narration with the same watermark it would have produced had a chunk
// arrived, so callers can distinguish "nothing new yet" from "no log at all."
/**
 * @param {string} logPath
 * @param {number} fromOffset
 * @param {{maxChars?: number}} [options]
 */
export function readDeltaNarration(logPath, fromOffset, { maxChars = DEFAULT_ACTIVITY_MAX_CHARS } = {}) {
  let size;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return { text: "", narration: "", outputWatermark: 0, sourceLogBytes: 0, inputBytes: 0 };
  }
  if (!Number.isFinite(fromOffset) || fromOffset < 0) fromOffset = 0;
  if (size <= fromOffset) {
    return { text: "", narration: "", outputWatermark: size, sourceLogBytes: size, inputBytes: 0 };
  }
  const deltaBytes = size - fromOffset;
  const buffer = Buffer.alloc(deltaBytes);
  let fd;
  try {
    fd = fs.openSync(logPath, "r");
    fs.readSync(fd, buffer, 0, deltaBytes, fromOffset);
  } catch {
    return { text: "", narration: "", outputWatermark: size, sourceLogBytes: size, inputBytes: 0 };
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
  // maxBytes > deltaBytes preserves the entire delta (no head+tail bounding);
  // only the char cap trims.
  return snapshotNarration(buffer, { maxBytes: deltaBytes + 1, maxChars, outputWatermark: size });
}

/** @param {unknown} value @param {number} [maxChars] */
export function sanitizeActivityText(value, maxChars = DEFAULT_ACTIVITY_MAX_CHARS) {
  if (typeof value !== "string") return "";
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  const controlPattern = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, "g");
  return boundedText(
    value
      .replace(ansiPattern, "")
      .replace(controlPattern, " ")
      .replace(/\s+/g, " ")
      .trim(),
    Math.max(1, maxChars)
  );
}

/** @param {{status?: string, prompt?: string, promptPreview?: string, narration?: string, text?: string}} activity */
export function buildLocalActivity({ status, prompt, promptPreview, narration, text } = {}) {
  const local = sanitizeActivityText(narration || text || prompt || promptPreview);
  return local || `Task ${status || "activity"}`;
}

/** @param {{id: string, status: string}} task @param {number} outputWatermark @param {string} summaryModel @param {number} maxWords @param {boolean} includeSummary */
export function activityCacheKey(task, outputWatermark, summaryModel, maxWords, includeSummary) {
  return JSON.stringify([task.id, task.status, outputWatermark, summaryModel, maxWords, !!includeSummary]);
}

/**
 * @param {object} [options]
 * @param {boolean} [options.summariesEnabled]
 * @param {number} [options.summarizerTimeoutMs]
 * @param {number} [options.refreshBytes]
 * @param {string} [options.summaryModel]
 * @param {number} [options.maxWords]
 * @param {(task: ActivityTask) => ActivitySnapshot} [options.snapshot]
 * @param {(input: {task: ActivityTask, snapshot: ActivitySnapshot, maxWords: number, summaryModel: string, previousActivity: string|null, previousSessionId: string|null, lastSummarizedWatermark: number}) => Promise<SummarizeOutcome>|SummarizeOutcome} [options.summarize]
 * @param {() => number} [options.now]
 */
export function createActivityCache({
  summariesEnabled = true,
  summarizerTimeoutMs = DEFAULT_SUMMARIZER_TIMEOUT_MS,
  refreshBytes = ACTIVITY_REFRESH_BYTES,
  summaryModel = "opencode/hy3-free",
  maxWords = 200,
  snapshot = (task) => readActivitySnapshot(task.logPath || ""),
  summarize = async ({ snapshot: current }) => ({ text: current.text, sessionId: null }),
  now = Date.now,
} = {}) {
  let summariesEnabledState = summariesEnabled;
  /** @type {Map<string, ActivityResult>} */
  const cache = new Map();
  /** @type {Map<string, Promise<ActivityResult>>} */
  const inFlight = new Map();
  const lastRefresh = new Map();
  /** @type {Map<string, string>} */
  const lastSummarizedActivity = new Map();
  // OpenCode session id of the most recent successful summary for this source
  // task. The summarize-task spawner reads this and passes it to
  // `opencode run --continue --session <id>` so the next turn lands in the
  // same prompt-cached conversation instead of starting fresh. Cleared on
  // failure so the next call retries against a brand-new session.
  /** @type {Map<string, string>} */
  const summarySessions = new Map();
  // Source-log byte offset at the moment the most recent summary was taken.
  // Mirrors the `outputWatermark` already on ActivitySnapshot but lives in
  // the cache so callers outside the refresh path (the direct
  // `taskferry summary` path that bypasses the cache) can compute the
  // "narration since last summary" delta on the next call.
  /** @type {Map<string, number>} */
  const lastSummarizedWatermarks = new Map();

  /** @param {ActivityTask} task @param {{force?: boolean, includeSummary?: boolean, maxWords?: number}} [options] @returns {Promise<ActivityResult|null>} */
  function refresh(task, { force = false, includeSummary, maxWords: requestedMaxWords } = {}) {
    const current = snapshot(task);
    const outputWatermark = Number(current.outputWatermark) || 0;
    const resolvedMaxWords = requestedMaxWords ?? maxWords;
    const resolvedIncludeSummary = includeSummary ?? summariesEnabledState;
    const key = activityCacheKey(task, outputWatermark, summaryModel, resolvedMaxWords, resolvedIncludeSummary);
    const cached = cache.get(key);
    if (cached) return Promise.resolve({ ...cached, cached: true });
    const pending = inFlight.get(key);
    if (pending) return pending;

    const previous = lastRefresh.get(task.id);
    if (!force && previous) {
      if (task.status === "running" && outputWatermark - previous.outputWatermark < refreshBytes) return Promise.resolve(null);
      if (now() - previous.refreshedAt < summarizerTimeoutMs) return Promise.resolve(null);
    }
    lastRefresh.set(task.id, { outputWatermark, refreshedAt: now() });

    const fallback = buildLocalActivity({
      status: task.status,
      prompt: task.prompt,
      promptPreview: task.promptPreview,
      text: current.text,
    });
    const promise = (async () => {
      if (!resolvedIncludeSummary) {
        const result = { activity: fallback, outputWatermark, cached: false };
        cache.set(key, result);
        inFlight.delete(key);
        return result;
      }
      try {
        const previousActivity = lastSummarizedActivity.get(task.id) || null;
        const previousSessionId = summarySessions.get(task.id) || null;
        const priorWatermark = lastSummarizedWatermarks.get(task.id) || 0;
        const summarized = await summarize({
          task,
          snapshot: current,
          maxWords: resolvedMaxWords,
          summaryModel,
          previousActivity,
          previousSessionId,
          lastSummarizedWatermark: priorWatermark,
        });
        const summarizedText = summarized && typeof summarized.text === "string" ? summarized.text : "";
        const text = sanitizeActivityText(summarizedText);
        if (!text) throw new Error("summarize() returned no usable text");
        lastSummarizedActivity.set(task.id, text);
        lastSummarizedWatermarks.set(task.id, outputWatermark);
        if (summarized && typeof summarized.sessionId === "string" && summarized.sessionId) {
          summarySessions.set(task.id, summarized.sessionId);
        }
        const result = { activity: text, outputWatermark, cached: false };
        cache.set(key, result);
        inFlight.delete(key);
        return result;
      } catch (err) {
        // Treat any failure (thrown or empty output) as "the cached state is
        // unreliable" so the next call retries fresh rather than resuming a
        // session that produced nothing usable. A failed refresh is never
        // cached (only `inFlight` tracking is cleared) -- callers see the
        // real error every time, not a stale masked result.
        summarySessions.delete(task.id);
        lastSummarizedWatermarks.delete(task.id);
        inFlight.delete(key);
        throw err;
      }
    })();
    inFlight.set(key, promise);
    return promise;
  }

  return {
    refresh,
    cache,
    inFlight,
    setSummariesEnabled: /** @param {boolean} value */ (value) => {
      summariesEnabledState = value === true;
    },
    /** @param {string} taskId @returns {string|null} */
    getSummarySessionId: (taskId) => summarySessions.get(taskId) || null,
    /** @param {string} taskId @returns {number} */
    getLastSummarizedWatermark: (taskId) => lastSummarizedWatermarks.get(taskId) || 0,
    /** @param {string} taskId @param {string} sessionId */
    setSummarySessionId: (taskId, sessionId) => {
      if (sessionId) summarySessions.set(taskId, sessionId);
    },
    /** @param {string} taskId @param {number} watermark */
    setLastSummarizedWatermark: (taskId, watermark) => {
      if (Number.isFinite(watermark) && watermark >= 0) lastSummarizedWatermarks.set(taskId, watermark);
    },
    /** @param {string} taskId */
    clearSummaryState: (taskId) => {
      summarySessions.delete(taskId);
      lastSummarizedWatermarks.delete(taskId);
    },
  };
}
