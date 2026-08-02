import fs from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { normalizeDirectory } from "./paths.js";
import {
  PROTOCOL_VERSION,
  encodeMessage,
  errorResponse,
  eventMessage,
  parseRequestLine,
  successResponse,
} from "./protocol.js";

export const MAX_BUFFER_BYTES = 1024 * 1024;

// The connection layer of the daemon: owns the per-client socket bookkeeping,
// request dispatch loop, event fan-out, and the deferred-until-idle
// self-restart. Everything here is driven by startDaemon() in daemon.js, which
// supplies the mutable collections and the RPC/invoke delegates.

// Picks the per-subscription payload for a single event: a summary-variant
// merge when the event carries activityVariants, the event itself otherwise,
// or null when the requested variant is absent.
function eventPayload(event, summaries) {
  if (!event.activityVariants) return event;
  const variant = event.activityVariants[String(summaries)];
  if (!variant) return null;
  const rest = { ...event };
  delete rest.activityVariants;
  return { ...rest, ...variant };
}

export function deliverEvent(subscriptions, writeMessage, event) {
  for (const [subscriptionId, subscription] of subscriptions) {
    let passes = event.directory === subscription.directory && !subscription.socket.destroyed;
    if (subscription.originSessionId && event.originSessionId && subscription.originSessionId !== event.originSessionId) {
      passes = false;
    }
    if (!passes) continue;
    const payload = eventPayload(event, subscription.summaries);
    if (payload) writeMessage(subscription.socket, eventMessage(subscriptionId, payload));
  }
}

export function syncActivitySubscriptions(manager, subscriptions) {
  if (typeof manager.setActivitySubscriptions !== "function") return;
  /** @type {Map<string, Set<boolean>>} */
  const subs = new Map();
  for (const subscription of subscriptions.values()) {
    let variants = subs.get(subscription.directory);
    if (!variants) {
      variants = new Set();
      subs.set(subscription.directory, variants);
    }
    variants.add(subscription.summaries);
  }
  manager.setActivitySubscriptions(subs);
}

// Returns whether the subscription-ack response was actually delivered
// (writeMessage's return value), not just whether this function ran to
// completion -- a destroyed/over-limit socket means the caller never saw
// the subscriptionId even though subscribeRequest itself didn't throw.
async function subscribeRequest({ manager, subscriptions, socket, writeMessage, syncActivity }, request) {
  if (request.params.summaries === true && typeof manager.checkSummaryModelReady === "function") {
    await manager.checkSummaryModelReady();
  }
  const directory = request.params.directory !== undefined
    ? normalizeDirectory(request.params.directory)
    : normalizeDirectory(manager.taskDirectory(request.params.taskId));
  const subscriptionId = randomUUID();
  subscriptions.set(subscriptionId, {
    socket,
    directory,
    summaries: request.params.summaries === true,
    originSessionId: request.params.originSessionId || null,
  });
  syncActivity();
  return writeMessage(socket, successResponse(request.id, { subscriptionId }));
}

// startedAt is only captured when a timer is actually wired up (onRequestTimed
// truthy) -- with profiling disabled, performance.now() is never called and
// no timing record is built, so an opted-out daemon pays none of this cost.
// Every return path (parse failure, SERVER_BUSY, and the normal try/finally)
// reports through onRequestTimed so "every RPC request" in the profiling
// docs is literally true, not just the ones that reach invoke().
export async function dispatchRequest({ subscriptions, manager, writeMessage, syncActivity, inFlightRef, maxInFlightRequests, maybeRestart, invoke, responseError, onRequestTimed }, socket, line) {
  const startedAt = onRequestTimed ? performance.now() : 0;
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
    ok = false;
    if (!socket.destroyed) writeMessage(socket, responseError(error, request?.id ?? null));
  } finally {
    inFlightRef.current--;
    onRequestTimed?.({ method: request.method, durationMs: performance.now() - startedAt, ok });
    maybeRestart();
  }
}

export function createDaemonServer({ clients, subscriptions, manager, writeMessage, syncActivity, inFlightRef, maxInFlightRequests, maybeRestart, invoke, responseError, onRequestTimed }) {
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
      if (Buffer.byteLength(buffer) > MAX_BUFFER_BYTES) {
        writeMessage(socket, errorResponse(null, "REQUEST_TOO_LARGE", "request exceeds 1 MiB", "Send a smaller request"));
        socket.destroy();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) {
          void dispatchRequest({ subscriptions, manager, writeMessage, syncActivity, inFlightRef, maxInFlightRequests, maybeRestart, invoke, responseError, onRequestTimed }, socket, line);
        }
      }
    });
  });
}

export function makeClose({ clients, server, socketPath, restart }) {
  let closing;
  return function close() {
    if (closing) return closing;
    closing = new Promise((resolve, reject) => {
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
          if (unlinkError.code !== "ENOENT") {
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

// Deferred-until-idle restart: a source change is detected any time after
// startup, but the actual restart waits for zero running/queued tasks so an
// in-flight opencode child is never orphaned mid-task by the daemon
// swapping itself out from under it.
export function makeMaybeRestart({ manager, sourceDir, sourceSignature, startupSourceSignature, close, spawnReplacement, daemonEntry, env, exitProcess, restart }) {
  return function maybeRestart() {
    if (restart.restarting) return;
    if (!restart.pending && sourceSignature(sourceDir) !== startupSourceSignature) restart.pending = true;
    if (!restart.pending) return;
    const { counts } = manager.list();
    if (counts.running > 0 || counts.queued > 0) return;
    restart.restarting = true;
    void (async () => {
      await close();
      spawnReplacement({ daemonEntry, env });
      exitProcess();
    })();
  };
}
