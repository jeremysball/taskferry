import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileLock } from "./state-lock.js";
import { PROTOCOL_VERSION, encodeMessage } from "./protocol.js";
import { MAX_BUFFER_BYTES } from "./daemon-server.js";
import { loadConfig } from "./config.js";
import { isObject } from "./numbers.js";
import { resolveRuntimeDir, resolveStateDir, resolveInvokedPath } from "./paths.js";
import { errCode } from "./errors.js";

const DAEMON_ENTRY = fileURLToPath(new URL("./daemon.js", import.meta.url));
const CLIENT_ENTRY = fileURLToPath(import.meta.url);
const SOCKET_FILENAME = "daemon.sock";

/**
 * @typedef {object} DaemonBooterOptions
 * @property {NodeJS.ProcessEnv} env
 * @property {string} stateDir
 * @property {string} runtimeDir
 * @property {string} socketPath
 */

/**
 * @typedef {object} StartDaemonBooterOptions
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [stateDir]
 * @property {string} [runtimeDir]
 * @property {string} [socketPath]
 * @property {(options: DaemonBooterOptions) => unknown} [spawnBooterFn]
 */

/**
 * @typedef {object} EnsureDaemonOptions
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [stateDir]
 * @property {string} [runtimeDir]
 * @property {string} [socketPath]
 * @property {number} [startupTimeoutMs]
 * @property {number} [retryDelayMs]
 * @property {<T>(lockPath: string, callback: () => T, options: {timeoutMs: number, staleMs: number, retryMs: number}) => T} [withLockFn]
 * @property {(socketPath: string) => boolean} [isDaemonReadySync]
 * @property {(options: DaemonBooterOptions) => unknown} [spawnDaemonFn]
 * @property {({env}: {env: NodeJS.ProcessEnv}) => unknown} [loadConfigFn]
 */

/**
 * @typedef {object} DaemonClientOptions
 * @property {number} maxBufferBytes
 * @property {number} maxQueuedEvents
 */

/**
 * @typedef {{resolve: (result: unknown) => void, reject: (error: Error) => void}} PendingRequest
 */

/**
 * @typedef {object} ErrorEnvelope
 * @property {string} code
 * @property {string} message
 * @property {string} help
 * @property {string} detail
 */

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

/**
 * Probe the daemon via a short-lived child that runs HEALTH_PROBE against the
 * socket. Returns true iff the probe got a healthy response within the timeout.
 * @param {string} socketPath
 * @returns {boolean}
 */
function daemonReadySync(socketPath) {
  return spawnSync(process.execPath, ["-e", HEALTH_PROBE, socketPath], {
    stdio: "ignore",
    timeout: 500,
  }).status === 0;
}

/**
 * Spawn the long-lived daemon process and unref it so the parent can exit
 * without waiting on it. Returns the spawned child so callers/tests can stub
 * or observe the spawn.
 * @param {DaemonBooterOptions} options
 * @returns {import("node:child_process").ChildProcess}
 */
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

/**
 * @param {string} runtimeDir
 * @returns {string}
 */
function bootErrorPath(runtimeDir) {
  return path.join(runtimeDir, "daemon-boot.err");
}

// The direct-execution guard below catches errors from ensureDaemonStarted(),
// but the booter subprocess can fail before reaching it (a syntax error, a
// missing import dependency). Node then prints to stderr, and with
// `stdio: "ignore"` discards the message. Piping stderr to a file next to
// daemon-boot.err preserves it.
/**
 * @param {string} runtimeDir
 * @returns {string}
 */
function bootStderrPath(runtimeDir) {
  return path.join(runtimeDir, "daemon-boot-stderr.log");
}

/**
 * @param {DaemonBooterOptions} options
 * @returns {import("node:child_process").ChildProcess}
 */
