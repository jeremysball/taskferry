import os from "node:os";
import path from "node:path";
import { encode } from "@toon-format/toon";

const HINT_KEYS = new Set(["help", "next", "note", "message"]);

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

function migrateHint(text) {
  return text
    .replaceAll("taskferry_dispatch", "taskferry dispatch")
    .replaceAll("taskferry_cancel", "taskferry cancel")
    .replaceAll("taskferry_poll", "taskferry wait")
    .replaceAll("taskferry_advisor", "taskferry advisor")
    .replaceAll("taskferry_status", "taskferry status")
    .replaceAll("taskferry_tail", "taskferry tail")
    .replaceAll("taskferry_summary", "taskferry summary")
    .replaceAll("taskferry_result", "taskferry result")
    .replaceAll("taskferry_list", "taskferry list")
    .replaceAll("task_id", "task id");
}

function migrateHints(value, key) {
  if (typeof value === "string") return key && HINT_KEYS.has(key) ? migrateHint(value) : value;
  if (Array.isArray(value)) return value.map((item) => migrateHints(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, migrateHints(item, name)]));
  }
  return value;
}

export function writeToon(value, io = process) {
  const useColor = Boolean(io.stdout.isTTY);
  const hinted = migrateHints(value);
  const text = encode(useColor ? markStatuses(hinted) : hinted);
  io.stdout.write(`${colorizeText(text, useColor)}\n`);
}

function stripPrefix(line, prefix) {
  return line.startsWith(prefix) ? line.slice(prefix.length).trim() : null;
}

export function errorValue(error) {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split("\n");
  const message = lines.map((line) => stripPrefix(line, "error:")).find(Boolean) || lines[0] || "taskferry request failed";
  const help = error && typeof error === "object" && typeof error.help === "string"
    ? error.help
    : lines.map((line) => stripPrefix(line, "help:")).find(Boolean) || "Retry the command or run `taskferry --help`";
  if (error && typeof error === "object" && error.name === "UsageError") return { error: message, help };
  return { error: migrateHint(message), help: migrateHint(help) };
}

export function writeError(error, io = process) {
  writeToon(errorValue(error), io);
}

/**
 * Keep polling output small. Static task metadata is available through
 * `--full`; lifecycle and log activity remain visible on every lookup.
 */
export function leanStatus(detail, { full = false } = {}) {
  if (full) return detail;
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
  } = detail;
  const lean = { id, status, startedAt };
  if (status !== "running" && status !== "queued") {
    lean.exitCode = exitCode;
    lean.signal = signal;
  }
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
    lean.note = `wait timed out; the task may still be running. Run taskferry wait again to keep waiting, or pass --timeout-ms to set a longer cap`;
  }
  lean.next = status === "running" || status === "queued"
    ? `Run taskferry wait or taskferry status with task id "${id}" to check progress; pass --full for directory/model/log path details`
    : status === "crashed" && detail.sessionId
      ? `Session ${shellQuote(detail.sessionId)} may be salvageable; resume with taskferry dispatch --session-id ${shellQuote(detail.sessionId)} --directory ${shellQuote(detail.directory)} --prompt "<continuation prompt>"`
      : `Run taskferry result with task id "${id}" to see the final message; pass --full here for directory/model/log path details`;
  return lean;
}

export function leanResult(detail, { full = false, fields } = {}) {
  if (full || fields) return detail;
  const { narration: _narration, narrationTruncated: _narrationTruncated, ...rest } = detail;
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

export function projectList(value, { limit } = {}) {
  const rows = Array.isArray(value.tasks)
    ? (value.tasks.length ? value.tasks.map(listRow) : "none found in this workspace")
    : value.tasks;
  return {
    ...(value.directory ? { directory: value.directory } : {}),
    counts: value.counts,
    tasks: Array.isArray(rows) && limit !== undefined ? rows.slice(0, limit) : rows,
  };
}

export function projectContext(value) {
  return {
    directory: value.directory,
    counts: value.counts,
    tasks: Array.isArray(value.tasks)
      ? (value.tasks.length ? value.tasks.map(listRow) : "none found in this workspace")
      : value.tasks,
  };
}

export function homeView(value, { executablePath, workspace }) {
  const home = os.homedir();
  const absolutePath = path.resolve(executablePath || process.argv[1] || process.execPath);
  const displayPath = absolutePath === home || absolutePath.startsWith(`${home}${path.sep}`)
    ? `~${absolutePath.slice(home.length)}`
    : absolutePath;
  const rows = Array.isArray(value.tasks) ? value.tasks : [];
  return {
    bin: displayPath,
    description: "Manage background OpenCode tasks in the current workspace.",
    workspace,
    counts: value.counts,
    tasks: value.tasks,
    next: rows.length
      ? ["Run taskferry status <id> for activity", "Run taskferry wait <id> to wait for settlement", "Run taskferry result <id> for the final answer"]
      : ["Run taskferry dispatch --prompt \"<text>\" to start a task", "Run taskferry list --all to inspect every workspace"],
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
