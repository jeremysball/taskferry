/**
 * Shared task-status sets. Kept out of the plugin entrypoints
 * (kilo-plugin.js) because its loader requires every
 * named export to be a function; a `Set` named export breaks opencode's
 * plugin loader ("Plugin export is not a function").
 */

/** @type {Set<string>} */
export const TERMINAL_STATUSES = new Set(["done", "crashed", "cancelled"]);
