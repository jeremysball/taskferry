import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_OPENCODE_VERSION_TIMEOUT_MS = 10000;
// How long a detected opencode CLI major version is trusted before the next
// launch re-probes it. The daemon outlives package upgrades, so a permanent
// memo would keep building the old argv after `opencode` moves to a new
// major; re-probing every launch would block the daemon's thread on a
// subprocess each time.
export const DEFAULT_OPENCODE_VERSION_TTL_MS = 5 * 60 * 1000;
// Anchored to (a) an optional `opencode ` prefix, (b) an optional `v` before
// the major, and (c) a `major.minor` pair -- so `opencode v2.0.22` (2.x),
// `1.18.3` (1.x), and `0.0.0-dev-202610030456` (npm dev build, which still
// exposes the 1.x argv) all return a real number, while a parse failure
// stays a parse failure rather than being fished out of arbitrary output.
const OPENCODE_VERSION_PARSE_RE = /^(?:opencode\s+)?v?(\d+)\.\d+/m;

/**
 * Memo for the detected opencode CLI major version: `{major, at}` from the
 * last successful probe (`major` is a real number) and the most recent
 * `inFlight` Promise<number|null> (still pending or settled). Failed
 * probes never overwrite this -- a `null` is only stored here because no
 * probe has ever succeeded yet.
 *
 * @type {{major: number|null, at: number, inFlight: Promise<number|null>|null}}
 */
let opencodeVersionMemo = { major: null, at: 0, inFlight: null };

/**
 * Synchronously returns the most recently successfully probed opencode CLI
 * major version, or `null` when (a) no probe has succeeded yet, (b) the
 * last successful probe is older than `OPENCODE_VERSION_TTL_MS`, or
 * (c) the caller is using a test-injected `now` whose monotonic value
 * says the memo is stale. A `null` here is *not* a guess at 1.x: callers
 * who need a major to build the argv must `await ensureOpencodeCliMajor()`
 * first, and treat a still-null result as a probe failure.
 * @param {{now?: () => number, ttlMs?: number}} [options]
 * @returns {number|null}
 */
export function detectOpencodeCliMajor({ now = () => performance.now(), ttlMs = defaultTtlMs() } = {}) {
  if (opencodeVersionMemo.major === null) return null;
  const at = now();
  if (at - opencodeVersionMemo.at >= ttlMs) return null;
  return opencodeVersionMemo.major;
}

/**
 * Errors thrown by `opencode --version` carry the cause code we want in the
 * warning line (ENOENT, ETIMEDOUT, EACCES, ...); `err.cause` is the way Node
 * attaches it. Promisified execFile also wraps the spawn rejection, so the
 * `.cause.code` is usually the right field to surface. This helper keeps
 * the warning text stable across both shapes (cause on, cause off).
 * @param {unknown} err
 */
function probeErrorDetail(err) {
  const e = /** @type {{message?: unknown, cause?: {code?: unknown} | null}} */ (err);
  const message = typeof e?.message === "string" ? e.message : String(err);
  const causeCode = e?.cause && typeof e.cause === "object" && typeof e.cause.code === "string" ? e.cause.code : null;
  return causeCode ? `${message} (cause: ${causeCode})` : message;
}

/**
 * Single async probe: shells out to `opencode --version` (via the injected
 * `execFileFn`) and parses the trimmed stdout for a major version. Returns
 * `null` for every failure mode (binary missing, timed out, output didn't
 * match `OPENCODE_VERSION_PARSE_RE`) and logs the underlying error to
 * stderr so a missing binary or a stale install is visible to the user,
 * not silently swallowed.
 *
 * Crucially, this function *never* updates {@link opencodeVersionMemo} --
 * only the wrapper in `ensureOpencodeCliMajor()` decides whether to commit
 * the result, so a failed probe can't poison a previously cached good
 * value.
 * @param {typeof execFileAsync} execFileFn
 * @returns {Promise<number|null>}
 */
