import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { detectOpencodeCliMajor, ensureOpencodeCliMajor, resetOpencodeCliProbe, setOpencodeVersionTtlMs, DEFAULT_OPENCODE_VERSION_TTL_MS } from "./opencode-version.js";
import { setOpencodeExecutorOverride, resetOpencodeExecutorOverride, resolveOpencodeExecutor } from "./opencode-executor.js";
import { PROMPT_FILE_INSTRUCTION, SUMMARY_ISOLATION_PROMPT } from "./executor-shared.js";

const execFileAsync = promisify(execFile);
const SUMMARY_PREFLIGHT_TIMEOUT_MS = 10000;
export { PROMPT_FILE_INSTRUCTION, SUMMARY_ISOLATION_PROMPT };
// Re-exports of the opencode executor + version probe so existing call sites
// (`import { opencodeExecutor, detectOpencodeCliMajor } from "./executor.js"`)
// keep working after the opencode-specific code moved to its own files.
export { detectOpencodeCliMajor, ensureOpencodeCliMajor, resetOpencodeCliProbe, setOpencodeVersionTtlMs, DEFAULT_OPENCODE_VERSION_TTL_MS, setOpencodeExecutorOverride, resetOpencodeExecutorOverride };

// Pi encodes a cwd into a per-project sessions directory the same way it does
// for getDefaultSessionDir() (see pi's core/session-manager.js): strip a single
// leading / or \, then turn every remaining /, \\, or : into a dash, then wrap
// in `-- ... --`. Must match exactly -- a drift here silently breaks every
// --session <id> resume by looking in the wrong directory.
const piSafePathForCwd = (/** @type {string} */ cwd) =>
  `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/**
 * Resolve `sessionId` (the value a dispatch passed to `--session`) to the
 * concrete pi session .jsonl file we should bind read-write into the sandbox.
 *
 * Pi accepts two shapes for `--session`: an explicit file path (contains a `/`
 * or `\\`, or ends in `.jsonl`), or a session-id prefix that
 * `SessionManager.list(cwd, sessionDir)` matches against the `id` field in
 * each `.jsonl` file's first line. Replicating that lookup here -- instead of
 * e.g. binding the whole sessions dir -- is the only way to keep a resumed
 * session writable for a sandboxed worker without also giving that worker
 * write/delete access to every other session in the user's pi history.
 *
 * Returns null when no unambiguous match is found; the caller should then
 * skip the bind entirely rather than guess. A matched file that lstat shows
 * to be a symlink is also rejected here (same guard as every other bound
 * host path): the resume bind is read-write, so a symlinked session file
 * would hand the sandboxed worker write access to the link's target.
 *
 * @param {string} realSessionsDir - pi's `<agentDir>/sessions/` on the host.
 * @param {string} sessionId
 * @param {{ readdirFn?: (dir: string) => string[], lstatFn?: (file: string) => {isSymbolicLink: () => boolean, isFile?: () => boolean, nlink?: number}} } [deps]
 * @returns {string|null}
 */
function resolvePiSessionFile(realSessionsDir, sessionId, { readdirFn = (/** @type {string} */ dir) => fs.readdirSync(dir), lstatFn = fs.lstatSync } = {}) {
  if (!sessionId) return null;
  // Pi treats --session as a literal path when it looks like one.
  if (sessionId.includes("/") || sessionId.includes("\\") || sessionId.endsWith(".jsonl")) {
    if (!isSafeBindSource(sessionId, lstatFn)) return null;
    return sessionId;
  }
  const matches = listPiSessionFileMatches(realSessionsDir, sessionId, readdirFn);
  // Ambiguous (zero or multiple matches) -> don't bind anything. Pi's own
  // resolver would surface an error to the user; we can't do that from here,
  // and a wrong-file bind would be worse than no bind.
  if (matches.length !== 1) return null;
  if (!isSafeBindSource(matches[0], lstatFn)) return null;
  return matches[0];
}

/**
 * Pi names session files `<isoTimestamp>_<sessionId>.jsonl`, with exactly one
 * underscore separating the timestamp from the UUID. Match by prefix on the
 * session-id portion of the filename -- this avoids reading every .jsonl's
 * first line just to filter candidates. Returns every matching full path;
 * the caller rejects ambiguous result sets.
 * @param {string} realSessionsDir
 * @param {string} sessionId
 * @param {(dir: string) => string[]} readdirFn
 * @returns {string[]}
 */
function listPiSessionFileMatches(realSessionsDir, sessionId, readdirFn) {
  let entries;
  try {
    entries = readdirFn(realSessionsDir);
  } catch {
    return [];
  }
  const matches = [];
  for (const entry of entries) {
    const underscoreIdx = entry.lastIndexOf("_");
    if (!entry.endsWith(".jsonl") || underscoreIdx === -1) continue;
    const fileSessionId = entry.slice(underscoreIdx + 1, -".jsonl".length);
    if (fileSessionId.startsWith(sessionId)) {
      matches.push(path.join(realSessionsDir, entry));
    }
  }
  return matches;
}

/**
 * Whether an lstat failure means "the path genuinely does not exist" -- the
 * one case worth swallowing silently (a vanished entry is an ordinary race,
 * not a problem to surface). Every other error (EACCES, EMFILE, EIO, ...)
 * indicates the path is unverifiable for a real reason the user should hear
 * about; the guard fails closed either way.
 * @param {unknown} err
 * @returns {boolean}
 */
function isEnoentError(err) {
  const e = /** @type {{code?: unknown, message?: unknown}} */ (err);
  return e?.code === "ENOENT" || String(e?.message ?? "").includes("ENOENT");
}

/**
 * Whether a real host path is safe to bind into the sandbox. lstat, never
 * stat: a plain stat follows the symlink and defeats the check, while bwrap
 * resolves a symlink on the host at bind time -- so binding a symlinked
 * path would bind whatever it points at, letting a plugin-planted symlink
 * pull arbitrary host paths (e.g. ~/.ssh) into the sandbox. Paths whose
 * lstat fails outright are skipped too (fail closed: never bind what we
 * couldn't verify isn't a symlink). A skipped path warns on stderr -- a
 * symlinked config entry is often a legitimate dotfiles-repo setup, and
 * dropping it silently would be an invisible regression -- except for the
 * plain ENOENT case, which is an ordinary existsFn/lstat race, not a
 * diagnostic.
 *
 * Hardlinked files are rejected too (isFile() && nlink > 1), so this check
 * is deliberately NOT a realpath-inside-the-tree comparison: fs.realpathSync
 * only resolves symlink components, and a hardlinked entry's realpath is its
 * own path inside the tree, so that check cannot see the inode's other name.
 * nlink > 1 is the only lstat-visible evidence an entry is reachable from
 * elsewhere on the host, and on kernels without fs.protected_hardlinks
 * (default-on since 2012, but absent on some older/embedded/NFS setups) a
 * plugin with config-dir write access could otherwise hardlink a sensitive
 * host file into the tree and leak it into the next dispatch. The false
 * positive is a dropped entry plus a warning -- acceptable for a setup as
 * rare as a hardlinked config entry (dotfiles repos use symlinks, which the
 * isSymbolicLink() check already rejects on purpose) -- and directories are
 * exempt because they cannot be hardlinked and their nlink counts
 * subdirectories.
 * @param {string} fullPath
 * @param {(file: string) => {isSymbolicLink: () => boolean, isFile?: () => boolean, nlink?: number}} lstatFn
 * @returns {boolean}
 */
function isSafeBindSource(fullPath, lstatFn) {
  let entryStat;
  try {
    entryStat = lstatFn(fullPath);
    // The isSymbolicLink() call sits inside the try on purpose: a
    // null-returning lstatFn (matching the sibling statFn seam's
    // null-on-failure convention) must fail closed here, not crash on a
    // TypeError in the line below.
    if (entryStat != null && entryStat.isSymbolicLink()) {
      process.stderr.write(`warning: ${fullPath} is a symlink; skipping the bind (bwrap would bind the link target instead)\n`);
      return false;
    }
  } catch (err) {
    if (!isEnoentError(err)) {
      process.stderr.write(`warning: could not verify ${fullPath} is not a symlink (${/** @type {Error} */ (err).message}); skipping the bind\n`);
    }
    return false;
  }
  if (entryStat == null) return false;
  if (typeof entryStat.isFile === "function" && entryStat.isFile() && typeof entryStat.nlink === "number" && entryStat.nlink > 1) {
    process.stderr.write(`warning: ${fullPath} is hardlinked (${entryStat.nlink} names for one inode); skipping the bind\n`);
    return false;
  }
  return true;
}

/**
 * @param {[string, string][]} list
 * @param {string} src
 * @param {string} dest
 * @param {(file: string) => boolean} existsFn
 * @param {(file: string) => {isSymbolicLink: () => boolean, isFile?: () => boolean, nlink?: number}} lstatFn
 */
function pushSafeRoBind(list, src, dest, existsFn, lstatFn) {
  if (existsFn(src) && isSafeBindSource(src, lstatFn)) list.push([src, dest]);
}

/**
 * @param {[string, string][]} list
 * @param {string} realAgentDir
 * @param {string} sandboxedDataHome
 * @param {{existsFn: (file: string) => boolean, lstatFn: (file: string) => {isSymbolicLink: () => boolean, isFile?: () => boolean, nlink?: number}, realpathFn: (file: string) => string}} fsFns
 */
function pushPiCatalogBinds(list, realAgentDir, sandboxedDataHome, fsFns) {
  const { existsFn, lstatFn, realpathFn = fs.realpathSync } = fsFns;
  for (const fname of ["models.json", "models-store.json", "settings.json"]) {
    const src = path.join(realAgentDir, fname);
    // The catalog is read-only, so unlike auth.json/extensions a symlinked
    // entry is safe to resolve and bind at its real target (issue #563): a
    // dotfiles-managed models.json is a symlink, and dropping it silently
    // makes every catalog-backed provider "Unknown provider".
    if (!existsFn(src)) continue;
    const bindSource = resolveConfigBindSource(src, lstatFn, realpathFn);
    if (bindSource) list.push([bindSource, path.join(sandboxedDataHome, fname)]);
  }
}

/**
 * @param {{realSessionsDir: string, sandboxedSessionsHome: string, sessionId: string|null|undefined, launchDirectory: string|null|undefined, statFn: (file: string) => {isDirectory: () => boolean}|null, readdirFn?: (dir: string) => string[], lstatFn: (file: string) => {isSymbolicLink: () => boolean, isFile?: () => boolean, nlink?: number}}} args
 * @returns {[string, string]|null}
 */
function resolvePiSessionRwBind({ realSessionsDir, sandboxedSessionsHome, sessionId, launchDirectory, statFn, readdirFn, lstatFn }) {
  if (!sessionId || !launchDirectory) return null;
  let sessionsDirStat;
  try {
    sessionsDirStat = statFn(realSessionsDir);
  } catch {
    return null;
  }
  if (!sessionsDirStat?.isDirectory()) return null;
  const safePath = piSafePathForCwd(launchDirectory);
  const realSessionFile = resolvePiSessionFile(path.join(realSessionsDir, safePath), sessionId, { readdirFn, lstatFn });
  if (!realSessionFile) return null;
  return [realSessionFile, path.join(sandboxedSessionsHome, safePath, path.basename(realSessionFile))];
}

/**
 * Resolve a single config entry (an opencode config file, or a pi catalog
 * file such as models.json) to a safe bind source. Dotfiles setups commonly
 * symlink individual entries (opencode.json, plugins, pi models.json) into
 * a repo, so a symlinked entry is resolved to its real target and that
 * target is bound read-only at the same sandboxed destination, instead of
 * being dropped. Dangling links fail closed (ENOENT silent, other errors
 * warn) and do not crash the dispatch. Auth files and the extensions dir
 * keep strict skip-symlink (via isSafeBindSource) as a conservative
 * default for credential and code paths, where following an unexpected
 * symlink would expose a different file's contents to the worker; the
 * read-write session bind also stays strict because resolving it would
 * hand the worker write access to the link target.
 * @param {string} fullPath
 * @param {(file: string) => {isSymbolicLink: () => boolean, isFile?: () => boolean, nlink?: number}} lstatFn
 * @param {(file: string) => string} realpathFn
 * @returns {string|null}
 */
function resolveConfigBindSource(fullPath, lstatFn, realpathFn) {
  let entryStat;
  try {
    entryStat = lstatFn(fullPath);
  } catch (err) {
    if (!isEnoentError(err)) {
      process.stderr.write(`warning: could not verify ${fullPath} is not a symlink (${/** @type {Error} */ (err).message}); skipping the bind\n`);
    }
    return null;
  }
  if (entryStat == null) return null;
  if (entryStat.isSymbolicLink?.()) {
    let realTarget;
    try {
      realTarget = realpathFn(fullPath);
    } catch (err) {
      if (!isEnoentError(err)) {
        process.stderr.write(`warning: could not resolve symlink ${fullPath} (${/** @type {Error} */ (err).message}); skipping the bind\n`);
      }
      return null;
    }
    if (!isSafeBindSource(realTarget, lstatFn)) return null;
    return realTarget;
  }
  if (typeof entryStat.isFile === "function" && entryStat.isFile() && typeof entryStat.nlink === "number" && entryStat.nlink > 1) {
    process.stderr.write(`warning: ${fullPath} is hardlinked (${entryStat.nlink} names for one inode); skipping the bind\n`);
    return null;
  }
  return fullPath;
}

/**
 * @typedef {Object} WorkerExecutor
 * @property {"opencode"|"pi"} id
 * @property {string} taskIdPrefix
 * @property {string} errorBucketPrefix
 * @property {string} defaultSummaryModel
 * @property {string} binaryName
 * @property {(env: NodeJS.ProcessEnv) => Promise<string>} listModelsFn
 * @property {(env: NodeJS.ProcessEnv, options?: {execFileFn?: typeof execFileAsync}) => Promise<Map<string, string[]>>} [listModelVariantsFn]
 * @property {(ctx: SpawnLaunchContext) => string[]} buildSpawnArgs
 * @property {() => string} buildSummaryPrompt
 * @property {(parsed: unknown) => unknown} normalizeLogEvent
 * @property {(ctx?: {isSummary: boolean}) => void | Promise<void>} [prepareLaunch] - optional async pre-spawn hook (e.g. awaiting a one-shot CLI version probe); the default is a no-op for executors that don't need one. Throws (sync) or rejects (async) to fail the dispatch with a clear error naming the preparation failure. Returns `void` when the probe is already cached (sync fast path); returns a `Promise` when the probe has to shell out.
 * @property {(args: {homeDir: string, dataDir: string, taskId: string, spawnEnv: NodeJS.ProcessEnv, existsFn: (file: string) => boolean, statFn?: (file: string) => {isDirectory: () => boolean}|null, lstatFn?: (file: string) => {isSymbolicLink: () => boolean, isFile?: () => boolean, nlink?: number}, readdirFn: (dir: string) => string[], realpathFn?: (file: string) => string, sessionId?: string|null, launchDirectory?: string|null}) => {extraRoBinds: [string, string][], extraRwPairBinds?: [string, string][], sandboxedDataHome: string, sandboxEnv: Record<string, string>}} sandboxAuthFile
 */

/**
 * @typedef {Object} SpawnLaunchContext
 * @property {boolean} isSummary
 * @property {string} model
 * @property {string} launchDirectory
 * @property {string|null} promptFilePath
 * @property {string} prompt
 * @property {string|null} sessionId
 * @property {string} [snapshotPath]
 * @property {string|null} [variant]
 * @property {string[]} [executorArgs]
 */

/**
 * @param {unknown} parsed
 * @returns {unknown|null}
 */
/** @param {Record<string, unknown>} evt */
function normalizeSessionEvent(evt) {
  return typeof evt.id === "string" ? { sessionID: evt.id } : null;
}

/** @param {Record<string, unknown>} evt */
function normalizeMessageUpdate(evt) {
  const { assistantMessageEvent, message } = evt;
  const inner = /** @type {Record<string, unknown>|undefined} */ (assistantMessageEvent);
  if (inner?.type !== "text_start" && inner?.type !== "text_delta") return null;
  const messageRecord = /** @type {Record<string, unknown>} */ (message);
  const messageID = typeof messageRecord?.responseId === "string" ? messageRecord.responseId : "__unknown_message__";
  const text = inner.type === "text_delta" && typeof inner.delta === "string" ? inner.delta : "";
  if (inner.type === "text_start") return null;
  return { type: "text", part: { type: "text", text, messageID } };
}

/** @param {Record<string, unknown>} evt */
function normalizeToolExecutionEnd(evt) {
  const { args } = evt;
  const toolName = typeof evt.toolName === "string" ? evt.toolName : "unknown";
  const result = /** @type {Record<string, unknown>} */ (evt.result);
  const outputText = Array.isArray(result?.content)
    ? result.content.filter((c) => c?.type === "text").map((c) => c.text).join("")
    : "";
  return {
    type: "tool_use",
    part: {
      type: "tool",
      tool: toolName,
      state: { input: args, output: outputText || undefined },
    },
  };
}

/**
 * A minimal marker for an in-progress tool call. pi previously dropped
 * tool_execution_start/tool_execution_update entirely (normalizeLogEvent
 * returned null), so a single long-running tool call -- a slow test suite,
 * a big build -- produced zero log growth for its whole duration; only
 * tool_execution_end ever wrote anything. That's real activity going
 * unrepresented in the log the no-output watchdog reads, independent of
 * this PR's own fix (log growth was already the loosest signal available;
 * this closes the gap on pi's write side, matching what the opencode
 * executor already does via its identity normalizeLogEvent). Keep the
 * payload minimal -- this is a liveness marker, not narration -- so it
 * doesn't inflate result()/summarize()'s token-visible output the way a
 * full tool_use event (with input/output) would.
 * @param {Record<string, unknown>} evt
 */
function normalizeToolExecutionHeartbeat(evt) {
  const toolName = typeof evt.toolName === "string" ? evt.toolName : "unknown";
  const toolCallId = typeof evt.toolCallId === "string" ? evt.toolCallId : null;
  return { type: "tool_progress", part: { type: "tool-progress", tool: toolName, toolCallId } };
}

/** @param {Record<string, unknown>} evt */
function normalizeAgentEnd(evt) {
  const messages = Array.isArray(evt.messages) ? evt.messages : [];
  let lastAssistant = null;
  for (const m of messages) {
    if (m && m.role === "assistant") lastAssistant = m;
  }
  if (!lastAssistant) return null;
  if (lastAssistant.stopReason === "error") {
    const errorMessage = typeof lastAssistant.errorMessage === "string" ? lastAssistant.errorMessage : "pi agent error";
    return {
      type: "error",
      message: errorMessage,
      error: { name: "pi_error", data: { message: errorMessage } },
    };
  }
  const messageID = typeof lastAssistant.responseId === "string" ? lastAssistant.responseId : "__unknown_message__";
  return {
    type: "step_finish",
    part: {
      type: "step-finish",
      reason: "stop",
      tokens: lastAssistant.usage,
      cost: lastAssistant.usage?.cost?.total ?? null,
      messageID,
    },
  };
}

/**
 * @param {unknown} parsed
 * @returns {unknown|null}
 */
function piNormalizeLogEvent(parsed) {
  const evt = /** @type {Record<string, unknown>} */ (parsed);
  switch (evt.type) {
    case "session": return normalizeSessionEvent(evt);
    case "message_update": return normalizeMessageUpdate(evt);
    case "tool_execution_start": return normalizeToolExecutionHeartbeat(evt);
    case "tool_execution_update": return normalizeToolExecutionHeartbeat(evt);
    case "tool_execution_end": return normalizeToolExecutionEnd(evt);
    case "agent_end": return normalizeAgentEnd(evt);
    default: return null;
  }
}

/** @param {{execFileFn?: typeof execFileAsync}} [options] @returns {import("./executor.js").WorkerExecutor} */
export function piExecutor({ execFileFn = execFileAsync } = {}) {
  return {
    id: "pi",
    taskIdPrefix: "pi",
    errorBucketPrefix: "pi",
    defaultSummaryModel: "minimax/MiniMax-M2.7",
    binaryName: "pi",
    /** @type {(env: NodeJS.ProcessEnv) => Promise<string>} */
    listModelsFn: async (env) => {
      const { stdout, stderr } = await execFileFn("pi", ["--list-models"], { encoding: "utf8", timeout: SUMMARY_PREFLIGHT_TIMEOUT_MS, env });
      /** @param {string} table @returns {string} */
      const normalizeTable = (table) => table.split("\n").map((line) => line.trim()).filter(Boolean).slice(1).map((line) => line.split(/\s+/).slice(0, 2).join("/")).join("\n");
      return normalizeTable(stderr) || normalizeTable(stdout);
    },
    /** @param {SpawnLaunchContext} ctx @returns {string[]} */
    // eslint-disable-next-line sonarjs/cyclomatic-complexity -- executorArgs passthrough adds one branch alongside existing provider/mode/session handling
    buildSpawnArgs(ctx) {
      const slash = ctx.model.indexOf("/");
      // Deliberately NOT providerOf()'s whole-string fallback: that value is a
      // scheduler map key, where any string works, but this one is pi's
      // --provider flag, which pi validates against its registered providers
      // ("Unknown provider" at startup otherwise). A slash-less model has no
      // provider to name, so omit the flag and let pi pick its own default.
      const provider = slash === -1 ? null : ctx.model.slice(0, slash);
      const modelName = slash === -1 ? ctx.model : ctx.model.slice(slash + 1);
      const args = provider ? ["--provider", provider, "--model", modelName] : ["--model", modelName];
      args.push("--mode", "json");
      if (ctx.sessionId) args.push("--continue", "--session", ctx.sessionId);
      if (!ctx.isSummary && ctx.variant) args.push("--thinking", ctx.variant);
      if (!ctx.isSummary && ctx.executorArgs?.length) args.push(...ctx.executorArgs);
      if (ctx.isSummary) args.push("-p", this.buildSummaryPrompt(), `@${ctx.snapshotPath}`);
      else if (ctx.promptFilePath) args.push("-p", PROMPT_FILE_INSTRUCTION, `@${ctx.promptFilePath}`);
      else args.push("-p", ctx.prompt);
      return args;
    },
    buildSummaryPrompt() {
      return SUMMARY_ISOLATION_PROMPT;
    },
    normalizeLogEvent: piNormalizeLogEvent,
    // dataDir must be real-disk storage (state dir), not the runtime dir's
    // small tmpfs: pi's sandboxed data home grows with every dispatch and an
    // unbounded tmpfs directory eventually starves the whole XDG_RUNTIME_DIR
    // (sockets, locks) of space.
    /** @param {{homeDir: string, dataDir: string, taskId: string, spawnEnv: NodeJS.ProcessEnv, existsFn: (file: string) => boolean, statFn?: (file: string) => {isDirectory: () => boolean}|null, lstatFn?: (file: string) => {isSymbolicLink: () => boolean, isFile?: () => boolean, nlink?: number}, readdirFn?: (dir: string) => string[], realpathFn?: (file: string) => string, sessionId?: string|null, launchDirectory?: string|null}} args @returns {{extraRoBinds: [string, string][], extraRwPairBinds?: [string, string][], sandboxedDataHome: string, sandboxEnv: Record<string, string>}} */
    sandboxAuthFile({ homeDir, dataDir, taskId: _taskId, spawnEnv, existsFn, statFn = fs.statSync, lstatFn = fs.lstatSync, readdirFn, realpathFn = fs.realpathSync, sessionId, launchDirectory }) {
      const realAgentDir = spawnEnv.PI_CODING_AGENT_DIR || path.join(homeDir, ".pi", "agent");
      const realAuthFile = path.join(realAgentDir, "auth.json");
      const realExtensionsDir = path.join(realAgentDir, "extensions");
      const realSessionsDir = path.join(realAgentDir, "sessions");
      const sandboxedDataHome = path.join(dataDir, "pi-data");
      const sandboxedSessionsHome = path.join(sandboxedDataHome, "sessions");
      /** @type {[string, string][]} */
      const extraRoBinds = [];
      // auth + extensions: custom providers live under PI_CODING_AGENT_DIR/extensions
      pushSafeRoBind(extraRoBinds, realAuthFile, path.join(sandboxedDataHome, "auth.json"), existsFn, lstatFn);
      pushSafeRoBind(extraRoBinds, realExtensionsDir, path.join(sandboxedDataHome, "extensions"), existsFn, lstatFn);
      // catalog: redirecting PI_CODING_AGENT_DIR hides models.json* -> Unknown provider
      pushPiCatalogBinds(extraRoBinds, realAgentDir, sandboxedDataHome, { existsFn, lstatFn, realpathFn });
      /** @type {[string, string][]} */
      const extraRwPairBinds = [];
      // single-file rw bind for resume only – whole-dir rw would expose session history
      const sessionBind = resolvePiSessionRwBind({ realSessionsDir, sandboxedSessionsHome, sessionId, launchDirectory, statFn, readdirFn, lstatFn });
      if (sessionBind) extraRwPairBinds.push(/** @type {[string, string]} */ (sessionBind));
      return {
        extraRoBinds,
        extraRwPairBinds,
        sandboxedDataHome,
        sandboxEnv: { PI_CODING_AGENT_DIR: sandboxedDataHome },
      };
    },
  };
}

/** The full set of executor names resolveExecutor() accepts. Single source of truth for
 * every layer (CLI args, RPC protocol) that validates a user-supplied --executor value. */
export const KNOWN_EXECUTORS = /** @type {readonly string[]} */ (["opencode", "pi"]);

/** @param {string|undefined} name @returns {import("./executor.js").WorkerExecutor} */
export function resolveExecutor(name) {
  if (name === undefined || name === "pi") return piExecutor();
  if (name === "opencode") return resolveOpencodeExecutor();
  throw new Error(`unknown executor: ${name}`);
}
