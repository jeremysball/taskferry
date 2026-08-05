import os from "node:os";
import path from "node:path";
import { encode } from "@toon-format/toon";

const ANSI_RESET = "\x1b[0m";
const ANSI_BY_STATUS = {
  done: "\x1b[32m", // green
  crashed: "\x1b[31m", // red
  cancelled: "\x1b[31m", // red
  running: "\x1b[33m", // yellow
  queued: "\x1b[33m", // yellow
};

/** Wrap text in an ANSI color code, but only when `enabled` (i.e. the target stream is a TTY). */
export function colorize(text, code, enabled) {
  return enabled && code ? `${code}${text}${ANSI_RESET}` : text;
}

/** @param {string} status */
export function colorForStatus(status) {
  return ANSI_BY_STATUS[status] || null;
}

// Coloring a status field has to happen post-encode: encode() escapes raw ANSI
// bytes embedded in a string value into \u escapes. encode() also reshapes a
// status field's surroundings unpredictably — a uniform tasks[] array collapses
// to a comma-separated tabular block instead of one "status: x" line per item —
// so a fixed line pattern can't find every occurrence. Instead, bracket
// recognized status values in an invisible marker before encoding (encode()
// passes it through unescaped and unquoted in both layouts) and swap the
// marked span for an ANSI-colored one afterward.
const STATUS_MARK = "\u2063";
const STATUS_MARK_RE = new RegExp(`${STATUS_MARK}(\\w+)${STATUS_MARK}`, "g");

export function markStatuses(value) {
  if (Array.isArray(value)) return value.map(markStatuses);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key === "status" && typeof item === "string" && colorForStatus(item)) {
        return [key, `${STATUS_MARK}${item}${STATUS_MARK}`];
      }
      return [key, markStatuses(item)];
    }));
  }
  return value;
}

export function colorizeText(text, useColor) {
  return text.replace(STATUS_MARK_RE, (_, status) => {
    const code = useColor && colorForStatus(status);
    return code ? colorize(status, code, true) : status;
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function writeToon(value, io = process) {
  const useColor = Boolean(io.stdout.isTTY);
  const text = encode(useColor ? markStatuses(value) : value);
  io.stdout.write(`${colorizeText(text, useColor)}\n`);
}

function stripPrefix(line, prefix) {
  return line.startsWith(prefix) ? line.slice(prefix.length).trim() : null;
}

/** @param {unknown} error @param {string|undefined} helpLine */
function errorHelp(error, helpLine) {
  if (error && typeof error === "object" && typeof error.help === "string") return error.help;
  return helpLine || "Retry the command or run `taskferry --help`";
}

// Single pass over `lines`: finds the first `error:`/`help:` line (if any)
// and collects every other line as a detail line. Split out of errorValue()
// so its own branch count stays low.
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

export function errorValue(error) {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split("\n");
  const { errorLine, helpLine, detailLines } = extractErrorParts(lines);
  const primary = errorLine || lines[0] || "taskferry request failed";
  // Detail lines only fold in when we found an `error:` line as the primary,
  // so the plain single-line fallback (no recognized prefixes) keeps
  // returning `lines[0]` unchanged.
  const message = errorLine !== undefined && detailLines.length ? `${primary}\n${detailLines.join("\n")}` : primary;
  const help = errorHelp(error, helpLine);
  return { error: message, help };
}

export function writeError(error, io = process) {
  writeToon(errorValue(error), io);
}

/** @param {{id: string, status: string, directory?: string, sessionId?: string}} detail @param {string} id @param {string} status */
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
 * @param {object} detail
 */
function trimOverlayDirs(detail) {
  if (!detail.overlayDirs) return detail;
  const { root, tmpRoot } = detail.overlayDirs;
  return { ...detail, overlayDirs: { root, tmpRoot } };
}

/**
 * Keep polling output small. Static task metadata is available through
 * `--full`; lifecycle and log activity remain visible on every lookup.
 */
/**
 * Extract the conditional check-gate fields a non-`--full` lean status surfaces
 * when a gate has actually run (status other than "none"). Split out of
 * leanStatus to keep its cyclomatic count under the ceiling once the new
 * fields land.
 * @param {Record<string, unknown>} detail
 * @returns {Record<string, unknown>}
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

export function leanStatus(detail, { full = false } = {}) {
  if (full) return trimOverlayDirs(detail);
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
  lean.next = nextHint(detail, id, status);
  return lean;
}

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

function listRow(row) {
  return {
    id: row.id,
    status: row.status,
    model: row.model,
    startedAt: row.startedAt,
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
  };
}

// Shared by projectList/projectContext: rows the raw task array down to
// `limit`, reporting whether anything was cut off.
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

export function projectContext(value, { limit } = {}) {
  const { tasks, truncated, total } = limitTasks(value, limit, DEFAULT_CONTEXT_LIMIT);
  return {
    directory: value.directory,
    counts: value.counts,
    tasks,
    ...(truncated ? { next: [`Run taskferry list --limit ${total} for all ${total} tasks`] } : {}),
  };
}

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

function shortTime(occurredAt) {
  const parsed = new Date(occurredAt);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleTimeString("en-US", { hour12: false });
}

// A raw task.activity/task.state event carries protocol plumbing (sequence,
// directory, outputWatermark, a previousStatus that's usually null) that's
// noise to a human watching progress at a glance. Collapse each event to one
// line: just the time, the task, and what actually changed.
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

export function formatWatchEvent(event, format, useColor = false) {
  if (format === "ndjson") return JSON.stringify(event);
  if (event.type === "task.activity" || event.type === "task.state") return formatActivityLine(event, useColor);
  return encode(event);
}

export function contextForHook(context, format) {
  if (format === "toon") return context;
  const additionalContext = encode(context);
  if (format === "claude-hook") {
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } };
  }
  return { additionalContext };
}
