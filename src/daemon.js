#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTaskManager, emptyStatusCounts } from "./tasks.js";
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
  makeWriteMessage,
  syncActivitySubscriptions,
} from "./daemon-server.js";
import { errCode } from "./errors.js";
import { errorValue } from "./output.js";

/**
 * @typedef {import("./tasks.js").Task} Task
 * @typedef {import("./tasks.js").TaskSummary} TaskSummary
 * @typedef {import("./tasks.js").TaskStatus} TaskStatus
 * @typedef {import("./tasks.js").ResultDetail} ResultDetail
 * tasks.js types the manager's api object as Record<string, any> on purpose --
 * it is assembled with forward references (see the notes around ctx.api
 * there) -- so this inherits that looseness rather than restating a contract
 * that would drift. daemon-server.js declares its own narrow TaskManager for
 * the handful of members the connection layer touches; the one cast bridging
 * the two lives at that call site, not here.
 * @typedef {ReturnType<typeof createTaskManager>} TaskManager
 */

/**
 * @typedef {import("./daemon-server.js").Request} DaemonRequest
 */

/**
 * @typedef {object} SocketHealthResult
 * @property {boolean} listening
 * @property {boolean} healthy
 */

/**
 * @typedef {import("./tasks.js").Counts} Counts
 */

/**
 * @typedef {object} DaemonEvent
 * @property {string} [type]
 * @property {string} [taskId]
 * @property {string} directory
 * @property {string|null} [originSessionId]
 * @property {Record<string, unknown>} [activityVariants]
 */

/**
 * @typedef {object} RequestTimerRecord
 * @property {string} method
 * @property {number} durationMs
 * @property {boolean} ok
 * @property {string} ts
 */

/**
 * @typedef {object} RestartState
 * @property {boolean} pending
 * @property {boolean} restarting
 */

/**
 * @typedef {object} InFlightRef
 * @property {number} current
 */

/**
 * @typedef {object} MaybeRestartRef
 * @property {(() => void) | null} current
 */

/**
 * @typedef {object} ProfilingConfig
 * @property {boolean} [profilingEnabled]
 */

/**
 * @typedef {object} DaemonOptionsInput
 * @property {NodeJS.Platform} [platform]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [stateDir]
 * @property {string} [runtimeDir]
 * @property {string} [socketPath]
 * @property {(startDir: string) => string} [resolveWorkspaceRoot]
 * @property {number} [healthCheckTimeoutMs]
 * @property {number} [maxOutboundBytes]
 * @property {number} [maxInFlightRequests]
 * @property {TaskManagerFactory} [taskManagerFactory]
 * @property {Record<string, any>} [taskManagerOptions]
 * @property {string} [sourceDir]
 * @property {string} [daemonEntry]
 * @property {SpawnReplacement} [spawnReplacement]
 * @property {() => void} [exitProcess]
 * @property {ProfilingConfig} [config]
 */

/**
 * @typedef {object} DaemonOptions
 * @property {NodeJS.Platform} platform
 * @property {NodeJS.ProcessEnv} env
 * @property {string} stateDir
 * @property {string} runtimeDir
 * @property {string} socketPath
 * @property {(startDir: string) => string} resolveWorkspaceRoot
 * @property {number} healthCheckTimeoutMs
 * @property {number} maxOutboundBytes
 * @property {number} maxInFlightRequests
 * @property {TaskManagerFactory} taskManagerFactory
 * @property {Record<string, any>} taskManagerOptions
 * @property {string} sourceDir
 * @property {string} daemonEntry
 * @property {SpawnReplacement} spawnReplacement
 * @property {() => void} exitProcess
 */

/**
 * @typedef {(options?: Record<string, any>) => TaskManager} TaskManagerFactory
 */

/**
 * @typedef {object} SpawnReplacementArgs
 * @property {string} daemonEntry
 * @property {NodeJS.ProcessEnv} env
 */

/**
 * @typedef {(args: SpawnReplacementArgs) => void} SpawnReplacement
 */

