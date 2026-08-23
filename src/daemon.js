#!/usr/bin/env node
/* eslint-disable max-lines -- daemon.js is just over the limit after restartWaitForIdle addition; split would be a larger refactor */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTaskManager, emptyStatusCounts } from "./tasks.js";
import { loadConfig } from "./config.js";
import { withFileLock, withFileLockAsync } from "./state-lock.js";
import { isNonNegativeInteger, isPositiveInteger } from "./numbers.js";
import { parsedEnvNumber, resolveEnvOverrideBoolean } from "./options.js";
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
 * @property {string} stateDir
 * @property {() => void} exitProcess
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
 * @param {NodeJS.ProcessEnv} [env]
 * @param {ProfilingConfig} [config]
 * @returns {boolean}
 */
function profilingEnabled(env, config) {
  return resolveEnvOverrideBoolean(env, "TASKFERRY_PROFILING_ENABLED", config?.profilingEnabled);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{restartWaitForIdle?: boolean}} [config]
 * @returns {boolean}
 */
function restartWaitForIdleEnabled(env, config) {
  return resolveEnvOverrideBoolean(env, "TASKFERRY_RESTART_WAIT_FOR_IDLE", config?.restartWaitForIdle);
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

// A live daemon's pid is recorded at startup as `<state-dir>/daemon.pid` so
// a second daemon boot can refuse to run -- and a stale one can be reclaimed
// -- even when the socket gate is not enough on its own. The socket probe
// only proves "nothing is listening *right now*"; it cannot distinguish a
// crashed daemon (whose zombie *children* may still be running tasks with
// live overlays) from a clean state with no daemon at all. Without this
// check, an ordinary no-daemon boot would reclaim the pidfile left behind by
// a zombie whose tasks are still executing, and that daemon's startup sweeps
// would then delete the zombies' in-flight overlays out from under their
// workers (taskferry#515). The pidfile deliberately lives in the state dir,
// not the runtime dir, because the socket gate is keyed to the socket path
// while task state is keyed to the state dir -- a caller can override the
// socket path (TASKFERRY_SOCKET_PATH) without changing state dir, so scoping
// the ownership record to the state dir keeps the "one daemon per state"
// guarantee congruent with where the destructive sweeps operate.
//
// Two processes can genuinely disagree about the pid file's owner between
// the read and the write, so the pid file's contents are only ever used to
// make a *conservative* decision -- refuse to boot, or overwrite a record
// that the liveness checks proved dead. The socket gate (which binds
// atomically, and whose identity is double-checked under a lock) remains
// the actual exclusivity mechanism; the pid file's mtime makes the record
// self-reclaiming for the warn-only case, since a fresh boot always stamps
// it.

/**
 * Reads a pid's kernel start time from /proc/<pid>/stat (field 22), the
 * stable process identity that survives pid reuse (same logic as
 * tasks.js's readProcStartTime, duplicated here so daemon.js need not
 * import from the manager module).
 * @param {number} pid
 * @returns {string|null}
 */
function readProcStartTime(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field is parenthesized and may itself contain spaces, so
    // count from the end: starttime is field 22 of the standard 52, i.e.
    // the 31st token from the tail.
    const parts = (stat ?? "").trim().split(/\s+/);
    return parts.length >= 31 ? parts[parts.length - 31] : null;
  } catch {
    return null;
  }
}

/**
 * Whether a pid is still alive (signal 0 probe). A live but recycled pid is
 * still "alive" for this check; /proc start-time matching on top of it (see
 * {@link pidIdentityMatches}) is what distinguishes the original process
 * from a stranger that reused its pid.
 * @param {number} pid
 * @returns {boolean}
 */
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) === "EPERM";
  }
}

/**
 * Whether `pid` is the same process that wrote `recordedStartTime`, by
 * comparing /proc start times. A bare kill(pid,0) probe cannot tell a
 * live-but-reused pid from the original process; when the recorded start
 * time is unavailable (non-Linux) the check passes open, so the caller's
 * "likely live, treat as live" fallback applies (safer than sweeping a
 * zombie's state: refusing to proceed only defers a boot, deleting is
 * unrecoverable).
 * @param {number} pid
 * @param {string|null} recordedStartTime
 * @returns {boolean}
 */
function pidIdentityMatches(pid, recordedStartTime) {
  if (recordedStartTime == null) return true;
  const current = readProcStartTime(pid);
  return current != null && current === recordedStartTime;
}

/**
 * @param {string} stateDir
 * @returns {string}
 */
function daemonPidFilePath(stateDir) {
  return path.join(stateDir, "daemon.pid");
}

/**
 * @param {string} stateDir
 * @returns {{pid: number|null, startTime: string|null}}
 */
function readDaemonPidFile(stateDir) {
  let raw;
  try {
    raw = fs.readFileSync(daemonPidFilePath(stateDir), "utf8");
  } catch {
    return { pid: null, startTime: null };
  }
  const parts = raw.trim().split(/\s+/);
  const pid = Number(parts[0]);
  return { pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null, startTime: parts[1] ?? null };
}

