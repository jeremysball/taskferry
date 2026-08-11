import { normalizeDirectory, resolveWorkspaceRoot } from "./paths.js";
import { formatWatchEvent } from "./output.js";
import { TERMINAL_STATUSES as CORE_TERMINAL_STATUSES } from "./opencode-plugin.js";

const TASK_STATUS_METHOD = "task.status";
const TASK_STATE_EVENT_TYPE = "task.state";

/**
 * @typedef {object} WatchEvent
 * @property {string} type
 * @property {string} taskId
 * @property {string} directory
 * @property {string} status
 * @property {string|null} [previousStatus]
 * @property {string} [occurredAt]
 * @property {string|null} [activity]
 * @property {string|null} [outputWatermark]
 * @property {string|null} [originSessionId]
 * @property {number} [sequence]
 * @property {boolean} [summaryFailed]
 * @property {string} [summaryError]
 */

/**
 * @typedef {object} WatchResult
 * @property {string|null|undefined} directory
 * @property {boolean} watching
 * @property {WatchEvent} [event]
 */

/**
 * @typedef {object} Client
 * @property {(method: string, params?: Record<string, unknown>) => Promise<any>} request
 * @property {(params: Record<string, unknown>, onEvent: (event: Record<string, unknown>) => void) => Promise<string>} subscribe
 * @property {() => void} [close]
 */

/**
 * @typedef {object} Io
 * @property {{write: (chunk: string) => unknown, isTTY?: boolean}} stdout
 */

// Watch considers a task "settled" (no further events worth emitting) when
// the daemon reports one of these states; matches the same set the daemon
// uses to gate terminal events, plus "unknown" for a task the daemon can no
// longer classify. Re-exported so tests can pin it.
const TERMINAL_STATUSES = new Set([...CORE_TERMINAL_STATUSES, "unknown"]);

/**
 * @param {{id: string, directory: string, status: string, originSessionId?: string|null}} detail
 * @returns {WatchEvent}
 */
function terminalEventFromStatus(detail) {
  return {
    type: TASK_STATE_EVENT_TYPE,
    taskId: detail.id,
    directory: detail.directory,
    status: detail.status,
    previousStatus: null,
    occurredAt: new Date().toISOString(),
    activity: null,
    outputWatermark: null,
    originSessionId: detail.originSessionId ?? null,
  };
}

// `all` (watch --all) wins over a directory or taskId (args.js already
// rejects combining them); otherwise an explicit directory beats a
// taskId-scoped subscribe (the daemon resolves the directory server-side --
// issue #59).
/**
 * @param {{all?: boolean, directory?: string|null, taskId?: string}} selector
 * @returns {{all: true} | {directory: string} | {taskId: string|undefined}}
 */
function subscribeSelector({ all, directory, taskId }) {
  if (all) return { all: true };
  if (directory) return { directory };
  return { taskId };
}

/**
 * @param {object} params
 * @param {Client} params.client
 * @param {Io} params.io
 * @param {AbortSignal} [params.signal]
 * @param {string|null} [params.directory]
 * @param {string} [params.taskId]
 * @param {boolean} [params.all]
 * @param {boolean} [params.summaries]
 * @param {"toon"|"ndjson"} [params.format]
 * @param {number} [params.flushIntervalMs]
 * @returns {Promise<WatchResult>}
 */
