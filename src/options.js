import { isNonNegativeInteger, isPositiveInteger } from "./numbers.js";

/**
 * Parse a `--flag` / `--flag=value` positive-int from argv.
 * Throws on an invalid value; returns undefined when the flag is absent.
 * @param {string[]} argv
 * @param {string} flagName e.g. "--max-response-bytes"
 * @returns {number|undefined}
 */
export function parsePositiveIntFlag(argv, flagName) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === flagName && i + 1 < argv.length) {
      const raw = argv[i + 1];
      const parsed = Number(raw);
      if (isPositiveInteger(parsed)) return parsed;
      throw new Error(`error: ${flagName} must be a positive integer (got ${JSON.stringify(raw)})\nhelp: pass a byte count like 2097152`);
    }
    if (arg.startsWith(`${flagName}=`)) {
      const raw = arg.slice(flagName.length + 1);
      const parsed = Number(raw);
      if (isPositiveInteger(parsed)) return parsed;
      throw new Error(`error: ${flagName} must be a positive integer (got ${JSON.stringify(raw)})\nhelp: pass a byte count like 2097152`);
    }
  }
  return undefined;
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
  const { envVarName = "env var", strictEnv = false } = options;
  if (rawValue !== undefined) return rawValue;
  if (envValue !== undefined && envValue !== "") {
    const parsed = Number(envValue);
    if (isPositiveInteger(parsed)) return parsed;
    if (strictEnv) {
      throw new Error(`error: ${envVarName} must be a positive integer (got ${JSON.stringify(envValue)})\nhelp: set a byte count like 2097152`);
    }
  }
  if (isPositiveInteger(configValue)) return configValue;
  return defaultValue;
}

/**
 * Flag > env > config > default chain for non-negative-int options (0 allowed).
 * Mirrors resolvePositiveIntOption but allows 0 (disables throttle).
 * @param {number|undefined} rawValue
 * @param {string|undefined} envValue
 * @param {number|undefined} configValue
 * @param {number} defaultValue
 * @param {{envVarName?: string, strictEnv?: boolean}} [options]
 * @returns {number}
 */
export function resolveNonNegativeIntOption(rawValue, envValue, configValue, defaultValue, options = {}) {
  const { envVarName = "env var", strictEnv = false } = options;
  if (rawValue !== undefined) return rawValue;
  if (envValue !== undefined && envValue !== "") {
    const parsed = Number(envValue);
    if (isNonNegativeInteger(parsed)) return parsed;
    if (strictEnv) {
      throw new Error(`error: ${envVarName} must be a non-negative integer (got ${JSON.stringify(envValue)})\nhelp: set a byte count like 0`);
    }
  }
  if (isNonNegativeInteger(configValue)) return configValue;
  return defaultValue;
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

// An unset var is undefined and Number(undefined) is already NaN, but an
// empty-string value (a blank .env line, an empty -e in Docker) is
// Number("") === 0 -- a false "valid, explicit zero" that would otherwise
// slip past isPositiveInteger/isNonNegativeInteger instead of falling back
// to the default the same way a genuinely non-numeric value does.
/**
 * @param {string|undefined} rawValue
 * @param {(value: unknown) => boolean} isValid
 * @param {number} fallback
 * @returns {number}
 */
export function parsedEnvNumber(rawValue, isValid, fallback) {
  if (!rawValue) return fallback;
  const parsed = Number(rawValue);
  return isValid(parsed) ? parsed : fallback;
}
