import { normalizeDirectory, resolveWorkspaceRoot } from "./paths.js";
import { formatWatchEvent } from "./output.js";
import { TERMINAL_STATUSES as CORE_TERMINAL_STATUSES } from "./opencode-plugin.js";

const TASK_STATUS_METHOD = "task.status";
const TASK_STATE_EVENT_TYPE = "task.state";

// Watch considers a task "settled" (no further events worth emitting) when
// the daemon reports one of these states; matches the same set the daemon
// uses to gate terminal events, plus "unknown" for a task the daemon can no
// longer classify. Re-exported so tests can pin it.
const TERMINAL_STATUSES = new Set([...CORE_TERMINAL_STATUSES, "unknown"]);

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

function streamTaskEvents({ client, io, signal, directory, taskId, summaries, format, flushIntervalMs }) {
  let settle;
  let abortHandler;
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
  const emit = (event) => {
    if (buffered) {
      buffered.set(event.taskId, event);
      return;
    }
    writeRaw(event);
  };
  // A terminal event for a taskId-scoped watch must reach stdout before the
  // process exits, never left sitting unflushed in the buffer.
  const emitTerminalNow = (event) => {
    if (buffered) {
      buffered.set(event.taskId, event);
      flush();
      return;
    }
    writeRaw(event);
  };
  const finished = new Promise((resolve, reject) => {
    let settled = false;
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
    abortHandler = () => {
      if (buffered && buffered.size > 0) flush();
      settle();
    };
    if (signal?.aborted) {
      if (buffered && buffered.size > 0) flush();
      settle();
      return;
    }
    signal?.addEventListener("abort", abortHandler, { once: true });
    Promise.resolve(client.subscribe({ ...(directory ? { directory } : { taskId }), ...(summaries ? { summaries: true } : {}) }, (event) => {
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

async function watchCommand(options, { client, io, signal, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn = resolveWorkspaceRoot }) {
  let directory;
  if (options.directory) directory = normalizeDirectory(options.directory);
  else if (options.taskId) directory = null;
  else directory = normalizeDirectory(resolveWorkspaceRootFn(cwd));
  return streamTaskEvents({
    client,
    io,
    signal,
    directory,
    taskId: options.taskId,
    summaries: options.summaries,
    format: options.format,
    flushIntervalMs: options.flushIntervalMs,
  }).finally(() => {
    if (client.close) client.close();
  });
}

export { streamTaskEvents, watchCommand, TERMINAL_STATUSES };