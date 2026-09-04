import { isNonNegativeInteger, isPositiveInteger } from "./numbers.js";

/**
 * @typedef {{isValid: (value: unknown) => boolean, noun: string, example: string}} IntKind
 */

/** @type {IntKind} */
const POSITIVE_INT = { isValid: isPositiveInteger, noun: "a positive integer", example: "2097152" };
/** @type {IntKind} */
const NON_NEGATIVE_INT = { isValid: isNonNegativeInteger, noun: "a non-negative integer", example: "0" };

/**
 * @param {number|undefined} rawValue
 * @param {string|undefined} envValue
 * @param {number|undefined} configValue
 * @param {number} defaultValue
 * @param {{kind: IntKind, envVarName?: string, strictEnv?: boolean}} options
 * @returns {number}
 */
function resolveIntOption(rawValue, envValue, configValue, defaultValue, options) {
  const { kind, envVarName = "env var", strictEnv = false } = options;
  if (rawValue !== undefined) return rawValue;
  if (envValue !== undefined && envValue !== "") {
    const parsed = Number(envValue);
    if (kind.isValid(parsed)) return parsed;
    if (strictEnv) {
      throw new Error(`error: ${envVarName} must be ${kind.noun} (got ${JSON.stringify(envValue)})\nhelp: set a byte count like ${kind.example}`);
    }
  }
  if (kind.isValid(configValue)) return /** @type {number} */ (configValue);
  return defaultValue;
}

/**
 * Flag > env > config > default chain for positive-int options.
 * When `strictEnv` is true an invalid non-empty env value throws
 * (flag/config precedence still applies; empty string falls through).
 * Otherwise an invalid env value is silently ignored (tasks.js lenient
 * behaviour). Shared by daemon and task manager so the precedence and
 * empty-string rule are defined once.
 * @param {number|undefined} rawValue
 * @param {string|undefined} envValue
 * @param {number|undefined} configValue
 * @param {number} defaultValue
 * @param {{envVarName?: string, strictEnv?: boolean}} [options]
 * @returns {number}
 */
export function resolvePositiveIntOption(rawValue, envValue, configValue, defaultValue, options = {}) {
  return resolveIntOption(rawValue, envValue, configValue, defaultValue, { ...options, kind: POSITIVE_INT });
}

/**
 * Flag > env > config > default chain for non-negative-int options (0 allowed).
 * Same chain as resolvePositiveIntOption but allows 0 (disables throttle).
 * @param {number|undefined} rawValue
 * @param {string|undefined} envValue
 * @param {number|undefined} configValue
 * @param {number} defaultValue
 * @param {{envVarName?: string, strictEnv?: boolean}} [options]
 * @returns {number}
 */
export function resolveNonNegativeIntOption(rawValue, envValue, configValue, defaultValue, options = {}) {
  return resolveIntOption(rawValue, envValue, configValue, defaultValue, { ...options, kind: NON_NEGATIVE_INT });
}

/**
 * Canonical raw-value pick for the response-cap aliases, shared by the
 * daemon and task-manager chains so both resolve the same winner when
 * several aliases are set (flag > outbound > buffer). Takes the raw
 * (pre-defaults) options object — callers must pass the unmerged input,
 * never a defaults-merged copy, or a default maxOutboundBytes shadows
 * env/config (taskferry#506 review).
 * @param {{maxResponseBytes?: number, maxOutboundBytes?: number, maxBufferBytes?: number}} rawOptions
 * @returns {number|undefined}
 */
export function resolveResponseCapRaw(rawOptions) {
  return rawOptions.maxResponseBytes ?? rawOptions.maxOutboundBytes ?? rawOptions.maxBufferBytes;
}

/**
 * Whether a string env value counts as enabled (1/true).
 * @param {string|undefined} value
 * @returns {boolean}
 */
export function isEnabledFlag(value) {
  return ["1", "true"].includes(/** @type {string} */ (value));
}

/**
 * Resolves a boolean toggle from the env-var-or-config-value-or-default
 * triple. `invert=true` matches the `TASKFERRY_DISABLE_*` family (where
 * 1/true DISABLES, anything else enables); `invert=false` matches
 * `TASKFERRY_ACTIVITY_SUMMARIES` (where 0 disables, anything else enables).
 * The env value wins when defined; otherwise `configValue` (or the default
 * if undefined) is used.
 * @param {string|undefined} envValue
 * @param {boolean|undefined} configValue
 * @param {boolean} defaultValue
 * @param {boolean} [invert]
 * @returns {boolean}
 */
export function resolveBooleanToggle(envValue, configValue, defaultValue, invert = false) {
  if (envValue === undefined) return configValue ?? defaultValue;
  return invert ? !isEnabledFlag(envValue) : envValue !== "0";
}

/**
 * Env-var-over-config boolean shared by every boolean flag that follows the
 * same precedence chain (profiling, restartWaitForIdle) so each caller
 * expresses only its own env var name and config key.
 * @param {NodeJS.ProcessEnv|undefined} env
 * @param {string} envVarName
 * @param {boolean|undefined} configValue
 * @returns {boolean}
 */
export function resolveEnvOverrideBoolean(env, envVarName, configValue) {
  if (env?.[envVarName] !== undefined) return isEnabledFlag(env[envVarName]);
  return configValue === true;
}
