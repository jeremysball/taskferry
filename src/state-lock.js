import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { errCode } from "./errors.js";

// A synchronous, cross-process exclusive lock backed by an exclusively-created
// file. Blocks the event loop via Atomics.wait while contended -- acceptable
// here because tasks.js's own state writes are already synchronous
// (fs.writeFileSync/renameSync) and only ever held for the duration of a
// single small JSON read-modify-write.
//
// Known limitation: the ownership token (read at release, compared, then
// unlinked) narrows but doesn't eliminate a TOCTOU race in stale-lock
// reclamation -- a holder stuck past `staleMs` could theoretically have its
// lock reclaimed by another process in the microsecond window between the
// read and the unlink. Plain fs syscalls have no atomic compare-and-delete;
// closing this fully would require a real locking primitive (e.g. flock)
// instead of a plain lock file. Accepted as residual risk: it only matters
// once a holder has already overrun staleMs, which is itself anomalous.
/**
 * @template T
 * @param {string} lockPath
 * @param {() => T} fn
 * @param {{staleMs?: number, retryMs?: number, timeoutMs?: number}} [options]
 * @returns {T}
 */
export function withFileLock(lockPath, fn, { staleMs = 10000, retryMs = 25, timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const ownershipToken = `${process.pid}-${Date.now()}-${randomUUID()}`;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, ownershipToken, { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err;
      /** @type {number} */
      let ageMs;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch (statErr) {
        if (errCode(statErr) === "ENOENT") continue; // lock disappeared between attempts
        throw statErr;
      }
      if (ageMs >= staleMs) {
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkErr) {
          if (errCode(unlinkErr) !== "ENOENT") throw unlinkErr;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`error: timed out waiting for lock: ${lockPath}\nhelp: another taskferry process may be stuck; remove the lock file if it is stale`, { cause: err });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
    }
  }
  // Throwing from a `finally` would mask a real error from fn() (e.g. a
  // failed state write) with an unrelated cleanup failure. Defer the
  // cleanup error and only surface it once fn() itself has succeeded.
  /** @type {unknown} */
  let cleanupError;
  /** @type {T} */
  let result;
  try {
    result = fn();
  } finally {
    /** @type {string|undefined} */
    let currentToken;
    try {
      currentToken = fs.readFileSync(lockPath, "utf8");
    } catch (err) {
      if (errCode(err) !== "ENOENT") cleanupError = err;
    }
    if (currentToken === ownershipToken) {
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        if (errCode(err) !== "ENOENT") cleanupError = err;
      }
    }
  }
  if (cleanupError) throw cleanupError;
  return result;
}
