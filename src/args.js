import { RESULT_FIELDS } from "./protocol.js";
import { UsageError } from "./errors.js";
import { KNOWN_EXECUTORS } from "./executor.js";

const commandSpecs = {
  dispatch: {
    usage: "taskferry dispatch --prompt <text> [options]",
    description: "Queue a background OpenCode run.",
    options: {
      "--prompt <text>": "required",
      "--directory <path>": "defaults to the current workspace",
      "--model <id>": "use the default model when omitted",
      "--variant <name>": "optional model reasoning variant",
      "--session-id <id>": "resume an existing OpenCode session",
      "--key-slot <name>": "use a configured provider key slot",
      "--require-final-marker <regex>": "flag the task as incomplete if the final message doesn't match this pattern (case-sensitive, standard JS RegExp semantics)",
      "--no-sandbox": "run this dispatch without the bwrap filesystem sandbox (default: sandboxed on Linux)",
      "--allowed-dirs <path,path,...>": "extra directories bound read-write inside the sandbox, in addition to the auto-detected git-common-dir for a worktree",
      "--executor <opencode|pi>": "worker backend to dispatch through, default pi",
    },
    examples: [
      'taskferry dispatch --prompt "Fix the failing tests"',
      'taskferry dispatch --prompt "Review this change" --model openai/gpt-5.6-sol',
      'taskferry dispatch --prompt "Investigate" --require-final-marker "^Status: (DONE|DONE_WITH_CONCERNS|BLOCKED)$"',
      'taskferry dispatch --prompt "Run one-off shell tooling" --no-sandbox',
      'taskferry dispatch --prompt "Update the shared cache dir" --allowed-dirs /home/user/.cache/myapp',
    ],
  },
  cancel: {
    usage: "taskferry cancel <id> [--grace-ms <number>]",
    description: "Cancel queued or running work.",
    options: { "--grace-ms <number>": "milliseconds before SIGKILL, default 5000" },
    examples: ['taskferry cancel <id>', 'taskferry cancel <id> --grace-ms 10000'],
  },
  wait: {
    usage: "taskferry wait <id> [options]",
    description: "Wait for a task to settle or return its current status after a timeout.",
    options: {
      "--timeout <duration>": "maximum wait, e.g. 10000 (ms), 30s, 5m, 1h",
      "--tail-chars <number>": "include this many trailing text characters on timeout",
      "--full": "include directory, model, and log details",
      "--summarize": "print periodic live summaries while waiting; exits when the task settles",
    },
    examples: ['taskferry wait <id>', 'taskferry wait <id> --timeout 10s --tail-chars 1000', 'taskferry wait <id> --summarize'],
  },
  advisor: {
    usage: "taskferry advisor --prompt <text> --model <id> [options]",
    description: "Ask a model for advice and wait for its response.",
    options: {
      "--prompt <text>": "required",
      "--model <id>": "required",
      "--directory <path>": "defaults to the current workspace",
      "--variant <name>": "optional model reasoning variant",
      "--session-id <id>": "continue a recent advisor session",
      "--timeout <duration>": "maximum wait, e.g. 10000 (ms), 30s, 5m, 1h",
      "--executor <opencode|pi>": "worker backend to dispatch through, default pi",
    },
    examples: [
      'taskferry advisor --prompt "How should I split this module?" --model openai/gpt-5.6-sol',
      'taskferry advisor --prompt "Review this design" --model zai/glm-5.2 --timeout 30s',
    ],
  },
  status: {
    usage: "taskferry status <id> [--full]",
    description: "Inspect task lifecycle and log activity.",
    options: { "--full": "include all recorded task details" },
    examples: ['taskferry status <id>', 'taskferry status <id> --full'],
  },
  tail: {
    usage: "taskferry tail <id> [--chars <number>]",
    description: "Read the latest model text for a task.",
    options: { "--chars <number>": "characters to return, default 1000, maximum 65536" },
    examples: ['taskferry tail <id>', 'taskferry tail <id> --chars 2000'],
  },
  summary: {
    usage: "taskferry summary <id> [options]",
    description: "Create a bounded report or activity summary for a task.",
    options: {
      "--mode report|activity": "summary mode, default report",
      "--max-words <number>": "target length from 75 through 300",
      "--wait": "wait for active work before summarizing",
    },
    examples: ['taskferry summary <id>', 'taskferry summary <id> --mode activity --wait'],
  },
  result: {
    usage: "taskferry result <id> [options]",
    description: "Read the final model result for a task.",
    options: {
      "--full": "include untruncated narration",
      "--fields <comma-list>": "request selected result fields",
    },
    examples: ['taskferry result <id>', 'taskferry result <id> --full', 'taskferry result <id> --fields message,tokens'],
  },
  list: {
    usage: "taskferry list [options]",
    description: "List tasks scoped to a workspace, newest first.",
    options: {
      "--directory <path>": "workspace to inspect, defaults to the current workspace",
      "--all": "include tasks from every workspace",
      "--limit <number>": "limit displayed rows while preserving counts",
    },
    examples: ['taskferry list', 'taskferry list --limit 20', 'taskferry list --all'],
  },
  watch: {
    usage: "taskferry watch [options]",
    description: "Stream task state events for a workspace.",
    options: {
      "--directory <path>": "workspace to watch, defaults to the current workspace",
      "--task-id <id>": "scope the stream to one task; exits automatically once it settles",
      "--format toon|ndjson": "stream format, default toon",
      "--summaries": "request activity summaries when available",
      "--flush-interval <duration>": "batch events and print them together on this interval, e.g. 30s, 5m, 1h; requires --summaries",
    },
    examples: ['taskferry watch', 'taskferry watch --task-id <id> --summaries', 'taskferry watch --format ndjson', 'taskferry watch --summaries --flush-interval 5m'],
  },
  context: {
    usage: "taskferry context [options]",
    description: "Print compact current-workspace context for an agent hook.",
    options: {
      "--directory <path>": "workspace to inspect, defaults to the current workspace",
      "--format toon|claude-hook|codex-hook": "context format, default toon",
    },
    examples: ['taskferry context', 'taskferry context --format claude-hook', 'taskferry context --format codex-hook'],
  },
  doctor: {
    usage: "taskferry doctor [--full]",
    description: "Check daemon health and installation details.",
    options: { "--full": "include complete health details" },
    examples: ['taskferry doctor', 'taskferry doctor --full'],
  },
  setup: {
    usage: "taskferry setup",
    description: "Install dependencies and create the CLI and OpenCode plugin symlinks without contacting the daemon.",
    options: {},
    examples: ['taskferry setup', 'node src/cli.js setup'],
  },
};

