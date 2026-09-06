/**
 * The warning half of `doctor`: every check `runDoctorChecks` performs turns
 * into at most one operator-facing message here. Split out of `commands.js`
 * so the command layer stays a dispatcher, and so a new check adds a helper
 * to one cohesive file instead of growing the file that routes every command.
 */

/**
 * @typedef {object} DoctorStorage
 * @property {{records: number, bytes: number|null}} taskStore
 * @property {{recorded: number, stale: number, live: number}} overlays
 * @property {{pending: number, applicable: number, unresolvable: number}} changesets
 * @property {Record<string, number>} perTaskCacheDirs
 */

// Each check kind produces at most one warning; the shared phrase anchors the
// three messages to the same root cause ("shared browser profile crashes
// dispatch / bwrap missing breaks sandbox") so adding a new check only needs
// to slot in another helper here.
const SHARED_BROWSER_CRASH_PHRASE = "concurrent dispatches sharing one browser profile crash with SIGKILL";

/**
 * @param {{checked: boolean, isolated?: boolean, path?: string}} opencodeMCP
 * @returns {string|null}
 */
export function opencodeMcpWarning(opencodeMCP) {
  if (!opencodeMCP.checked || opencodeMCP.isolated) return null;
  return `Playwright MCP for opencode is not isolated (${opencodeMCP.path}): ${SHARED_BROWSER_CRASH_PHRASE}. Run taskferry setup to fix, or add --isolated to its command manually.`;
}

/**
 * @param {{checked: boolean, isolated?: boolean, path?: string, reason?: string}} claudeCodeMCP
 * @returns {string|null}
 */
export function claudeCodeMcpWarning(claudeCodeMCP) {
  if (!claudeCodeMCP.checked || claudeCodeMCP.isolated) return null;
  const pathFragment = claudeCodeMCP.path ? ` (${claudeCodeMCP.path})` : "";
  const reasonFragment = claudeCodeMCP.reason && !claudeCodeMCP.path ? `, or ${claudeCodeMCP.reason.toLowerCase()}` : "";
  return `Playwright MCP for Claude Code is not isolated${pathFragment}: ${SHARED_BROWSER_CRASH_PHRASE}. Run taskferry setup to fix${reasonFragment}.`;
}

/**
 * @param {{available?: boolean, reason?: string}|null} bwrap
 * @returns {string|null}
 */
export function bwrapWarning(bwrap) {
  if (!bwrap || bwrap.available) return null;
  return `Filesystem sandboxing is unavailable: bwrap is not installed (${bwrap.reason}). Dispatches will fail with a spawnError instead of running unconfined. Install bubblewrap (e.g. apt install bubblewrap), or opt out explicitly with TASKFERRY_DISABLE_SANDBOX=1.`;
}

/**
 * Dead overlay pointers are the one storage number worth a warning rather
 * than a count: every one of them makes the accept path and `hasLiveOverlay`
 * stat a directory that cannot come back, and their presence means the boot
 * reconcile has not run since whatever cleared the overlay root. The
 * unresolvable-changeset count deliberately stays informational -- it is a
 * record of ferries that failed to extract a diff, which is a diagnosis to
 * read, not debris to clear.
 * @param {DoctorStorage|null|undefined} storage
 * @returns {string|null}
 */
export function staleOverlayWarning(storage) {
  if (!storage || storage.overlays.stale === 0) return null;
  return `${storage.overlays.stale} of ${storage.overlays.recorded} task records point at an overlay directory that no longer exists. Restart the daemon to reconcile them (taskferry daemon restart); until then every accept/status touch on those tasks stats a directory that cannot come back.`;
}

/**
 * @param {object} checked
 * @param {{checked: boolean, isolated?: boolean, path?: string}} checked.opencodeMCP
 * @param {{checked: boolean, isolated?: boolean, path?: string, reason?: string}} checked.claudeCodeMCP
 * @param {{available?: boolean, reason?: string}|null} checked.bwrap
 * @param {DoctorStorage|null} [checked.storage]
 * @param {NodeJS.Platform} platform
 * @returns {{warnings: string[], info: string[]}}
 */
export function collectDoctorDiagnostics(checked, platform) {
  const warnings = [
    opencodeMcpWarning(checked.opencodeMCP),
    claudeCodeMcpWarning(checked.claudeCodeMCP),
    bwrapWarning(checked.bwrap),
    staleOverlayWarning(checked.storage),
  ].filter((message) => message !== null);
  const info = platform !== "linux"
    ? ["Filesystem sandboxing (bwrap) is only available on Linux; dispatched tasks on this platform run unconfined."]
    : [];
  return { warnings, info };
}


/**
 * Narrows an arbitrary `system.storage` reply to the shape `doctor` renders,
 * returning null for anything else. A daemon old enough not to know the
 * method rejects it outright (handled by the caller's allSettled), but one
 * mid-upgrade can answer with a different shape, and reporting no storage
 * section beats rendering a half-populated one or throwing out of a health
 * check.
 * @param {unknown} value
 * @returns {DoctorStorage|null}
 */
export function asDoctorStorage(value) {
  if (typeof value !== "object" || value === null) return null;
  const candidate = /** @type {Record<string, any>} */ (value);
  const counters = [candidate.taskStore?.records, candidate.overlays?.stale, candidate.changesets?.pending];
  if (counters.some((count) => typeof count !== "number")) return null;
  if (typeof candidate.perTaskCacheDirs !== "object" || candidate.perTaskCacheDirs === null) return null;
  return /** @type {DoctorStorage} */ (value);
}
