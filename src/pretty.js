import pc from "picocolors";
import Table from "cli-table3";

const c = pc.createColors(true);

const STATUS_TONE = { done: c.green, crashed: c.red, cancelled: c.red, running: c.yellow, queued: c.yellow };
const TREND_TONE = { improving: c.green, worsening: c.red, flat: c.gray };

function toneFor(map, key) {
  return map[key] || ((text) => text);
}

const FALLBACK_ENUM_TONES = { status: STATUS_TONE, direction: TREND_TONE };
const FALLBACK_BOOL_KEYS = new Set(["healthy", "installed", "isolated"]);

function colorScalar(key, value) {
  if (typeof value === "string" && FALLBACK_ENUM_TONES[key]) {
    return toneFor(FALLBACK_ENUM_TONES[key], value)(value);
  }
  if (typeof value === "boolean" && FALLBACK_BOOL_KEYS.has(key)) {
    return value ? c.green(String(value)) : c.red(String(value));
  }
  return String(value);
}

function renderScalarField(key, value, indent = "") {
  if (value === undefined) return null;
  const label = c.bold(key);
  if (value === null) return `${indent}${label}  ${c.dim("null")}`;
  if (Array.isArray(value)) return renderArrayField(label, value, indent);
  if (typeof value === "object") return [`${indent}${label}`, renderFallback(value, `${indent}  `)].join("\n");
  return `${indent}${label}  ${colorScalar(key, value)}`;
}

function renderArrayField(label, value, indent) {
  if (!value.length) return `${indent}${label}  ${c.dim("(none)")}`;
  if (value.every((entry) => typeof entry !== "object")) return `${indent}${label}  ${c.dim(value.join(", "))}`;
  return [`${indent}${label}`, ...value.map((entry) => renderFallback(entry, `${indent}  `))].join("\n");
}

function renderFallback(value, indent = "") {
  return Object.entries(value)
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

function renderTaskRows(tasks) {
  const table = borderlessTable();
  for (const task of tasks) {
    const row = [task.id, task.model || "", task.startedAt || ""];
    if (task.failureReason) row.push(c.dim(task.failureReason));
    table.push(row);
  }
  return table.toString().split("\n").map((line) => `  ${line}`).join("\n");
}

function renderHintLines(next) {
  if (Array.isArray(next)) return next.map((hint) => c.dim(hint));
  if (typeof next === "string") return [c.dim(next)];
  return [];
}

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

function checkState(value) {
  if (value === true) return "pass";
  if (value === false) return "fail";
  return "unknown";
}

function checkGlyph(state) {
  if (state === "pass") return c.green("✓");
  if (state === "fail") return c.red("✗");
  return c.dim("?");
}

function checkLine(label, state, note) {
  const suffix = note ? ` ${c.dim(note)}` : "";
  return `${checkGlyph(state)} ${label}${suffix}`;
}

function renderMcpCheckLine(label, check) {
  if (!check) return null;
  if (!check.checked) return checkLine(label, "unknown", check.reason);
  return checkLine(label, checkState(check.isolated), check.isolated ? void 0 : check.path);
}

function renderBulletBlock(title, tone, entries) {
  const lines = ["", tone(c.bold(title))];
  for (const entry of entries) lines.push(`${tone("•")} ${c.dim(entry)}`);
  return lines;
}

function renderMcpIsolationSection(mcp) {
  if (!mcp) return [];
  const lines = ["", c.bold("MCP isolation")];
  const opencodeLine = renderMcpCheckLine("opencode", mcp.opencode);
  const claudeCodeLine = renderMcpCheckLine("claude-code", mcp.claudeCode);
  if (opencodeLine) lines.push(opencodeLine);
  if (claudeCodeLine) lines.push(claudeCodeLine);
  return lines;
}

function renderDoctorExtras(value, lines) {
  const covered = new Set(["healthy", "integrations", "warnings", "info"]);
  const extras = Object.entries(value).filter(([key]) => !covered.has(key));
  if (!extras.length) return;
  lines.push("");
  for (const [key, val] of extras) lines.push(renderScalarField(key, val));
}

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
  renderDoctorExtras(value, lines);
  return lines.join("\n").trimEnd();
}

const STATS_TABLE_COLUMNS = ["model", "dispatches", "done", "crashed", "doneRate", "crashRate"];

function renderByModelTable(byModel) {
  if (!byModel.length) return null;
  const table = borderlessTable();
  table.push(STATS_TABLE_COLUMNS.map((column) => c.dim(column)));
  for (const row of byModel) table.push(STATS_TABLE_COLUMNS.map((column) => (row[column] === null || row[column] === undefined ? c.dim("n/a") : String(row[column]))));
  return ["", c.bold("By model"), table.toString()];
}

function renderTrendSection(trend) {
  if (!trend) return [];
  const tone = toneFor(TREND_TONE, trend.direction);
  const current = trend.current || {};
  const previous = trend.previous || {};
  const summary = `${tone(c.bold(trend.direction || "unknown"))}  ${current.crashRate ?? "n/a"} crash rate now (${current.settled ?? 0} settled) vs ${previous.crashRate ?? "n/a"} previously (${previous.settled ?? 0} settled)`;
  return ["", c.bold(`Trend (${trend.window || "24h"})`), summary];
}

function renderStatusMixSection(statusMix) {
  const overall = statusMix?.overall;
  if (!overall || Object.keys(overall).length === 0) return [];
  const summary = Object.entries(overall).filter(([key]) => key !== "total").map(([key, count]) => `${count} ${key}`).join(" \u00b7 ");
  return ["", c.bold("Status mix (overall)"), c.dim(summary)];
}

function renderFailureReasonsSection(failureReasons) {
  if (!Array.isArray(failureReasons) || !failureReasons.length) return [];
  const lines = ["", c.bold("Top failure reasons")];
  for (const { reason, count } of failureReasons.slice(0, 5)) lines.push(c.dim(`${count}\u00d7 ${reason}`));
  return lines;
}

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

function detectShape(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("tasks" in value && "counts" in value) return "list";
    if (value.integrations && "playwrightMcpIsolation" in value.integrations) return "doctor";
    if ("trend" in value || "byModel" in value) return "stats";
  }
  return "fallback";
}

export function renderPretty(value) {
  if (value === null || typeof value !== "object") return String(value);
  const shape = detectShape(value);
  if (shape === "list") return renderTaskGroups(value);
  if (shape === "doctor") return renderDoctorReport(value);
  if (shape === "stats") return renderStatsReport(value);
  return renderFallback(value);
}
