import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TERMINAL_STATUSES } from "./statuses.js";

/**
 * Default retention window in days. 0 disables the sweep entirely.
 * @type {number}
 */
export const DEFAULT_TASK_RETENTION_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/**
 * Statuses a retention sweep is allowed to evict. The core terminal set plus
 * `unknown`, matching the wider set commands-stream.js:43 already treats as
 * final: an `unknown` task is one whose daemon died without recording an exit,
 * so it will never transition again and nothing is waiting on it. Every other
 * status (`queued`, `running`) is live work and is kept regardless of age.
 */
export const EVICTABLE_STATUSES = new Set([...TERMINAL_STATUSES, "unknown"]);

/**
 * The task's most recent known timestamp, as epoch ms, or `undefined` when the
 * record carries no parseable one. Prefers `endedAt` so a task that started
 * long ago and finished recently is aged from when it actually finished.
 * @param {{startedAt?: string, endedAt?: string}} task
 * @returns {number|undefined}
 */
export function taskAgeAnchor(task) {
  for (const raw of [task.endedAt, task.startedAt]) {
    if (typeof raw !== "string") continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Splits task records into the ones a retention sweep keeps and the ones it
 * evicts. Pure: does no IO and mutates nothing.
 *
 * Three ways a record is kept, all deliberately fail-safe:
 * - `keepDays <= 0`, which disables retention.
 * - A non-evictable status, so live or queued work never ages out.
 * - No parseable timestamp, so an undateable record is never guessed at.
 *
 * @param {Array<{status?: string, startedAt?: string, endedAt?: string}>} tasks
 * @param {{keepDays: number, now?: number}} options
 * @returns {{kept: Array<any>, evicted: Array<any>}}
 */
export function partitionByRetention(tasks, { keepDays, now = Date.now() }) {
  if (!Number.isFinite(keepDays) || keepDays <= 0) return { kept: [...tasks], evicted: [] };
  const cutoff = now - keepDays * MS_PER_DAY;
  /** @type {Array<any>} */
  const kept = [];
  /** @type {Array<any>} */
  const evicted = [];
  for (const task of tasks) {
    if (!EVICTABLE_STATUSES.has(/** @type {string} */ (task.status))) {
      kept.push(task);
      continue;
    }
    const anchor = taskAgeAnchor(task);
    if (anchor === undefined || anchor >= cutoff) kept.push(task);
    else evicted.push(task);
  }
  return { kept, evicted };
}

/**
 * The directory evicted records are archived into. Evicted tasks are never
 * deleted outright: they are the only surviving record of dispatches whose
 * logs have their own retention story, so the sweep moves them out of the hot
 * state file rather than dropping them.
 * @param {string} stateDir
 * @returns {string}
 */
export function archiveDir(stateDir) {
  return path.join(stateDir, "archive");
}

/**
 * Appends evicted records to a timestamped NDJSON archive under
 * `<stateDir>/archive/`. NDJSON rather than JSON so a later sweep can be
 * streamed or concatenated without reparsing a growing array.
 *
 * Writes to a temp file and renames, so a crash mid-write leaves either no
 * archive or a complete one, never a truncated file that looks whole.
 *
 * @param {string} stateDir
 * @param {Array<any>} evicted
 * @param {{now?: Date}} [options]
 * @returns {string|undefined} the archive path, or undefined when nothing was evicted
 */
export function archiveEvictedTasks(stateDir, evicted, options = {}) {
  if (evicted.length === 0) return undefined;
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const dir = archiveDir(stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `tasks-pruned-${stamp}.ndjson`);
  const temporary = path.join(dir, `.tasks-pruned-${randomUUID()}.ndjson`);
  const body = evicted.map((task) => JSON.stringify(task)).join("\n") + "\n";
  try {
    fs.writeFileSync(temporary, body, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (err) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The rename already consumed it, or the write never got that far.
    }
    throw err;
  }
  return target;
}
