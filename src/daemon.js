#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTaskManager } from "./tasks.js";
import { loadConfig } from "./config.js";
import { withFileLock, withFileLockAsync } from "./state-lock.js";
import { normalizeDirectory, resolveRuntimeDir, resolveStateDir } from "./paths.js";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  encodeMessage,
  errorResponse,
  eventMessage,
  parseRequestLine,
  successResponse,
} from "./protocol.js";

const MAX_BUFFER_BYTES = 1024 * 1024;
const DAEMON_ENTRY = fileURLToPath(import.meta.url);
const SOURCE_DIR = path.dirname(DAEMON_ENTRY);

// Detects a source-code update (e.g. a merge picked up while the daemon was
// running) so the daemon can restart itself onto the new code. Recomputed
// after every request and compared against the value captured at startup.
function sourceSignature(dir = SOURCE_DIR) {
  let max = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".js")) continue;
    const { mtimeMs } = fs.statSync(path.join(dir, entry));
    if (mtimeMs > max) max = mtimeMs;
  }
  return max;
}

function resolveSocketPath(options = {}) {
  return options.socketPath || options.env?.TASKFERRY_SOCKET_PATH || path.join(resolveRuntimeDir(options), "daemon.sock");
}

function defaultSpawnReplacement({ daemonEntry, env }) {
  spawn(process.execPath, [daemonEntry], { detached: true, stdio: "ignore", env }).unref();
}

