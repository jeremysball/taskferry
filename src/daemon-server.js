import fs from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { normalizeDirectory, sameWorkspace } from "./paths.js";
import {
  PROTOCOL_VERSION,
  encodeMessage,
  errorResponse,
  eventMessage,
  parseRequestLine,
  successResponse,
} from "./protocol.js";

export const MAX_BUFFER_BYTES = 1024 * 1024;

// An oversized *success* response (message.ok === true, from successResponse)
// degrades to a small RESPONSE_TOO_LARGE error frame instead of a silent
// socket.destroy() -- without this, the client only ever sees "daemon
// connection closed", indistinguishable from a crash or a network blip, with
// no hint the request's own result was the cause. Event pushes (no `ok`
// field, see eventMessage) and already-small error responses fall straight
// through to the destroy, same as before.
export function makeWriteMessage(maxOutboundBytes) {
  return function writeMessage(socket, message) {
    if (socket.destroyed) return false;
    const encoded = encodeMessage(message);
    if (socket.writableLength + Buffer.byteLength(encoded) <= maxOutboundBytes) {
      socket.write(encoded);
      return true;
    }
    if (message.ok === true) {
      const fallback = errorResponse(
        message.id,
        "RESPONSE_TOO_LARGE",
        `daemon response for this request exceeds ${maxOutboundBytes} bytes`,
        "Narrow the request (e.g. pass --directory), or use a method that summarizes server-side if one exists",
      );
      const fallbackEncoded = encodeMessage(fallback);
      if (socket.writableLength + Buffer.byteLength(fallbackEncoded) <= maxOutboundBytes) {
        socket.write(fallbackEncoded);
        return true;
      }
    }
    socket.destroy();
    return false;
  };
}

// Defensive fallback for a caller that omits resolveWorkspaceRootFn: falls
// back to sameWorkspace()'s literal-equality fast path (today's pre-#315
// behavior) rather than throwing on a directory-comparison call.
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
function eventPayload(event, summaries) {
  if (!event.activityVariants) return event;
  const variant = event.activityVariants[String(summaries)];
  if (!variant) return null;
  const rest = { ...event };
  delete rest.activityVariants;
  return { ...rest, ...variant };
}

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

export function syncActivitySubscriptions(manager, subscriptions) {
  if (typeof manager.setActivitySubscriptions !== "function") return;
  // A `watch --all` subscription groups under the ALL_DIRECTORIES (null)
  // key here; tasks.js's scheduleActivityFor() unions that bucket's variants
  // into every task's lookup regardless of the task's own directory.
  /** @type {Map<string|null, Set<boolean>>} */
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

// `all: true` (watch --all) short-circuits to ALL_DIRECTORIES; otherwise an
// explicit directory wins, falling back to the daemon resolving it from
// taskId server-side (watch --task-id, issue #59).
function subscriptionDirectory(params, manager) {
  if (params.all === true) return ALL_DIRECTORIES;
  if (params.directory !== undefined) return normalizeDirectory(params.directory);
  return normalizeDirectory(manager.taskDirectory(params.taskId));
}

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
    originSessionId: request.params.originSessionId || null,
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

export function createDaemonServer({ clients, subscriptions, manager, writeMessage, syncActivity, inFlightRef, maxInFlightRequests, maybeRestart, invoke, responseError, onRequestTimed }) {
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
      if (Buffer.byteLength(buffer) > MAX_BUFFER_BYTES) {
        const requestTooLargeStartedAt = onRequestTimed ? performance.now() : 0;
        writeMessage(socket, errorResponse(null, "REQUEST_TOO_LARGE", "request exceeds 1 MiB", "Send a smaller request"));
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

export function makeClose({ manager, clients, server, socketPath, restart }) {
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
