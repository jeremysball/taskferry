/** @param {unknown} value @returns {value is number} */
export function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0;
}

/** @param {unknown} value @returns {value is number} */
export function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
}
