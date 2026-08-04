#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTaskManager } from "./tasks.js";
import { loadConfig } from "./config.js";
import { withFileLock, withFileLockAsync } from "./state-lock.js";
import { isNonNegativeInteger, isPositiveInteger } from "./numbers.js";
import { normalizeDirectory, resolveRuntimeDir, resolveStateDir, createWorkspaceRootResolver, sameWorkspace } from "./paths.js";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  encodeMessage,
  errorResponse,
} from "./protocol.js";
import {
  MAX_BUFFER_BYTES,
  createDaemonServer,
  deliverEvent,
  makeClose,
  makeMaybeRestart,
  syncActivitySubscriptions,
} from "./daemon-server.js";

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

const DEFAULT_SLOW_REQUEST_MS = 500;
const DEFAULT_PERF_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

function isEnabledFlag(value) {
  return ["1", "true"].includes(value);
}

function profilingEnabled(env, config) {
  if (env?.TASKFERRY_PROFILING_ENABLED !== undefined) return isEnabledFlag(env.TASKFERRY_PROFILING_ENABLED);
  return config?.profilingEnabled ?? false;
}

// An unset var is undefined and Number(undefined) is already NaN, but an
// empty-string value (a blank .env line, an empty -e in Docker) is
// Number("") === 0 -- a false "valid, explicit zero" that would otherwise
// slip past isPositiveInteger/isNonNegativeInteger instead of falling back
// to the default the same way a genuinely non-numeric value does.
function parsedEnvNumber(rawValue, isValid, fallback) {
  if (!rawValue) return fallback;
  const parsed = Number(rawValue);
  return isValid(parsed) ? parsed : fallback;
}