export { UsageError };

export function helpText(command) {
  if (!command || !commandSpecs[command]) {
    return {
      command: "taskferry",
      usage: "taskferry <command> [options]",
      description: "Manage background OpenCode tasks in the current workspace.",
      commands: Object.keys(commandSpecs),
      options: ["--help", "--version"],
      examples: ["taskferry", "taskferry dispatch --prompt \"Fix the failing tests\"", "taskferry list"],
    };
  }
  const spec = commandSpecs[command];
  return {
    command,
    usage: spec.usage,
    description: spec.description,
    options: spec.options,
    examples: spec.examples,
  };
}

function usageError(message, command) {
  if (command && commandSpecs[command]) {
    const validFlags = Object.keys(commandSpecs[command].options).join(", ") || "none";
    return new UsageError(message, `Valid flags for ${command}: ${validFlags}. Run \`taskferry ${command} --help\` for details`);
  }
  const help = "Run `taskferry --help` for usage";
  return new UsageError(message, help);
}

function migrationError(name, args) {
  const migrations = {
    taskferry_dispatch: `Use: taskferry dispatch --prompt "<text>"${args.length ? ` (received ${args.join(" ")})` : ""}`,
    taskferry_cancel: "Use: taskferry cancel <id>",
    taskferry_poll: `Use: taskferry wait ${args[0] || "<id>"}`,
    taskferry_advisor: "Use: taskferry advisor --prompt \"<text>\" --model <id>",
    taskferry_status: "Use: taskferry status <id>",
    taskferry_tail: "Use: taskferry tail <id>",
    taskferry_summary: "Use: taskferry summary <id>",
    taskferry_result: "Use: taskferry result <id>",
    taskferry_list: "Use: taskferry list",
  };
  return new UsageError(`${name} is an MCP tool name and is no longer a command`, migrations[name] || "Run `taskferry --help` for the AXI CLI commands");
}

