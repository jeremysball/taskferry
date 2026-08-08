import { RESULT_FIELDS } from "./protocol.js";
import { UsageError } from "./errors.js";
import { KNOWN_EXECUTORS } from "./executor.js";
import { commandSpecs } from "./command-specs.js";
import { isNonNegativeInteger } from "./numbers.js";

/**
 * @typedef {{
 *   usage: string,
 *   description: string,
 *   options: Record<string, string>,
 *   examples: string[],
 * }} CommandSpec
 */

/** @type {Record<string, CommandSpec>} */
const COMMAND_SPECS = commandSpecs;

const POSITIONAL_TASK_COMMANDS = ["cancel", "wait", "status", "tail", "summary", "result", "accept", "reject"];
const PROMPT_REQUIRED_COMMANDS = ["dispatch"];

export { UsageError };

/**
 * @typedef {{
 *   command: string,
 *   usage: string,
 *   description: string,
 *   commands?: string[],
 *   options: string[] | Record<string, string>,
 *   examples: string[],
 * }} HelpText
 */

/**
 * @typedef {{
 *   command: string,
 *   options: Record<string, unknown>,
 *   help: boolean,
 *   helpText?: HelpText,
 * }} ParseResult
 */

/**
 * @typedef {{
 *   done: true,
 *   result: ParseResult,
 * } | {
 *   done: false,
 *   command: string,
 *   rest: string[],
 * }} ParseHeadResult
 */

/**
 * @typedef {{
 *   command: string,
 *   options: Record<string, unknown>,
 *   seen: Set<string>,
 *   positional: boolean,
 *   help: boolean,
 * }} ParseContext
 */

/**
 * @typedef {{
 *   allow?: string[],
 *   key?: string,
 *   bool?: boolean,
 *   coerce?: (value: string, name: string, command: string) => unknown,
 *   mention?: string,
 *   target?: string,
 * }} FlagDef
 */

/**
 * @param {string} [command]
 * @returns {HelpText}
 */
export function helpText(command) {
  if (!command || !COMMAND_SPECS[command]) {
    return {
      command: "taskferry",
      usage: "taskferry <command> [options]",
      description: "Manage background OpenCode tasks in the current workspace.",
      commands: Object.keys(COMMAND_SPECS),
      options: ["--help", "--version"],
      examples: ["taskferry", "taskferry dispatch --prompt \"Fix the failing tests\"", "taskferry list"],
    };
  }
  const spec = COMMAND_SPECS[command];
  return { command, usage: spec.usage, description: spec.description, options: spec.options, examples: spec.examples };
}

/**
 * @param {string} message
 * @param {string} [command]
 * @returns {UsageError}
 */
function usageError(message, command) {
  if (command && COMMAND_SPECS[command]) {
    const validFlags = Object.keys(COMMAND_SPECS[command].options).join(", ") || "none";
    return new UsageError(message, `Valid flags for ${command}: ${validFlags}. Run \`taskferry ${command} --help\` for details`);
  }
  return new UsageError(message, "Run `taskferry --help` for usage");
}

/**
 * @param {string} name
 * @param {string[]} args
 * @returns {UsageError}
 */
function migrationError(name, args) {
  const received = args.length ? ` (received ${args.join(" ")})` : "";
  /** @type {Record<string, string>} */
  const migrations = {
    taskferry_dispatch: `Use: taskferry dispatch --prompt "<text>"${received}`,
    taskferry_cancel: "Use: taskferry cancel <id>",
    taskferry_poll: `Use: taskferry wait ${args[0] || "<id>"}`,
    taskferry_advisor: "Use: taskferry advisor --model <id>  (--prompt is optional)",
    taskferry_status: "Use: taskferry status <id>",
    taskferry_tail: "Use: taskferry tail <id>",
    taskferry_summary: "Use: taskferry summary <id>",
    taskferry_result: "Use: taskferry result <id>",
    taskferry_list: "Use: taskferry list",
  };
  return new UsageError(`${name} is an MCP tool name and is no longer a command`, migrations[name] || "Run `taskferry --help` for the AXI CLI commands");
}

/**
 * @param {string} value
 * @param {string} flag
 * @param {{min?: number, max?: number}} [opts]
 * @returns {number}
 */
