/**
 * @param {unknown} err
 * @returns {string|undefined}
 */
export function errCode(err) {
  return err && typeof err === "object" && "code" in err ? String(/** @type {{code: unknown}} */ (err).code) : undefined;
}

export class UsageError extends Error {
  /**
   * @param {string} message
   * @param {string} [help]
   */
  constructor(message, help = "Run `taskferry --help` for usage") {
    super(message);
    this.name = "UsageError";
    this.help = help;
    this.exitCode = 2;
  }
}
