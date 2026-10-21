import { parseLongFlag, parseNumber, requireValue, setOption } from "./args.js";

/**
 * Read a positive-integer flag from an argv slice, with the same grammar as
 * every other numeric flag: space and `=` forms, digits only, a missing or
 * empty value rejected, and a repeated flag rejected. Used by the daemon
 * entrypoint, which parses its own argv before the main CLI parser runs.
 * @param {string[]} argv
 * @param {string} flagName e.g. "--max-response-bytes"
 * @returns {number|undefined}
 */
export function parsePositiveIntFlag(argv, flagName) {
  /** @type {Record<string, unknown>} */
  const options = {};
  const seen = new Set();
  let i = 0;
  while (i < argv.length) {
    const { name, inlineValue } = parseLongFlag(argv[i]);
    if (name !== flagName) {
      i++;
      continue;
    }
    const { value, nextIndex } = requireValue(argv, i, flagName, inlineValue);
    setOption(options, flagName, parseNumber(value, flagName, { min: 1 }), "daemon", seen);
    i = nextIndex + 1;
  }
  const found = options[flagName];
  return typeof found === "number" ? found : undefined;
}