// Rotates perf.log to perf.log.1 (clobbering any previous perf.log.1) once
// the live file would exceed maxBytes, so profiling can be left on
// indefinitely without the log growing unbounded. A rename right before the
// write that would tip it over keeps this a single stat+rename per request,
// not a periodic sweep.
function rotateIfOversized(perfLogPath, maxBytes, nextLineBytes) {
  let size;
  try {
    ({ size } = fs.statSync(perfLogPath));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (size + nextLineBytes <= maxBytes) return;
  fs.renameSync(perfLogPath, `${perfLogPath}.1`);
}

// One JSONL line per handled request in <state-dir>/perf.log, so a latency
// spike (the kind that shows up as "the daemon felt slow for a second") has
// a durable per-method trail instead of only ever being visible live.
// Opt-in via TASKFERRY_PROFILING_ENABLED=1 or config.json's profilingEnabled
// -- disabled by default so every daemon isn't paying an append-per-request
// write it never asked for. Returns null when disabled, so the caller can
// skip performance.now() entirely rather than timing into a discarded value.
function makeRequestTimer({ stateDir, env, config, appendLine = (filePath, line) => fs.appendFileSync(filePath, line) }) {
  if (!profilingEnabled(env, config)) return null;
  const perfLogPath = path.join(stateDir, "perf.log");
  const maxBytes = parsedEnvNumber(env?.TASKFERRY_PERF_LOG_MAX_BYTES, isPositiveInteger, DEFAULT_PERF_LOG_MAX_BYTES);
  const slowRequestMs = parsedEnvNumber(env?.TASKFERRY_SLOW_REQUEST_MS, isNonNegativeInteger, DEFAULT_SLOW_REQUEST_MS);
  return function onRequestTimed({ method, durationMs, ok }) {
    const rounded = Math.round(durationMs * 100) / 100;
    const record = { method, ok, ts: new Date().toISOString(), durationMs: rounded };
    const line = `${JSON.stringify(record)}\n`;
    try {
      rotateIfOversized(perfLogPath, maxBytes, Buffer.byteLength(line));
      appendLine(perfLogPath, line);
    } catch (error) {
      process.stderr.write(`warn: failed to write perf.log: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    if (rounded >= slowRequestMs) {
      process.stderr.write(`slow request: ${method} took ${rounded}ms (>= ${slowRequestMs}ms threshold)\n`);
    }
  };
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

function filteredTaskDetails(manager, directory, resolveWorkspaceRootFn) {
  const normalized = normalizeDirectory(directory);
  return {
    directory: normalized,
    // Filter the cheap in-memory row (which already carries `directory`)
    // before calling manager.status() -- status() does per-task log I/O
    // (statSync/open/read), so calling it for every task ever recorded
    // instead of just the ones in this workspace turns a routine
    // statusline poll into O(all-time task count) synchronous I/O on the
    // daemon's single thread (taskferry#287). sameWorkspace() (not a raw
    // `===`) so a root-scoped filter also matches a task dispatched into a
    // linked worktree of the same repo (taskferry#315).
    tasks: listRows(manager)
      .filter((row) => sameWorkspace(row.directory, normalized, resolveWorkspaceRootFn))
      .map((row) => manager.status(row.id)),
  };
}

function filteredList(manager, directory, resolveWorkspaceRootFn) {
  if (directory === undefined) return manager.list();
  const details = filteredTaskDetails(manager, directory, resolveWorkspaceRootFn);
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

// RPC method routing: each method is a small handler that forwards to the task
// manager. task.summary/task.advisor forward the whole validated params object
// rather than rebuilding a field list -- the explicit rebuild was the shape
// that silently dropped newly-added fields, whereas forwarding (task.dispatch's
// pattern) means new fields arrive at the manager without a daemon.js change.
const invokeHandlers = {
  "system.health": () => ({ healthy: true, pid: process.pid, version: PROTOCOL_VERSION }),
  "task.dispatch": (manager, params) => manager.dispatch(params),
  "task.cancel": (manager, params) => manager.cancel(params.taskId, params.graceMs === undefined ? undefined : { graceMs: params.graceMs }),
  "task.status": (manager, params) => manager.status(params.taskId),
  "task.wait": (manager, params) => manager.poll(params.taskId, params),
  "task.list": (manager, params, resolveWorkspaceRootFn) => filteredList(manager, params.directory, resolveWorkspaceRootFn),
  "task.result": (manager, params) => manager.result(params.taskId, params),
  "task.tail": (manager, params) => manager.tail(params.taskId, params.chars === undefined ? undefined : { chars: params.chars }),
  "task.summary": (manager, params) => manager.summarize(params.taskId, params),
  "task.advisor": (manager, params) => manager.advisor(params),
  "task.context": (manager, params, resolveWorkspaceRootFn) => {
    const context = filteredTaskDetails(manager, params.directory, resolveWorkspaceRootFn);
    return { ...context, counts: countTasks(context.tasks) };
  },
  "task.accept": (manager, params) => manager.accept(params.taskId),
  "task.reject": (manager, params) => manager.reject(params.taskId),
};

function invoke(manager, request, resolveWorkspaceRootFn) {
  const handler = invokeHandlers[request.method];
  if (!handler) throw new Error(`unsupported method after validation: ${request.method}`);
  return handler(manager, request.params, resolveWorkspaceRootFn);
}

const DAEMON_DEFAULTS = {
  platform: process.platform,
  env: process.env,
  healthCheckTimeoutMs: 250,
  maxOutboundBytes: MAX_BUFFER_BYTES,
  maxInFlightRequests: 256,
  taskManagerFactory: createTaskManager,
  taskManagerOptions: {},
  sourceDir: SOURCE_DIR,
  daemonEntry: DAEMON_ENTRY,
  spawnReplacement: defaultSpawnReplacement,
  exitProcess: () => process.exit(0),
};

function resolveDaemonOptions(options = {}) {
  const merged = { ...DAEMON_DEFAULTS, ...options };
  for (const key of Object.keys(DAEMON_DEFAULTS)) {
    if (merged[key] === undefined) merged[key] = DAEMON_DEFAULTS[key];
  }
  const env = merged.env;
  const stateDir = merged.stateDir ?? resolveStateDir(env);
  const runtimeDir = merged.runtimeDir ?? resolveRuntimeDir({ env, stateDir });
  const socketPath = merged.socketPath ?? resolveSocketPath({ env, stateDir, runtimeDir });
  // Created fresh per startDaemon() call (not a DAEMON_DEFAULTS literal,
  // which would be evaluated once at module load and shared -- with its
  // per-directory cache -- across every daemon started in one process,
  // e.g. multiple daemons spun up across a test file).
  const resolveWorkspaceRoot = merged.resolveWorkspaceRoot ?? createWorkspaceRootResolver();
  return {
    env,
    stateDir,
    runtimeDir,
    socketPath,
    resolveWorkspaceRoot,
    platform: merged.platform,
    healthCheckTimeoutMs: merged.healthCheckTimeoutMs,
    maxOutboundBytes: merged.maxOutboundBytes,
    maxInFlightRequests: merged.maxInFlightRequests,
    taskManagerFactory: merged.taskManagerFactory,
    taskManagerOptions: merged.taskManagerOptions,
    sourceDir: merged.sourceDir,
    daemonEntry: merged.daemonEntry,
    spawnReplacement: merged.spawnReplacement,
    exitProcess: merged.exitProcess,
  };
}

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
async function bindDaemonSocket({ server, runtimeDir, socketPath, healthCheckTimeoutMs }) {
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
}

export async function startDaemon(options = {}) {
  const {
    platform,
    env,
    stateDir,
    runtimeDir,
    socketPath,
    resolveWorkspaceRoot,
    healthCheckTimeoutMs,
    maxOutboundBytes,
    maxInFlightRequests,
    taskManagerFactory,
    taskManagerOptions,
    sourceDir,
    daemonEntry,
    spawnReplacement,
    exitProcess,
  } = resolveDaemonOptions(options);

  if (platform !== "linux" && platform !== "darwin") {
    throw new Error("error: taskferry daemon supports Linux and macOS only\nhelp: run taskferry on a Unix host with Unix-domain socket support");
  }
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  const clients = new Set();
  const subscriptions = new Map();
  const inFlightRef = { current: 0 };
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
  const onEvent = (event) => deliverEvent(subscriptions, writeMessage, event, resolveWorkspaceRoot);
  const manager = taskManagerFactory({ ...taskManagerOptions, onEvent, stateDir, runtimeDir });
  const onRequestTimed = makeRequestTimer({ stateDir, env, config: taskManagerOptions.config });
  const startupSourceSignature = sourceSignature(sourceDir);
  const syncActivity = () => syncActivitySubscriptions(manager, subscriptions);
  const restart = { pending: false, restarting: false };
  const maybeRestartRef = { current: null };
  const server = createDaemonServer({
    clients,
    subscriptions,
    manager,
    writeMessage,
    syncActivity,
    inFlightRef,
    maxInFlightRequests,
    responseError,
    onRequestTimed,
    invoke: (targetManager, request) => invoke(targetManager, request, resolveWorkspaceRoot),
    maybeRestart: () => maybeRestartRef.current?.(),
  });

  await bindDaemonSocket({ server, runtimeDir, socketPath, healthCheckTimeoutMs });

  const close = makeClose({ manager, clients, server, socketPath, restart });
  maybeRestartRef.current = makeMaybeRestart({
    manager,
    sourceDir,
    sourceSignature,
    startupSourceSignature,
    close,
    spawnReplacement,
    daemonEntry,
    env,
    exitProcess,
    restart,
  });

  return {
    socketPath,
    close,
    stats: () => ({ connections: clients.size, subscriptions: subscriptions.size }),
  };
}

async function main() {
  const daemon = await startDaemon({ taskManagerOptions: { config: loadConfig() } });
  const stop = async () => {
    try {
      await daemon.close();
      process.exit(0);
    } catch (error) {
      process.stderr.write(`error: daemon shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
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