function parseNumber(value, flag, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!/^\d+$/.test(value)) throw new UsageError(`${flag} must be an integer`, `Use ${flag} with a number from ${min} through ${max}`);
  const number = Number(value);
  if (!isNonNegativeInteger(number) || number < min || number > max) {
    let qualifier;
    if (min !== 1) {
      qualifier = `from ${min} through ${max}`;
    } else if (number > max) {
      qualifier = `a positive integer from ${min} through ${max}`;
    } else {
      qualifier = "a positive integer";
    }
    throw new UsageError(`${flag} must be ${qualifier}`, `Use ${flag} with a number from ${min} through ${max}`);
  }
  return number;
}

// Node's setTimeout silently clamps any delay above 2^31-1 ms (~24.8 days)
// down to 1ms, so a "parses fine" duration string would silently fire the
// wait timer after ~1ms instead of the requested duration. Reject upfront
// with a clear message instead of inheriting Node's vague overflow warning.
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_HUMAN = `${MAX_TIMEOUT_MS} milliseconds (about 24 days)`;
const DURATION_UNITS_MS = { s: 1000, m: 60_000, h: 3_600_000 };
/** @type {Record<string, number>} */
const DURATION_UNITS = DURATION_UNITS_MS;
/**
 * @param {string} value
 * @param {string} flag
 * @returns {number}
 */
function parseDuration(value, flag) {
  const remediation = `Use ${flag} with milliseconds (e.g. 10000) or a duration string (e.g. 30s, 5m, 1h); values must not exceed ${MAX_TIMEOUT_HUMAN}, the maximum Node's setTimeout supports`;
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    if (!Number.isSafeInteger(ms)) throw new UsageError(`${flag} is not a valid integer`, remediation);
    if (ms > MAX_TIMEOUT_MS) throw new UsageError(`${flag} must not exceed ${MAX_TIMEOUT_HUMAN}`, remediation);
    return ms;
  }
  const match = /^(\d+)([smh])$/.exec(value);
  if (!match) throw new UsageError(`${flag} must be milliseconds or a duration like 30s, 5m, 1h`, remediation);
  const ms = Number(match[1]) * DURATION_UNITS[match[2]];
  if (!Number.isSafeInteger(ms) || ms > MAX_TIMEOUT_MS) throw new UsageError(`${flag} must not exceed ${MAX_TIMEOUT_HUMAN}`, remediation);
  return ms;
}

/**
 * @param {string[]} argv
 * @param {number} index
 * @param {string} flag
 * @param {string|undefined} inlineValue
 * @returns {{value: string, nextIndex: number}}
 */
