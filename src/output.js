import os from "node:os";
import path from "node:path";
import { encode } from "@toon-format/toon";

const HINT_KEYS = new Set(["help", "next", "note", "message"]);

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
  io.stdout.write(`${encode(migrateHints(value))}\n`);
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
  lean.next = status === "running" || status === "queued"
    ? `Run taskferry wait or taskferry status with task id "${id}" to check progress; pass --full for directory/model/log path details`
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

export function formatWatchEvent(event, format) {
  if (format === "ndjson") return JSON.stringify(event);
  if (format === "claude-monitor") {
    const activity = typeof event.activity === "string" && event.activity ? event.activity : `Task ${event.status}`;
    return `Taskferry(${event.status} · ${event.taskId}): ${activity.replace(/[\r\n]+/g, " ")}`;
  }
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