/**
 * @callback AppendLineFn
 * @param {string} filePath
 * @param {string} line
 * @returns {void}
 */

/**
 * @typedef {object} RequestTimerDeps
 * @property {string} stateDir
 * @property {NodeJS.ProcessEnv} [env]
 * @property {ProfilingConfig} [config]
 * @property {AppendLineFn} [appendLine]
 */

/**
 * @typedef {object} BindSocketDeps
 * @property {net.Server} server
 * @property {string} runtimeDir
 * @property {string} socketPath
 * @property {number} healthCheckTimeoutMs
 */

const DAEMON_ENTRY = fileURLToPath(import.meta.url);
const SOURCE_DIR = path.dirname(DAEMON_ENTRY);

// Detects a source-code update (e.g. a merge picked up while the daemon was
// running) so the daemon can restart itself onto the new code. Recomputed
// after every request and compared against the value captured at startup.
/**
 * @param {string} [dir]
 * @returns {number}
 */
function sourceSignature(dir = SOURCE_DIR) {
  let max = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".js")) continue;
    const { mtimeMs } = fs.statSync(path.join(dir, entry));
    if (mtimeMs > max) max = mtimeMs;
  }
  return max;
}

/**
 * @param {{socketPath?: string, env?: NodeJS.ProcessEnv, stateDir?: string, runtimeDir?: string}} [options]
 * @returns {string}
 */
function resolveSocketPath(options = {}) {
  return options.socketPath || options.env?.TASKFERRY_SOCKET_PATH || path.join(resolveRuntimeDir(options), "daemon.sock");
}

const DEFAULT_SLOW_REQUEST_MS = 500;
const DEFAULT_PERF_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * @param {string|undefined} value
 * @returns {boolean}
 */
