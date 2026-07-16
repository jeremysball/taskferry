import path from "node:path";

export const PROTOCOL_VERSION = 1;

export const RPC_METHODS = Object.freeze([
  "system.health",
  "task.dispatch",
  "task.cancel",
  "task.status",
  "task.wait",
  "task.list",
  "task.result",
  "task.tail",
  "task.summary",
  "task.advisor",
  "task.context",
]);

const REQUEST_METHODS = new Set([...RPC_METHODS, "event.subscribe"]);
const RESULT_FIELDS = new Set([
  "message",
  "narration",
  "tokens",
  "cost",
  "sessionId",
  "exitCode",
  "signal",
  "spawnError",
  "failureReason",
  "keySlot",
  "logPath",
]);
const MANAGER_METHODS = Object.freeze({
  "task.dispatch": "dispatch",
  "task.cancel": "cancel",
  "task.status": "status",
  "task.wait": "poll",
  "task.list": "list",
  "task.result": "result",
  "task.tail": "tail",
  "task.summary": "summarize",
  "task.advisor": "advisor",
});

export class ProtocolError extends Error {
  constructor(code, message, help, requestId = null) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.help = help;
    this.requestId = requestId;
  }
}

export function managerMethodFor(method) {
  return MANAGER_METHODS[method] ?? null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isAbsolutePath(value) {
  return isNonEmptyString(value) && path.isAbsolute(value);
}

function optional(value, predicate) {
  return value === undefined || predicate(value);
}

function hasOnly(params, names) {
  const allowed = new Set(names);
  return Object.keys(params).every((name) => allowed.has(name));
}

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const nonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

function validParams(method, params) {
  switch (method) {
    case "system.health":
      return hasOnly(params, []);
    case "task.dispatch":
      return hasOnly(params, ["prompt", "directory", "model", "variant", "sessionId", "keySlot"])
        && isNonEmptyString(params.prompt)
        && isAbsolutePath(params.directory)
        && optional(params.model, isNonEmptyString)
        && optional(params.variant, isNonEmptyString)
        && optional(params.sessionId, isNonEmptyString)
        && optional(params.keySlot, isNonEmptyString);
    case "task.cancel":
      return hasOnly(params, ["taskId", "graceMs"])
        && isNonEmptyString(params.taskId)
        && optional(params.graceMs, nonNegativeInteger);
    case "task.status":
      return hasOnly(params, ["taskId"]) && isNonEmptyString(params.taskId);
    case "task.wait":
      return hasOnly(params, ["taskId", "timeoutMs", "tailChars"])
        && isNonEmptyString(params.taskId)
        && optional(params.timeoutMs, nonNegativeInteger)
        && optional(params.tailChars, positiveInteger);
    case "task.list":
      return hasOnly(params, ["directory"]) && optional(params.directory, isAbsolutePath);
    case "task.result":
      return hasOnly(params, ["taskId", "full", "fields"])
        && isNonEmptyString(params.taskId)
        && optional(params.full, (value) => typeof value === "boolean")
        && optional(params.fields, (value) => Array.isArray(value) && value.length > 0 && value.every((field) => RESULT_FIELDS.has(field)));
    case "task.tail":
      return hasOnly(params, ["taskId", "chars"])
        && isNonEmptyString(params.taskId)
        && optional(params.chars, (value) => positiveInteger(value) && value <= 65536);
    case "task.summary":
      return hasOnly(params, ["taskId", "maxWords", "style"])
        && isNonEmptyString(params.taskId)
        && optional(params.maxWords, (value) => Number.isSafeInteger(value) && value >= 75 && value <= 300)
        && optional(params.style, (value) => value === "report" || value === "activity");
    case "task.advisor":
      return hasOnly(params, ["prompt", "directory", "model", "variant", "sessionId", "timeoutMs"])
        && isNonEmptyString(params.prompt)
        && isAbsolutePath(params.directory)
        && isNonEmptyString(params.model)
        && optional(params.variant, isNonEmptyString)
        && optional(params.sessionId, isNonEmptyString)
        && optional(params.timeoutMs, nonNegativeInteger);
    case "task.context":
      return hasOnly(params, ["directory"]) && isAbsolutePath(params.directory);
    case "event.subscribe":
      return hasOnly(params, ["directory", "summaries"])
        && isAbsolutePath(params.directory)
        && optional(params.summaries, (value) => typeof value === "boolean");
    default:
      return false;
  }
}

export function parseRequestLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ProtocolError(
      "MALFORMED_JSON",
      "request is not valid JSON",
      "Send one JSON request object followed by a newline"
    );
  }

  const requestId = isObject(value) && typeof value.id === "string" ? value.id : null;
  if (!isObject(value)
    || !hasOnly(value, ["version", "id", "method", "params"])
    || !("version" in value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.method)
    || !isObject(value.params)) {
    throw new ProtocolError(
      "INVALID_REQUEST",
      "request must contain version, id, method, and params",
      "Use `{ version: 1, id: \"request-id\", method: \"system.health\", params: {} }`",
      requestId
    );
  }
  if (value.version !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      "UNSUPPORTED_VERSION",
      `unsupported protocol version: ${String(value.version)}`,
      `Use protocol version ${PROTOCOL_VERSION}`,
      requestId
    );
  }
  if (!REQUEST_METHODS.has(value.method)) {
    throw new ProtocolError(
      "UNKNOWN_METHOD",
      `unknown method: ${value.method}`,
      `Use one of: ${[...RPC_METHODS, "event.subscribe"].join(", ")}`,
      requestId
    );
  }
  if (!validParams(value.method, value.params)) {
    throw new ProtocolError(
      "INVALID_PARAMS",
      `invalid params for ${value.method}`,
      `Check the parameter names and types for ${value.method}`,
      requestId
    );
  }
  return value;
}

export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

export function successResponse(id, result) {
  return { version: PROTOCOL_VERSION, id, ok: true, result };
}

export function errorResponse(id, code, message, help) {
  return { version: PROTOCOL_VERSION, id, ok: false, error: { code, message, help } };
}

export function eventMessage(subscriptionId, event) {
  return { version: PROTOCOL_VERSION, type: "event", subscriptionId, event };
}
