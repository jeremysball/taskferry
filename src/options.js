import { isNonNegativeInteger, isPositiveInteger } from "./numbers.js";

const BYTE_COUNT_HELP = "pass a byte count like 2097152";

/**
 * @param {string} flagName
 * @param {string} raw
 * @returns {number}
 */
function parsePositiveIntFlagValue(flagName, raw) {
  // Digits only, the same rule as parseNumber() in args.js: Number() alone
  // would also accept "1e3", "0x10", " 5" and "+5".
  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (isPositiveInteger(parsed)) return parsed;
  }
  throw new Error(`error: ${flagName} must be a positive integer (got ${JSON.stringify(raw)})\nhelp: ${BYTE_COUNT_HELP}`);
}

/**
 * Parse a `--flag value` / `--flag=value` positive-int from argv, with the
 * same strictness as the CLI parser in args.js: the value is digits only, a
 * flag with no value is an error, and a repeated flag is an error.
 * Throws on any of those; returns undefined when the flag is absent.
 * @param {string[]} argv
 * @param {string} flagName e.g. "--max-response-bytes"
 * @returns {number|undefined}
 */
export function parsePositiveIntFlag(argv, flagName) {
  /** @type {number|undefined} */
  let found;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    /** @type {string} */
    let raw;
    if (arg === flagName) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        const got = next === undefined ? "end of command line" : JSON.stringify(next);
        throw new Error(`error: ${flagName} needs a value (got ${got})\nhelp: ${BYTE_COUNT_HELP}`);
      }
      raw = next;
      i++;
    } else if (arg.startsWith(`${flagName}=`)) {
      raw = arg.slice(flagName.length + 1);
    } else {
      continue;
    }
    if (found !== undefined) {
      throw new Error(`error: duplicate flag ${flagName}\nhelp: pass ${flagName} once`);
    }
    found = parsePositiveIntFlagValue(flagName, raw);
  }
  return found;
}

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