function spawnDaemonBooter({ env, stateDir, runtimeDir, socketPath }) {
  /** @type {number | undefined} */
  let stderrFd;
  try {
    stderrFd = fs.openSync(bootStderrPath(runtimeDir), "w", 0o600);
  } catch {
    // Best-effort: if the file can't be opened, discard stderr instead of
    // blocking the booter from spawning.
  }
  const child = spawn(process.execPath, [CLIENT_ENTRY], {
    detached: true,
    stdio: ["ignore", "ignore", stderrFd ?? "ignore"],
    env: {
      ...env,
      TASKFERRY_STATE_DIR: stateDir,
      TASKFERRY_RUNTIME_DIR: runtimeDir,
      TASKFERRY_SOCKET_PATH: socketPath,
    },
  });
  if (stderrFd != null) child.once("exit", () => fs.closeSync(stderrFd));
  child.unref();
  return child;
}

// Fires a detached, unref'd subprocess to run ensureDaemonStarted's
// lock-acquire/spawn/poll sequence and returns immediately, without waiting
// on it. The subprocess isn't tied to this process's lifetime, so a caller
// with a short external timeout (e.g. a 1s-refresh statusline) can be killed
// mid-boot without ever having held daemon-start.lock itself.
/**
 * @param {StartDaemonBooterOptions} [options]
 * @returns {Promise<void>}
 */
export async function startDaemonBooter({
  env = process.env,
  stateDir = resolveStateDir(env),
  runtimeDir = resolveRuntimeDir({ env, stateDir }),
  socketPath = env.TASKFERRY_SOCKET_PATH || path.join(runtimeDir, SOCKET_FILENAME),
  spawnBooterFn = spawnDaemonBooter,
} = {}) {
  try {
    fs.unlinkSync(bootErrorPath(runtimeDir));
  } catch {
    // Best-effort: clearing a stale diagnostic file must never block the
    // booter itself from spawning (e.g. EACCES on a file left by another uid).
  }
  spawnBooterFn({ env, stateDir, runtimeDir, socketPath });
}

/**
 * @param {EnsureDaemonOptions} [options]
 * @returns {boolean}
 */
