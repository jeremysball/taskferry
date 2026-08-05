import path from "node:path";
import { isNonNegativeInteger, isObject, isPositiveInteger } from "./numbers.js";
import { KNOWN_EXECUTORS } from "./executor.js";

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
  "task.accept",
  "task.reject",
]);

const METHOD_SUMMARY = "task.summary";
const METHOD_SUBSCRIBE = "event.subscribe";

const REQUEST_METHODS = new Set([...RPC_METHODS, METHOD_SUBSCRIBE]);
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
  "logPath",
  "incomplete",
  "finalMarker",
  "finalStatus",
  "class",
  "diff",
  "diffStat",
  "changesetError",
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

/**
 * Validates a caller-supplied environment map. Rejects anything that isn't a
 * plain string-keyed object so a stray `null`/array/number/string can never
 * reach dispatchEnvironment() -- the keys must also be non-empty strings
 * without an `=`, since environment variable names can't contain one (shell
 * export syntax), and every value must be a string so spawn() doesn't have to
 * coerce at the boundary.
 * @param {unknown} value
 * @returns {value is Record<string, string>}
 */
function isEnvironment(value) {
  return isObject(value)
    && Object.entries(value).every(
      ([name, entry]) =>
        isNonEmptyString(name)
        && !name.includes("=")
        && typeof entry === "string"
    );
}

/** @param {Record<string, unknown>} params @param {ReadonlySet<string>} allowed @returns {boolean} */
function hasOnly(params, allowed) {
  return Object.keys(params).every((name) => allowed.has(name));
}

const ENVELOPE_KEYS = new Set(["version", "id", "method", "params"]);

const positiveInteger = isPositiveInteger;
const nonNegativeInteger = isNonNegativeInteger;

/** @param {unknown} value @returns {value is boolean} */
function isBoolean(value) {
  return typeof value === "boolean";
}

/** @param {unknown} value @returns {value is string} */
function isKnownExecutor(value) {
  return typeof value === "string" && KNOWN_EXECUTORS.includes(value);
}

/** @param {unknown} value @returns {value is string[]} */
function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

/** @param {unknown} value @returns {value is string[]} */
function isResultFields(value) {
  return Array.isArray(value) && value.length > 0 && value.every((field) => RESULT_FIELDS.has(field));
}

/** @param {unknown} value @returns {value is number} */
function isTailChars(value) {
  return positiveInteger(value) && value <= 131072;
}

/** @param {unknown} value @returns {value is number} */
function isMaxWords(value) {
  return Number.isSafeInteger(value)
    && /** @type {number} */ (value) >= 75
    && /** @type {number} */ (value) <= 300;
}

/** @param {unknown} value @returns {value is "report" | "activity"} */
function isMode(value) {
  return value === "report" || value === "activity";
}

/** @param {string} method @param {Record<string, unknown>} params @returns {boolean} */
function isSummaryEnvActivity(method, params) {
  return method === METHOD_SUMMARY && params.env !== undefined && params.mode === "activity";
}

/**
 * @typedef {Object} MethodSpec
 * @property {Array<[string, (value: unknown) => boolean]>} required
 *   Field names that must be present, each paired with its predicate.
 * @property {Array<[string, (value: unknown) => boolean]>} optional
 *   Field names that may be absent, each paired with its predicate (validated
 *   only when present).
 * @property {((params: Record<string, unknown>) => boolean) | undefined} [extra]
 *   Cross-field invariants that can't be expressed per-field (e.g. the
 *   task.summary env/activity rejection, or event.subscribe's directory-or-
 *   taskId choice).
 */

