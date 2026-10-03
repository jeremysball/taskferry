import path from "node:path";

/**
 * Accounting for the state a long-lived daemon accumulates but never reports:
 * task records still pointing at an overlay directory that is gone, pending
 * changesets nothing on disk can ever apply, per-task scratch dirs, and the
 * raw size of tasks.json. None of it is derivable from `doctor`'s existing
 * checks (which look at the environment) or from `doctor --stats` (which
 * looks at dispatch outcomes), and all of it grows silently until something
 * runs out of space.
 *
 * Measured on a real daemon before this existed: 21,645 task records in a
 * 135 MB tasks.json, 4,804 of them still carrying an `overlayDirs` pointer
 * of which only 43 named a directory that still existed, and 1,809 pending
 * changesets with no extracted diff and no surviving overlay -- permanently
 * unresolvable, and invisible from every command.
 */

/** Buckets under the cache dir that hold one directory per task id. */
const PER_TASK_CACHE_BUCKETS = ["uv-cache", "uv-tools"];

/**
 * @typedef {object} HousekeepingTask
 * @property {string} [status]
 * @property {string} [changesetStatus]
 * @property {string|null} [diffPath]
 * @property {{root: string, tmpRoot: string, upperDir?: string}|null} [overlayDirs]
 */

/**
 * Whether a task's `overlayDirs` pointer names a directory that no longer
 * exists. Deliberately excludes `running`/`queued` tasks: the overlay record
 * is persisted *before* the child is spawned (taskferry#346), so a task the
 * daemon has not settled yet can legitimately be recorded a moment before
 * its directory appears.
 * @param {HousekeepingTask} task
 * @param {(p: string) => boolean} existsFn
 */
export function overlayPointerIsStale(task, existsFn) {
  const root = task.overlayDirs?.root;
  if (typeof root !== "string" || root.length === 0) return false;
  if (task.status === "running" || task.status === "queued") return false;
  return !existsFn(root);
}

/**
 * Whether a pending changeset can still be resolved into a real change.
 * `accept` applies the persisted `.patch` (`validateAcceptable` in tasks.js),
 * so a readable diff is enough even after the overlay is gone -- but a task
 * whose extraction failed has neither, and no future command can produce one.
 * @param {HousekeepingTask} task
 * @param {(p: string) => boolean} existsFn
 */
export function pendingChangesetIsApplicable(task, existsFn) {
  if (task.changesetStatus !== "pending") return false;
  return typeof task.diffPath === "string" && task.diffPath.length > 0 && existsFn(task.diffPath);
}

/**
 * @param {Iterable<HousekeepingTask>} tasks
 * @param {(p: string) => boolean} existsFn
 */
function countOverlays(tasks, existsFn) {
  // Filter to the records that carry a pointer at all before touching the
  // filesystem: on a store this size the stat is the expensive half, and
  // most records never had an overlay (CLAUDE.md, "Always filter, then
  // process").
  const withPointer = [...tasks].filter((task) => typeof task.overlayDirs?.root === "string");
  let stale = 0;
  for (const task of withPointer) {
    if (overlayPointerIsStale(task, existsFn)) stale++;
  }
  return { stale, recorded: withPointer.length, live: withPointer.length - stale };
}

/**
 * @param {Iterable<HousekeepingTask>} tasks
 * @param {(p: string) => boolean} existsFn
 */
function countChangesets(tasks, existsFn) {
  const pending = [...tasks].filter((task) => task.changesetStatus === "pending");
  let applicable = 0;
  for (const task of pending) {
    if (pendingChangesetIsApplicable(task, existsFn)) applicable++;
  }
  return { applicable, pending: pending.length, unresolvable: pending.length - applicable };
}

/**
 * @param {string} cacheDir
 * @param {(p: string) => string[]} readdirFn
 */
function countPerTaskCacheDirs(cacheDir, readdirFn) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const bucket of PER_TASK_CACHE_BUCKETS) {
    try {
      counts[bucket] = readdirFn(path.join(cacheDir, bucket)).length;
    } catch {
      // An absent bucket is the normal state on a daemon that has never
      // dispatched a uv-using worker, not an error worth surfacing.
      counts[bucket] = 0;
    }
  }
  return counts;
}

/**
 * @param {string} tasksFile
 * @param {(p: string) => {size: number}} statFn
 */
function taskStoreBytes(tasksFile, statFn) {
  try {
    return statFn(tasksFile).size;
  } catch {
    return null;
  }
}

/**
 * @param {object} ctx
 * @param {Iterable<HousekeepingTask>} ctx.tasks
 * @param {string} ctx.cacheDir
 * @param {string} ctx.tasksFile
 * @param {(p: string) => boolean} ctx.existsFn
 * @param {(p: string) => string[]} ctx.readdirFn
 * @param {(p: string) => {size: number}} ctx.statFn
 */
export function computeHousekeeping(ctx) {
  const tasks = [...ctx.tasks];
  return {
    taskStore: { records: tasks.length, bytes: taskStoreBytes(ctx.tasksFile, ctx.statFn) },
    overlays: countOverlays(tasks, ctx.existsFn),
    changesets: countChangesets(tasks, ctx.existsFn),
    perTaskCacheDirs: countPerTaskCacheDirs(ctx.cacheDir, ctx.readdirFn),
  };
}