function requireValue(argv, index, flag, inlineValue) {
  if (inlineValue !== undefined) {
    if (!inlineValue) throw new UsageError(`${flag} requires a non-empty value`, `Run ${flag} with a value`);
    return { value: inlineValue, nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} requires a value`, `Run ${flag} with a value`);
  if (!value) throw new UsageError(`${flag} requires a non-empty value`, `Run ${flag} with a value`);
  return { value, nextIndex: index + 1 };
}

/**
 * @param {Record<string, unknown>} options
 * @param {string} name
 * @param {unknown} value
 * @param {string} command
 * @param {Set<string>} seen
 */
function setOption(options, name, value, command, seen) {
  if (seen.has(name)) throw usageError(`duplicate flag ${name}`, command);
  seen.add(name);
  options[name] = value;
}

/**
 * @param {string} token
 * @returns {{name: string, inlineValue: string|undefined}}
 */
function parseLongFlag(token) {
  const equals = token.indexOf("=");
  return equals === -1 ? { name: token, inlineValue: void 0 } : { name: token.slice(0, equals), inlineValue: token.slice(equals + 1) };
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function parseFields(value) {
  const fields = value.split(",").map((field) => field.trim()).filter(Boolean);
  if (!fields.length || fields.some((field) => !RESULT_FIELDS.has(field))) {
    throw new UsageError("--fields must contain one or more supported result fields", `Use one of: ${[...RESULT_FIELDS].join(", ")}`);
  }
  return fields;
}

// The key a flag definition writes to: its explicit `key` when the flag
// renames or camelCases its name, otherwise the flag name itself with the
// leading `--` and any `-word` hyphenation collapsed to camelCase.
/**
 * @param {string} flagName
 * @param {FlagDef} def
 * @returns {string}
 */
function flagKeyName(flagName, def) {
  return def.key ?? flagName.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

// Every flag command allows gets its default here: bare booleans default
// false, everything else defaults to undefined (omitted from the RPC
// payload -- see isSet() in commands.js) until the caller sets it. Derived
// from FLAGS' own per-command allow-lists so a command's default-option
// shape can't drift out of sync with which flags it actually accepts.
// Migration-only entries (no `allow`) are never a real command's default.
/**
 * @param {string} command
 * @returns {Record<string, unknown>}
 */
function flagDefaultsFor(command) {
  /** @type {Record<string, unknown>} */
  const defaults = {};
  for (const [flagName, def] of Object.entries(FLAGS)) {
    if (def.mention || !def.allow?.includes(command)) continue;
    defaults[flagKeyName(flagName, def)] = def.bool ? false : void 0;
  }
  return defaults;
}

// Fields FLAGS can't express (the positional task id, and defaults that
// aren't simply false/undefined) are layered on top of the derived shape.
/** @type {Record<string, (cwd: string) => Record<string, unknown>>} */
const DEFAULT_OPTIONS = {
  dispatch: (c) => ({ ...flagDefaultsFor("dispatch"), directory: c }),
  advisor: () => flagDefaultsFor("advisor"),
  cancel: () => ({ taskId: void 0, ...flagDefaultsFor("cancel") }),
  wait: () => ({ taskId: void 0, ...flagDefaultsFor("wait") }),
  status: () => ({ taskId: void 0, ...flagDefaultsFor("status") }),
  tail: () => ({ taskId: void 0, ...flagDefaultsFor("tail") }),
  summary: () => ({ taskId: void 0, ...flagDefaultsFor("summary"), mode: "report" }),
  result: () => ({ taskId: void 0, ...flagDefaultsFor("result") }),
  accept: () => ({ taskId: void 0, ...flagDefaultsFor("accept") }),
  reject: () => ({ taskId: void 0 }),
  list: () => flagDefaultsFor("list"),
  watch: () => ({ ...flagDefaultsFor("watch"), format: "toon", taskId: void 0 }),
  context: () => ({ ...flagDefaultsFor("context"), format: "toon" }),
  doctor: () => flagDefaultsFor("doctor"),
  setup: () => ({}),
  init: () => ({}),
};

/**
 * @param {string} command
 * @param {string} cwd
 * @returns {Record<string, unknown>}
 */
function defaultOptions(command, cwd) {
  const factory = DEFAULT_OPTIONS[command];
  return factory ? factory(cwd) : {};
}

/**
 * @param {string} value
 * @param {string} _name
 * @returns {string[]}
 */
function coerceAllowedDirs(value, _name) {
  const dirs = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!dirs.length) throw new UsageError("--allowed-dirs must contain at least one path", "Use --allowed-dirs with one or more comma-separated paths");
  return dirs;
}

/**
 * @param {string} value
 * @param {string} name
 * @param {string} command
 * @returns {string}
 */
function coerceFormat(value, name, command) {
  const allowed = command === "watch" ? ["toon", "ndjson"] : ["toon", "claude-hook", "codex-hook"];
  if (!allowed.includes(value)) throw new UsageError(`${name} must be one of ${allowed.join(", ")}`, `Use ${name} with one of: ${allowed.join(", ")}`);
  return value;
}

/**
 * @param {string} value
 * @param {string} name
 * @returns {string}
 */
function coerceMode(value, name) {
  if (!["report", "activity"].includes(value)) throw new UsageError(`${name} must be one of report, activity`, "Use --mode report or --mode activity");
  return value;
}

/**
 * @param {string} value
 * @param {string} name
 * @returns {string}
 */
function coerceExecutor(value, name) {
  if (!KNOWN_EXECUTORS.includes(value)) throw new UsageError(`${name} must be one of ${KNOWN_EXECUTORS.join(", ")}`, `Use --executor ${KNOWN_EXECUTORS.join(" or --executor ")}`);
  return value;
}

/**
 * @param {string} value
 * @param {string} name
 * @returns {string}
 */
function coerceFinalMarker(value, name) {
  try {
    new RegExp(value);
  } catch (err) {
    throw new UsageError(`${name} is not a valid RegExp: ${err instanceof Error ? err.message : String(err)}`, "Use --require-final-marker with a pattern that compiles as a standard JS RegExp");
  }
  return value;
}

// Every flag in one table: the commands that allow it, whether it is a bare
// boolean, the option key it writes, an optional value coercer, and (for
// retired MCP-era names) a rename hint plus the flag the hint points at.
/** @type {Record<string, FlagDef>} */
const FLAGS = {
  "--prompt": { allow: ["dispatch", "advisor"], key: "prompt" },
  "--directory": { allow: ["dispatch", "advisor", "list", "watch", "context"], key: "directory" },
  "--model": { allow: ["dispatch", "advisor"], key: "model" },
  "--variant": { allow: ["dispatch", "advisor"], key: "variant" },
  "--session-id": { allow: ["dispatch", "advisor"], key: "sessionId" },
  "--require-final-marker": { allow: ["dispatch"], key: "finalMarker", coerce: coerceFinalMarker },
  "--allowed-dirs": { allow: ["dispatch"], key: "allowedDirs", coerce: coerceAllowedDirs },
  "--executor": { allow: ["dispatch", "advisor"], key: "executor", coerce: coerceExecutor },
  "--class": { allow: ["dispatch", "advisor"], key: "class" },
  "--parent-task": { allow: ["dispatch", "advisor"], key: "parentTaskId" },
  "--grace-ms": { allow: ["cancel"], key: "graceMs", coerce: (v, n) => parseNumber(v, n, { min: 0 }) },
  "--timeout": { allow: ["wait", "advisor"], key: "timeoutMs", coerce: (v, n) => parseDuration(v, n) },
  "--tail-chars": { allow: ["wait"], key: "tailChars", coerce: (v, n) => parseNumber(v, n, { min: 1, max: 65536 }) },
  "--chars": { allow: ["tail"], key: "chars", coerce: (v, n) => parseNumber(v, n, { min: 1, max: 131072 }) },
  "--mode": { allow: ["summary"], key: "mode", coerce: coerceMode },
  "--max-words": { allow: ["summary"], key: "maxWords", coerce: (v, n) => parseNumber(v, n, { min: 75, max: 300 }) },
  "--fields": { allow: ["result"], key: "fields", coerce: parseFields },
  "--limit": { allow: ["list"], key: "limit", coerce: (v, n) => parseNumber(v, n, { min: 1 }) },
  "--format": { allow: ["watch", "context"], key: "format", coerce: coerceFormat },
  "--task-id": { allow: ["watch"], key: "taskId", mention: "--task-id was replaced by the positional task id; use `taskferry status <id>`" },
  "--flush-interval": { allow: ["watch"], key: "flushIntervalMs", coerce: (v, n) => parseDuration(v, n) },
  "--full": { allow: ["wait", "status", "result", "doctor"], bool: true },
  "--all": { allow: ["list", "watch"], bool: true },
  "--wait": { allow: ["summary"], bool: true },
  "--summaries": { allow: ["watch"], bool: true },
  "--summarize": { allow: ["wait"], bool: true },
  "--summarize-context": { allow: ["advisor"], bool: true, key: "summarizeContext" },
  "--stats": { allow: ["doctor"], bool: true },
  "--no-sandbox": { allow: ["dispatch"], bool: true, key: "noSandbox" },
  "--no-overlay": { allow: ["dispatch"], bool: true, key: "noOverlay" }, // advisor deliberately excluded -- review finding #5
  "--force": { allow: ["accept"], bool: true },
  "--diff": { allow: ["result"], bool: true },
  "--timeout_ms": { mention: "--timeout_ms was renamed; use --timeout", target: "--timeout" },
  "--timeout-ms": { mention: "--timeout-ms was renamed; use --timeout", target: "--timeout" },
  "--tail_chars": { mention: "--tail_chars was renamed; use --tail-chars" },
  "--max_words": { mention: "--max_words was renamed; use --max-words" },
  "--session_id": { mention: "--session_id was renamed; use --session-id" },
  "--style": { mention: "--style was renamed; use --mode" },
};

// A subset of migration flags point at a target that isn't a valid flag on
// every command (e.g. --timeout only exists on wait/advisor). For those, only
// emit the "use <target>" hint when the current command actually accepts the
// target -- otherwise the hint itself triggers a second "unknown flag" error.
/**
 * @param {string} command
 * @param {string} flag
 * @returns {boolean}
 */
function commandAllows(command, flag) {
  return FLAGS[flag]?.allow?.includes(command) === true;
}

/**
 * @param {ParseContext} ctx
 * @param {string} name
 * @returns {never}
 */
function throwUnknown(ctx, name) {
  throw usageError(`unknown flag ${name} for \`${ctx.command}\``, ctx.command);
}

