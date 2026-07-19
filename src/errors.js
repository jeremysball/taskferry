/**
 * @param {unknown} err
 * @returns {string|undefined}
 */
export function errCode(err) {
  return err && typeof err === "object" && "code" in err ? String(/** @type {{code: unknown}} */ (err).code) : undefined;
}
