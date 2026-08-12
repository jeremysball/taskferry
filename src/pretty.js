import pc from "picocolors";
import Table from "cli-table3";

const c = pc.createColors(true);

/** @typedef {(input: string|number|null|undefined) => string} ColorFormatter */

/**
 * @typedef {object} TaskRow
 * @property {string} id
 * @property {string} [status]
 * @property {string} [model]
 * @property {string} [startedAt]
 * @property {string} [failureReason]
 */

/**
 * @typedef {object} TaskGroup
 * @property {string} status
 * @property {TaskRow[]} tasks
 */

/**
 * @typedef {object} McpCheck
 * @property {boolean} [checked]
 * @property {boolean} [isolated]
 * @property {string} [path]
 * @property {string} [reason]
 */

/**
 * @typedef {object} McpIsolation
 * @property {McpCheck} [opencode]
 * @property {McpCheck} [claudeCode]
 */

/**
 * @typedef {object} Integrations
 * @property {{installed?: boolean, reason?: string}} [claude]
 * @property {McpIsolation} [playwrightMcpIsolation]
 */

/**
 * @typedef {object} DoctorReport
 * @property {boolean} [healthy]
 * @property {Integrations} [integrations]
 * @property {string[]} [warnings]
 * @property {string[]} [info]
 * @property {unknown} [pid]
 * @property {unknown} [version]
 */

/**
 * @typedef {object} TrendCurrent
 * @property {string|null} [crashRate]
 * @property {number} [settled]
 */

/**
 * @typedef {object} Trend
 * @property {string} [direction]
 * @property {string} [window]
 * @property {TrendCurrent} [current]
 * @property {TrendCurrent} [previous]
 */

/**
 * @typedef {object} StatusMix
 * @property {Record<string, number>} [overall]
 */

/**
 * @typedef {object} FailureReasonEntry
 * @property {string} reason
 * @property {number} count
 */

/**
 * @typedef {object} UnknownBacklog
 * @property {number} [total]
 * @property {unknown[]} [tasks]
 */

/**
 * @typedef {object} StatsReport
 * @property {Trend} [trend]
 * @property {Array<Record<string, unknown>>} [byModel]
 * @property {StatusMix} [statusMix]
 * @property {FailureReasonEntry[]} [failureReasons]
 * @property {UnknownBacklog} [unknownBacklog]
 */

/**
 * @typedef {{tasks: string|TaskRow[]|undefined, counts?: Record<string, number>, next?: string|string[]|null, [key: string]: unknown}} TaskGroupsValue
 */

/** @type {Record<string, ColorFormatter>} */
const STATUS_TONE = { done: c.green, crashed: c.red, cancelled: c.red, running: c.yellow, queued: c.yellow };
/** @type {Record<string, ColorFormatter>} */
const TREND_TONE = { improving: c.green, worsening: c.red, flat: c.gray };

/**
 * @param {Record<string, ColorFormatter>} map
 * @param {string} key
 * @returns {ColorFormatter}
 */
function toneFor(map, key) {
  return map[key] || ((text) => text);
}

/** @type {Record<string, Record<string, ColorFormatter>>} */
const FALLBACK_ENUM_TONES = { status: STATUS_TONE, direction: TREND_TONE };
const FALLBACK_BOOL_KEYS = new Set(["healthy", "installed", "isolated"]);

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
function colorScalar(key, value) {
  if (typeof value === "string" && FALLBACK_ENUM_TONES[key]) {
    return toneFor(FALLBACK_ENUM_TONES[key], value)(value);
  }
  if (typeof value === "boolean" && FALLBACK_BOOL_KEYS.has(key)) {
    return value ? c.green(String(value)) : c.red(String(value));
  }
  return String(value);
}

/**
 * @param {string} key
 * @param {unknown} value
 * @param {string} [indent]
 * @returns {string|null}
 */