/**
 * @param {ParseContext} ctx
 * @param {string} name
 * @param {FlagDef} def
 * @returns {boolean}
 */
function isMigration(ctx, name, def) {
  return Boolean(def.mention && !(name === "--task-id" && ctx.command === "watch"));
}

/**
 * @param {ParseContext} ctx
 * @param {string} name
 * @param {FlagDef} def
 * @returns {never}
 */
function handleMigrationFlag(ctx, name, def) {
  if (def.target && !commandAllows(ctx.command, def.target)) throwUnknown(ctx, name);
  throw new UsageError(`unknown flag ${name} for \`${ctx.command}\``, def.mention);
}

/**
 * @param {ParseContext} ctx
 * @param {string} name
 * @param {FlagDef} def
 * @param {string|undefined} inlineValue
 * @param {number} index
 * @returns {number}
 */
function handleBooleanFlag(ctx, name, def, inlineValue, index) {
  if (inlineValue !== undefined) throw usageError(`${name} does not take a value`, ctx.command);
  setOption(ctx.options, flagKeyName(name, def), true, ctx.command, ctx.seen);
  return index + 1;
}

/**
 * @param {ParseContext} ctx
 * @param {string} name
 * @param {FlagDef} def
 * @param {{value: string, nextIndex: number}} required
 * @returns {number}
 */