function parseNumber(value, flag, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!/^\d+$/.test(value)) throw new UsageError(`${flag} must be an integer`, `Use ${flag} with a number from ${min} through ${max}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    const qualifier = min === 1 ? "a positive integer" : `from ${min} through ${max}`;
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

function parseDuration(value, flag) {
  const remediation = `Use ${flag} with milliseconds (e.g. 10000) or a duration string (e.g. 30s, 5m, 1h); values must not exceed ${MAX_TIMEOUT_HUMAN}, the maximum Node's setTimeout supports`;
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    if (!Number.isSafeInteger(ms)) throw new UsageError(`${flag} is not a valid integer`, remediation);
    if (ms > MAX_TIMEOUT_MS) throw new UsageError(`${flag} must not exceed ${MAX_TIMEOUT_HUMAN}`, remediation);
    return ms;
  }
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match) throw new UsageError(`${flag} must be milliseconds or a duration like 30s, 5m, 1h`, remediation);
  const ms = Number(match[1]) * DURATION_UNITS_MS[match[2]];
  if (!Number.isSafeInteger(ms) || ms > MAX_TIMEOUT_MS) {
    throw new UsageError(`${flag} must not exceed ${MAX_TIMEOUT_HUMAN}`, remediation);
  }
  return ms;
}

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

function setOption(options, name, value, command, seen) {
  if (seen.has(name)) throw usageError(`duplicate flag ${name}`, command);
  seen.add(name);
  options[name] = value;
}

function parseLongFlag(token) {
  const equals = token.indexOf("=");
  return equals === -1 ? { name: token, inlineValue: undefined } : { name: token.slice(0, equals), inlineValue: token.slice(equals + 1) };
}

function parseFields(value) {
  const fields = value.split(",").map((field) => field.trim()).filter(Boolean);
  if (!fields.length || fields.some((field) => !RESULT_FIELDS.has(field))) {
    throw new UsageError(
      "--fields must contain one or more supported result fields",
      `Use one of: ${[...RESULT_FIELDS].join(", ")}`
    );
  }
  return fields;
}

function defaultOptions(command, cwd) {
  switch (command) {
    case "dispatch":
      return { prompt: undefined, directory: cwd, model: undefined, variant: undefined, sessionId: undefined, keySlot: undefined, finalMarker: undefined, noSandbox: false, allowedDirs: undefined, executor: undefined };
    case "advisor":
      return { prompt: undefined, model: undefined, directory: undefined, variant: undefined, sessionId: undefined, timeoutMs: undefined, executor: undefined };
    case "cancel":
      return { taskId: undefined, graceMs: undefined };
    case "wait":
      return { taskId: undefined, timeoutMs: undefined, tailChars: undefined, full: false, summarize: false };
    case "status":
      return { taskId: undefined, full: false };
    case "tail":
      return { taskId: undefined, chars: undefined };
    case "summary":
      return { taskId: undefined, mode: "report", maxWords: undefined, wait: false };
    case "result":
      return { taskId: undefined, full: false, fields: undefined };
    case "list":
      return { directory: undefined, all: false, limit: undefined };
    case "watch":
      return { directory: undefined, format: "toon", summaries: false, taskId: undefined, flushIntervalMs: undefined };
    case "context":
      return { directory: undefined, format: "toon" };
    case "doctor":
      return { full: false };
    case "setup":
      return {};
    default:
      return {};
  }
}