function renderScalarField(key, value, indent = "") {
  if (value === undefined) return null;
  const label = c.bold(key);
  if (value === null) return `${indent}${label}  ${c.dim("null")}`;
  if (Array.isArray(value)) return renderArrayField(label, value, indent);
  if (typeof value === "object") return [`${indent}${label}`, renderFallback(/** @type {Record<string, unknown>} */ (value), `${indent}  `)].join("\n");
  return `${indent}${label}  ${colorScalar(key, value)}`;
}

/**
 * @param {string} label
 * @param {unknown[]} value
 * @param {string} indent
 * @returns {string}
 */
function renderArrayField(label, value, indent) {
  if (!value.length) return `${indent}${label}  ${c.dim("(none)")}`;
  if (value.every((entry) => typeof entry !== "object")) return `${indent}${label}  ${c.dim(value.join(", "))}`;
  return [`${indent}${label}`, ...value.map((entry) => renderFallback(entry, `${indent}  `))].join("\n");
}

/**
 * @param {unknown} value
 * @param {string} [indent]
 * @returns {string}
 */
function renderFallback(value, indent = "") {
  if (value === null || typeof value !== "object") return `${indent}${c.dim(String(value))}`;
  return Object.entries(/** @type {Record<string, unknown>} */ (value))
    .map(([key, val]) => renderScalarField(key, val, indent))
    .filter((line) => line !== null)
    .join("\n");
}

const STATUS_ORDER = ["running", "queued", "done", "crashed", "cancelled"];
const LIST_SHAPE_KEYS = new Set(["tasks", "counts", "next"]);

function borderlessTable() {
  const blank = { top: "", "top-mid": "", "top-left": "", "top-right": "", bottom: "", "bottom-mid": "", "bottom-left": "", "bottom-right": "", left: "", "left-mid": "", mid: "", "mid-mid": "", right: "", "right-mid": "", middle: "  " };
  return new Table({ chars: blank, style: { head: [], border: [], "padding-left": 0, "padding-right": 0 } });
}

/**
 * @param {TaskRow[]} tasks
 * @returns {TaskGroup[]}
 */
function groupTasksByStatus(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const key = task.status || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  const orderedKeys = [...STATUS_ORDER.filter((s) => groups.has(s)), ...[...groups.keys()].filter((s) => !STATUS_ORDER.includes(s)).sort()];
  return orderedKeys.map((status) => ({ status, tasks: groups.get(status) }));
}

/**
 * @param {TaskRow[]} tasks
 * @returns {string}
 */
function renderTaskRows(tasks) {
  const table = borderlessTable();
  for (const task of tasks) {
    const row = [task.id, task.model || "", task.startedAt || ""];
    if (task.failureReason) row.push(c.dim(task.failureReason));
    table.push(row);
  }
  return table.toString().split("\n").map((line) => `  ${line}`).join("\n");
}

/**
 * @param {string|string[]|null|undefined} next
 * @returns {string[]}
 */
function renderHintLines(next) {
  if (Array.isArray(next)) return next.map((hint) => c.dim(hint));
  if (typeof next === "string") return [c.dim(next)];
  return [];
}

/**
 * @param {TaskGroupsValue} value
 * @returns {string}
 */
function renderTaskGroups(value) {
  const lines = Object.entries(value)
    .filter(([key]) => !LIST_SHAPE_KEYS.has(key))
    .map(([key, val]) => renderScalarField(key, val))
    .filter((line) => line !== null);
  if (lines.length) lines.push("");

  if (typeof value.tasks === "string") {
    lines.push(c.dim(value.tasks));
  } else {
    for (const { status, tasks } of groupTasksByStatus(value.tasks || [])) {
      lines.push(`${toneFor(STATUS_TONE, status)(c.bold(status))} (${tasks.length})`);
      lines.push(renderTaskRows(tasks));
      lines.push("");
    }
  }

  if (value.counts) {
    lines.push(c.dim(Object.entries(value.counts).filter(([k]) => k !== "total").map(([k, v]) => `${v} ${k}`).join(" \u00b7 ")));
  }
  lines.push(...renderHintLines(value.next));
  return lines.join("\n").trimEnd();
}