function handleValueFlag(ctx, name, def, required) {
  const value = def.coerce ? def.coerce(required.value, name, ctx.command) : required.value;
  setOption(ctx.options, def.key ?? flagKeyName(name, def), value, ctx.command, ctx.seen);
  return required.nextIndex + 1;
}

/**
 * @param {ParseContext} ctx
 * @param {string[]} rest
 * @param {number} index
 * @param {string} token
 * @returns {number}
 */
function consumeFlag(ctx, rest, index, token) {
  const { name, inlineValue } = parseLongFlag(token);
  const def = FLAGS[name];
  if (!def) throwUnknown(ctx, name);
  if (isMigration(ctx, name, def)) return handleMigrationFlag(ctx, name, def);
  if (!def.allow?.includes(ctx.command)) throwUnknown(ctx, name);
  if (def.bool) return handleBooleanFlag(ctx, name, def, inlineValue, index);
  const required = requireValue(rest, index, name, inlineValue);
  return handleValueFlag(ctx, name, def, required);
}

/**
 * @param {ParseContext} ctx
 * @param {string} token
 */
function handlePositional(ctx, token) {
  const { command, options } = ctx;
  if (ctx.positional) throw usageError(`unexpected argument: ${token}`, command);
  if (!POSITIONAL_TASK_COMMANDS.includes(command)) throw usageError(`unexpected argument: ${token}`, command);
  options.taskId = token;
  ctx.positional = true;
}

/**
 * @param {string[]} argv
 * @returns {ParseResult}
 */
function helpHome(argv) {
  if (argv.length > 1) throw usageError(`unexpected argument: ${argv[1]}`);
  return { command: "home", options: { directory: void 0 }, help: true, helpText: helpText() };
}

/**
 * @param {string[]} argv
 * @returns {ParseResult}
 */
function versionResult(argv) {
  if (argv.length > 1) throw usageError(`unexpected argument: ${argv[1]}`);
  return { command: "version", options: {}, help: false };
}

// Fast-path returns described by { done: true, result } (home/version/show
// help), otherwise { done: false, command, rest } once the command is known.
/**
 * @param {string[]} argv
 * @returns {ParseHeadResult}
 */
function parseHead(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  if (argv.length === 0) return { done: true, result: { command: "home", options: { directory: void 0 }, help: false, helpText: helpText() } };
  const first = argv[0];
  if (first === "--help" || first === "-h") return { done: true, result: helpHome(argv) };
  if (first === "--version" || first === "-V") return { done: true, result: versionResult(argv) };
  if (first.startsWith("taskferry_")) throw migrationError(first, argv.slice(1));
  if (first === "poll") throw new UsageError("poll was renamed to wait", "Use `taskferry wait <id>`");
  if (!COMMAND_SPECS[first]) throw new UsageError(`unknown command: ${first}`, "Run `taskferry --help` to see available commands");
  return { done: false, command: first, rest: argv.slice(1) };
}

