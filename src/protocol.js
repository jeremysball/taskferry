import path from "node:path";
import { isNonNegativeInteger, isObject, isPositiveInteger } from "./numbers.js";

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
export const RESULT_FIELDS = new Set([
  "message",
  "narration",
  "tokens",
  "cost",
  "sessionId",
  "exitCode",
  "signal",
  "spawnError",
  "failureReason",
  "failureDetail",
  "keySlot",
  "logPath",
  "incomplete",
  "finalMarker",
]);
export class ProtocolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} help
   * @param {string | null} [requestId]
   */
  constructor(code, message, help, requestId = null) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.help = help;
    this.requestId = requestId;
  }
}

/** @param {unknown} value @returns {value is string} */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** @param {unknown} value @returns {value is string} */
function isAbsolutePath(value) {
  return isNonEmptyString(value) && path.isAbsolute(value);
}

/** @param {unknown} value @param {(value: unknown) => boolean} predicate @returns {boolean} */
function optional(value, predicate) {
  return value === undefined || predicate(value);
}

/** @param {Record<string, unknown>} params @param {string[]} names @returns {boolean} */
function hasOnly(params, names) {
  const allowed = new Set(names);
  return Object.keys(params).every((name) => allowed.has(name));
}

const positiveInteger = isPositiveInteger;
const nonNegativeInteger = isNonNegativeInteger;

/** @param {string} method @param {Record<string, unknown>} params @returns {boolean} */
function validParams(method, params) {
  switch (method) {
    case "system.health":
      return hasOnly(params, []);
    case "task.dispatch":
      return hasOnly(params, ["prompt", "directory", "model", "variant", "sessionId", "keySlot", "finalMarker", "originSessionId", "noSandbox", "allowedDirs"])
        && isNonEmptyString(params.prompt)
        && isAbsolutePath(params.directory)
        && optional(params.model, isNonEmptyString)
        && optional(params.variant, isNonEmptyString)
        && optional(params.sessionId, isNonEmptyString)
        && optional(params.keySlot, isNonEmptyString)
        && optional(params.finalMarker, isNonEmptyString)
        && optional(params.originSessionId, isNonEmptyString)
        && optional(params.noSandbox, (value) => typeof value === "boolean")
        && optional(params.allowedDirs, (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => isNonEmptyString(entry)));
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
      return hasOnly(params, ["taskId", "maxWords", "mode"])
        && isNonEmptyString(params.taskId)
        && optional(params.maxWords, (value) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 75 && /** @type {number} */ (value) <= 300)
        && optional(params.mode, (value) => value === "report" || value === "activity");
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
      // Either an explicit directory, or a taskId the daemon resolves the
      // directory from server-side -- lets a taskId-scoped subscribe (watch
      // --task-id) skip a client-side task.status round-trip solely to
      // learn which directory to subscribe to.
      return hasOnly(params, ["directory", "taskId", "summaries", "originSessionId"])
        && (params.directory !== undefined ? isAbsolutePath(params.directory) : isNonEmptyString(params.taskId))
        && optional(params.summaries, (value) => typeof value === "boolean")
        && optional(params.originSessionId, isNonEmptyString);
    default:
      return false;
  }
}

/** @param {string} line */
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

/** @param {unknown} message */
export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

/** @param {string} id @param {unknown} result */
export function successResponse(id, result) {
  return { version: PROTOCOL_VERSION, id, ok: true, result };
}

/** @param {string | null} id @param {string} code @param {string} message @param {string} help */
export function errorResponse(id, code, message, help) {
  return { version: PROTOCOL_VERSION, id, ok: false, error: { code, message, help } };
}

/** @param {string} subscriptionId @param {unknown} event */
export function eventMessage(subscriptionId, event) {
  return { version: PROTOCOL_VERSION, type: "event", subscriptionId, event };
}
