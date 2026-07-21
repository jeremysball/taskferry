#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTaskManager } from "./tasks.js";
import { loadConfig } from "./config.js";
import { withFileLock } from "./state-lock.js";
import { resolveRuntimeDir, resolveStateDir } from "./paths.js";
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

async function prepareSocket(runtimeDir, socketPath, healthCheckTimeoutMs) {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  for (;;) {
    if (!fs.existsSync(socketPath)) return;
    let checkedIdentity;
    try {
      checkedIdentity = fs.statSync(socketPath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const health = await socketHealth(socketPath, healthCheckTimeoutMs);
    if (health.listening) {
      const qualifier = health.healthy ? "taskferry daemon" : "another process";
      throw new Error(`error: ${qualifier} is already listening on ${socketPath}\nhelp: use the existing daemon or choose another TASKFERRY_RUNTIME_DIR`);
    }
    if (removeStaleSocketIfUnchanged(socketPath, checkedIdentity, runtimeDir)) return;
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

function normalizeDirectory(directory) {
  return fs.realpathSync(directory);
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
    tasks: listRows(manager)
      .map((row) => manager.status(row.id))
      .filter((task) => task.directory === normalized),
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
      return manager.poll(params.taskId, {
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.tailChars !== undefined ? { tailChars: params.tailChars } : {}),
      });
    case "task.list":
      return filteredList(manager, params.directory);
    case "task.result":
      return manager.result(params.taskId, {
        ...(params.full !== undefined ? { full: params.full } : {}),
        ...(params.fields !== undefined ? { fields: params.fields } : {}),
      });
    case "task.tail":
      return manager.tail(params.taskId, params.chars === undefined ? undefined : { chars: params.chars });
    case "task.summary":
      return manager.summarize(params.taskId, {
        ...(params.maxWords === undefined ? {} : { maxWords: params.maxWords }),
        ...(params.mode === undefined ? {} : { mode: params.mode }),
      });
    case "task.advisor":
      return manager.advisor({
        prompt: params.prompt,
        directory: params.directory,
        model: params.model,
        ...(params.variant !== undefined ? { variant: params.variant } : {}),
        ...(params.sessionId !== undefined ? { session_id: params.sessionId } : {}),
        ...(params.timeoutMs !== undefined ? { timeout_ms: params.timeoutMs } : {}),
      });
    case "task.context": {
      const context = filteredTaskDetails(manager, params.directory);
      return { ...context, counts: countTasks(context.tasks) };
    }
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
  const code = /unknown task_id:/.test(text) ? "UNKNOWN_TASK" : "REQUEST_FAILED";
  return errorResponse(requestId, code, message.replace("unknown task_id:", "unknown task id:"), help);
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
  await prepareSocket(runtimeDir, socketPath, healthCheckTimeoutMs);

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
      writeMessage(subscription.socket, eventMessage(subscriptionId, event));
    }
  };
  const manager = taskManagerFactory({ ...taskManagerOptions, stateDir, onEvent });
  const startupSourceSignature = sourceSignature(sourceDir);
  let restartPending = false;
  let restarting = false;
  const updateSummarySubscriptions = () => {
    if (typeof manager.setActivitySummarySubscriptions !== "function") return;
    manager.setActivitySummarySubscriptions(Array.from(subscriptions.values()).filter((subscription) => subscription.summaries).length);
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
              const subscriptionId = randomUUID();
              subscriptions.set(subscriptionId, {
                socket,
                directory: normalizeDirectory(request.params.directory),
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

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o600);

  let closing;
  function close() {
    if (closing) return closing;
    closing = new Promise((resolve, reject) => {
      for (const socket of clients) socket.destroy();
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
