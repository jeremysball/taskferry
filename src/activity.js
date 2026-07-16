import fs from "node:fs";

/** @typedef {{id: string, status: string, logPath?: string, prompt?: string, promptPreview?: string}} ActivityTask */
/** @typedef {{text: string, narration?: string, outputWatermark: number, sourceLogBytes: number, inputBytes: number}} ActivitySnapshot */
/** @typedef {{activity: string, outputWatermark: number, summaryFailed: boolean, cached: boolean}} ActivityResult */

export const ACTIVITY_REFRESH_BYTES = 4096;
export const DEFAULT_ACTIVITY_MIN_INTERVAL_MS = 60000;
export const DEFAULT_ACTIVITY_SNAPSHOT_BYTES = 96 * 1024;
export const DEFAULT_ACTIVITY_MAX_CHARS = 4000;

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
  const textOrder = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== "text" || typeof event.part?.text !== "string") continue;
      const messageId = event.part.messageID ?? "__unknown_message__";
      if (!textByMessageId.has(messageId)) {
        textByMessageId.set(messageId, []);
        textOrder.push(messageId);
      }
      textByMessageId.get(messageId).push(event.part.text);
    } catch {
      // Logs can contain stderr lines and partial NDJSON records.
    }
  }
  return textOrder.map((messageId) => textByMessageId.get(messageId).join("")).join("\n\n");
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
 * @param {number} [options.minIntervalMs]
 * @param {number} [options.refreshBytes]
 * @param {string} [options.summaryModel]
 * @param {number} [options.maxWords]
 * @param {(task: ActivityTask) => ActivitySnapshot} [options.snapshot]
 * @param {(input: {task: ActivityTask, snapshot: ActivitySnapshot, maxWords: number, summaryModel: string}) => Promise<string>|string} [options.summarize]
 * @param {() => number} [options.now]
 */
export function createActivityCache({
  summariesEnabled = true,
  minIntervalMs = DEFAULT_ACTIVITY_MIN_INTERVAL_MS,
  refreshBytes = ACTIVITY_REFRESH_BYTES,
  summaryModel = "opencode-go/deepseek-v4-flash",
  maxWords = 200,
  snapshot = (task) => readActivitySnapshot(task.logPath || ""),
  summarize = async ({ snapshot: current }) => current.text,
  now = Date.now,
} = {}) {
  let summariesEnabledState = summariesEnabled;
  /** @type {Map<string, ActivityResult>} */
  const cache = new Map();
  /** @type {Map<string, Promise<ActivityResult>>} */
  const inFlight = new Map();
  const lastRefresh = new Map();

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
      if (now() - previous.refreshedAt < minIntervalMs) return Promise.resolve(null);
    }
    lastRefresh.set(task.id, { outputWatermark, refreshedAt: now() });

    const fallback = buildLocalActivity({
      status: task.status,
      prompt: task.prompt,
      promptPreview: task.promptPreview,
      text: current.text,
    });
    const promise = (async () => {
      let activity = fallback;
      let summaryFailed = false;
      if (resolvedIncludeSummary) {
        try {
          const summarized = await summarize({ task, snapshot: current, maxWords: resolvedMaxWords, summaryModel });
          const text = sanitizeActivityText(summarized);
          if (text) activity = text;
          else summaryFailed = true;
        } catch {
          summaryFailed = true;
        }
      }
      const result = { activity, outputWatermark, summaryFailed, cached: false };
      cache.set(key, result);
      inFlight.delete(key);
      return result;
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
  };
}