/** @type {Record<string, MethodSpec>} */
const METHOD_PARAMS = {
  "system.health": {
    required: [],
    optional: [],
  },
  "task.dispatch": {
    required: [
      ["prompt", isNonEmptyString],
      ["directory", isAbsolutePath],
    ],
    optional: [
      ["model", isNonEmptyString],
      ["variant", isNonEmptyString],
      ["sessionId", isNonEmptyString],
      ["env", isEnvironment],
      ["finalMarker", isNonEmptyString],
      ["originSessionId", isNonEmptyString],
      ["noSandbox", isBoolean],
      ["noOverlay", isBoolean],
      ["allowedDirs", isNonEmptyStringArray],
      ["executor", isKnownExecutor],
      ["class", isNonEmptyString],
    ],
  },
  "task.cancel": {
    required: [["taskId", isNonEmptyString]],
    optional: [["graceMs", nonNegativeInteger]],
  },
  "task.status": {
    required: [["taskId", isNonEmptyString]],
    optional: [],
  },
  "task.wait": {
    required: [["taskId", isNonEmptyString]],
    optional: [
      ["timeoutMs", nonNegativeInteger],
      ["tailChars", positiveInteger],
    ],
  },
  "task.list": {
    required: [],
    optional: [["directory", isAbsolutePath]],
  },
  "task.result": {
    required: [["taskId", isNonEmptyString]],
    optional: [
      ["full", isBoolean],
      ["fields", isResultFields],
    ],
  },
  "task.tail": {
    required: [["taskId", isNonEmptyString]],
    optional: [["chars", isTailChars]],
  },
  [METHOD_SUMMARY]: {
    required: [["taskId", isNonEmptyString]],
    optional: [
      ["maxWords", isMaxWords],
      ["mode", isMode],
      ["env", isEnvironment],
    ],
    // env is meaningless on the activity path -- it reads the cached task
    // activity and spawns nothing, so there's no process to forward caller
    // env into. A caller passing it is expressing an intent the daemon can't
    // honor; reject here so direct RPC callers see a clean error instead of
    // silently dropping the field. The CLI gates this on its end too
    // (commands.js), so a normal `taskferry summary --mode activity` never
    // sends the combination.
    extra: (params) => !isSummaryEnvActivity(METHOD_SUMMARY, params),
  },
  "task.advisor": {
    required: [
      ["prompt", isNonEmptyString],
      ["directory", isAbsolutePath],
      ["model", isNonEmptyString],
    ],
    optional: [
      ["variant", isNonEmptyString],
      ["sessionId", isNonEmptyString],
      ["timeoutMs", nonNegativeInteger],
      ["env", isEnvironment],
      ["executor", isKnownExecutor],
      ["class", isNonEmptyString],
    ],
  },
  "task.context": {
    required: [["directory", isAbsolutePath]],
    optional: [],
  },
  "task.accept": {
    required: [["taskId", isNonEmptyString]],
    optional: [],
  },
  "task.reject": {
    required: [["taskId", isNonEmptyString]],
    optional: [],
  },
  [METHOD_SUBSCRIBE]: {
    // Either an explicit directory, a taskId the daemon resolves the
    // directory from server-side (lets a taskId-scoped subscribe -- watch
    // --task-id -- skip a client-side task.status round-trip solely to learn
    // which directory to subscribe to), or `all: true` (watch --all,
    // taskferry#315) to skip directory filtering entirely.
    required: [],
    optional: [
      ["directory", isAbsolutePath],
      ["taskId", isNonEmptyString],
      ["all", isBoolean],
      ["summaries", isBoolean],
      ["originSessionId", isNonEmptyString],
    ],
    extra: (params) =>
      params.all === true
      || (params.directory !== undefined ? isAbsolutePath(params.directory) : isNonEmptyString(params.taskId)),
  },
};

/** @type {WeakMap<MethodSpec, Set<string>>} */
const SPEC_ALLOWED_NAMES = new WeakMap(
  Object.values(METHOD_PARAMS).map((spec) => [
    spec,
    new Set([...spec.required.map(([name]) => name), ...spec.optional.map(([name]) => name)]),
  ])
);

/** @param {Record<string, unknown>} params @param {MethodSpec} spec @returns {boolean} */
function isWithinParams(params, spec) {
  if (!hasOnly(params, /** @type {Set<string>} */ (SPEC_ALLOWED_NAMES.get(spec)))) {
    return false;
  }
  if (!spec.required.every(([name, validate]) => name in params && validate(params[name]))) {
    return false;
  }
  return !spec.optional.some(([name, validate]) => params[name] !== undefined && !validate(params[name]));
}

/** @param {string} method @param {Record<string, unknown>} params @returns {boolean} */
function validParams(method, params) {
  const spec = METHOD_PARAMS[method];
  if (spec === undefined) {
    return false;
  }
  if (!isWithinParams(params, spec)) {
    return false;
  }
  return spec.extra === undefined || spec.extra(params);
}

/** @param {string} method @param {Record<string, unknown>} params
 *  @returns {{ message: string, help: string } | null} */
function invalidParamsError(method, params) {
  if (validParams(method, params)) {
    return null;
  }
  if (isSummaryEnvActivity(method, params)) {
    return {
      message: "task.summary does not accept env with mode \"activity\"",
      help: "Omit env, or use mode \"report\" so the spawned summary child can forward caller env",
    };
  }
  return {
    message: `invalid params for ${method}`,
    help: `Check the parameter names and types for ${method}`,
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRequestEnvelope(value) {
  return isObject(value) && hasOnly(value, ENVELOPE_KEYS);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function hasVersion(value) {
  return isObject(value) && "version" in value;
}

/** @param {unknown} value
 *  @returns {value is { version: unknown, id: string, method: string, params: Record<string, unknown> }} */
function isRequestBody(value) {
  return hasVersion(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.method)
    && isObject(value.params);
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
  if (!isRequestEnvelope(value) || !isRequestBody(value)) {
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
      `Use one of: ${[...RPC_METHODS, METHOD_SUBSCRIBE].join(", ")}`,
      requestId
    );
  }
  const paramsError = invalidParamsError(value.method, value.params);
  if (paramsError !== null) {
    throw new ProtocolError("INVALID_PARAMS", paramsError.message, paramsError.help, requestId);
  }
  return value;
}

/** @param {unknown} message */
export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

/** @param {string} id @param {unknown} result */
export function successResponse(id, result) {
  return { version: PROTOCOL_VERSION, ok: true, id, result };
}

/** @param {string | null} id @param {string} code @param {string} message @param {string} help */
export function errorResponse(id, code, message, help) {
  return { version: PROTOCOL_VERSION, ok: false, error: { code, message, help }, id };
}

/** @param {string} subscriptionId @param {unknown} event */
export function eventMessage(subscriptionId, event) {
  return { version: PROTOCOL_VERSION, type: "event", subscriptionId, event };
}
