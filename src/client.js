import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileLock } from "./state-lock.js";
import { PROTOCOL_VERSION, encodeMessage } from "./protocol.js";
import { loadConfig } from "./config.js";
import { resolveRuntimeDir, resolveStateDir } from "./paths.js";

const DAEMON_ENTRY = fileURLToPath(new URL("./daemon.js", import.meta.url));

const HEALTH_PROBE = String.raw`
const net = require("node:net");
const socket = net.createConnection(process.argv[1]);
let buffer = "";
const timer = setTimeout(() => process.exit(1), 200);
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(JSON.stringify({version:1,id:"health-check",method:"system.health",params:{}}) + "\n"));
socket.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\n");
  if (newline === -1) return;
  clearTimeout(timer);
  try {
    const response = JSON.parse(buffer.slice(0, newline));
    process.exit(response.version === 1 && response.id === "health-check" && response.ok === true && response.result && response.result.healthy === true ? 0 : 1);
  } catch { process.exit(1); }
});
socket.on("error", () => process.exit(1));
`;

function daemonReadySync(socketPath) {
  return spawnSync(process.execPath, ["-e", HEALTH_PROBE, socketPath], {
    stdio: "ignore",
    timeout: 500,
  }).status === 0;
}

function spawnDaemon({ env, stateDir, runtimeDir, socketPath }) {
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    stdio: "ignore",
    env: {
      ...env,
      TASKFERRY_STATE_DIR: stateDir,
      TASKFERRY_RUNTIME_DIR: runtimeDir,
      TASKFERRY_SOCKET_PATH: socketPath,
    },
  });
  child.unref();
  return child;
}

export function ensureDaemonStarted({
  env = process.env,
  stateDir = resolveStateDir(env),
  runtimeDir = resolveRuntimeDir({ env, stateDir }),
  socketPath = env.TASKFERRY_SOCKET_PATH || path.join(runtimeDir, "daemon.sock"),
  startupTimeoutMs = 5000,
  retryDelayMs = 25,
  withLockFn = withFileLock,
  isDaemonReadySync = daemonReadySync,
  spawnDaemonFn = spawnDaemon,
  loadConfigFn = loadConfig,
} = {}) {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  const lockPath = path.join(runtimeDir, "daemon-start.lock");
  return withLockFn(lockPath, () => {
    if (isDaemonReadySync(socketPath)) return false;
    loadConfigFn({ env });
    spawnDaemonFn({ env, stateDir, runtimeDir, socketPath });
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (isDaemonReadySync(socketPath)) return true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelayMs);
    }
    throw new Error(
      `error: taskferry daemon did not become ready within ${startupTimeoutMs}ms\n`
      + `help: check ${runtimeDir} permissions and daemon startup diagnostics, then retry`
    );
  }, {
    timeoutMs: startupTimeoutMs + 1000,
    staleMs: startupTimeoutMs + 1000,
    retryMs: retryDelayMs,
  });
}

