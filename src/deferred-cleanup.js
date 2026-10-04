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
 * The confinement helper (`confinePath`) deliberately lives here, not
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
 * `allowedRoots` confines every target to one of those roots before rm: any
 * path outside is refused (dropped from the list permanently and reported)
 * rather than reaped. Refusal is the only line of defense between a
 * hand-edited `tasks.json` and `fs.rmSync`, so the roots are mandatory: a
 * call without any refuses every target and leaves the list untouched for a
 * correctly configured drain to retry, instead of reaping unconfined.
 * @param {{deferredCleanup?: string[]}} task
 * @param {{rmFn?: (target: string) => void, allowedRoots: string[]}} options
 * @returns {{removed: string[], failed: Array<{path: string, error: string}>, refused: Array<{path: string, reason: string}>}}
 */
export function runDeferredCleanup(task, { rmFn = defaultRemoveTree, allowedRoots }) {
  /** @type {string[]} */
  const removed = [];
  /** @type {Array<{path: string, error: string}>} */
  const failed = [];
  /** @type {Array<{path: string, reason: string}>} */
  const refused = [];
  /** @type {string[]} */
  const remaining = [];
  const targets = Array.isArray(task.deferredCleanup) ? task.deferredCleanup : [];
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    for (const target of targets) refused.push({ path: String(target), reason: "no allowed roots configured" });
    return { removed, failed, refused };
  }
  const resolvedRoots = resolveRoots(allowedRoots);
  for (const target of targets) {
    const confinement = confineToResolvedRoots(target, resolvedRoots);
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
 * exists, falling back to lexical resolution only when the path is gone (the
 * common case for a deferred cleanup where the dir was already removed by a
 * tmpfs reboot). Any other realpath failure refuses: a path whose symlinks
 * cannot be resolved cannot be proven to stay inside the root.
 *
 * This is the only line of defense between `tasks.json` and `fs.rmSync`:
 * `tasks.json` is plain JSON an operator can hand-edit, and the deferred
 * list is whatever shape survives that edit. Refuse rather than coerce.
 *
 * @param {unknown} candidate
 * @param {string[]} allowedRoots
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export function confinePath(candidate, allowedRoots) {
  return confineToResolvedRoots(candidate, resolveRoots(allowedRoots));
}

/**
 * Resolves each allowed root once per drain rather than once per target.
 * @param {string[]} allowedRoots
 * @returns {Array<{lexical: string, resolved: string|null}>}
 */
function resolveRoots(allowedRoots) {
  return allowedRoots.map((root) => {
    const real = realpathOrMissing(root);
    return { lexical: root, resolved: real.ok ? real.path : null };
  });
}

/**
 * @param {unknown} candidate
 * @param {Array<{lexical: string, resolved: string|null}>} roots
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
function confineToResolvedRoots(candidate, roots) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return { ok: false, reason: "empty or not a string" };
  }
  if (!path.isAbsolute(candidate)) {
    return { ok: false, reason: "not an absolute path" };
  }
  const real = realpathOrMissing(candidate);
  if (!real.ok) return { ok: false, reason: real.reason };
  const compared = /** @type {string[]} */ ([]);
  for (const root of roots) {
    compared.push(`${root.resolved ?? "<unresolvable>"} (lexical=${root.lexical})`);
    if (root.resolved != null && isStrictlyInside(real.path, root.resolved)) {
      return { ok: true, path: real.path };
    }
  }
  return { ok: false, reason: `not strictly inside any allowed root (compared: ${compared.join(", ")})` };
}

/**
 * Whether `inner` is strictly inside `outer`: `outer/inner` yes, `outer`
 * itself no, so a removed-sibling case can't slip a `rm -rf <root>` past
 * confinement. Same escape test as `isOutsideDirectory` in tasks.js (which
 * this module can't import without a cycle): `..` exactly or followed by a
 * separator escapes, while a child literally named `..foo` does not.
 * @param {string} inner
 * @param {string} outer
 * @returns {boolean}
 */
function isStrictlyInside(inner, outer) {
  const rel = path.relative(outer, inner);
  if (rel === "" || path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * `fs.realpathSync`, with a missing path resolved lexically (a tmpfs reboot
 * cleared the dir and the task's list still mentions it; the rm will find
 * nothing either way). Any other failure -- EACCES on a parent, ELOOP -- is a
 * refusal, not a lexical fallback: lexical resolution does not follow
 * symlinks, so it cannot prove a path whose links it could not read stays
 * inside a root.
 * @param {string} target
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
function realpathOrMissing(target) {
  try {
    return { ok: true, path: fs.realpathSync(target) };
  } catch (err) {
    if (errCode(err) === "ENOENT") return { ok: true, path: path.resolve(target) };
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `realpath failed: ${message}` };
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