/**
 * Whether the daemon that wrote the pid file appears to be genuinely alive:
 * the recorded pid responds to signal 0 and still has the recorded /proc
 * start time (so it is the original daemon, not a recycled pid). A pid that
 * fails either check is treated as dead even if something else now lives at
 * that pid. Called only when the socket gate has already established that
 * nothing is listening, which is exactly the zombie-daemon case.
 * @param {string} stateDir
 * @returns {boolean}
 */
function recordedDaemonIsAlive(stateDir) {
  const { pid, startTime } = readDaemonPidFile(stateDir);
  return pid != null && pidIsAlive(pid) && pidIdentityMatches(pid, startTime);
}

// Runs inside the socket-bind lock, so racing daemon boots serialize their
// pid-file cleanup/reclaim decisions (two of them can't each conclude "the
// other's stale file is mine to remove" at the same instant).
/**
 * @param {{stateDir: string, exitProcess: () => void}} deps
 * @returns {void}
 */
function enforceDaemonSingleton({ stateDir, exitProcess }) {
  const pidFilePath = daemonPidFilePath(stateDir);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const previousOwner = readDaemonPidFile(stateDir);
  if (recordedDaemonIsAlive(stateDir)) {
    process.stderr.write(
      `error: another taskferry daemon (pid ${previousOwner.pid}, recorded at ${daemonPidFilePath(stateDir)}) is already running for ${stateDir}\n`
      + "help: reuse the existing daemon, or stop it first; a second daemon for the same state dir would delete its overlays at startup\n"
    );
    exitProcess();
    return;
  }
  fs.writeFileSync(pidFilePath, `${process.pid} ${readProcStartTime(process.pid) ?? ""}\n`, { mode: 0o600 });
}

/**
 * Removes the daemon.pid record on clean shutdown, so a fresh boot that
 * outlives the socket gate (no listener, but the pid file may already be
 * gone) doesn't see a stale "previous daemon" record from the previous
 * incarnation.
 * @param {string} stateDir
 * @returns {() => void}
 */
function makeUnclaimDaemonPid(stateDir) {
  return () => {
    const { pid } = readDaemonPidFile(stateDir);
    if (pid === process.pid) {
      try {
        fs.unlinkSync(daemonPidFilePath(stateDir));
      } catch {
        // best-effort; a leftover pid file is re-checked (and reclaimed) on
        // the next boot
      }
    }
  };
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
async function bindDaemonSocket({ server, runtimeDir, socketPath, healthCheckTimeoutMs, stateDir, exitProcess }) {
  const bindLockPath = path.join(runtimeDir, "socket-bind.lock");
  await withFileLockAsync(bindLockPath, async () => {
    await prepareSocket(runtimeDir, socketPath, healthCheckTimeoutMs);
    // Inside the lock: only one boot holds the bind lock at a time, so the
    // pid-file liveness decision (refuse / reclaim / write) is serialized
    // against every other boot's. A refused boot exits without ever
    // binding; a boot whose recorded predecessor is provably dead stamps
    // the record for itself.
    enforceDaemonSingleton({ stateDir, exitProcess });
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

  // The singleton gate runs *before* the task manager is constructed: the
  // manager's constructor executes the boot-time orphan sweeps (overlay /
  // prompt / output dirs) against the shared state, so a second daemon that
  // was allowed to reach construction would delete the first daemon's
  // live-state overlays at boot (taskferry#515). The socket bind itself is
  // the exclusivity authority (OS-level, atomic); the daemon.pid record is
  // the conservative liveness check that refuses to reclaim a crashed
  // daemon's record while that daemon's process is still genuinely alive
  // without a listener. The bind target is a plain server; the app-level
  // server (createDaemonServer, below) cannot be created before the manager,
  // and the manager cannot be created before exclusivity is won, so the
  // bound server forwards connections to it.
  const boundServer = net.createServer();

  await bindDaemonSocket({ server: boundServer, runtimeDir, socketPath, healthCheckTimeoutMs, stateDir, exitProcess });

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
  const appServer = createDaemonServer({
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
  // The app server is the one that actually speaks the protocol; forward
  // connections from the bound server (which holds the socket path) to it.
  boundServer.on("connection", (socket) => appServer.emit("connection", socket));

  const unclaimDaemonPid = makeUnclaimDaemonPid(stateDir);
  const close = makeClose({ clients, socketPath, restart, manager: serverManager, server: boundServer });
  // Remove the ownership record on clean shutdown (both the caller's
  // close() and the source-change restart path): a crashed daemon leaves
  // it behind deliberately, so the next boot's singleton gate can refuse
  // to reclaim it while the zombie process is still alive. The restart
  // path must unclaim too, or the replacement daemon booting against a
  // still-unreaped zombie (which still passes the signal-0 probe) could
  // refuse its own incarnation.
  const closeWithUnclaim = async () => {
    await close();
    unclaimDaemonPid();
  };
  maybeRestartRef.current = makeMaybeRestart({
    sourceDir,
    sourceSignature,
    startupSourceSignature,
    daemonEntry,
    env,
    exitProcess,
    spawnReplacement,
    restart,
    close: closeWithUnclaim,
    manager: serverManager,
    restartWaitForIdle: restartWaitForIdleEnabled(env, taskManagerOptions.config),
  });

  return {
    socketPath,
    close: closeWithUnclaim,
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