export function parseArgs(argv, { cwd = process.cwd() } = {}) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  if (!argv.length) {
    return { command: "home", options: { directory: undefined }, help: false, helpText: helpText() };
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    if (argv.length > 1) throw usageError(`unexpected argument: ${argv[1]}`);
    return { command: "home", options: { directory: undefined }, help: true, helpText: helpText() };
  }
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-V") {
    if (rest.length) throw usageError(`unexpected argument: ${rest[0]}`);
    return { command: "version", options: {}, help: false };
  }
  if (command.startsWith("taskferry_")) throw migrationError(command, rest);
  if (command === "poll") throw new UsageError("poll was renamed to wait", "Use `taskferry wait <id>`");
  if (!commandSpecs[command]) throw new UsageError(`unknown command: ${command}`, "Run `taskferry --help` to see available commands");

  const options = defaultOptions(command, cwd);
  const seen = new Set();
  let positional = false;
  let help = false;
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (!token.startsWith("-")) {
      if (positional) throw usageError(`unexpected argument: ${token}`, command);
      if (!["cancel", "wait", "status", "tail", "summary", "result"].includes(command)) {
        throw usageError(`unexpected argument: ${token}`, command);
      }
      options.taskId = token;
      positional = true;
      continue;
    }
    if (!token.startsWith("--")) throw usageError(`unknown flag ${token} for \`${command}\``, command);
    const { name, inlineValue } = parseLongFlag(token);
    const migrationFlags = {
      "--task-id": "--task-id was replaced by the positional task id; use `taskferry status <id>`",
      "--timeout_ms": "--timeout_ms was renamed; use --timeout",
      "--timeout-ms": "--timeout-ms was renamed; use --timeout",
      "--tail_chars": "--tail_chars was renamed; use --tail-chars",
      "--max_words": "--max_words was renamed; use --max-words",
      "--session_id": "--session_id was renamed; use --session-id",
      "--style": "--style was renamed; use --mode",
    };
    // A subset of migration flags point at a target that isn't a valid flag
    // on every command (e.g. --timeout only exists on wait/advisor). For
    // those, only emit the "use <target>" hint when the current command
    // actually accepts the target — otherwise the hint itself triggers a
    // second "unknown flag" error, which is misleading.
    const migrationTargetFlag = {
      "--task-id": null,
      "--timeout_ms": "--timeout",
      "--timeout-ms": "--timeout",
    };
    if (migrationFlags[name] && !(name === "--task-id" && command === "watch")) {
      const target = migrationTargetFlag[name];
      if (target && !commandAllows(command, target)) {
        throw usageError(`unknown flag ${name} for \`${command}\``, command);
      }
      throw new UsageError(`unknown flag ${name} for \`${command}\``, migrationFlags[name]);
    }

    const booleanCommands = {
      "--full": ["wait", "status", "result", "doctor"],
      "--all": ["list"],
      "--wait": ["summary"],
      "--summaries": ["watch"],
      "--summarize": ["wait"],
      "--no-sandbox": ["dispatch"],
    };
    const booleanKeyOverrides = { "--no-sandbox": "noSandbox" };
    if (booleanCommands[name]) {
      if (!booleanCommands[name].includes(command)) throw usageError(`unknown flag ${name} for \`${command}\``, command);
      if (inlineValue !== undefined) throw usageError(`${name} does not take a value`, command);
      const key = booleanKeyOverrides[name] ?? name.slice(2);
      setOption(options, key, true, command, seen);
      continue;
    }

    const values = {
      "--prompt": "prompt",
      "--directory": "directory",
      "--model": "model",
      "--variant": "variant",
      "--session-id": "sessionId",
      "--key-slot": "keySlot",
      "--grace-ms": "graceMs",
      "--timeout": "timeoutMs",
      "--tail-chars": "tailChars",
      "--chars": "chars",
      "--mode": "mode",
      "--max-words": "maxWords",
      "--fields": "fields",
      "--limit": "limit",
      "--format": "format",
      "--task-id": "taskId",
      "--require-final-marker": "finalMarker",
      "--allowed-dirs": "allowedDirs",
      "--executor": "executor",
      "--flush-interval": "flushIntervalMs",
    };
    const key = values[name];
    if (!key || !commandAllows(command, name)) throw usageError(`unknown flag ${name} for \`${command}\``, command);
    const required = requireValue(rest, index, name, inlineValue);
    index = required.nextIndex;
    let value = required.value;
    if (key === "timeoutMs" || key === "flushIntervalMs") {
      value = parseDuration(value, name);
    } else if (["graceMs", "tailChars", "chars", "maxWords", "limit"].includes(key)) {
      value = parseNumber(value, name, key === "tailChars" || key === "chars" ? { min: 1, max: 65536 } : key === "maxWords" ? { min: 75, max: 300 } : { min: key === "limit" ? 1 : 0 });
    } else if (key === "fields") {
      value = parseFields(value);
    } else if (key === "allowedDirs") {
      value = value.split(",").map((entry) => entry.trim()).filter(Boolean);
      if (!value.length) throw new UsageError("--allowed-dirs must contain at least one path", "Use --allowed-dirs with one or more comma-separated paths");
    } else if (key === "format") {
      const allowed = command === "watch" ? ["toon", "ndjson"] : ["toon", "claude-hook", "codex-hook"];
      if (!allowed.includes(value)) throw new UsageError(`${name} must be one of ${allowed.join(", ")}`, `Use ${name} with one of: ${allowed.join(", ")}`);
    } else if (key === "mode" && !["report", "activity"].includes(value)) {
      throw new UsageError(`${name} must be one of report, activity`, "Use --mode report or --mode activity");
    } else if (key === "executor" && !KNOWN_EXECUTORS.includes(value)) {
      throw new UsageError(`${name} must be one of ${KNOWN_EXECUTORS.join(", ")}`, `Use --executor ${KNOWN_EXECUTORS.join(" or --executor ")}`);
    } else if (key === "finalMarker") {
      try {
        new RegExp(value);
      } catch (err) {
        throw new UsageError(`${name} is not a valid RegExp: ${err.message}`, "Use --require-final-marker with a pattern that compiles as a standard JS RegExp");
      }
    }
    setOption(options, key, value, command, seen);
  }

  if (command === "list" && options.all && seen.has("directory")) {
    throw usageError("--all cannot be combined with --directory", command);
  }
  if (command === "list" && options.all) options.directory = undefined;
  if (!help) {
    if (["cancel", "wait", "status", "tail", "summary", "result"].includes(command) && !options.taskId) {
      throw usageError("task id is required", command);
    }
    if (["dispatch", "advisor"].includes(command) && !options.prompt) throw usageError("--prompt is required", command);
    if (command === "advisor" && !options.model) throw usageError("--model is required", command);
    if (command === "result" && options.full && options.fields && !options.fields.includes("narration")) {
      throw usageError("--full requires narration in --fields", command);
    }
    if (command === "wait" && options.summarize && options.timeoutMs !== undefined) {
      throw usageError("--summarize cannot be combined with --timeout", command);
    }
    if (command === "wait" && options.summarize && options.tailChars !== undefined) {
      throw usageError("--summarize cannot be combined with --tail-chars", command);
    }
    if (command === "watch" && options.flushIntervalMs !== undefined && !options.summaries) {
      throw usageError("--flush-interval requires --summaries", command);
    }
    // A zero-length flush interval is meaningless (it would either flush
    // every event individually -- defeating the batching -- or, with the
    // streamTaskEvents truthy-check, fall back silently to per-event
    // streaming). Reject it explicitly rather than letting it pass.
    if (command === "watch" && options.flushIntervalMs === 0) {
      throw usageError("--flush-interval must be greater than zero", command);
    }
  }
  return { command, options, help, ...(help ? { helpText: helpText(command) } : {}) };
}

function commandAllows(command, flag) {
  const flags = {
    dispatch: ["--prompt", "--directory", "--model", "--variant", "--session-id", "--key-slot", "--require-final-marker", "--allowed-dirs", "--executor"],
    cancel: ["--grace-ms"],
    wait: ["--timeout", "--tail-chars"],
    advisor: ["--prompt", "--model", "--directory", "--variant", "--session-id", "--timeout", "--executor"],
    status: [],
    tail: ["--chars"],
    summary: ["--mode", "--max-words"],
    result: ["--fields"],
    list: ["--directory", "--limit"],
    watch: ["--directory", "--format", "--task-id", "--flush-interval"],
    context: ["--directory", "--format"],
    doctor: [],
  };
  return flags[command]?.includes(flag) === true;
}