class DaemonClient {
  constructor(socket, { maxBufferBytes, maxQueuedEvents }) {
    this.socket = socket;
    this.buffer = "";
    this.closed = false;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.queuedEvents = new Map();
    this.maxBufferBytes = maxBufferBytes;
    this.maxQueuedEvents = maxQueuedEvents;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.failAll(error));
    socket.on("close", () => this.failAll(new Error("taskferry daemon connection closed")));
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        if (Buffer.byteLength(this.buffer) > this.maxBufferBytes) {
          this.protocolFailure(`taskferry daemon message exceeds ${this.maxBufferBytes} bytes`);
        }
        return;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.failAll(new Error("taskferry daemon sent malformed JSON"));
        this.socket.destroy();
        return;
      }
      if (!isObject(message)) {
        this.protocolFailure("taskferry daemon sent an invalid daemon message");
        return;
      }
      if (message.version !== PROTOCOL_VERSION) {
        this.protocolFailure(`taskferry daemon sent unsupported protocol version: ${String(message.version)}`);
        return;
      }
      if (message.type === "event") {
        if (!isExactObject(message, ["version", "type", "subscriptionId", "event"])
          || typeof message.subscriptionId !== "string"
          || !message.subscriptionId
          || !isObject(message.event)) {
          this.protocolFailure("taskferry daemon sent an invalid event envelope");
          return;
        }
        const handler = this.eventHandlers.get(message.subscriptionId);
        if (handler) handler(message.event);
        else {
          const queuedCount = Array.from(this.queuedEvents.values()).reduce((count, events) => count + events.length, 0);
          if (queuedCount >= this.maxQueuedEvents) {
            this.protocolFailure("taskferry daemon exceeded the queued event limit");
            return;
          }
          const queued = this.queuedEvents.get(message.subscriptionId) || [];
          queued.push(message.event);
          this.queuedEvents.set(message.subscriptionId, queued);
        }
        continue;
      }
      const responseKeys = message.ok === true
        ? ["version", "id", "ok", "result"]
        : ["version", "id", "ok", "error"];
      if (!isExactObject(message, responseKeys)
        || typeof message.id !== "string"
        || typeof message.ok !== "boolean"
        || (message.ok === false && !validError(message.error))) {
        this.protocolFailure("taskferry daemon sent an invalid response envelope");
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.ok === true) pending.resolve(message.result);
      else {
        const error = new Error(`${message.error?.message || "daemon request failed"}\nhelp: ${message.error?.help || "retry the request"}`);
        error.code = message.error?.code || "REQUEST_FAILED";
        pending.reject(error);
      }
    }
  }

  protocolFailure(message) {
    this.failAll(new Error(message));
    this.socket.destroy();
  }

  failAll(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("taskferry daemon connection is closed"));
    const id = randomUUID();
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.write(encodeMessage({ version: PROTOCOL_VERSION, id, method, params }));
    return response;
  }

  async subscribe(params, onEvent) {
    if (typeof onEvent !== "function") throw new TypeError("event subscription requires an onEvent callback");
    const { subscriptionId } = await this.request("event.subscribe", params);
    this.eventHandlers.set(subscriptionId, onEvent);
    const queued = this.queuedEvents.get(subscriptionId) || [];
    this.queuedEvents.delete(subscriptionId);
    for (const event of queued) onEvent(event);
    return subscriptionId;
  }

  close() {
    this.failAll(new Error("taskferry daemon connection closed by client"));
    this.socket.destroy();
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactObject(value, keys) {
  return isObject(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function validError(error) {
  return isExactObject(error, ["code", "message", "help"])
    && typeof error.code === "string"
    && typeof error.message === "string"
    && typeof error.help === "string";
}

async function openClient(socketPath, clientOptions) {
  const socket = net.createConnection(socketPath);
  const client = new DaemonClient(socket, clientOptions);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return client;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectClient({
  env = process.env,
  stateDir = resolveStateDir(env),
  runtimeDir = resolveRuntimeDir({ env, stateDir }),
  socketPath = env.TASKFERRY_SOCKET_PATH || path.join(runtimeDir, "daemon.sock"),
  autoStart = true,
  startupTimeoutMs = 5000,
  retryDelayMs = 25,
  maxBufferBytes = 1024 * 1024,
  maxQueuedEvents = 1000,
  ensureDaemonFn = ensureDaemonStarted,
  ...startupOptions
} = {}) {
  const clientOptions = { maxBufferBytes, maxQueuedEvents };
  try {
    return await openClient(socketPath, clientOptions);
  } catch (error) {
    if (!autoStart) throw error;
  }

  await ensureDaemonFn({
    env,
    stateDir,
    runtimeDir,
    socketPath,
    startupTimeoutMs,
    retryDelayMs,
    ...startupOptions,
  });
  const deadline = Date.now() + startupTimeoutMs;
  let lastError;
  do {
    try {
      return await openClient(socketPath, clientOptions);
    } catch (error) {
      lastError = error;
      await delay(retryDelayMs);
    }
  } while (Date.now() < deadline);

  throw new Error(
    `error: taskferry daemon did not become ready within ${startupTimeoutMs}ms: ${lastError?.message || "connection failed"}\n`
    + `help: check ${runtimeDir} permissions and daemon startup diagnostics, then retry`
  );
}