/**
 * @param {unknown} value
 * @returns {"pass"|"fail"|"unknown"}
 */
function checkState(value) {
  if (value === true) return "pass";
  if (value === false) return "fail";
  return "unknown";
}

/**
 * @param {"pass"|"fail"|"unknown"} state
 * @returns {string}
 */
function checkGlyph(state) {
  if (state === "pass") return c.green("✓");
  if (state === "fail") return c.red("✗");
  return c.dim("?");
}

/**
 * @param {string} label
 * @param {"pass"|"fail"|"unknown"} state
 * @param {string} [note]
 * @returns {string}
 */
function checkLine(label, state, note) {
  const suffix = note ? ` ${c.dim(note)}` : "";
  return `${checkGlyph(state)} ${label}${suffix}`;
}

/**
 * @param {string} label
 * @param {McpCheck|undefined|null} check
 * @returns {string|null}
 */
function renderMcpCheckLine(label, check) {
  if (!check) return null;
  if (!check.checked) return checkLine(label, "unknown", check.reason);
  return checkLine(label, checkState(check.isolated), check.isolated ? void 0 : check.path);
}

/**
 * @param {string} title
 * @param {ColorFormatter} tone
 * @param {string[]} entries
 * @returns {string[]}
 */
function renderBulletBlock(title, tone, entries) {
  const lines = ["", tone(c.bold(title))];
  for (const entry of entries) lines.push(`${tone("•")} ${c.dim(entry)}`);
  return lines;
}

/**
 * @param {McpIsolation|undefined|null} mcp
 * @returns {string[]}
 */
function renderMcpIsolationSection(mcp) {
  if (!mcp) return [];
  const lines = ["", c.bold("MCP isolation")];
  const opencodeLine = renderMcpCheckLine("opencode", mcp.opencode);
  const claudeCodeLine = renderMcpCheckLine("claude-code", mcp.claudeCode);
  if (opencodeLine) lines.push(opencodeLine);
  if (claudeCodeLine) lines.push(claudeCodeLine);
  return lines;
}

/**
 * @param {Record<string, unknown>} value
 * @param {string[]} lines
 * @returns {void}
 */
function renderDoctorExtras(value, lines) {
  const covered = new Set(["healthy", "integrations", "warnings", "info"]);
  for (const key of Object.keys(value)) {
    if (covered.has(key)) continue;
    const rendered = renderScalarField(key, value[key]);
    if (rendered !== null) lines.push(rendered);
  }
}

/**
 * @param {DoctorReport} value
 * @returns {string}
 */
function renderDoctorReport(value) {
  const lines = [];
  if (typeof value.healthy === "boolean") {
    lines.push(c.bold("Daemon"), checkLine("healthy", checkState(value.healthy)));
  }
  const claude = value.integrations?.claude;
  if (claude) {
    lines.push("", c.bold("Claude integration"), checkLine("installed", checkState(claude.installed), claude.reason));
  }
  lines.push(...renderMcpIsolationSection(value.integrations?.playwrightMcpIsolation));
  if (Array.isArray(value.warnings) && value.warnings.length) lines.push(...renderBulletBlock("warnings", c.yellow, value.warnings));
  if (Array.isArray(value.info) && value.info.length) lines.push(...renderBulletBlock("info", c.dim, value.info));
  renderDoctorExtras(/** @type {Record<string, unknown>} */ (value), lines);
  return lines.join("\n").trimEnd();
}

const STATS_TABLE_COLUMNS = ["model", "dispatches", "done", "crashed", "doneRate", "crashRate"];

/**
 * @param {Array<Record<string, unknown>>} byModel
 * @returns {string[]|null}
 */
