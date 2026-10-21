import fs from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { normalizeActivitySubscriptionKey, normalizeDirectory, sameWorkspace } from "./paths.js";
import {
  PROTOCOL_VERSION,
  encodeMessage,
  errorResponse,
  eventMessage,
  parseRequestLine,
  successResponse,
} from "./protocol.js";

export const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
export const MAX_BUFFER_BYTES = DEFAULT_MAX_BUFFER_BYTES;

/**
 * The subset of the task manager's surface that the daemon connection layer
 * touches. The full manager is built by `createTaskManager` in tasks.js; this
 * narrows it to the members used here so the connection layer doesn't need to
 * import the whole manager type.
 * @typedef {object} TaskManager
 * @property {(subs: Map<string|null, Set<boolean>>) => void} setActivitySubscriptions
 * @property {() => Promise<void>} checkSummaryModelReady
 * @property {(taskId: string) => string} taskDirectory
 * @property {() => {counts: {running: number, queued: number, done: number, crashed: number, cancelled: number, unknown: number}}} list
 * @property {() => void} [close]
 */

/**
 * @typedef {object} Subscription
 * @property {import("node:net").Socket} socket
 * @property {string | null} directory
 * @property {boolean} summaries
 * @property {string | null} originSessionId
 */

/**
 * @typedef {object} DispatchDeps
 * @property {Map<string, Subscription>} subscriptions
 * @property {TaskManager} manager
 * @property {(socket: import("node:net").Socket, message: Record<string, unknown>) => boolean} writeMessage
 * @property {() => void} syncActivity
 * @property {{current: number}} inFlightRef
 * @property {number} maxInFlightRequests
 * @property {() => void} maybeRestart
 * @property {(manager: TaskManager, request: Request) => unknown} invoke
 * @property {(error: unknown, requestId: string | null) => Record<string, unknown>} responseError
 * @property {((timing: {method: string, durationMs: number, ok: boolean}) => void) | null | undefined} onRequestTimed
 */

// An oversized response (success, error, or event push) degrades to a small
// RESPONSE_TOO_LARGE error frame instead of a silent socket.destroy() --
// without this, the client only ever sees "daemon connection closed",
// indistinguishable from a crash or a network blip, with no hint the
// request's own result was the cause. Two bounded fallback levels (a
// "normal" envelope and a "small" envelope with shorter message/help
// strings), so a socket whose existing backlog already sits within one
// fallback frame's width of the cap still gets a diagnosable frame instead
// of a zero-diagnostic destroy. If even the small fallback doesn't fit, the
// wire is too far gone for any useful frame to land -- destroy.
/**
 * @param {number} maxOutboundBytes
 * @returns {(socket: import("node:net").Socket, message: Record<string, unknown>) => boolean}
 */
export function makeWriteMessage(maxOutboundBytes) {
  /**
   * @param {import("node:net").Socket} socket
   * @param {unknown} message
   */
  function tryWrite(socket, message) {
    const encoded = encodeMessage(message);
    if (socket.writableLength + Buffer.byteLength(encoded) <= maxOutboundBytes) {
      socket.write(encoded);
      return true;
    }
    return false;
  }
  /**
   * @param {import("node:net").Socket} socket
   * @param {Record<string, unknown>} message
   */
  return function writeMessage(socket, message) {
    if (socket.destroyed) return false;
    if (tryWrite(socket, message)) return true;
    // Event pushes (eventMessage) carry no request id and a different
    // envelope shape; there's no equivalent success/error response to
    // degrade to, so the closest we can offer is a no-id error frame
    // that the client's consumeResponse treats as a stray (no pending
    // request to fail) and discards. That's still strictly better than
    // tearing the socket down: the caller loses one event, not the
    // whole connection.
    if (message.ok === undefined) {
      if (tryWrite(socket, errorResponse(null, "RESPONSE_TOO_LARGE", "event dropped: response too large", ""))) {
        return true;
      }
      socket.destroy();
      return false;
    }
    const id = typeof message.id === "string" ? message.id : null;
    if (tryWrite(socket, errorResponse(
      id,
      "RESPONSE_TOO_LARGE",
      `daemon response for this request exceeds ${maxOutboundBytes} bytes`,
      "Narrow the request (e.g. pass --directory), or use a method that summarizes server-side if one exists",
    ))) {
      return true;
    }
    if (tryWrite(socket, errorResponse(id, "RESPONSE_TOO_LARGE", "response too large", ""))) {
      return true;
    }
    socket.destroy();
    return false;
  };
}

