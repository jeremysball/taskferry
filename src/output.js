import os from "node:os";
import path from "node:path";
import { encode } from "@toon-format/toon";
import { renderPretty } from "./pretty.js";

const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_RED = "\x1b[31m";
const ANSI_YELLOW = "\x1b[33m";
/** @type {Record<string, string>} */
const ANSI_BY_STATUS = {
  done: ANSI_GREEN,
  crashed: ANSI_RED,
  cancelled: ANSI_RED,
  running: ANSI_YELLOW,
  queued: ANSI_YELLOW,
};

/**
 * Wrap text in an ANSI color code, but only when `enabled` (i.e. the target stream is a TTY).
 * @param {string} text
 * @param {string | null} code
 * @param {boolean} enabled
 * @returns {string}
 */
export function colorize(text, code, enabled) {
  return enabled && code ? `${code}${text}${ANSI_RESET}` : text;
}

/**
 * @param {string} status
 * @returns {string | null}
 */
export function colorForStatus(status) {
  return ANSI_BY_STATUS[status] || null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * @typedef {object} IoLike
 * @property {{isTTY?: boolean, write: (chunk: string) => void}} stdout
 */

/**
 * @typedef {{argv: string[], execPath: string, stdout: IoLike["stdout"]}} NodeLike
 */

/**
 * @typedef {IoLike | NodeLike} WriteIo
 */

/**
 * @param {unknown} value
 * @param {WriteIo} [io]
 * @returns {void}
 */
export function writeToon(value, io = process) {
  if (io.stdout.isTTY) {
    io.stdout.write(`${renderPretty(/** @type {Parameters<typeof renderPretty>[0]} */ (value))}\n`);
    return;
  }
  io.stdout.write(`${encode(value)}\n`);
}

/**
 * @param {string} line
 * @param {string} prefix
 * @returns {string | null}
 */
function stripPrefix(line, prefix) {
  return line.startsWith(prefix) ? line.slice(prefix.length).trim() : null;
}

/**
 * @param {unknown} error
 * @param {string | undefined} helpLine
 * @param {string} [fallback] -- caller-supplied default when neither
 *   `error.help` nor a parsed `help:` line exists. Defaults to the
 *   CLI-oriented text; the daemon's responseError() passes its own
 *   log-oriented one.
 * @returns {string}
 */
function errorHelp(error, helpLine, fallback = "Retry the command or run `taskferry --help`") {
  if (error && typeof error === "object" && typeof /** @type {{help?: unknown}} */ (error).help === "string") {
    return /** @type {{help: string}} */ (error).help;
  }
  return helpLine || fallback;
}

// Single pass over `lines`: finds the first `error:`/`help:` line (if any)
// and collects every other line as a detail line. Split out of errorValue()
// so its own branch count stays low.
/**
 * @param {string[]} lines
 * @returns {{errorLine: string | undefined, helpLine: string | undefined, detailLines: string[]}}
 */
function extractErrorParts(lines) {
  let errorLine;
  let helpLine;
  const detailLines = [];
  for (const line of lines) {
    const isErrorLine = line.startsWith("error:");
    const isHelpLine = line.startsWith("help:");
    if (errorLine === undefined && isErrorLine) errorLine = stripPrefix(line, "error:") || errorLine;
    if (helpLine === undefined && isHelpLine) helpLine = stripPrefix(line, "help:") || helpLine;
    if (!isErrorLine && !isHelpLine) detailLines.push(line);
  }
  return { errorLine, helpLine, detailLines };
}

/**
 * @param {unknown} error
 * @param {{helpFallback?: string, messageFallback?: string, foldDetailLines?: boolean}} [options]
 *   The defaults are CLI-oriented: the help fallback suggests `taskferry
 *   --help`, an empty error text fabricates "taskferry request failed",
 *   and detail lines fold into the message for a rich terminal display.
 *   The daemon's responseError() overrides all three so its wire envelope
 *   keeps the historical shape (single-line message, empty text stays
 *   empty, daemon-flavored help fallback) -- see docs/daemon.md.
 * @returns {{error: string, help: string}}
 */
export function errorValue(error, { helpFallback = "Retry the command or run `taskferry --help`", messageFallback = "taskferry request failed", foldDetailLines = true } = {}) {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split("\n");
  const { errorLine, helpLine, detailLines } = extractErrorParts(lines);
  const primary = errorLine || lines[0] || messageFallback;
  // Detail lines only fold in when we found an `error:` line as the primary,
  // so the plain single-line fallback (no recognized prefixes) keeps
  // returning `lines[0]` unchanged.
  const message = errorLine !== undefined && detailLines.length && foldDetailLines ? `${primary}\n${detailLines.join("\n")}` : primary;
  const help = errorHelp(error, helpLine, helpFallback);
  return { error: message, help };
}

/**
 * @param {unknown} error
 * @param {WriteIo} [io]
 * @returns {void}
 */
export function writeError(error, io = process) {
  writeToon(errorValue(error), io);
}

/**
 * @typedef {object} StatusDetailBase
 * @property {string} id
 * @property {string} status
 * @property {string} [directory]
 * @property {string|null} [sessionId]
 * @property {string} [startedAt]
 * @property {number|null} [exitCode]
 * @property {NodeJS.Signals|null} [signal]
 * @property {number} [logBytesWritten]
 * @property {string|null} [logLastWriteAt]
 * @property {boolean} [logHasEvent]
 * @property {string} [outputTail]
 * @property {number} [outputTailTotalChars]
 * @property {boolean} [outputTailTruncated]
 * @property {boolean} [timedOut]
 * @property {"none"|"pending"|"accepted"|"rejected"} [changesetStatus]
 * @property {string|null} [changesetError]
 * @property {string|null} [projectConfigWarning]
 * @property {"none"|"running"|"passed"|"failed"|"timeout"|"interrupted"} [checkStatus]
 * @property {string|null} [checkCommand]
 * @property {number|null} [checkExitCode]
 * @property {string|null} [checkStartedAt]
 * @property {string|null} [checkEndedAt]
 * @property {boolean} [checkOverride]
 * @property {{root?: string, tmpRoot?: string} | null} [overlayDirs]
 */

/**
 * @typedef {StatusDetailBase & {id: string, status: string}} NextHintDetail
 */

/**
 * @param {NextHintDetail} detail
 * @param {string} id
 * @param {string} status
 * @returns {string}
 */
function nextHint(detail, id, status) {
  if (status === "running" || status === "queued") {
    return `Run taskferry wait or taskferry status with task id "${id}" to check progress; pass --full for directory/model/log path details`;
  }
  if (status === "crashed" && detail.sessionId) {
    return `Session ${shellQuote(detail.sessionId)} may be salvageable; resume with taskferry dispatch --session-id ${shellQuote(detail.sessionId)} --directory ${shellQuote(detail.directory)} --prompt "<continuation prompt>"`;
  }
  return `Run taskferry result with task id "${id}" to see the final message; pass --full here for directory/model/log path details`;
}

/**
 * `--full` status is meant for the directory/model/log path details a human
 * debugging a stuck dispatch actually reads, not the daemon's own overlay
 * bookkeeping -- `overlayDirs` on the raw task record carries one
 * `{path, upperDir, workDir}` entry per git-common-dir sub-overlay
 * (gitDir, objects, refs, logs/refs) plus a `rwFileBinds` entry for a
 * scratch-copied writable file like `packed-refs`, none of which is
 * actionable from the CLI: those upper/work tmp paths only mean anything to
 * `tasks.js`'s own extraction/cleanup code, which reads them straight off
 * the task record, not off a status response. Keep just `root` (the overlay's
 * own scratch dir, useful for manually inspecting a stuck/crashed changeset)
 * and `tmpRoot` (its parent, `resolveOverlayTmpRoot()`'s output).
 * @param {StatusDetailBase} detail
 * @returns {StatusDetailBase}
 */
function trimOverlayDirs(detail) {
  if (!detail.overlayDirs) return detail;
  const { root, tmpRoot } = detail.overlayDirs;
  return { ...detail, overlayDirs: { root, tmpRoot } };
}

/**
 * Extract the conditional check-gate fields a non-`--full` lean status surfaces
 * when a gate has actually run (status other than "none"). Split out of
 * leanStatus to keep its cyclomatic count under the ceiling once the new
 * fields land.
 * @param {StatusDetailBase} detail
 * @returns {Partial<StatusDetailBase>}
 */
function leanCheckGateFields(detail) {
  if (!detail.checkStatus || detail.checkStatus === "none") return {};
  return {
    checkStatus: detail.checkStatus,
    checkCommand: detail.checkCommand,
    checkExitCode: detail.checkExitCode,
    checkStartedAt: detail.checkStartedAt,
    checkEndedAt: detail.checkEndedAt,
    ...(detail.checkOverride ? { checkOverride: true } : {}),
  };
}

/**
 * @param {StatusDetailBase} detail
 * @param {{full?: boolean}} [options]
 * @returns {Record<string, unknown>}
 */
export function leanStatus(detail, { full = false } = {}) {
  if (full) return /** @type {Record<string, unknown>} */ (trimOverlayDirs(detail));
  const {
    id,
    status,
    startedAt,
    exitCode,
    signal,
    logBytesWritten,
    logLastWriteAt,
    logHasEvent,
    outputTail,
    outputTailTotalChars,
    outputTailTruncated,
    timedOut,
    changesetStatus,
  } = detail;
  /** @type {Record<string, unknown>} */
  const lean = { id, status, startedAt };
  if (status !== "running" && status !== "queued") {
    lean.exitCode = exitCode;
    lean.signal = signal;
  }
  if (changesetStatus === "pending") {
    lean.changesetStatus = changesetStatus;
  }
  if (detail.changesetError) lean.changesetError = detail.changesetError;
  Object.assign(lean, leanCheckGateFields(detail));
  if (detail.projectConfigWarning) lean.projectConfigWarning = detail.projectConfigWarning;
  if (logBytesWritten !== undefined) {
    lean.logBytesWritten = logBytesWritten;
    lean.logLastWriteAt = logLastWriteAt;
    lean.logHasEvent = logHasEvent;
  }
  if (outputTail !== undefined) {
    lean.outputTail = outputTail;
    lean.outputTailTotalChars = outputTailTotalChars;
    lean.outputTailTruncated = outputTailTruncated;
  }
  if (timedOut) {
    lean.note = `wait timed out; the task may still be running. Run taskferry wait again to keep waiting, or pass --timeout to set a longer cap`;
  }
  lean.next = nextHint(/** @type {NextHintDetail} */ (detail), /** @type {string} */ (id), /** @type {string} */ (status));
  return lean;
}

/**
 * @typedef {object} ResultDetailBase
 * @property {string} taskId
 * @property {string} [status]
 * @property {string} [narration]
 * @property {boolean} [narrationTruncated]
 * @property {number} [narrationTotalChars]
 * @property {string} [next]
 */

/**
 * @param {ResultDetailBase} detail
 * @param {{full?: boolean, fields?: string[]}} [options]
 * @returns {ResultDetailBase}
 */
export function leanResult(detail, { full = false, fields } = {}) {
  if (full || fields) return detail;
  const rest = { ...detail };
  delete rest.narration;
  delete rest.narrationTruncated;
  if (detail.narrationTotalChars === undefined) {
    return {
      ...rest,
      next: `Run taskferry wait with task id "${detail.taskId}" to block until the task settles, then re-run taskferry result`,
    };
  }
  return {
    ...rest,
    next: `Run taskferry result --full or --fields narration with task id "${detail.taskId}" to see intermediate step narration (${detail.narrationTotalChars} chars total)`,
  };
}

/**
 * @typedef {object} ListRowInput
 * @property {string} id
 * @property {string} status
 * @property {string} model
 * @property {string} startedAt
 * @property {string|null} [failureReason]
 */

/**
 * @typedef {{id: string, status: string, model: string, startedAt: string, failureReason?: string}} ListRow
 */

/**
 * @param {ListRowInput} row
 * @returns {ListRow}
 */
function listRow(row) {
  return {
    id: row.id,
    status: row.status,
    model: row.model,
    startedAt: row.startedAt,
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
  };
}

/**
 * @typedef {object} ListValue
 * @property {ListRowInput[] | string} tasks
 * @property {string} [directory]
 * @property {Record<string, number>} [counts]
 */

// Shared by projectList/projectContext: rows the raw task array down to
// `limit`, reporting whether anything was cut off.
/**
 * @param {ListValue} value
 * @param {number | undefined} limit
 * @param {number} defaultLimit
 * @returns {{tasks: ListRow[] | string, truncated: boolean, total: number}}
 */
function limitTasks(value, limit, defaultLimit) {
  let rows;
  if (Array.isArray(value.tasks)) {
    rows = value.tasks.length ? value.tasks.map(listRow) : "none found in this workspace";
  } else {
    rows = value.tasks;
  }
  const total = Array.isArray(rows) ? rows.length : 0;
  const effectiveLimit = limit !== undefined ? limit : defaultLimit;
  const tasks = Array.isArray(rows) ? rows.slice(0, effectiveLimit) : rows;
  const truncated = Array.isArray(tasks) && tasks.length < total;
  return { tasks, truncated, total };
}

const DEFAULT_LIST_LIMIT = 30;

/**
 * @param {ListValue} value
 * @param {{limit?: number}} [options]
 * The declared return is deliberately narrower than Record<string, unknown>:
 * homeView() takes a ListValue, and projectList() always produces one (`tasks`
 * is unconditional below), so erasing that to a bare key bag would break the
 * projectList -> homeView pipeline runHome() depends on.
 * @returns {ListValue & {next?: string[]}}
 */
export function projectList(value, { limit } = {}) {
  const { tasks, truncated, total } = limitTasks(value, limit, DEFAULT_LIST_LIMIT);
  return {
    ...(value.directory ? { directory: value.directory } : {}),
    counts: value.counts,
    tasks,
    ...(truncated ? { next: [`Run taskferry list --limit ${total} for all ${total} tasks`] } : {}),
  };
}

const DEFAULT_CONTEXT_LIMIT = 10;

/**
 * @param {ListValue} value
 * @param {{limit?: number}} [options]
 * @returns {Record<string, unknown>}
 */
export function projectContext(value, { limit } = {}) {
  const { tasks, truncated, total } = limitTasks(value, limit, DEFAULT_CONTEXT_LIMIT);
  return {
    directory: value.directory,
    counts: value.counts,
    tasks,
    ...(truncated ? { next: [`Run taskferry list --limit ${total} for all ${total} tasks`] } : {}),
  };
}

/**
 * @param {ListValue} value
 * @param {{executablePath?: string, workspace?: string}} options
 * @returns {Record<string, unknown>}
 */
export function homeView(value, { executablePath, workspace }) {
  const home = os.homedir();
  const absolutePath = path.resolve(executablePath || process.argv[1] || process.execPath);
  const displayPath = absolutePath === home || absolutePath.startsWith(`${home}${path.sep}`)
    ? `~${absolutePath.slice(home.length)}`
    : absolutePath;
  const allRows = Array.isArray(value.tasks) ? value.tasks : [];
  const total = allRows.length;
  const rows = allRows.slice(0, DEFAULT_LIST_LIMIT);
  const truncated = rows.length < total;
  const next = rows.length
    ? ["Run taskferry status <id> for activity", "Run taskferry wait <id> to wait for settlement", "Run taskferry result <id> for the final answer"]
    : ["Run taskferry dispatch --prompt \"<text>\" to start a task", "Run taskferry list --all to inspect every workspace"];
  return {
    workspace,
    bin: displayPath,
    description: "Manage background OpenCode tasks in the current workspace.",
    counts: value.counts,
    tasks: Array.isArray(value.tasks) ? rows : value.tasks,
    next: truncated ? [...next, `Run taskferry list --limit ${total} for all ${total} tasks`] : next,
  };
}

// computeDoctorStats() reports rates as raw 0..1 floats (or null when there's
// no settled data yet) -- exactly right for a test asserting `0.5`, but
// `0.8419603524229075` next to a dozen other model rows is the single
// biggest readability problem in `doctor --stats` today. Formatted for
// display only; the daemon's own `task.stats` response (and the tested,
// reusable computeDoctorStats()) keep the raw numeric form.
/**
 * @param {number | null | undefined} rate
 * @returns {number | null | string | undefined}
 */
function formatRate(rate) {
  if (rate === null || rate === undefined) return rate;
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * @typedef {object} DoctorStatsEntry
 * @property {string} [model]
 * @property {number} [dispatches]
 * @property {number} [done]
 * @property {number} [crashed]
 * @property {number | null | undefined} [doneRate]
 * @property {number | null | undefined} [crashRate]
 */

/**
 * @typedef {object} DoctorStatsTrendPeriod
 * @property {number | null | undefined} [crashRate]
 */

/**
 * @typedef {object} DoctorStatsTrend
 * @property {DoctorStatsTrendPeriod} [current]
 * @property {DoctorStatsTrendPeriod} [previous]
 * @property {string} [window]
 * @property {string} [direction]
 */

/**
 * @typedef {object} DoctorStatsInput
 * @property {DoctorStatsEntry[]} [byModel]
 * @property {DoctorStatsTrend} [trend]
 * @property {Record<string, unknown>} [statusMix]
 * @property {unknown[]} [failureReasons]
 * @property {unknown} [unknownBacklog]
 * @property {string} [computedAt]
 */

/**
 * @param {DoctorStatsInput | null | undefined} stats
 * @returns {Record<string, unknown>}
 */
export function projectDoctorStats(stats) {
  // Defensive shape guards: a partial / stubbed / version-skewed response
  // (e.g. the fallback path in commands.js's runDoctorStats that aggregates
  // a pre-PR `task.list` on the client side, or any future server-side
  // shape change that lands before the CLI picks it up) should still
  // surface SOMETHING usable rather than throwing a raw TypeError on
  // `stats.byModel.map` or `stats.trend.current`. Coerce the missing bits
  // to their documented empty shapes; the rest of the response
  // (`statusMix`, `failureReasons`, `unknownBacklog`, `computedAt`) is
  // already a pass-through via the `...stats` spread.
  /** @type {Partial<DoctorStatsInput>} */
  const safeStats = stats && typeof stats === "object" ? /** @type {Partial<DoctorStatsInput>} */ (stats) : {};
  /** @type {DoctorStatsEntry[]} */
  const byModel = Array.isArray(safeStats.byModel) ? safeStats.byModel : [];
  /** @type {DoctorStatsTrend} */
  const trend = safeStats.trend && typeof safeStats.trend === "object" ? safeStats.trend : {};
  /** @type {DoctorStatsTrendPeriod} */
  const trendCurrent = trend.current && typeof trend.current === "object" ? trend.current : {};
  /** @type {DoctorStatsTrendPeriod} */
  const trendPrevious = trend.previous && typeof trend.previous === "object" ? trend.previous : {};
  return {
    ...safeStats,
    byModel: byModel.map((entry) => ({ ...entry, doneRate: formatRate(entry.doneRate), crashRate: formatRate(entry.crashRate) })),
    trend: {
      ...trend,
      current: { ...trendCurrent, crashRate: formatRate(trendCurrent.crashRate) },
      previous: { ...trendPrevious, crashRate: formatRate(trendPrevious.crashRate) },
    },
  };
}

/**
 * @param {unknown} occurredAt
 * @returns {string}
 */
function shortTime(occurredAt) {
  const parsed = new Date(/** @type {string | number | Date} */ (occurredAt));
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleTimeString("en-US", { hour12: false });
}

/**
 * @typedef {object} ActivityEvent
 * @property {"task.activity" | "task.state"} type
 * @property {string} taskId
 * @property {string} status
 * @property {string} [previousStatus]
 * @property {string|null|undefined} [activity]
 * @property {boolean} [summaryFailed]
 * @property {string} [summaryError]
 * @property {unknown} [occurredAt]
 */

// A raw task.activity/task.state event carries protocol plumbing (sequence,
// directory, outputWatermark, a previousStatus that's usually null) that's
// noise to a human watching progress at a glance. Collapse each event to one
// line: just the time, the task, and what actually changed.
/**
 * @param {ActivityEvent} event
 * @param {boolean} useColor
 * @returns {string}
 */
function formatActivityLine(event, useColor) {
  const time = shortTime(event.occurredAt);
  const prefix = time ? `${time} ` : "";
  const status = colorize(event.status, colorForStatus(event.status), useColor);
  if (event.type === "task.state") {
    const transition = event.previousStatus && event.previousStatus !== event.status
      ? `${event.previousStatus} -> ${status}`
      : status;
    return `${prefix}${event.taskId} ${transition}`;
  }
  if (event.summaryFailed === true) {
    const reason = typeof event.summaryError === "string" && event.summaryError
      ? event.summaryError.replace(/[\r\n]+/g, " ")
      : "unknown error";
    return `${prefix}${event.taskId} ${status}: summary unavailable (${reason})`;
  }
  const activity = typeof event.activity === "string" && event.activity
    ? event.activity.replace(/[\r\n]+/g, " ")
    : event.status;
  return `${prefix}${event.taskId} ${status}: ${activity}`;
}

/**
 * @param {ActivityEvent | Record<string, unknown>} event
 * @param {string} [format] -- absent unless `--format` was passed; the only
 *   test below is an equality check, so undefined selects the default rendering
 * @param {boolean} [useColor]
 * @returns {string}
 */
export function formatWatchEvent(event, format, useColor = false) {
  if (format === "ndjson") return JSON.stringify(event);
  if (event.type === "task.activity" || event.type === "task.state") {
    return formatActivityLine(/** @type {ActivityEvent} */ (event), useColor);
  }
  return encode(event);
}

/**
 * @param {unknown} context
 * @param {string} [format] -- `--format` has no default, so this is genuinely
 *   absent unless the caller passed one; every branch below is an equality
 *   test, so undefined falls through to the plain `additionalContext` shape.
 * @returns {unknown}
 */
export function contextForHook(context, format) {
  if (format === "toon") return context;
  const additionalContext = encode(context);
  if (format === "claude-hook") {
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } };
  }
  return { additionalContext };
}