function renderByModelTable(byModel) {
  if (!byModel.length) return null;
  const table = borderlessTable();
  table.push(STATS_TABLE_COLUMNS.map((column) => c.dim(column)));
  for (const row of byModel) table.push(STATS_TABLE_COLUMNS.map((column) => (row[column] === null || row[column] === undefined ? c.dim("n/a") : String(row[column]))));
  return ["", c.bold("By model"), table.toString()];
}

/**
 * @param {Trend|undefined|null} trend
 * @returns {string[]}
 */
function renderTrendSection(trend) {
  if (!trend) return [];
  const direction = trend.direction || "unknown";
  const tone = toneFor(TREND_TONE, direction);
  const current = trend.current || {};
  const previous = trend.previous || {};
  const summary = `${tone(c.bold(direction))}  ${current.crashRate ?? "n/a"} crash rate now (${current.settled ?? 0} settled) vs ${previous.crashRate ?? "n/a"} previously (${previous.settled ?? 0} settled)`;
  return ["", c.bold(`Trend (${trend.window || "24h"})`), summary];
}

/**
 * @param {StatusMix|undefined|null} statusMix
 * @returns {string[]}
 */
function renderStatusMixSection(statusMix) {
  const overall = statusMix?.overall;
  if (!overall || Object.keys(overall).length === 0) return [];
  const summary = Object.entries(overall).filter(([key]) => key !== "total").map(([key, count]) => `${count} ${key}`).join(" \u00b7 ");
  return ["", c.bold("Status mix (overall)"), c.dim(summary)];
}

/**
 * @param {FailureReasonEntry[]|undefined|null} failureReasons
 * @returns {string[]}
 */
function renderFailureReasonsSection(failureReasons) {
  if (!Array.isArray(failureReasons) || !failureReasons.length) return [];
  const lines = ["", c.bold("Top failure reasons")];
  for (const { reason, count } of failureReasons.slice(0, 5)) lines.push(c.dim(`${count}\u00d7 ${reason}`));
  return lines;
}

/**
 * @param {StatsReport} value
 * @returns {string}
 */
function renderStatsReport(value) {
  const lines = [c.bold("doctor --stats")];
  lines.push(...renderTrendSection(value.trend));
  const table = renderByModelTable(Array.isArray(value.byModel) ? value.byModel : []);
  if (table) lines.push(...table);
  lines.push(...renderStatusMixSection(value.statusMix));
  lines.push(...renderFailureReasonsSection(value.failureReasons));
  if (value.unknownBacklog?.total) lines.push("", c.dim(`${value.unknownBacklog.total} task(s) in unknown backlog`));
  return lines.join("\n").trimEnd();
}

/**
 * @param {unknown} value
 * @returns {"list"|"doctor"|"stats"|"fallback"}
 */
function detectShape(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = /** @type {Record<string, unknown>} */ (value);
    if ("tasks" in obj && "counts" in obj) return "list";
    const integrations = /** @type {Record<string, unknown>|undefined} */ (obj.integrations);
    if (integrations && "playwrightMcpIsolation" in integrations) return "doctor";
    if ("trend" in obj || "byModel" in obj) return "stats";
  }
  return "fallback";
}

/**
 * Shape-based TTY renderer. Picks one of four renderers based on the value's
 * top-level shape (`detectShape()`) and dispatches. Falls back to a generic
 * field-by-field renderer for anything that doesn't match a known shape.
 * @param {unknown} value
 * @returns {string}
 */
export function renderPretty(value) {
  if (value === null || typeof value !== "object") return String(value);
  const shape = detectShape(value);
  if (shape === "list") return renderTaskGroups(/** @type {TaskGroupsValue} */ (value));
  if (shape === "doctor") return renderDoctorReport(/** @type {DoctorReport} */ (value));
  if (shape === "stats") return renderStatsReport(/** @type {StatsReport} */ (value));
  return renderFallback(value);
}