async function probeOpencodeCliMajor(execFileFn) {
  try {
    const { stdout } = await execFileFn("opencode", ["--version"], { encoding: "utf8", timeout: opencodeVersionTimeoutOverride });
    const trimmed = String(stdout).trim();
    const match = OPENCODE_VERSION_PARSE_RE.exec(trimmed);
    if (!match) {
      process.stderr.write(`warning: could not parse \`opencode --version\` output as a version (got ${JSON.stringify(trimmed)}); opencode dispatches fail until it parses\n`);
      return null;
    }
    const major = Number(match[1]);
    return Number.isFinite(major) ? major : null;
  } catch (err) {
    process.stderr.write(`warning: opencode version probe failed: ${probeErrorDetail(err)}\n`);
    return null;
  }
}

/**
 * Mutable override for the default probe TTL. Set once at daemon boot from
 * the configured `opencodeVersionTtlMs` (`TASKFERRY_OPENCODE_VERSION_TTL_MS`
 * or `config.opencodeVersionTtlMs`); read by `defaultTtlMs()` whenever the
 * `ttlMs` option to `detectOpencodeCliMajor`/`ensureOpencodeCliMajor` is
 * omitted. Tasks.js owns the lifecycle (a single setter at construction,
 * one reset on test cleanup) so the value is always in sync with the
 * manager that owns this process.
 * @type {number}
 */
let opencodeVersionTtlOverride = DEFAULT_OPENCODE_VERSION_TTL_MS;

/** @returns {number} */
function defaultTtlMs() {
  return opencodeVersionTtlOverride;
}

/**
 * Set the default TTL for the opencode CLI major-version probe. Called by
 * `tasks.js` at daemon boot once `opencodeVersionTtlMs` has been resolved
 * through the env/config/default chain, so subsequent `ensureOpencodeCliMajor`
 * calls honor the configured value without each caller having to thread it
 * through. Test-only resets via `resetOpencodeCliProbe()` do not touch the
 * override; tests that want a different TTL pass `ttlMs` explicitly per call.
 * @param {number} ttlMs
 */
export function setOpencodeVersionTtlMs(ttlMs) {
  opencodeVersionTtlOverride = ttlMs;
}

/**
 * Mutable override for the `opencode --version` subprocess timeout. Set once
 * at daemon boot from the configured `opencodeVersionTimeoutMs`, same
 * lifecycle as the TTL override above.
 * @type {number}
 */
let opencodeVersionTimeoutOverride = DEFAULT_OPENCODE_VERSION_TIMEOUT_MS;

/**
 * Set the `opencode --version` probe timeout. Called by `tasks.js` at daemon
 * boot once `opencodeVersionTimeoutMs` has been resolved through the
 * option/env/config/default chain.
 * @param {number} timeoutMs
 */
export function setOpencodeVersionTimeoutMs(timeoutMs) {
  opencodeVersionTimeoutOverride = timeoutMs;
}

/**
 * Async getter that resolves to the cached major version when the memo is
 * fresh, otherwise kicks off one `probeOpencodeCliMajor` call and shares
 * the in-flight Promise across all callers (so a stampede of dispatches
 * during the first probe after a daemon boot doesn't shell out N times).
 *
 * On a successful probe the memo is updated to `{major: <number>, at:
 * performance.now()}`; on a failed probe the memo is left untouched
 * (a previous good value survives, a never-probed value stays `null`).
 * Callers that need a non-null major to build the argv must treat a still-
 * `null` resolved value as a hard probe failure.
 * @param {{execFileFn?: typeof execFileAsync, now?: () => number, ttlMs?: number}} [options]
 * @returns {Promise<number|null>}
 */
export function ensureOpencodeCliMajor({ execFileFn = execFileAsync, now = () => performance.now(), ttlMs = defaultTtlMs() } = {}) {
  const cached = detectOpencodeCliMajor({ now, ttlMs });
  if (cached !== null) return Promise.resolve(cached);
  if (opencodeVersionMemo.inFlight) return opencodeVersionMemo.inFlight;
  const probeP = probeOpencodeCliMajor(execFileFn).then((major) => {
    if (major !== null) opencodeVersionMemo = { major, at: now(), inFlight: null };
    else opencodeVersionMemo = { ...opencodeVersionMemo, inFlight: null };
    return major;
  });
  opencodeVersionMemo = { ...opencodeVersionMemo, inFlight: probeP };
  return probeP;
}

/** Test-only: forget the memoized opencode version and any in-flight probe. */
export function resetOpencodeCliProbe() {
  opencodeVersionMemo = { major: null, at: 0, inFlight: null };
}