function streamTaskEvents({ client, io, signal, directory, taskId, all, summaries, format, flushIntervalMs }) {
  // `settle` is reassigned inside the Promise executor below, which runs
  // synchronously on construction -- so by the time abortHandler is
  // registered (or any .then/.catch callback fires) it is always the real
  // resolver. Initialized to a no-op so it is never `undefined` and needs no
  // non-null assertion at the call sites.
  /** @type {(result?: WatchResult) => void} */
  let settle = () => {};
  // `directory` is only known upfront when the caller already had it (plain
  // `watch --directory`); a taskId-scoped `watch --task-id` subscribes by
  // taskId directly (the daemon resolves the directory server-side) and only
  // learns it once the first matching event arrives.
  let resolvedDirectory = directory;
  // Defensive: the args layer rejects `--flush-interval 0`, so this
  // code path normally sees only positive values, but use `> 0` instead
  // of truthy so any future caller that bypasses args.js can't
  // accidentally fall back to unbuffered per-event streaming on a zero
  // interval (the silent bug this check exists to prevent).
  const buffered = flushIntervalMs && flushIntervalMs > 0 ? new Map() : null;
  /** @param {WatchEvent} event */
  const writeRaw = (event) => io.stdout.write(`${formatWatchEvent(event, format, io.stdout.isTTY)}\n`);
  const flush = () => {
    if (!buffered || buffered.size === 0) return;
    const events = [...buffered.values()];
    buffered.clear();
    if (format === "ndjson") {
      io.stdout.write(`${JSON.stringify({ type: "watch.flush", timestamp: new Date().toISOString(), events })}\n`);
      return;
    }
    for (const event of events) writeRaw(event);
  };
  const timer = buffered ? setInterval(flush, flushIntervalMs) : null;
  /** @param {WatchEvent} event */
  const emit = (event) => {
    if (buffered) {
      buffered.set(event.taskId, event);
      return;
    }
    writeRaw(event);
  };
  // A terminal event for a taskId-scoped watch must reach stdout before the
  // process exits, never left sitting unflushed in the buffer.
  /** @param {WatchEvent} event */
  const emitTerminalNow = (event) => {
    if (buffered) {
      buffered.set(event.taskId, event);
      flush();
      return;
    }
    writeRaw(event);
  };
  // Hoisted above the Promise executor so the abort listener sites have a
  // stable const to register and remove -- no `undefined` state and no
  // force-cast. It closes over `settle`, which the executor assigns
  // synchronously on construction, before any abort could possibly fire.
  const abortHandler = () => {
    if (buffered && buffered.size > 0) flush();
    settle();
  };
  const finished = new Promise((resolve, reject) => {
    let settled = false;
    /** @param {WatchResult} [result] */
    settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result ?? { directory: resolvedDirectory, watching: false });
    };
    // On abort (SIGINT/SIGTERM or injected AbortSignal) flush any
    // buffered events first, otherwise up to one `--flush-interval`
    // window's worth of events would be silently dropped on a clean
    // (exit code 0) abort. The setInterval is cleared in the `.finally`
    // below, so this is the only path that emits them on the abort
    // boundary.
    if (signal?.aborted) {
      abortHandler();
      return;
    }
    signal?.addEventListener("abort", abortHandler, { once: true });
    Promise.resolve(client.subscribe({ ...subscribeSelector({ all, directory, taskId }), ...(summaries ? { summaries: true } : {}) }, (rawEvent) => {
      // The client is a transport: it hands back whatever JSON the daemon sent,
      // typed only as a bag of keys. The daemon's own event contract (protocol.js)
      // is what guarantees the WatchEvent shape, so this is the one place that
      // narrowing belongs -- everything downstream can then rely on it.
      const event = /** @type {WatchEvent} */ (rawEvent);
      if (taskId && event.taskId !== taskId) return;
      resolvedDirectory = event.directory;
      if (taskId && TERMINAL_STATUSES.has(event.status)) {
        emitTerminalNow(event);
        settle({ directory: resolvedDirectory, watching: false, event });
        return;
      }
      emit(event);
    })).then(() => {
      // Subscriptions only broadcast future transitions (no snapshot replay), so a task
      // that was already terminal before subscribing, or that settled in the gap between
      // resolving task.status above and the subscription actually registering, would
      // otherwise never deliver a terminal event and hang forever.
      if (!taskId || settled) return undefined;
      return client.request(TASK_STATUS_METHOD, { taskId }).then((detail) => {
        if (settled || !TERMINAL_STATUSES.has(detail.status)) return;
        const event = terminalEventFromStatus(detail);
        resolvedDirectory = detail.directory;
        emitTerminalNow(event);
        settle({ directory: resolvedDirectory, watching: false, event });
      });
    }).catch((error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
  return finished.finally(() => {
    signal?.removeEventListener("abort", abortHandler);
    if (timer) clearInterval(timer);
  });
}

/**
 * @param {object} options
 * @param {string} [options.directory]
 * @param {string} [options.taskId]
 * @param {boolean} [options.all]
 * @param {boolean} [options.summaries]
 * @param {"toon"|"ndjson"} [options.format]
 * @param {number} [options.flushIntervalMs]
 * @param {object} deps
 * @param {Client} deps.client
 * @param {Io} deps.io
 * @param {AbortSignal} [deps.signal]
 * @param {string} deps.cwd
 * @param {(startDir: string) => string} [deps.resolveWorkspaceRoot]
 * @returns {Promise<WatchResult>}
 */
async function watchCommand(options, { client, io, signal, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn = resolveWorkspaceRoot }) {
  let directory;
  if (options.all) directory = null;
  else if (options.directory) directory = normalizeDirectory(options.directory);
  else if (options.taskId) directory = null;
  else directory = normalizeDirectory(resolveWorkspaceRootFn(cwd));
  return streamTaskEvents({
    client,
    io,
    signal,
    directory,
    taskId: options.taskId,
    all: options.all,
    summaries: options.summaries,
    format: options.format,
    flushIntervalMs: options.flushIntervalMs,
  }).finally(() => {
    if (client.close) client.close();
  });
}

export { streamTaskEvents, watchCommand, TERMINAL_STATUSES };