// Defensive fallback for a caller that omits resolveWorkspaceRootFn: falls
// back to sameWorkspace()'s literal-equality fast path (today's pre-#315
// behavior) rather than throwing on a directory-comparison call.
/** @param {string} directory @returns {string} */
const identityWorkspaceRoot = (directory) => directory;

// Sentinel subscription.directory for `event.subscribe({ all: true })`
// (watch --all, taskferry#315's escape hatch): matches every task
// regardless of directory instead of being compared against one.
const ALL_DIRECTORIES = null;

// The connection layer of the daemon: owns the per-client socket bookkeeping,
// request dispatch loop, event fan-out, and the deferred-until-idle
// self-restart. Everything here is driven by startDaemon() in daemon.js, which
// supplies the mutable collections and the RPC/invoke delegates.

// Picks the per-subscription payload for a single event: a summary-variant
// merge when the event carries activityVariants, the event itself otherwise,
// or null when the requested variant is absent.
/**
 * @typedef {object} Event
 * @property {string} directory
 * @property {string | null} [originSessionId]
 * @property {Record<string, unknown>} [activityVariants]
 */

/**
 * @param {Event} event
 * @param {boolean} summaries
 * @returns {object | null}
 */
function eventPayload(event, summaries) {
  if (!event.activityVariants) return event;
  const variant = event.activityVariants[String(summaries)];
  if (!variant) return null;
  const rest = { ...event };
  delete rest.activityVariants;
  return { ...rest, ...variant };
}

/**
 * @param {Map<string, Subscription>} subscriptions
 * @param {(socket: import("node:net").Socket, message: Record<string, unknown>) => boolean} writeMessage
 * @param {Event} event
 * @param {(directory: string) => string} [resolveWorkspaceRootFn]
 */
export function deliverEvent(subscriptions, writeMessage, event, resolveWorkspaceRootFn = identityWorkspaceRoot) {
  for (const [subscriptionId, subscription] of subscriptions) {
    // ALL_DIRECTORIES bypasses the directory check entirely (watch --all).
    // Otherwise sameWorkspace(), not a raw `===`, so a subscription scoped
    // to a repo root also receives events for a task dispatched into a
    // linked worktree of the same repo (taskferry#315).
    let passes = (subscription.directory === ALL_DIRECTORIES || sameWorkspace(event.directory, subscription.directory, resolveWorkspaceRootFn))
      && !subscription.socket.destroyed;
    if (subscription.originSessionId && event.originSessionId && subscription.originSessionId !== event.originSessionId) {
      passes = false;
    }
    if (!passes) continue;
    const payload = eventPayload(event, subscription.summaries);
    if (payload) writeMessage(subscription.socket, eventMessage(subscriptionId, payload));
  }
}

/**
 * @param {TaskManager} manager
 * @param {Map<string, Subscription>} subscriptions
 * @param {(directory: string) => string} [resolveWorkspaceRootFn]
 */