function socketHealth(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let connected = false;
    let settled = false;
    let buffer = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ listening: connected, healthy: false }), timeoutMs);

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      connected = true;
      socket.write(encodeMessage({ version: 1, id: "health-check", method: "system.health", params: {} }));
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        finish({
          listening: true,
          healthy: response.version === PROTOCOL_VERSION
            && response.id === "health-check"
            && response.ok === true
            && response.result?.healthy === true,
        });
      } catch {
        finish({ listening: true, healthy: false });
      }
    });
    socket.on("error", (error) => {
      if (settled) return;
      if (["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes(error.code)) {
        finish({ listening: false, healthy: false });
        return;
      }
      clearTimeout(timer);
      settled = true;
      reject(error);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries with a short backoff between iterations: without one, concurrent
// daemon boots racing over the same socket path can keep invalidating each
// other's removeStaleSocketIfUnchanged CAS indefinitely, and each iteration
// resolves near-instantly (an ECONNREFUSED/ENOENT socketHealth check fires in
// well under a millisecond), so the loop busy-spins a full CPU core for as
// long as the race lasts instead of actually converging.
export async function prepareSocket(runtimeDir, socketPath, healthCheckTimeoutMs, retryDelayMs = 25) {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  for (;;) {
    if (!fs.existsSync(socketPath)) return;
    let checkedIdentity;
    try {
      checkedIdentity = fs.statSync(socketPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        await delay(retryDelayMs);
        continue;
      }
      throw error;
    }
    const health = await socketHealth(socketPath, healthCheckTimeoutMs);
    if (health.listening) {
      const qualifier = health.healthy ? "taskferry daemon" : "another process";
      throw new Error(`error: ${qualifier} is already listening on ${socketPath}\nhelp: use the existing daemon or choose another TASKFERRY_RUNTIME_DIR`);
    }
    if (removeStaleSocketIfUnchanged(socketPath, checkedIdentity, runtimeDir)) return;
    await delay(retryDelayMs);
  }
}

export function removeStaleSocketIfUnchanged(socketPath, checkedIdentity, runtimeDir) {
  const cleanupLock = path.join(runtimeDir, "socket-cleanup.lock");
  return withFileLock(cleanupLock, () => {
    let currentIdentity;
    try {
      currentIdentity = fs.statSync(socketPath);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    // dev+ino alone can collide: an unlink immediately followed by a create
    // can reuse the freed inode number on some filesystems. ctimeMs (set
    // fresh on every create/rename) closes that race.
    if (
      currentIdentity.dev !== checkedIdentity.dev ||
      currentIdentity.ino !== checkedIdentity.ino ||
      currentIdentity.ctimeMs !== checkedIdentity.ctimeMs
    ) return false;
    fs.unlinkSync(socketPath);
    return true;
  });
}

function emptyCounts() {
  return { queued: 0, running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0 };
}

function listRows(manager) {
  const listed = manager.list();
  return Array.isArray(listed.tasks) ? listed.tasks : [];
}

function filteredTaskDetails(manager, directory) {
  const normalized = normalizeDirectory(directory);
  return {
    directory: normalized,
    // Filter the cheap in-memory row (which already carries `directory`)
    // before calling manager.status() -- status() does per-task log I/O
    // (statSync/open/read), so calling it for every task ever recorded
    // instead of just the ones in this workspace turns a routine
    // statusline poll into O(all-time task count) synchronous I/O on the
    // daemon's single thread (taskferry#287).
    tasks: listRows(manager)
      .filter((row) => row.directory === normalized)
      .map((row) => manager.status(row.id)),
  };
}

function filteredList(manager, directory) {
  if (directory === undefined) return manager.list();
  const details = filteredTaskDetails(manager, directory);
  const counts = countTasks(details.tasks);
  const rows = details.tasks.map(({ id, status, model, startedAt, failureReason }) => ({ id, status, model, startedAt, failureReason: failureReason ?? null }));
  return { counts, tasks: rows.length ? rows : "none found in this workspace" };
}

function countTasks(tasks) {
  const counts = emptyCounts();
  for (const task of tasks) {
    if (counts[task.status] !== undefined) counts[task.status]++;
  }
  return counts;
}

async function invoke(manager, request) {
  const params = request.params;
  switch (request.method) {
    case "system.health":
      return { healthy: true, pid: process.pid, version: PROTOCOL_VERSION };
    case "task.dispatch":
      return manager.dispatch(params);
    case "task.cancel":
      return manager.cancel(params.taskId, params.graceMs === undefined ? undefined : { graceMs: params.graceMs });
    case "task.status":
      return manager.status(params.taskId);
    case "task.wait":
      // Forward the whole validated params object, same as task.summary/
      // task.advisor below -- manager.poll() destructures what it consumes
      // and ignores the rest, so a rebuilt field list here would just be
      // another spot for a newly-added field to silently vanish.
      return manager.poll(params.taskId, params);
    case "task.list":
      return filteredList(manager, params.directory);
    case "task.result":
      // Same reasoning as task.wait above -- manager.result() destructures
      // { full, fields } and ignores the rest.
      return manager.result(params.taskId, params);
    case "task.tail":
      return manager.tail(params.taskId, params.chars === undefined ? undefined : { chars: params.chars });
    case "task.summary":
      // Forward the whole validated params object as the manager's options
      // argument. The explicit field-list rebuild was the shape that
      // silently dropped newly-added fields (the previous fix that landed
      // this env forwarding had to be its own commit because the rebuild
      // here was filtering it out); forwarding the whole params matches
      // task.dispatch's pattern and means new fields arrive at the manager
      // without a separate code change here.
      return manager.summarize(params.taskId, params);
    case "task.advisor":
      // Same as task.summary: forward the whole validated params object
      // rather than rebuilding a field list. manager.advisor() destructures
      // the fields it consumes and ignores the rest.
      return manager.advisor(params);
    case "task.context": {
      const context = filteredTaskDetails(manager, params.directory);
      return { ...context, counts: countTasks(context.tasks) };
    }
    case "task.accept":
      return manager.accept(params.taskId);
    case "task.reject":
      return manager.reject(params.taskId);
    default:
      throw new Error(`unsupported method after validation: ${request.method}`);
  }
}

function responseError(error, requestId) {
  if (error instanceof ProtocolError) {
    return errorResponse(error.requestId, error.code, error.message, error.help);
  }
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split("\n");
  const message = lines.find((line) => line.startsWith("error:"))?.slice(6).trim() || lines[0];
  const help = lines.find((line) => line.startsWith("help:"))?.slice(5).trim() || "Retry the request or inspect the daemon logs";
  const code = /unknown task id:/.test(text) ? "UNKNOWN_TASK" : "REQUEST_FAILED";
  return errorResponse(requestId, code, message, help);
}

export async function startDaemon({
  platform = process.platform,
  env = process.env,
  stateDir = resolveStateDir(env),
  runtimeDir = resolveRuntimeDir({ env, stateDir }),
  socketPath = resolveSocketPath({ env, stateDir, runtimeDir }),
  healthCheckTimeoutMs = 250,
  maxOutboundBytes = MAX_BUFFER_BYTES,
  maxInFlightRequests = 256,
  taskManagerFactory = createTaskManager,
  taskManagerOptions = {},
  sourceDir = SOURCE_DIR,
  daemonEntry = DAEMON_ENTRY,
  spawnReplacement = defaultSpawnReplacement,
  exitProcess = () => process.exit(0),
} = {}) {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error("error: taskferry daemon supports Linux and macOS only\nhelp: run taskferry on a Unix host with Unix-domain socket support");
  }
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  const clients = new Set();
  const subscriptions = new Map();
  let inFlightRequests = 0;
  const writeMessage = (socket, message) => {
    if (socket.destroyed) return false;
    const encoded = encodeMessage(message);
    if (socket.writableLength + Buffer.byteLength(encoded) > maxOutboundBytes) {
      socket.destroy();
      return false;
    }
    socket.write(encoded);
    return true;
  };
  const onEvent = (event) => {
    for (const [subscriptionId, subscription] of subscriptions) {
      if (event.directory !== subscription.directory || subscription.socket.destroyed) continue;
      if (subscription.originSessionId && event.originSessionId && subscription.originSessionId !== event.originSessionId) continue;
      if (event.activityVariants) {
        const variant = event.activityVariants[String(subscription.summaries)];
        if (!variant) continue;
        const { activityVariants, ...rest } = event;
        writeMessage(subscription.socket, eventMessage(subscriptionId, { ...rest, ...variant }));
      } else {
        writeMessage(subscription.socket, eventMessage(subscriptionId, event));
      }
    }
  };
  const manager = taskManagerFactory({ ...taskManagerOptions, stateDir, runtimeDir, onEvent });
  const startupSourceSignature = sourceSignature(sourceDir);
  let restartPending = false;
  let restarting = false;
  const updateSummarySubscriptions = () => {
    if (typeof manager.setActivitySubscriptions === "function") {
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
  };
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    const cleanup = () => {
      clients.delete(socket);
      for (const [subscriptionId, subscription] of subscriptions) {
        if (subscription.socket === socket) subscriptions.delete(subscriptionId);
      }
      updateSummarySubscriptions();
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
        if (!line) continue;
        let request;
        try {
          request = parseRequestLine(line);
        } catch (error) {
          writeMessage(socket, responseError(error, null));
          continue;
        }
        if (inFlightRequests >= maxInFlightRequests) {
          writeMessage(socket, errorResponse(
            request.id,
            "SERVER_BUSY",
            "daemon has too many requests in flight",
            "Wait for an outstanding request to finish, then retry"
          ));
          continue;
        }
        inFlightRequests++;
        void (async () => {
          try {
            if (request.method === "event.subscribe") {
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
              updateSummarySubscriptions();
              writeMessage(socket, successResponse(request.id, { subscriptionId }));
              return;
            }
            const result = await invoke(manager, request);
            writeMessage(socket, successResponse(request.id, result));
          } catch (error) {
            if (!socket.destroyed) writeMessage(socket, responseError(error, request?.id ?? null));
          } finally {
            inFlightRequests--;
            maybeRestart();
          }
        })();
      }
    });
  });

  // Hold one lock across the whole check-decide-bind sequence, not just
  // around the stale-socket unlink inside removeStaleSocketIfUnchanged().
  // This does NOT prevent two processes from ever truly binding the same
  // path at once -- the OS's own bind(2) already guarantees only one
  // AF_UNIX listen() on a given path can succeed, the loser gets
  // EADDRINUSE regardless. What this closes is two concurrent invocations
  // each independently deciding "no socket exists yet, safe to proceed"
  // and both racing into server.listen() -- without this lock the loser
  // fails via a raw EADDRINUSE bubbling out of the listen() promise
  // instead of prepareSocket()'s clean "already listening" error, and both
  // do the existence/health-check work redundantly.
  //
  // The actual "two daemon.js processes observed bound to the identical
  // socket path at once" symptom from taskferry#287 has a different root
  // cause: under CPU starvation (the O(n)-over-all-tasks list/status scan
  // fixed alongside this), socketHealth()'s `connect` event can fail to
  // fire within healthCheckTimeoutMs even though the existing daemon is
  // still alive and still bound -- `connected` stays false, so
  // prepareSocket() reads `listening: false` and falls through to
  // removeStaleSocketIfUnchanged(), which finds the socket file's identity
  // unchanged (nobody replaced it) and unlinks a merely-slow, not actually
  // dead, daemon's live socket. A second daemon then binds fresh at the
  // freed path while the first is still running, unreachable, in the
  // background. Fixing the CPU-starvation root cause removes the trigger
  // for this; the identity check itself doesn't distinguish "dead" from
  // "alive but didn't answer in 250ms" and remains a latent gap worth a
  // follow-up (e.g. a short retry before concluding stale).
  const bindLockPath = path.join(runtimeDir, "socket-bind.lock");
  await withFileLockAsync(bindLockPath, async () => {
    await prepareSocket(runtimeDir, socketPath, healthCheckTimeoutMs);
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
  });
  fs.chmodSync(socketPath, 0o600);

  let closing;
  function close() {
    if (closing) return closing;
    closing = new Promise((resolve, reject) => {
      manager.close?.();
      for (const socket of clients) {
        socket.write(encodeMessage({ version: PROTOCOL_VERSION, type: "shutdown", reason: restarting ? "restart" : "shutdown" }));
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
  }

  // Deferred-until-idle restart: a source change is detected any time after
  // startup, but the actual restart waits for zero running/queued tasks so an
  // in-flight opencode child is never orphaned mid-task by the daemon
  // swapping itself out from under it.
  function maybeRestart() {
    if (restarting) return;
    if (!restartPending && sourceSignature(sourceDir) !== startupSourceSignature) restartPending = true;
    if (!restartPending) return;
    const { counts } = manager.list();
    if (counts.running > 0 || counts.queued > 0) return;
    restarting = true;
    void (async () => {
      await close();
      spawnReplacement({ daemonEntry, env });
      exitProcess();
    })();
  }

  return {
    socketPath,
    stats: () => ({ connections: clients.size, subscriptions: subscriptions.size }),
    close,
  };
}

async function main() {
  const daemon = await startDaemon({ taskManagerOptions: { config: loadConfig() } });
  const stop = async () => {
    await daemon.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
