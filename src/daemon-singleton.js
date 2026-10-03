// Sole-daemon enforcement: everything that decides whether *this* process is
// allowed to be the daemon for a given socket path and state dir. Split out
// of daemon.js, which was over the 400-line cap and carrying a file-level
// lint bypass to hide it.
//
// Two independent gates live here, and they answer different questions. The
// socket gate (socketHealth/prepareSocket/removeStaleSocketIfUnchanged) binds
// atomically and answers "is anything listening right now". The pid gate
// (the daemon.pid record and its liveness checks) answers "did a daemon crash
// leaving children that still own overlays" -- a case the socket probe cannot
// see, because a zombie's socket is already gone while its tasks keep running.
// Both are needed; see the long comment above readProcStartTime for why the
// pid file lives in the state dir rather than the runtime dir.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { withFileLock } from "./state-lock.js";
import { PROTOCOL_VERSION, encodeMessage } from "./protocol.js";
import { errCode } from "./errors.js";

/**
 * @typedef {object} SocketHealthResult
 * @property {boolean} listening
 * @property {boolean} healthy
 */

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
export function enforceDaemonSingleton({ stateDir, exitProcess }) {
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
export function makeUnclaimDaemonPid(stateDir) {
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