export function syncActivitySubscriptions(manager, subscriptions, resolveWorkspaceRootFn = identityWorkspaceRoot) {
  if (typeof manager.setActivitySubscriptions !== "function") return;
  // A `watch --all` subscription groups under the ALL_DIRECTORIES (null)
  // key here; tasks.js's scheduleActivityFor() unions that bucket's variants
  // into every task's lookup regardless of the task's own directory. Every
  // other key is normalized to its git workspace root (taskferry#335), the
  // same normalization scheduleActivityFor() applies to a task's own
  // directory before looking this map up -- otherwise a root-scoped `watch`
  // is keyed under the repo root while a task dispatched into a linked
  // worktree looks itself up under the worktree path, and the two never
  // meet even though deliverEvent() already treats them as the same
  // subscriber via sameWorkspace().
  /** @type {Map<string|null, Set<boolean>>} */
  const subs = new Map();
  for (const subscription of subscriptions.values()) {
    let key;
    try {
      key = normalizeActivitySubscriptionKey(subscription.directory, resolveWorkspaceRootFn);
    } catch (err) {
      console.error(`taskferry: failed to resolve activity subscription directory ${subscription.directory}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    let variants = subs.get(key);
    if (!variants) {
      variants = new Set();
      subs.set(key, variants);
    }
    variants.add(subscription.summaries);
  }
  manager.setActivitySubscriptions(subs);
}

// `all: true` (watch --all) short-circuits to ALL_DIRECTORIES; otherwise an
// explicit directory wins, falling back to the daemon resolving it from
// taskId server-side (watch --task-id, issue #59).
/**
 * @param {Record<string, unknown>} params
 * @param {TaskManager} manager
 * @returns {string | null}
 */
function subscriptionDirectory(params, manager) {
  if (params.all === true) return ALL_DIRECTORIES;
  if (params.directory !== undefined) return normalizeDirectory(/** @type {string} */ (params.directory));
  return normalizeDirectory(manager.taskDirectory(/** @type {string} */ (params.taskId)));
}

/**
 * A request as parseRequestLine() in protocol.js hands it back, after that
 * function has already validated the envelope. daemon.js aliases this rather
 * than restating it, so the invoke() delegate it supplies and the dispatch
 * loop that calls it cannot drift apart.
 * @typedef {object} Request
 * @property {unknown} version
 * @property {string} id
 * @property {string} method
 * @property {Record<string, unknown>} params
 */

/**
 * @param {object} deps
 * @param {TaskManager} deps.manager
 * @param {Map<string, Subscription>} deps.subscriptions
 * @param {import("node:net").Socket} deps.socket
 * @param {(socket: import("node:net").Socket, message: Record<string, unknown>) => boolean} deps.writeMessage
 * @param {() => void} deps.syncActivity
 * @param {Request} request
 */
async function subscribeRequest({ manager, subscriptions, socket, writeMessage, syncActivity }, request) {
  if (request.params.summaries === true && typeof manager.checkSummaryModelReady === "function") {
    await manager.checkSummaryModelReady();
  }
  const directory = subscriptionDirectory(request.params, manager);
  const subscriptionId = randomUUID();
  subscriptions.set(subscriptionId, {
    socket,
    directory,
    summaries: request.params.summaries === true,
    originSessionId: typeof request.params.originSessionId === "string" ? request.params.originSessionId : null,
  });
  syncActivity();
  return writeMessage(socket, successResponse(request.id, { subscriptionId }));
}

// startedAt is only captured when a timer is actually wired up (onRequestTimed
// truthy) -- with profiling disabled, performance.now() is never called, so an
// opted-out daemon pays none of this cost. Every path below (parse failure,
// SERVER_BUSY, and the normal try/finally) reports through onRequestTimed so
// "every RPC request" in the profiling docs is literally true, not just the
// ones that reach invoke().
/**
 * @param {DispatchDeps} deps
 * @param {import("node:net").Socket} socket
 * @param {string} line
 */
export async function dispatchRequest({ subscriptions, manager, writeMessage, syncActivity, inFlightRef, maxInFlightRequests, maybeRestart, invoke, responseError, onRequestTimed }, socket, line) {
  const startedAt = onRequestTimed ? performance.now() : 0;
  /** @type {Request | undefined} */
  let request;
  try {
    request = parseRequestLine(line);
  } catch (error) {
    writeMessage(socket, responseError(error, null));
    onRequestTimed?.({ method: "parse_error", durationMs: performance.now() - startedAt, ok: false });
    return;
  }
  if (inFlightRef.current >= maxInFlightRequests) {
    writeMessage(socket, errorResponse(request.id, "SERVER_BUSY", "daemon has too many requests in flight", "Wait for an outstanding request to finish, then retry"));
    onRequestTimed?.({ method: request.method, durationMs: performance.now() - startedAt, ok: false });
    return;
  }
  inFlightRef.current++;
  let ok = true;
  try {
    if (request.method === "event.subscribe") {
      ok = await subscribeRequest({ manager, subscriptions, socket, writeMessage, syncActivity }, request);
      return;
    }
    const result = await invoke(manager, request);
    ok = writeMessage(socket, successResponse(request.id, result));
  } catch (error) {
    // ok tracks whether a response reached the client, not merely whether
    // invoke() threw -- an error response that was successfully written is
    // still a delivered response.
    ok = !socket.destroyed && writeMessage(socket, responseError(error, request?.id ?? null));
  } finally {
    inFlightRef.current--;
    onRequestTimed?.({ method: request.method, durationMs: performance.now() - startedAt, ok });
    maybeRestart();
  }
}

/**
 * @param {object} opts
 * @param {Set<import("node:net").Socket>} opts.clients
 * @param {Map<string, Subscription>} opts.subscriptions
 * @param {TaskManager} opts.manager
 * @param {(socket: import("node:net").Socket, message: Record<string, unknown>) => boolean} opts.writeMessage
 * @param {() => void} opts.syncActivity
 * @param {{current: number}} opts.inFlightRef
 * @param {number} opts.maxInFlightRequests
 * @param {() => void} opts.maybeRestart
 * @param {(manager: TaskManager, request: Request) => unknown} opts.invoke
 * @param {(error: unknown, requestId: string | null) => Record<string, unknown>} opts.responseError
 * @param {((timing: {method: string, durationMs: number, ok: boolean}) => void) | null | undefined} opts.onRequestTimed
 * @param {number} [opts.maxBufferBytes]
 * @returns {import("node:net").Server}
 */
export function createDaemonServer({ clients, subscriptions, manager, writeMessage, syncActivity, inFlightRef, maxInFlightRequests, maybeRestart, invoke, responseError, onRequestTimed, maxBufferBytes = MAX_BUFFER_BYTES }) {
  /** @type {DispatchDeps} */
  const dispatchDeps = { subscriptions, manager, writeMessage, syncActivity, inFlightRef, maxInFlightRequests, maybeRestart, invoke, responseError, onRequestTimed };
  return net.createServer((socket) => {
    clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    const cleanup = () => {
      clients.delete(socket);
      for (const [subscriptionId, subscription] of subscriptions) {
        if (subscription.socket === socket) subscriptions.delete(subscriptionId);
      }
      syncActivity();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);

    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxBufferBytes) {
        const requestTooLargeStartedAt = onRequestTimed ? performance.now() : 0;
        writeMessage(socket, errorResponse(null, "REQUEST_TOO_LARGE", `request exceeds ${maxBufferBytes} bytes`, "Send a smaller request"));
        onRequestTimed?.({ method: "request_too_large", durationMs: performance.now() - requestTooLargeStartedAt, ok: false });
        socket.destroy();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) {
          void dispatchRequest(dispatchDeps, socket, line);
        }
      }
    });
  });
}

/**
 * @param {object} opts
 * @param {TaskManager} opts.manager
 * @param {Set<import("node:net").Socket>} opts.clients
 * @param {import("node:net").Server} opts.server
 * @param {string} opts.socketPath
 * @param {{restarting: boolean}} opts.restart
 * @returns {() => Promise<void>}
 */
export function makeClose({ manager, clients, server, socketPath, restart }) {
  /** @type {Promise<void> | undefined} */
  let closing;
  return function close() {
    if (closing) return closing;
    closing = new Promise((resolve, reject) => {
      // A throw here (e.g. from envFileWatcher.close() inside manager.close())
      // must not skip the shutdown broadcast, server.close(), or socket
      // unlink below -- letting it propagate would reject the whole close()
      // promise, which in turn leaves maybeRestart()'s `restarting` latch
      // stuck true forever (the restart's spawnReplacement/exitProcess never
      // run) and makes the SIGTERM/SIGINT handler exit nonzero for a failure
      // that's otherwise harmless to the actual shutdown.
      try {
        manager.close?.();
      } catch { /* best-effort cleanup; shutdown must proceed regardless */ }
      for (const socket of clients) {
        socket.write(encodeMessage({ version: PROTOCOL_VERSION, type: "shutdown", reason: restart.restarting ? "restart" : "shutdown" }));
        socket.destroy();
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          fs.unlinkSync(socketPath);
        } catch (unlinkError) {
          if (/** @type {{code?: string}} */ (unlinkError).code !== "ENOENT") {
            reject(unlinkError);
            return;
          }
        }
        resolve();
      });
    });
    return closing;
  };
}

// Source-change restart: by default the daemon restarts immediately on a
// source-file mtime change (tasks in flight are auto-resumed on the next
// boot via tasks.js's daemon-restart handler). When `restartWaitForIdle` is
// true (opt-in via TASKFERRY_RESTART_WAIT_FOR_IDLE or config
// restartWaitForIdle), the restart defers until zero running/queued tasks,
// preserving the old "never orphan a child" behavior for callers that
// explicitly want it.
/**
 * @param {object} opts
 * @param {TaskManager} opts.manager
 * @param {string} opts.sourceDir
 * @param {(dir?: string) => number} opts.sourceSignature
 * @param {number} opts.startupSourceSignature
 * @param {() => Promise<void>} opts.close
 * @param {(opts: {daemonEntry: string, env: NodeJS.ProcessEnv}) => void} opts.spawnReplacement
 * @param {string} opts.daemonEntry
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {() => void} opts.exitProcess
 * @param {{pending: boolean, restarting: boolean}} opts.restart
 * @param {boolean} [opts.restartWaitForIdle]
 * @returns {() => void}
 */
export function makeMaybeRestart({ manager, sourceDir, sourceSignature, startupSourceSignature, close, spawnReplacement, daemonEntry, env, exitProcess, restart, restartWaitForIdle = false }) {
  return function maybeRestart() {
    if (restart.restarting) return;
    if (!restart.pending && sourceSignature(sourceDir) !== startupSourceSignature) restart.pending = true;
    if (!restart.pending) return;
    if (restartWaitForIdle) {
      const { counts } = manager.list();
      if (counts.running > 0 || counts.queued > 0) return;
    }
    restart.restarting = true;
    void (async () => {
      await close();
      spawnReplacement({ daemonEntry, env });
      exitProcess();
    })();
  };
}
