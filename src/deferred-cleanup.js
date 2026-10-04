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
 *
 * The confinement helper (`confinePath`) is deliberately exported here, not
 * in tasks.js: every caller of `runDeferredCleanup` is also a caller of
 * confinement, and putting both pieces next to each other keeps the contract
 * -- "this function calls rm -rf on what it finds there" -- in one place,
 * defended in one place. A persisted tasks.json is a JSON file an operator
 * can hand-edit; that surface has to refuse anything outside the cache root
 * regardless of who calls it.
 */

import fs from "node:fs";
import path from "node:path";
import { errCode } from "./errors.js";
import { TERMINAL_STATUSES } from "./statuses.js";

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
 *
 * `allowedRoots`, when provided, confines every target to one of those roots
 * before rm: any path outside is refused (dropped from the list permanently
 * and reported) rather than reaped. Refusal is the only line of defense
 * between a hand-edited `tasks.json` and `fs.rmSync`.
 * @param {{deferredCleanup?: string[]}} task
 * @param {{rmFn?: (target: string) => void, allowedRoots?: string[]}} [options]
 * @returns {{removed: string[], failed: Array<{path: string, error: string}>, refused: Array<{path: string, reason: string}>}}
 */
export function runDeferredCleanup(task, { rmFn = defaultRemoveTree, allowedRoots } = {}) {
  /** @type {string[]} */
  const removed = [];
  /** @type {Array<{path: string, error: string}>} */
  const failed = [];
  /** @type {Array<{path: string, reason: string}>} */
  const refused = [];
  /** @type {string[]} */
  const remaining = [];
  const targets = Array.isArray(task.deferredCleanup) ? task.deferredCleanup : [];
  for (const target of targets) {
    /** @type {{ok: true, path: string} | {ok: false, reason: string}} */
    const confinement = allowedRoots && allowedRoots.length > 0 ? confinePath(target, allowedRoots) : { ok: true, path: String(target) };
    if (!confinement.ok) {
      refused.push({ path: String(target), reason: confinement.reason });
      continue;
    }
    const outcome = attemptRemoval(confinement.path, rmFn);
    if (outcome.error == null) {
      removed.push(confinement.path);
    } else {
      failed.push({ path: confinement.path, error: outcome.error });
      if (outcome.retryable) remaining.push(String(target));
    }
  }
  if (remaining.length > 0) task.deferredCleanup = remaining;
  else delete task.deferredCleanup;
  return { removed, failed, refused };
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
 * Confines an absolute path to one of the daemon's own roots. Anything not
 * strictly inside an allowed root (a `..` traversal, a symlink escape, the
 * root itself) is refused with a human-readable reason and never reaches the
 * `rm -rf` below. The check is against `fs.realpath` of the candidate when it
 * exists, falling back to lexical resolution when the path is gone (the
 * common case for a deferred cleanup where the dir was already removed by a
 * tmpfs reboot).
 *
 * This is the only line of defense between `tasks.json` and `fs.rmSync`:
 * `tasks.json` is plain JSON an operator can hand-edit, and the deferred
 * list is whatever shape survives that edit. Refuse rather than coerce.
 *
 * @param {string} candidate
 * @param {string[]} allowedRoots
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export function confinePath(candidate, allowedRoots) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return { ok: false, reason: "not a string" };
  }
  if (!path.isAbsolute(candidate)) {
    return { ok: false, reason: "not an absolute path" };
  }
  const resolved = safeRealpath(candidate);
  const compared = /** @type {string[]} */ ([]);
  for (const root of allowedRoots) {
    const resolvedRoot = safeRealpath(root);
    compared.push(`${resolvedRoot} (lexical=${root})`);
    if (isStrictlyInside(resolved, resolvedRoot)) {
      return { ok: true, path: resolved };
    }
  }
  return { ok: false, reason: `not strictly inside any allowed root (compared: ${compared.join(", ")})` };
}

/**
 * Filters a target list through {@link confinePath} and returns the kept
 * entries paired with the dropped ones. Dropped entries are reported (the
 * caller logs them) but never reaped.
 *
 * @param {string[]} targets
 * @param {string[]} allowedRoots
 * @returns {{kept: string[], dropped: Array<{path: string, reason: string}>}}
 */
export function confinePaths(targets, allowedRoots) {
  /** @type {string[]} */
  const kept = [];
  /** @type {Array<{path: string, reason: string}>} */
  const dropped = [];
  for (const target of targets) {
    const result = confinePath(target, allowedRoots);
    if (result.ok) kept.push(result.path);
    else dropped.push({ path: String(target), reason: result.reason });
  }
  return { kept, dropped };
}

/**
 * Whether `inner` is strictly inside `outer`. The strict form refuses the
 * outer itself (`outer/inner` yes, `outer` no) so a removed-sibling case
 * can't slip a `rm -rf <root>` past confinement. `path.relative` returns an
 * empty string only when the paths are equal, and a string starting with
 * `..` only when `inner` escapes `outer` -- both correctly excluded.
 * @param {string} inner
 * @param {string} outer
 * @returns {boolean}
 */
function isStrictlyInside(inner, outer) {
  if (inner === outer) return false;
  const rel = path.relative(outer, inner);
  if (rel === "" || rel.startsWith("..")) return false;
  return true;
}

/**
 * `fs.realpathSync` on a deferred cleanup candidate. A missing path resolves
 * to its lexical form (the common case: a tmpfs reboot cleared the dir, the
 * task's list still mentions it); a non-ENOENT error falls back to lexical
 * resolution but is logged so an EACCES-on-a-symlink case does not vanish
 * from the daemon's view -- lexical resolution against `path.resolve(target)`
 * still catches `..` traversal, so the confinement verdict is correct even
 * when the realpath probe failed. Both branches produce a string
 * `confinePath` can run through `path.relative`.
 * @param {string} target
 * @returns {string}
 */
function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch (err) {
    if (errCode(err) !== "ENOENT") {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`taskferry: realpath failed for ${target}; falling back to lexical resolution: ${message}`);
    }
    return path.resolve(target);
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
  if (!task.status || !TERMINAL_STATUSES.has(task.status)) return false;
  return task.changesetStatus !== "pending";
}

/** @param {string} target */
function defaultRemoveTree(target) {
  fs.rmSync(target, { recursive: true, force: true });
}