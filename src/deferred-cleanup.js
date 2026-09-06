import fs from "node:fs";
import path from "node:path";
import { errCode } from "./errors.js";

/**
 * Deferred file cleanup: a per-task list of filesystem paths that must
 * outlive the worker child but must not outlive the task.
 *
 * The existing scratch-cleanup hook (`registerScratchCleanup` in tasks.js) is
 * a closure list drained by `finishChildSettlement`, which makes it wrong for
 * two overlapping reasons:
 *
 *   1. It fires at child exit, and a ferry is not settled at child exit. The
 *      check gate spawns *after* the child is gone and re-runs the worker's
 *      own uv dirs; a changeset sits `pending` until someone accepts or
 *      rejects it, and an interrupted gate is deliberately re-runnable. A
 *      path reaped at child exit is a path yanked out from under all three.
 *   2. A closure only exists in the daemon that created it. A daemon killed
 *      mid-flight loses every registered cleanup, and nothing on disk records
 *      that the path was ever meant to be removed. That is how ~/.cache/
 *      taskferry/uv-cache reached 30G across 1106 per-task directories with
 *      no live task to attribute any of them to.
 *
 * So the deferred list is data, not closures: a `string[]` hanging off the
 * task record, persisted with the rest of it by the ordinary
 * `JSON.stringify(tasks)` flush, and drained at real settlement points.
 * Restart-surviving state is the whole point -- "defer a function" is the
 * right shape until the process holding the function dies.
 *
 * Paths, not arbitrary callbacks, because a path is the only thing that
 * round-trips through JSON. Anything needing a genuine callback at settlement
 * still belongs on `registerScratchCleanup`.
 */

/**
 * Records paths to remove when the task settles. Absolute paths only, and
 * duplicates collapse, so a caller that re-registers the same deterministic
 * path on a later code path (the check gate re-deriving the worker's uv dirs,
 * a resumed task re-running its dispatch) is a no-op rather than a growing
 * list.
 * @param {{deferredCleanup?: string[]}} task
 * @param {...string} paths
 */
export function registerDeferredCleanup(task, ...paths) {
  for (const candidate of paths) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      throw new Error(`error: deferred cleanup path must be absolute, got ${JSON.stringify(candidate)}`);
    }
  }
  const existing = task.deferredCleanup ?? [];
  task.deferredCleanup = [...new Set([...existing, ...paths])];
}

/**
 * Removes every path the task deferred, keeping the ones that failed so a
 * later drain (the next settlement point, or the boot sweep) retries them.
 * Never throws: every caller is on a settlement path where an unhandled
 * throw would strand a concurrency slot or crash the daemon.
 *
 * A path that is already gone counts as removed -- the common case is a tmpfs
 * that cleared across a reboot, which is exactly the outcome the drain wanted.
 *
 * Reads defensively (`Array.isArray`, absolute-path check) because
 * `tasks.json` is a plain JSON file an operator can and does hand-edit, and
 * this function's whole job is calling `rm -rf` on what it finds there.
 * @param {{deferredCleanup?: string[]}} task
 * @param {{rmFn?: (target: string) => void}} [options]
 * @returns {{removed: string[], failed: Array<{path: string, error: string}>}}
 */
export function runDeferredCleanup(task, { rmFn = defaultRemoveTree } = {}) {
  /** @type {string[]} */
  const removed = [];
  /** @type {Array<{path: string, error: string}>} */
  const failed = [];
  /** @type {string[]} */
  const remaining = [];
  const targets = Array.isArray(task.deferredCleanup) ? task.deferredCleanup : [];
  for (const target of targets) {
    const outcome = attemptRemoval(target, rmFn);
    if (outcome.error == null) {
      removed.push(String(target));
    } else {
      failed.push({ path: String(target), error: outcome.error });
      if (outcome.retryable) remaining.push(String(target));
    }
  }
  if (remaining.length > 0) task.deferredCleanup = remaining;
  else delete task.deferredCleanup;
  return { removed, failed };
}

/**
 * One removal attempt, reduced to a verdict the caller can bucket without
 * branching. A missing path counts as removed: the common case is a tmpfs
 * cleared by a reboot, which is the outcome the drain wanted anyway.
 *
 * A malformed entry is reported but *not* retryable, so it drops off the list
 * instead of being retried on every boot forever. Retrying it would never
 * succeed -- nothing later in the task's life turns a relative path or a
 * non-string into something this function is willing to `rm -rf`.
 * @param {unknown} target
 * @param {(target: string) => void} rmFn
 * @returns {{error: string|null, retryable: boolean}}
 */
function attemptRemoval(target, rmFn) {
  if (typeof target !== "string" || !path.isAbsolute(target)) {
    return { error: "not an absolute path", retryable: false };
  }
  try {
    rmFn(target);
    return { error: null, retryable: false };
  } catch (err) {
    if (errCode(err) === "ENOENT") return { error: null, retryable: false };
    return { error: err instanceof Error ? err.message : String(err), retryable: true };
  }
}

/**
 * Whether a task is far enough along that its deferred paths are safe to
 * reap without a settlement event having fired in this process. Used by the
 * boot sweep, which sees only what a killed daemon left on disk.
 *
 * `pending` is the exclusion that matters: a pending changeset still owns a
 * live overlay, `markInterruptedGates` may re-run its check gate against that
 * overlay, and the gate needs the same uv dirs the worker ran with.
 * @param {{status?: string, changesetStatus?: string}} task
 * @returns {boolean}
 */
export function isDeferredCleanupReapable(task) {
  if (task.status !== "done" && task.status !== "crashed" && task.status !== "cancelled") return false;
  return task.changesetStatus !== "pending";
}

/** @param {string} target */
function defaultRemoveTree(target) {
  fs.rmSync(target, { recursive: true, force: true });
}