// `--all` (list and watch) drops the directory scope entirely -- see every
// task/event regardless of which workspace dispatched it. Combining it with
// an explicit `--directory` (or, for watch, `--task-id`) is a contradiction
// the caller almost certainly didn't intend, so it's rejected rather than
// silently letting one option win.
/**
 * @param {ParseContext} ctx
 */
function applyAllFlag({ command, options, seen }) {
  if (!["list", "watch"].includes(command)) return;
  if (options.all && seen.has("directory")) throw usageError("--all cannot be combined with --directory", command);
  if (command === "watch" && options.all && seen.has("taskId")) throw usageError("--all cannot be combined with --task-id", command);
  if (options.all) options.directory = void 0;
}

/**
 * @param {string} command
 * @param {Record<string, unknown>} options
 */
function validateResult(command, options) {
  if (command !== "result") return;
  if (options.full && options.fields && !/** @type {string[]} */ (options.fields).includes("narration")) throw usageError("--full requires narration in --fields", command);
  if (options.diff && options.fields) throw usageError("--diff cannot be combined with --fields", command);
  if (options.diff && options.full) {
    // --full server-side only widens the narration preview; the diff field
    // is independent and gated by `fields: ["diff"]` (--diff takes that
    // route). Combining them would either silently drop --full (the
    // pre-fix if/else-if in commands.js) or send both and have the
    // projection throw away one -- either way a confusing user experience.
    // Reject at parse time so the failure is loud and early.
    throw usageError("--diff cannot be combined with --full", command);
  }
}

/**
 * @param {string} command
 * @param {Record<string, unknown>} options
 */
function validateWait(command, options) {
  if (command !== "wait") return;
  if (options.summarize && options.timeoutMs !== undefined) throw usageError("--summarize cannot be combined with --timeout", command);
  if (options.summarize && options.tailChars !== undefined) throw usageError("--summarize cannot be combined with --tail-chars", command);
}

/**
 * @param {string} command
 * @param {Record<string, unknown>} options
 */
function validateWatch(command, options) {
  if (command !== "watch") return;
  if (options.flushIntervalMs !== undefined && !options.summaries) throw usageError("--flush-interval requires --summaries", command);
  // A zero-length flush interval is meaningless (it would either flush
  // every event individually -- defeating the batching -- or fall back
  // silently to per-event streaming via the streamTaskEvents truthy check).
  if (options.flushIntervalMs === 0) throw usageError("--flush-interval must be greater than zero", command);
}

/**
 * @param {string} command
 * @param {Record<string, unknown>} options
 */
function validateDoctor(command, options) {
  if (command !== "doctor") return;
  if (options.stats && options.full) throw usageError("--stats cannot be combined with --full", command);
}

/**
 * @param {string} command
 * @param {Record<string, unknown>} options
 */
function validateCommand(command, options) {
  if (POSITIONAL_TASK_COMMANDS.includes(command) && !options.taskId) throw usageError("task id is required", command);
  if (PROMPT_REQUIRED_COMMANDS.includes(command) && !options.prompt) throw usageError("--prompt is required", command);
  if (command === "advisor" && !options.model) throw usageError("--model is required", command);
  validateResult(command, options);
  validateWait(command, options);
  validateWatch(command, options);
  validateDoctor(command, options);
}

/**
 * @param {string[]} argv
 * @param {{cwd?: string}} [opts]
 * @returns {ParseResult}
 */
export function parseArgs(argv, { cwd = process.cwd() } = {}) {
  const head = parseHead(argv);
  if (head.done) return head.result;
  const { command, rest } = head;
  const ctx = { command, options: defaultOptions(command, cwd), seen: new Set(), positional: false, help: false };
  let index = 0;
  while (index < rest.length) {
    const token = rest[index];
    if (token === "--help" || token === "-h") {
      ctx.help = true;
      index += 1;
    } else if (!token.startsWith("-")) {
      handlePositional(ctx, token);
      index += 1;
    } else if (!token.startsWith("--")) {
      throw usageError(`unknown flag ${token} for \`${command}\``, command);
    } else {
      index = consumeFlag(ctx, rest, index, token);
    }
  }
  applyAllFlag(ctx);
  if (!ctx.help) validateCommand(command, ctx.options);
  return { command, options: ctx.options, help: ctx.help, ...(ctx.help ? { helpText: helpText(command) } : {}) };
}