function isEnabledFlag(value) {
  return ["1", "true"].includes(/** @type {string} */ (value));
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {ProfilingConfig} [config]
 * @returns {boolean}
 */
function profilingEnabled(env, config) {
  if (env?.TASKFERRY_PROFILING_ENABLED !== undefined) return isEnabledFlag(env.TASKFERRY_PROFILING_ENABLED);
  return config?.profilingEnabled ?? false;
}

// An unset var is undefined and Number(undefined) is already NaN, but an
// empty-string value (a blank .env line, an empty -e in Docker) is
// Number("") === 0 -- a false "valid, explicit zero" that would otherwise
// slip past isPositiveInteger/isNonNegativeInteger instead of falling back
// to the default the same way a genuinely non-numeric value does.
/**
 * @param {string|undefined} rawValue
 * @param {(value: unknown) => boolean} isValid
 * @param {number} fallback
 * @returns {number}
 */
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
/**
 * @param {string} perfLogPath
 * @param {number} maxBytes
 * @param {number} nextLineBytes
 */
function rotateIfOversized(perfLogPath, maxBytes, nextLineBytes) {
  let size;
  try {
    ({ size } = fs.statSync(perfLogPath));
  } catch (error) {
    if (errCode(error) === "ENOENT") return;
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
/**
 * @type {AppendLineFn}
 */
const defaultAppendLine = (filePath, line) => fs.appendFileSync(filePath, line);

/**
 * @param {RequestTimerDeps} deps
 * @returns {((record: {method: string, durationMs: number, ok: boolean}) => void) | null}
 */
function makeRequestTimer({ stateDir, env, config, appendLine = defaultAppendLine }) {
  if (!profilingEnabled(env, config)) return null;
  const perfLogPath = path.join(stateDir, "perf.log");
  const maxBytes = parsedEnvNumber(env?.TASKFERRY_PERF_LOG_MAX_BYTES, isPositiveInteger, DEFAULT_PERF_LOG_MAX_BYTES);
  const slowRequestMs = parsedEnvNumber(env?.TASKFERRY_SLOW_REQUEST_MS, isNonNegativeInteger, DEFAULT_SLOW_REQUEST_MS);
  /**
   * @param {{method: string, durationMs: number, ok: boolean}} record
   */
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

/**
 * @param {SpawnReplacementArgs} args
 */
function defaultSpawnReplacement({ daemonEntry, env }) {
  spawn(process.execPath, [daemonEntry], { detached: true, stdio: "ignore", env }).unref();
}

/**
 * @param {string} socketPath
 * @param {number} timeoutMs
 * @returns {Promise<SocketHealthResult>}
 */
function socketHealth(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let connected = false;
    let settled = false;
    let buffer = "";
    /**
     * @param {SocketHealthResult} result
     */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(/** @type {NodeJS.Timeout} */ (timer));
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
      if (["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes(/** @type {string} */ (errCode(error)))) {
        finish({ listening: false, healthy: false });
        return;
      }
      clearTimeout(/** @type {NodeJS.Timeout} */ (timer));
      settled = true;
      reject(error);
    });
  });
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries with a short backoff between iterations: without one, concurrent
// daemon boots racing over the same socket path can keep invalidating each
// other's removeStaleSocketIfUnchanged CAS indefinitely, and each iteration
// resolves near-instantly (an ECONNREFUSED/ENOENT socketHealth check fires in
// well under a millisecond), so the loop busy-spins a full CPU core for as
// long as the race lasts instead of actually converging.
/**
 * @param {string} runtimeDir
 * @param {string} socketPath
 * @param {number} healthCheckTimeoutMs
 * @param {number} [retryDelayMs]
 * @returns {Promise<void>}
 */
export async function prepareSocket(runtimeDir, socketPath, healthCheckTimeoutMs, retryDelayMs = 25) {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  for (;;) {
    if (!fs.existsSync(socketPath)) return;
    let checkedIdentity;
    try {
      checkedIdentity = fs.statSync(socketPath);
    } catch (error) {
      if (errCode(error) === "ENOENT") {
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

/**
 * @param {string} socketPath
 * @param {fs.Stats} checkedIdentity
 * @param {string} runtimeDir
 * @returns {boolean}
 */
export function removeStaleSocketIfUnchanged(socketPath, checkedIdentity, runtimeDir) {
  const cleanupLock = path.join(runtimeDir, "socket-cleanup.lock");
  return withFileLock(cleanupLock, () => {
    let currentIdentity;
    try {
      currentIdentity = fs.statSync(socketPath);
    } catch (error) {
      if (errCode(error) === "ENOENT") return false;
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

/**
 * @param {ReturnType<TaskManager["list"]>["tasks"]} tasks
 * @returns {Task[]}
 */
function asTaskArray(tasks) {
  return Array.isArray(tasks) ? tasks : [];
}

/**
 * @param {TaskManager} manager
 * @returns {Task[]}
 */
function listRows(manager) {
  return asTaskArray(manager.list().tasks);
}

/**
 * @param {TaskManager} manager
 * @param {string} directory
 * @param {(startDir: string) => string} resolveWorkspaceRootFn
 * @returns {{directory: string, tasks: TaskStatus[]}}
 */
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

// `list --all` (task.list with no `directory`) returns every task ever
// recorded, and all-time history grows without bound. An unfiltered
// response can outgrow the daemon's 1 MiB outbound message cap
// (MAX_BUFFER_BYTES) and -- before daemon-server.js's RESPONSE_TOO_LARGE
// degradation landed -- tear the connection down with no error frame,
// which surfaced to the CLI as "taskferry daemon connection closed"
// (taskferry#342). Cap the shipped rows at the newest MAX_LIST_ROWS rows
// while keeping counts over the full set: counts are a cheap in-memory
// tally (no per-task log I/O, unlike the directory path's manager.status()
// calls). This is a row-count cap, not a byte-budget cap -- 500 rows with
// pathologically long `directory` values could in principle still exceed
// MAX_BUFFER_BYTES -- so daemon-server.js's RESPONSE_TOO_LARGE degradation
// stays in place as the wire-level backstop for that case; it just no
// longer fires for the common case this cap is sized for. Truncation is
// no longer silent either: output.js's projectList/projectContext diff
// `counts` (the true all-time tally) against the shipped row count to
// tell the CLI user when more rows exist than were sent. The same
// server-side-bounding treatment was already applied to `doctor --stats`
// (task.stats, taskferry#332).
export const MAX_LIST_ROWS = 500;

/**
 * @param {TaskManager} manager
 * @returns {ReturnType<TaskManager["list"]>}
 */
function cappedList(manager) {
  // Pass the limit into manager.list() itself rather than slicing its
  // result afterward -- listTasks() (tasks.js) slices to `limit` before
  // running summarizeRow() over the surviving rows, so summarize work never
  // runs on a row this cap is about to discard (CLAUDE.md "Always filter,
  // then process").
  return manager.list({ limit: MAX_LIST_ROWS });
}

/**
 * @param {TaskManager} manager
 * @param {string|undefined} directory
 * @param {(startDir: string) => string} resolveWorkspaceRootFn
 * @returns {ReturnType<TaskManager["list"]>}
 */
function filteredList(manager, directory, resolveWorkspaceRootFn) {
  if (directory === undefined) return cappedList(manager);
  const details = filteredTaskDetails(manager, directory, resolveWorkspaceRootFn);
  // `counts` here is a fresh tally over the workspace-filtered rows
  // (countTasks), not the cheap in-memory tally cappedList() reuses from
  // manager.list() -- different populations (this workspace's tasks vs.
  // every task ever recorded), computed differently for that reason, but
  // both represent the true total for their own scope, unaffected by any
  // row cap.
  const counts = countTasks(details.tasks);
  // Keep `directory` on each row (summarizeRow already includes it) so
  // task.list {} and task.list {directory} ship structurally identical
  // rows -- a non-CLI RPC consumer shouldn't see the field appear/disappear
  // depending on which branch answered the request.
  const rows = details.tasks.map(({ id, status, model, startedAt, directory, failureReason }) => ({ id, status, model, startedAt, directory, failureReason: failureReason ?? null }));
  return { counts, tasks: rows.length ? rows : "none found in this workspace" };
}

/**
 * @param {TaskStatus[]} tasks
 * @returns {Counts}
 */
function countTasks(tasks) {
  const counts = emptyStatusCounts();
  for (const task of tasks) {
    if (counts[/** @type {keyof Counts} */ (task.status)] !== undefined) counts[/** @type {keyof Counts} */ (task.status)]++;
  }
  return counts;
}

/**
 * @param {unknown} error
 * @param {string|null} requestId
 */
export function responseError(error, requestId) {
  if (error instanceof ProtocolError) {
    return errorResponse(error.requestId, error.code, error.message, error.help, error.message);
  }
  const text = error instanceof Error ? error.message : String(error);
  // The error envelope's `message` is single-line by contract: the
  // hand-rolled parser this replaced shipped the first `error:` line (or
  // first raw line) and put the full text in `detail`. errorValue()'s
  // detail-line folding and fabricated "taskferry request failed" for empty
  // text are CLI presentation; keep the wire shape unchanged, so a
  // multi-line error stays single-line in `message` (detail lines live in
  // `detail`), empty error text stays empty, and the help fallback is
  // daemon-oriented, not the CLI's "run `taskferry --help`".
  const { error: message, help } = errorValue(error, {
    helpFallback: "Retry the request or inspect the daemon logs",
    messageFallback: "",
    foldDetailLines: false,
  });
  const maybeCode = errCode(error);
  // eslint-disable-next-line sonarjs/no-nested-conditional, sonarjs/expression-complexity -- typed codes first, then legacy regex for UNKNOWN_TASK; output codes must not fall back to substring matching
  const code = maybeCode === "OUTPUT_NOT_FOUND" || maybeCode === "NO_OUTPUT_DIR" ? maybeCode : maybeCode === "UNKNOWN_TASK" || /unknown task id:/.test(text) ? "UNKNOWN_TASK" : "REQUEST_FAILED";
  return errorResponse(requestId, code, message, help, text);
}

// RPC method routing: each method is a small handler that forwards to the task
// manager. task.summary/task.advisor forward the whole validated params object
// rather than rebuilding a field list -- the explicit rebuild was the shape
// that silently dropped newly-added fields, whereas forwarding (task.dispatch's
// pattern) means new fields arrive at the manager without a daemon.js change.
/**
 * @typedef {(
 *   manager: TaskManager,
 *   params: Record<string, unknown>,
 *   resolveWorkspaceRootFn: (startDir: string) => string
 * ) => unknown} InvokeHandler
 */
/** @type {Record<string, InvokeHandler>} */
const invokeHandlers = {
  "system.health": () => ({ healthy: true, pid: process.pid, version: PROTOCOL_VERSION }),
  "task.dispatch": (manager, params) => manager.dispatch(/** @type {any} */ (params)),
  "task.cancel": (manager, params) => manager.cancel(/** @type {string} */ (params.taskId), params.graceMs === undefined ? undefined : { graceMs: /** @type {number} */ (params.graceMs) }),
  "task.status": (manager, params) => manager.status(/** @type {string} */ (params.taskId)),
  "task.wait": (manager, params) => manager.poll(/** @type {string} */ (params.taskId), /** @type {any} */ (params)),
  "task.list": (manager, params, resolveWorkspaceRootFn) => filteredList(manager, /** @type {string|undefined} */ (params.directory), resolveWorkspaceRootFn),
  "task.stats": (manager) => manager.stats(),
  "task.result": (manager, params) => manager.result(/** @type {string} */ (params.taskId), /** @type {any} */ (params)),
  "task.tail": (manager, params) => manager.tail(/** @type {string} */ (params.taskId), params.chars === undefined ? undefined : { chars: /** @type {number} */ (params.chars) }),
  "task.summary": (manager, params) => manager.summarize(/** @type {string} */ (params.taskId), /** @type {any} */ (params)),
  "task.advisor": (manager, params) => manager.advisor(/** @type {any} */ (params)),
  "task.context": (manager, params, resolveWorkspaceRootFn) => {
    const context = filteredTaskDetails(manager, /** @type {string} */ (params.directory), resolveWorkspaceRootFn);
    return { ...context, counts: countTasks(context.tasks) };
  },
  "task.accept": (manager, params) => manager.accept(/** @type {string} */ (params.taskId), { force: params.force === true }),
  "task.reject": (manager, params) => manager.reject(/** @type {string} */ (params.taskId)),
  "task.output": (manager, params) => manager.output(/** @type {string} */ (params.taskId), { path: typeof params.path === "string" ? params.path : undefined, ...(typeof params.maxOutputFileBytes === "number" ? { maxOutputFileBytes: params.maxOutputFileBytes } : {}) }),
};

/**
 * @param {TaskManager} manager
 * @param {DaemonRequest} request
 * @param {(startDir: string) => string} resolveWorkspaceRootFn
 */
function invoke(manager, request, resolveWorkspaceRootFn) {
  const handler = invokeHandlers[request.method];
  if (!handler) throw new Error(`unsupported method after validation: ${request.method}`);
  return handler(manager, request.params, resolveWorkspaceRootFn);
}

/** @type {Partial<DaemonOptions>} */
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

/**
 * @param {DaemonOptionsInput} [options]
 * @returns {DaemonOptions}
 */
function resolveDaemonOptions(options = {}) {
  /** @type {Partial<DaemonOptions>} */
  const merged = { ...DAEMON_DEFAULTS, ...options };
  for (const key of Object.keys(DAEMON_DEFAULTS)) {
    if (merged[/** @type {keyof DaemonOptions} */ (key)] === undefined) merged[/** @type {keyof DaemonOptions} */ (key)] = /** @type {any} */ (DAEMON_DEFAULTS[/** @type {keyof DaemonOptions} */ (key)]);
  }
  const env = /** @type {NodeJS.ProcessEnv} */ (merged.env);
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
    platform: /** @type {NodeJS.Platform} */ (merged.platform),
    healthCheckTimeoutMs: /** @type {number} */ (merged.healthCheckTimeoutMs),
    maxOutboundBytes: /** @type {number} */ (merged.maxOutboundBytes),
    maxInFlightRequests: /** @type {number} */ (merged.maxInFlightRequests),
    taskManagerFactory: /** @type {TaskManagerFactory} */ (merged.taskManagerFactory),
    taskManagerOptions: /** @type {Record<string, any>} */ (merged.taskManagerOptions),
    sourceDir: /** @type {string} */ (merged.sourceDir),
    daemonEntry: /** @type {string} */ (merged.daemonEntry),
    spawnReplacement: /** @type {SpawnReplacement} */ (merged.spawnReplacement),
    exitProcess: /** @type {() => void} */ (merged.exitProcess),
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
/**
 * @param {BindSocketDeps} deps
 * @returns {Promise<void>}
 */
async function bindDaemonSocket({ server, runtimeDir, socketPath, healthCheckTimeoutMs }) {
  const bindLockPath = path.join(runtimeDir, "socket-bind.lock");
  await withFileLockAsync(bindLockPath, async () => {
    await prepareSocket(runtimeDir, socketPath, healthCheckTimeoutMs);
    /**
     * @type {Promise<void>}
     */
    const listenPromise = new Promise((resolve, reject) => {
      /**
       * @param {Error} error
       */
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
    await listenPromise;
  });
  fs.chmodSync(socketPath, 0o600);
}

/**
 * @param {DaemonOptionsInput} [options]
 * @returns {Promise<{socketPath: string, close: () => Promise<void>, stats: () => {connections: number, subscriptions: number}}>}
 */
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

  /** @type {Set<net.Socket>} */
  const clients = new Set();
  /** @type {Map<string, {socket: net.Socket, directory: string|null, summaries: boolean, originSessionId: string|null}>} */
  const subscriptions = new Map();
  /** @type {InFlightRef} */
  const inFlightRef = { current: 0 };
  const writeMessage = makeWriteMessage(maxOutboundBytes);
  /**
   * @param {DaemonEvent} event
   */
  const onEvent = (event) => deliverEvent(subscriptions, writeMessage, event, resolveWorkspaceRoot);
  const manager = taskManagerFactory({ ...taskManagerOptions, onEvent, stateDir, runtimeDir, socketPath, resolveWorkspaceRootFn: resolveWorkspaceRoot });
  // The manager is a Record<string, any> by construction (see the TaskManager
  // typedef above). daemon-server.js states the narrow contract it depends on;
  // assert it once here so every hand-off below carries it, instead of casting
  // at each of the four call sites.
  const serverManager = /** @type {import("./daemon-server.js").TaskManager} */ (manager);
  const onRequestTimed = makeRequestTimer({ stateDir, env, config: taskManagerOptions.config });
  const startupSourceSignature = sourceSignature(sourceDir);
  const syncActivity = () => syncActivitySubscriptions(serverManager, subscriptions, resolveWorkspaceRoot);
  /** @type {RestartState} */
  const restart = { pending: false, restarting: false };
  /** @type {MaybeRestartRef} */
  const maybeRestartRef = { current: null };
  const server = createDaemonServer({
    clients,
    subscriptions,
    writeMessage,
    syncActivity,
    inFlightRef,
    maxInFlightRequests,
    responseError,
    onRequestTimed,
    manager: serverManager,
    /**
     * @param {TaskManager} targetManager
     * @param {DaemonRequest} request
     */
    invoke: (targetManager, request) => invoke(targetManager, request, resolveWorkspaceRoot),
    maybeRestart: () => maybeRestartRef.current?.(),
  });

  await bindDaemonSocket({ server, runtimeDir, socketPath, healthCheckTimeoutMs });

  const close = makeClose({ manager: serverManager, clients, server, socketPath, restart });
  maybeRestartRef.current = makeMaybeRestart({
    manager: serverManager,
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
