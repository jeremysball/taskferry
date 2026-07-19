import { RESULT_FIELDS } from "./protocol.js";

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
    },
    examples: [
      'taskferry dispatch --prompt "Fix the failing tests"',
      'taskferry dispatch --prompt "Review this change" --model openai/gpt-5.6-sol',
      'taskferry dispatch --prompt "Investigate" --require-final-marker "^Status: (DONE|DONE_WITH_CONCERNS|BLOCKED)$"',
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
      "--timeout-ms <number>": "maximum wait in milliseconds",
      "--tail-chars <number>": "include this many trailing text characters on timeout",
      "--full": "include directory, model, and log details",
      "--summarize": "print periodic live summaries while waiting; exits when the task settles",
    },
    examples: ['taskferry wait <id>', 'taskferry wait <id> --timeout-ms 10000 --tail-chars 1000', 'taskferry wait <id> --summarize'],
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
      "--timeout-ms <number>": "maximum wait in milliseconds",
    },
    examples: [
      'taskferry advisor --prompt "How should I split this module?" --model openai/gpt-5.6-sol',
      'taskferry advisor --prompt "Review this design" --model zai/glm-5.2 --timeout-ms 30000',
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
      "--style report|activity": "summary style, default report",
      "--max-words <number>": "target length from 75 through 300",
      "--wait": "wait for active work before summarizing",
    },
    examples: ['taskferry summary <id>', 'taskferry summary <id> --style activity --wait'],
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
      "--format toon|claude-monitor|ndjson": "stream format, default toon",
      "--summaries": "request activity summaries when available",
      "--origin-session-id <id>": "with --format claude-monitor, only stream tasks dispatched with the same origin session id",
    },
    examples: ['taskferry watch', 'taskferry watch --task-id <id> --summaries', 'taskferry watch --format ndjson'],
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

export class UsageError extends Error {
  constructor(message, help = "Run `taskferry --help` for usage") {
    super(message);
    this.name = "UsageError";
    this.help = help;
    this.exitCode = 2;
  }
}

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
      return { prompt: undefined, directory: cwd, model: undefined, variant: undefined, sessionId: undefined, keySlot: undefined, finalMarker: undefined };
    case "advisor":
      return { prompt: undefined, model: undefined, directory: cwd, variant: undefined, sessionId: undefined, timeoutMs: undefined };
    case "cancel":
      return { taskId: undefined, graceMs: undefined };
    case "wait":
      return { taskId: undefined, timeoutMs: undefined, tailChars: undefined, full: false, summarize: false };
    case "status":
      return { taskId: undefined, full: false };
    case "tail":
      return { taskId: undefined, chars: undefined };
    case "summary":
      return { taskId: undefined, style: "report", maxWords: undefined, wait: false };
    case "result":
      return { taskId: undefined, full: false, fields: undefined };
    case "list":
      return { directory: cwd, all: false, limit: undefined };
    case "watch":
      return { directory: undefined, format: "toon", summaries: false, taskId: undefined, originSessionId: undefined };
    case "context":
      return { directory: cwd, format: "toon" };
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
    return { command: "home", options: { directory: cwd }, help: false, helpText: helpText() };
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    if (argv.length > 1) throw usageError(`unexpected argument: ${argv[1]}`);
    return { command: "home", options: { directory: cwd }, help: true, helpText: helpText() };
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
      "--timeout_ms": "--timeout_ms was renamed; use --timeout-ms",
      "--tail_chars": "--tail_chars was renamed; use --tail-chars",
      "--max_words": "--max_words was renamed; use --max-words",
      "--session_id": "--session_id was renamed; use --session-id",
    };
    if (migrationFlags[name] && !(name === "--task-id" && command === "watch")) {
      throw new UsageError(`unknown flag ${name} for \`${command}\``, migrationFlags[name]);
    }

    const booleanCommands = {
      "--full": ["wait", "status", "result", "doctor"],
      "--all": ["list"],
      "--wait": ["summary"],
      "--summaries": ["watch"],
      "--summarize": ["wait"],
    };
    if (booleanCommands[name]) {
      if (!booleanCommands[name].includes(command)) throw usageError(`unknown flag ${name} for \`${command}\``, command);
      if (inlineValue !== undefined) throw usageError(`${name} does not take a value`, command);
      const key = name.slice(2);
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
      "--timeout-ms": "timeoutMs",
      "--tail-chars": "tailChars",
      "--chars": "chars",
      "--style": "style",
      "--max-words": "maxWords",
      "--fields": "fields",
      "--limit": "limit",
      "--format": "format",
      "--task-id": "taskId",
      "--require-final-marker": "finalMarker",
      "--origin-session-id": "originSessionId",
    };
    const key = values[name];
    if (!key || !commandAllows(command, name)) throw usageError(`unknown flag ${name} for \`${command}\``, command);
    const required = requireValue(rest, index, name, inlineValue);
    index = required.nextIndex;
    let value = required.value;
    if (["graceMs", "timeoutMs", "tailChars", "chars", "maxWords", "limit"].includes(key)) {
      value = parseNumber(value, name, key === "tailChars" || key === "chars" ? { min: 1, max: 65536 } : key === "maxWords" ? { min: 75, max: 300 } : { min: key === "limit" ? 1 : 0 });
    } else if (key === "fields") {
      value = parseFields(value);
    } else if (key === "format") {
      const allowed = command === "watch" ? ["toon", "claude-monitor", "ndjson"] : ["toon", "claude-hook", "codex-hook"];
      if (!allowed.includes(value)) throw new UsageError(`${name} must be one of ${allowed.join(", ")}`, `Use ${name} with one of: ${allowed.join(", ")}`);
    } else if (key === "style" && !["report", "activity"].includes(value)) {
      throw new UsageError(`${name} must be one of report, activity`, "Use --style report or --style activity");
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
      throw usageError("--summarize cannot be combined with --timeout-ms", command);
    }
    if (command === "wait" && options.summarize && options.tailChars !== undefined) {
      throw usageError("--summarize cannot be combined with --tail-chars", command);
    }
    if (command === "watch" && options.originSessionId !== undefined && options.format !== "claude-monitor") {
      throw usageError("--origin-session-id requires --format claude-monitor", command);
    }
  }
  return { command, options, help, ...(help ? { helpText: helpText(command) } : {}) };
}

function commandAllows(command, flag) {
  const flags = {
    dispatch: ["--prompt", "--directory", "--model", "--variant", "--session-id", "--key-slot", "--require-final-marker"],
    cancel: ["--grace-ms"],
    wait: ["--timeout-ms", "--tail-chars"],
    advisor: ["--prompt", "--model", "--directory", "--variant", "--session-id", "--timeout-ms"],
    status: [],
    tail: ["--chars"],
    summary: ["--style", "--max-words"],
    result: ["--fields"],
    list: ["--directory", "--limit"],
    watch: ["--directory", "--format", "--task-id", "--origin-session-id"],
    context: ["--directory", "--format"],
    doctor: [],
  };
  return flags[command]?.includes(flag) === true;
}