export function ensureDaemonStarted({
  env = process.env,
  stateDir = resolveStateDir(env),
  runtimeDir = resolveRuntimeDir({ env, stateDir }),
  socketPath = env.TASKFERRY_SOCKET_PATH || path.join(runtimeDir, SOCKET_FILENAME),
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

/**
 * @typedef {"restart" | "shutdown" | null} ShutdownReason
 */

/**
 * @typedef {(event: Record<string, unknown>) => void} EventHandler
 */

class DaemonClient {
  /** @type {net.Socket} */
  socket;
  /** @type {string} */
  buffer;
  /** @type {boolean} */
  closed;
  /** @type {ShutdownReason} */
  shutdownReason;
  /** @type {Map<string, PendingRequest>} */
  pending;
  /** @type {Map<string, EventHandler>} */
  eventHandlers;
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  queuedEvents;
  /** @type {number} */
  maxBufferBytes;
  /** @type {number} */
  maxQueuedEvents;

  /**
   * @param {net.Socket} socket
   * @param {DaemonClientOptions} options
   */
  constructor(socket, { maxBufferBytes, maxQueuedEvents }) {
    this.socket = socket;
    this.buffer = "";
    this.closed = false;
    this.shutdownReason = null;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.queuedEvents = new Map();
    this.maxBufferBytes = maxBufferBytes;
    this.maxQueuedEvents = maxQueuedEvents;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.failAll(error));
    socket.on("close", () => this.failAll(this.shutdownReason === "restart"
      ? new Error("taskferry daemon is restarting (config or version change) — retry your command in a moment")
      : new Error("taskferry daemon connection closed")));
  }

  /**
   * The socket runs in utf8 mode (setEncoding in the constructor), so Node
   * hands strings here. Accept `string | Buffer` so that coupling is explicit:
   * a Buffer means the encoding contract was broken, and decoding it per-chunk
   * would silently corrupt multi-byte characters split across frames. Fail
   * loudly instead.
   * @param {string|Buffer} chunk
   */
  onData(chunk) {
    if (typeof chunk !== "string") {
      this.protocolFailure("daemon socket is not in utf8 mode; expected string data");
      return;
    }
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
      if (line && !this.consumeFrame(line)) return;
    }
  }

  // Process a single newline-delimited frame. Returns false when the connection
  // must be torn down (malformed/protocol-invalid data), true to keep reading.
  /** @param {string} line @returns {boolean} */
  consumeFrame(line) {
    if (!line) return true;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.failAll(new Error("taskferry daemon sent malformed JSON"));
      this.socket.destroy();
      return false;
    }
    if (!isObject(message)) {
      this.protocolFailure("taskferry daemon sent an invalid daemon message");
      return false;
    }
    if (message.version !== PROTOCOL_VERSION) {
      this.protocolFailure(`taskferry daemon sent unsupported protocol version: ${String(message.version)}`);
      return false;
    }
    if (message.type === "shutdown") {
      this.shutdownReason = message.reason === "restart" ? "restart" : "shutdown";
      return true;
    }
    if (message.type === "event") return this.consumeEvent(/** @type {Record<string, unknown> & {subscriptionId: string, event: Record<string, unknown>}} */ (message));
    return this.consumeResponse(/** @type {Record<string, unknown>} */ (message));
  }

  /** @param {Record<string, unknown> & {subscriptionId: string, event: Record<string, unknown>}} message @returns {boolean} */
  consumeEvent(message) {
    if (!isExactObject(message, ["version", "type", "subscriptionId", "event"])
      || typeof message.subscriptionId !== "string"
      || !message.subscriptionId
      || !isObject(message.event)) {
      this.protocolFailure("taskferry daemon sent an invalid event envelope");
      return false;
    }
    const handler = this.eventHandlers.get(message.subscriptionId);
    if (handler) {
      handler(message.event);
      return true;
    }
    const queuedCount = Array.from(this.queuedEvents.values()).reduce((count, events) => count + events.length, 0);
    if (queuedCount >= this.maxQueuedEvents) {
      this.protocolFailure("taskferry daemon exceeded the queued event limit");
      return false;
    }
    const queued = this.queuedEvents.get(message.subscriptionId) || [];
    queued.push(message.event);
    this.queuedEvents.set(message.subscriptionId, queued);
    return true;
  }

  /** @param {Record<string, unknown>} message @returns {boolean} */
  consumeResponse(message) {
    const responseKeys = message.ok === true
      ? ["version", "id", "ok", "result"]
      : ["version", "id", "ok", "error"];
    if (!isValidResponseEnvelope(message, responseKeys)) {
      this.protocolFailure("taskferry daemon sent an invalid response envelope");
      return false;
    }
    const pending = this.pending.get(/** @type {string} */ (message.id));
    if (!pending) return true;
    this.pending.delete(/** @type {string} */ (message.id));
    if (message.ok === true) {
      pending.resolve(message.result);
    } else {
      pending.reject(buildRequestError(/** @type {ErrorEnvelope} */ (message.error)));
    }
    return true;
  }

  /** @param {string} message */
  protocolFailure(message) {
    this.failAll(new Error(message));
    this.socket.destroy();
  }

  /** @param {Error} error */
  failAll(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<unknown>}
   */
  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("taskferry daemon connection is closed"));
    const id = randomUUID();
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.write(encodeMessage({ version: PROTOCOL_VERSION, id, method, params }));
    return response;
  }

  /**
   * @param {Record<string, unknown>} params
   * @param {EventHandler} onEvent
   * @returns {Promise<string>}
   */
  async subscribe(params, onEvent) {
    if (typeof onEvent !== "function") throw new TypeError("event subscription requires an onEvent callback");
    const { subscriptionId } = /** @type {{subscriptionId: string}} */ (await this.request("event.subscribe", params));
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

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {value is Record<string, unknown>}
 */
function isExactObject(value, keys) {
  return isObject(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(/** @type {string} */ (key)));
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function validError(error) {
  if (!isExactObject(error, ["code", "message", "help", "detail"])) return false;
  return typeof error.code === "string"
    && typeof error.message === "string"
    && typeof error.help === "string"
    && typeof error.detail === "string";
}

/**
 * @param {unknown} message
 * @param {string[]} responseKeys
 * @returns {boolean}
 */
function isValidResponseEnvelope(message, responseKeys) {
  if (!isExactObject(message, responseKeys)
    || typeof message.id !== "string"
    || typeof message.ok !== "boolean") {
    return false;
  }
  return !(message.ok === false && !validError(message.error));
}

/**
 * @param {ErrorEnvelope} error
 * @returns {Error & {code: string}}
 */
function buildRequestError(error) {
  const message = error?.message || "daemon request failed";
  const help = error?.help || "retry the request";
  let body = `${message}\nhelp: ${help}`;
  if (error?.detail && error.detail !== error.message) body = error.detail;
  /** @type {Error & {code: string}} */
  const err = /** @type {Error & {code: string}} */ (new Error(body));
  err.code = error?.code || "REQUEST_FAILED";
  return err;
}

/**
 * @param {string} socketPath
 * @param {DaemonClientOptions} clientOptions
 * @returns {Promise<DaemonClient>}
 */
async function openClient(socketPath, clientOptions) {
  const socket = net.createConnection(socketPath);
  const client = new DaemonClient(socket, clientOptions);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return client;
}

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Read a daemon diagnostic file, tolerating a missing file (ENOENT) as "no
// diagnostics". Any other read error is real and must propagate.
/**
 * @param {string} file
 * @returns {string | undefined}
 */
function readStartupDiagnostic(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
    return undefined;
  }
}

// Capture both startup diagnostics, but read the stderr log only when
// bootError is absent: the booter subprocess failed at import time, before
// reaching the try/catch that writes bootError above.
/**
 * @param {string} runtimeDir
 * @returns {{bootError: string | undefined, bootStderr: string | undefined}}
 */
function readStartupDiagnostics(runtimeDir) {
  const bootError = readStartupDiagnostic(bootErrorPath(runtimeDir));
  const bootStderr = bootError ? "" : readStartupDiagnostic(bootStderrPath(runtimeDir));
  return { bootError, bootStderr };
}

// Retry connecting to the socket until the deadline passes. Returns the first
// successful client, or { client: null, lastError } on timeout.
/**
 * @param {string} socketPath
 * @param {DaemonClientOptions} clientOptions
 * @param {number} retryDelayMs
 * @param {number} deadline
 * @returns {Promise<{client: DaemonClient | null, lastError?: unknown}>}
 */
async function retryOpenClient(socketPath, clientOptions, retryDelayMs, deadline) {
  let lastError;
  do {
    try {
      return { client: await openClient(socketPath, clientOptions) };
    } catch (error) {
      lastError = error;
      await delay(retryDelayMs);
    }
  } while (Date.now() < deadline);
  return { client: null, lastError };
}

// Resolve the connect-time defaults, then delegate to the core connection
// logic (kept as a separate function so the default-heavy signature doesn't
// inflate its cyclomatic complexity).
/**
 * @typedef {object} ConnectClientOptions
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [stateDir]
 * @property {string} [runtimeDir]
 * @property {string} [socketPath]
 * @property {boolean} [autoStart]
 * @property {number} [startupTimeoutMs]
 * @property {number} [retryDelayMs]
 * @property {number} [maxBufferBytes]
 * @property {number} [maxQueuedEvents]
 * @property {(options: {env: NodeJS.ProcessEnv, stateDir: string, runtimeDir: string, socketPath: string, startupTimeoutMs: number, retryDelayMs: number}) => Promise<void> | void} [ensureDaemonFn]
 * @property {Record<string, unknown>} [startupOptions]
 */

/**
 * @param {ConnectClientOptions} [options]
 * @returns {Promise<DaemonClient>}
 */
export async function connectClient({
  env = process.env,
  stateDir = resolveStateDir(env),
  runtimeDir = resolveRuntimeDir({ env, stateDir }),
  socketPath = env.TASKFERRY_SOCKET_PATH || path.join(runtimeDir, SOCKET_FILENAME),
  // General-purpose escape hatch: a caller can set TASKFERRY_AUTO_START=0 to
  // fail fast on a missing daemon instead of spawning one (e.g. a script that
  // should never have side effects). Not needed for lock safety — the
  // detached booter (startDaemonBooter, above) never blocks the caller on
  // the lock regardless of autoStart, so a short-timeout poller no longer
  // has to opt out just to avoid the old inline-boot livelock.
  autoStart = env.TASKFERRY_AUTO_START !== "0",
  startupTimeoutMs = 5000,
  retryDelayMs = 25,
  maxBufferBytes = MAX_BUFFER_BYTES,
  maxQueuedEvents = 1000,
  ensureDaemonFn = startDaemonBooter,
  ...startupOptions
} = {}) {
  return connectClientCore({
    env, stateDir, runtimeDir, socketPath, autoStart, startupTimeoutMs,
    retryDelayMs, maxBufferBytes, maxQueuedEvents, ensureDaemonFn, startupOptions,
  });
}

/**
 * @param {{env: NodeJS.ProcessEnv, stateDir: string, runtimeDir: string, socketPath: string, autoStart: boolean, startupTimeoutMs: number, retryDelayMs: number, maxBufferBytes: number, maxQueuedEvents: number, ensureDaemonFn: (options: {env: NodeJS.ProcessEnv, stateDir: string, runtimeDir: string, socketPath: string, startupTimeoutMs: number, retryDelayMs: number}) => Promise<void> | void, startupOptions: Record<string, unknown>}} args
 * @returns {Promise<DaemonClient>}
 */
async function connectClientCore({
  env, stateDir, runtimeDir, socketPath, autoStart, startupTimeoutMs,
  retryDelayMs, maxBufferBytes, maxQueuedEvents, ensureDaemonFn, startupOptions,
}) {
  const clientOptions = { maxBufferBytes, maxQueuedEvents };
  try {
    return await openClient(socketPath, clientOptions);
  } catch (error) {
    if (!autoStart) throw error;
  }

  await ensureDaemonFn({ env, stateDir, runtimeDir, socketPath, startupTimeoutMs, retryDelayMs, ...startupOptions });
  const deadline = Date.now() + startupTimeoutMs;
  const { client, lastError } = await retryOpenClient(socketPath, clientOptions, retryDelayMs, deadline);
  if (client) return client;

  const { bootError, bootStderr } = readStartupDiagnostics(runtimeDir);
  /** @type {{message?: string} | undefined} */
  const lastErrorTyped = /** @type {{message?: string} | undefined} */ (lastError);
  throw new Error(
    `error: taskferry daemon did not become ready within ${startupTimeoutMs}ms: ${lastErrorTyped?.message || "connection failed"}\n`
    + (bootError ? `daemon boot failed: ${bootError}\n` : "")
    + (bootStderr ? `booter subprocess failed before startup: ${bootStderr}\n` : "")
    + `help: check ${runtimeDir} permissions and daemon startup diagnostics, then retry`
  );
}

if (process.argv[1] && resolveInvokedPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    ensureDaemonStarted();
  } catch (err) {
    const bootEnv = process.env;
    const bootStateDir = resolveStateDir(bootEnv);
    const bootRuntimeDir = resolveRuntimeDir({ env: bootEnv, stateDir: bootStateDir });
    try {
      fs.mkdirSync(bootRuntimeDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(bootErrorPath(bootRuntimeDir), err instanceof Error ? err.message : String(err));
    } catch {
      // Best-effort diagnostics only — connectClient's own generic timeout
      // error still surfaces to the user even if this write fails.
    }
    process.exitCode = 1;
  }
}
