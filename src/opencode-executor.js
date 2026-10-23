/** @typedef {import("./executor.js").SpawnLaunchContext} SpawnLaunchContext */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { detectOpencodeCliMajor, ensureOpencodeCliMajor } from "./opencode-version.js";
import { appendPromptFileArgs, buildSummaryPrompt, identityLogEvent, isSafeBindSource, resolveConfigDirBinds } from "./executor-shared.js";
import { buildV2SandboxSpawn } from "./opencode-auth.js";
import { resolveXdgDataHome } from "./sandbox.js";

const execFileAsync = promisify(execFile);
const SUMMARY_PREFLIGHT_TIMEOUT_MS = 10000;
const LIST_MODEL_VARIANTS_TIMEOUT_MS = 30000;

// `opencode models --verbose` prints one model per block: a `provider/model`
// line at column 0 with no leading whitespace, followed by that model's
// full JSON description. The JSON body is not reliably indented -- real
// output puts `{`/`}` at column 0 too -- but no body line contains a
// slash, so a column-0 line containing a slash is always the next
// model-id line (provider ids may themselves contain slashes, e.g.
// openrouter's `provider/subprovider/model`). A block that fails to
// JSON.parse is skipped rather than aborting the whole listing; one
// malformed model must not cost every other model's variant data.
const OPENCODE_MODEL_ID_LINE = /^([^\s/]+\/.*)$/;

/**
 * @param {string} verboseOutput - raw stdout of `opencode models --verbose`
 * @returns {Map<string, string[]>}
 */
function parseOpencodeModelVariants(verboseOutput) {
  /** @type {Map<string, string[]>} */
  const result = new Map();
  const lines = verboseOutput.split("\n");
  /** @type {string|null} */
  let currentModel = null;
  /** @type {string[]} */
  let currentBlockLines = [];
  const flush = () => {
    if (!currentModel || currentBlockLines.length === 0) return;
    try {
      const parsed = JSON.parse(currentBlockLines.join("\n"));
      const keys = Object.keys(parsed.variants ?? {});
      if (keys.length > 0) result.set(currentModel, keys);
    } catch {
      // Malformed block for this one model -- skip it, keep going.
    }
  };
  for (const line of lines) {
    const idMatch = OPENCODE_MODEL_ID_LINE.exec(line);
    if (idMatch) {
      flush();
      currentModel = idMatch[1];
      currentBlockLines = [];
    } else if (currentModel) {
      currentBlockLines.push(line);
    } else {
      // Line before any model-id line (e.g. a header) -- ignore it.
    }
  }
  flush();
  return result;
}

/**
 * opencode 2.x `run` argv. 2.0 removed `--dir` (the run uses its process
 * cwd, which the spawn already sets to the launch directory), `--variant`
 * (now a `#variant` suffix on `-m`), and `--pure` (no replacement, so a
 * summary run loads the user's plugins). `--standalone` keeps each run in
 * its own private server, as every 1.x run was: without it `run` connects to
 * a shared background service, whose tools execute outside the bwrap
 * sandbox and outside the copy-on-write overlay. `--session` alone resumes
 * an existing session; `--continue` would mean "the last session".
 *
 * 2.x also has no `--pure`, so a plugin load prompt can pause the summary
 * child indefinitely mid-run; `--auto` accepts every plugin approval
 * automatically so the summary can finish without a human at the keyboard.
 * @param {SpawnLaunchContext} ctx
 * @returns {string[]}
 */
function buildOpencodeV2SpawnArgs(ctx) {
  const model = !ctx.isSummary && ctx.variant ? opencodeV2ModelWithVariant(ctx.model, ctx.variant) : ctx.model;
  // `--auto` skips the plugin approval prompt that would otherwise stall
  // the child. 1.x had `--pure` for the same job; 2.x removed it with no
  // replacement, so plugins always load and would block without `--auto`.
  // The summary child needs it for the same reason.
  const args = ["run", "--standalone", "--auto", "--format", "json", "-m", model];
  if (ctx.isSummary) args.push("-f", /** @type {string} */ (ctx.snapshotPath));
  if (ctx.sessionId) args.push("--session", ctx.sessionId);
  return appendPromptFileArgs(args, ctx);
}

/**
 * Apply the user's variant to the `-m` value on opencode 2.x. If the model
 * id already carries an explicit `#variant` suffix, the override *replaces*
 * the existing suffix rather than stacking (`x/y#high` + variant `max` =>
 * `x/y#max`, not `x/y#high#max`); the override also wins when the model
 * has no suffix at all. pi uses `--thinking <variant>` directly, so it
 * doesn't share this behavior.
 * @param {string} model
 * @param {string} variant
 * @returns {string}
 */
function opencodeV2ModelWithVariant(model, variant) {
  const hashIdx = model.indexOf("#");
  return hashIdx === -1 ? `${model}#${variant}` : `${model.slice(0, hashIdx)}#${variant}`;
}

/**
 * opencode 1.x `run` argv.
 * @param {SpawnLaunchContext} ctx
 * @returns {string[]}
 */
function buildOpencodeV1SpawnArgs(ctx) {
  const args = ctx.isSummary
    ? /** @type {string[]} */ (["run", "--dir", path.dirname(/** @type {string} */ (ctx.snapshotPath)), "--pure", "--format", "json", "-m", ctx.model, "-f", /** @type {string} */ (ctx.snapshotPath)])
    : ["run", "--dir", ctx.launchDirectory, "--auto", "--format", "json", "-m", ctx.model];
  if (ctx.sessionId) args.push("--continue", "--session", ctx.sessionId);
  if (!ctx.isSummary && ctx.variant) args.push("--variant", ctx.variant);
  return appendPromptFileArgs(args, ctx);
}


/**
 * The generic executor contract plus the opencode-only version probe, which
 * the daemon's boot warm-up reaches through the executor so a test's pinned
 * version is the one it sees.
 * @typedef {import("./executor.js").WorkerExecutor & {ensureCliMajor: () => Promise<number|null>}} OpencodeWorkerExecutor
 */

/**
 * @param {object} [options]
 * @param {() => number|null} [options.detectCliMajorFn] - synchronous cache read; defaults to detectOpencodeCliMajor() (uses the module-level memo + performance.now()). Returns null when no probe has succeeded yet or the cache is stale.
 * @param {() => Promise<number|null>} [options.ensureCliMajorFn] - async cache-or-probe; defaults to ensureOpencodeCliMajor({ execFileFn }). Returns null only when the probe failed (then `prepareLaunch` rejects with a clear error naming the failure).
 * @returns {OpencodeWorkerExecutor}
 */
export function opencodeExecutor({ detectCliMajorFn = () => detectOpencodeCliMajor(), ensureCliMajorFn = () => ensureOpencodeCliMajor() } = {}) {
  return {
    id: "opencode",
    taskIdPrefix: "oc",
    errorBucketPrefix: "opencode",
    defaultSummaryModel: "opencode/muse-spark-1.3-contributor-free",
    binaryName: "opencode",
    buildSandboxSpawn(args) {
      return args[1] === "--standalone" ? buildV2SandboxSpawn(args) : ["opencode", ...args];
    },
    listModelsFn: async (env) =>
      (await execFileAsync("opencode", ["models"], { encoding: "utf8", timeout: SUMMARY_PREFLIGHT_TIMEOUT_MS, env })).stdout,
    /** @param {NodeJS.ProcessEnv} env @param {{execFileFn?: typeof execFileAsync}} [options] @returns {Promise<Map<string, string[]>>} */
    listModelVariantsFn: async (env, { execFileFn = execFileAsync } = {}) => {
      const { stdout } = await execFileFn("opencode", ["models", "--verbose"], { encoding: "utf8", timeout: LIST_MODEL_VARIANTS_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, env });
      return parseOpencodeModelVariants(stdout);
    },
    /** @param {SpawnLaunchContext} ctx @returns {string[]} */
    buildSpawnArgs(ctx) {
      const major = detectCliMajorFn();
      // `null` means no successful probe yet (the launch path's
      // `prepareLaunch` would have rejected with a clear error first, so a
      // buildSpawnArgs call here with `null` is only possible from tests
      // that bypassed `prepareLaunch`). Treat it as 1.x in that case: the
      // probe's "fail the dispatch" promise is stronger than guessing.
      return (major ?? 1) >= 2 ? buildOpencodeV2SpawnArgs(ctx) : buildOpencodeV1SpawnArgs(ctx);
    },
    /**
     * Pre-spawn hook: ensures the opencode CLI major probe has resolved
     * before `buildSpawnArgs` is called. The fast path returns `undefined`
     * synchronously when the cache is already warm (the daemon's boot
     * warm-up populated it; the launch path stays sync and tests that
     * rely on the synchronous dispatch -> captured argv pattern keep
     * working). The slow path returns a Promise that resolves when the
     * one-shot probe completes; concurrent slow-path callers share the
     * in-flight Promise so a stampede after daemon boot only shells out
     * once.
     *
     * On a probe that returns `null` (binary missing, output unparseable,
     * etc.), throws/rejects with an error naming the failure so the
     * launch path can fail the dispatch with `crashed` instead of
     * silently guessing an argv.
     * @returns {void | Promise<void>}
     */
    prepareLaunch() {
      const cached = detectCliMajorFn();
      if (cached !== null) return undefined;
      return ensureCliMajorFn().then((major) => {
        if (major === null) {
          throw new Error("opencode CLI major version could not be detected (`opencode --version` failed or its output did not parse; the cause is on the daemon's stderr); fix the opencode install, then re-dispatch (failed probes are not cached)");
        }
        return undefined;
      });
    },
    /**
     * The override-aware cache-or-probe, for callers outside the launch path
     * (the daemon's boot warm-up and variants refresh) that must see the
     * same pinned version a test injected.
     * @returns {Promise<number|null>}
     */
    ensureCliMajor() {
      return ensureCliMajorFn();
    },
    normalizeLogEvent: identityLogEvent,
    // dataDir must be real-disk storage (state dir), not the runtime dir's
    // small tmpfs: opencode's snapshot store under here grows unbounded
    // across dispatches (no gc) and previously filled the whole
    // XDG_RUNTIME_DIR tmpfs, starving it of space for sockets/locks too.
    /** @param {{homeDir: string, dataDir: string, taskId: string, spawnEnv: NodeJS.ProcessEnv, existsFn: (file: string) => boolean, statFn?: (file: string) => {isDirectory: () => boolean}|null, lstatFn?: (file: string) => {isSymbolicLink: () => boolean, isFile?: () => boolean, nlink?: number}, readdirFn: (dir: string) => string[], realpathFn?: (file: string) => string, sessionId?: string|null, launchDirectory?: string|null}} args @returns {{extraRoBinds: [string, string][], extraRwPairBinds?: [string, string][], sandboxedDataHome: string, sandboxEnv: Record<string, string>, instructionsDest: string}} */
    sandboxAuthFile({ homeDir, dataDir, taskId, spawnEnv, existsFn, lstatFn = fs.lstatSync, readdirFn, realpathFn = fs.realpathSync }) {
      const realDataHome = resolveXdgDataHome(spawnEnv, homeDir);
      const realAuthFile = path.join(realDataHome, "opencode", "auth.json");
      // Per-task data home: every dispatch's opencode session state (its
      // sqlite db, logs, snapshots) lands in its own directory, so concurrent
      // dispatches never contend on one shared opencode.db (issue #501).
      const sandboxedDataHome = path.join(dataDir, "opencode-data", taskId);
      // opencode writes into its config dir on boot (a .gitignore, and a
      // default opencode.jsonc when none exists). The sandbox binds the root
      // read-only, so pointing XDG_CONFIG_HOME at the real ~/.config made that
      // boot write fail EROFS on any machine where opencode had not already
      // run -- a fresh CI runner, or a new user's very first dispatch. Nest
      // the sandboxed config home under sandboxedDataHome, which startTask()
      // already mkdirs and binds read-write, so the boot write has somewhere
      // to land without widening the sandbox.
      const sandboxedConfigHome = path.join(sandboxedDataHome, "config");
      const sandboxedConfigDir = path.join(sandboxedConfigHome, "opencode");
      /** @type {[string, string][]} */
      const extraRoBinds = existsFn(realAuthFile) && isSafeBindSource(realAuthFile, lstatFn) ? [[realAuthFile, path.join(sandboxedDataHome, "opencode", "auth.json")]] : [];
      // Bind the user's real config entries (custom provider definitions,
      // plugins, agents) in read-only so a sandboxed dispatch still resolves
      // the same models it would unsandboxed. .gitignore is skipped on
      // purpose: opencode rewrites it on boot, so a read-only bind there
      // would fail the same way the unredirected path did.
      const realConfigDir = path.join(spawnEnv.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "opencode");
      // lstat the config dir itself before trusting it: existsFn/readdirFn
      // follow a symlink, so a symlinked realConfigDir would let every entry
      // inside pass the per-entry guard while the whole tree points outside.
      // A symlinked dir is treated as absent (fail closed, same as an entry).
      // Per-entry symlinks are handled differently: dotfiles-managed setups
      // commonly symlink individual entries (opencode.json, plugins, etc.)
      // into a dotfiles repo, so a symlinked entry is resolved to its real
      // target and that target is bound read-only at the same sandboxed
      // destination, instead of being dropped. Dangling/unresolvable links
      // fail closed (skip with ENOENT-silent / non-ENOENT warning) and do
      // not crash the dispatch. Other bind sites (auth.json, pi session
      // binds) keep strict skip-symlink -- see isSafeBindSource -- for
      // different reasons: auth files are credential paths, where following
      // an unexpected symlink would expose a different file's contents, and
      // the pi session bind is read-write, where resolving would hand the
      // worker write access to the link target.
      extraRoBinds.push(
        ...resolveConfigDirBinds({ realConfigDir, sandboxedConfigDir, existsFn, lstatFn, readdirFn, realpathFn }),
      );
      return {
        sandboxedDataHome,
        extraRoBinds,
        sandboxEnv: { XDG_DATA_HOME: sandboxedDataHome, XDG_CONFIG_HOME: sandboxedConfigHome },
        // The sandboxed config dir's AGENTS.md, which opencode loads as its
        // global instructions. The config walk above leaves AGENTS.md
        // unbound; an explicit --ro-bind of an instructions file is mapped
        // here instead.
        instructionsDest: path.join(sandboxedConfigDir, "AGENTS.md"),
      };
    },
    buildSummaryPrompt,
  };
}







/**
 * Module-level override for the factory options `opencodeExecutor()` reads
 * when called with no arguments (the production path through
 * `resolveExecutor()`). Tests set this once at boot to pin the probe's
 * detection/seam to a fake `detectCliMajorFn`/`ensureCliMajorFn`/`execFileFn`
 * so neither `opencode --version` nor the real `opencode models` runs from
 * a test suite. Production never touches this: it stays an empty object,
 * and `opencodeExecutor()` falls through to its parameter defaults.
 * @type {{detectCliMajorFn?: () => number|null, ensureCliMajorFn?: () => Promise<number|null>, execFileFn?: typeof execFileAsync}}
 */
let opencodeExecutorOverride = {};

/**
 * Set (or clear with `{}`) the override for `opencodeExecutor()`'s factory
 * options. Called by `tasks.test-helpers.js`'s `buildManagerOptions()` to
 * inject the version pin, and never from production code.
 * @param {{detectCliMajorFn?: () => number|null, ensureCliMajorFn?: () => Promise<number|null>, execFileFn?: typeof execFileAsync}} [opts]
 */
export function setOpencodeExecutorOverride(opts = {}) {
  opencodeExecutorOverride = { ...opencodeExecutorOverride, ...opts };
}

/** Test-only: forget any opencodeExecutor() override. */
export function resetOpencodeExecutorOverride() {
  opencodeExecutorOverride = {};
}

/**
 * Apply the current opencodeExecutorOverride before producing a real
 * executor. The shared `resolveExecutor()` helper calls this so production
 * code (and tests that don't go through `makeManager`) see the same
 * factory args the helpers injected.
 * @returns {OpencodeWorkerExecutor}
 */
export function resolveOpencodeExecutor() {
  return opencodeExecutor(opencodeExecutorOverride);
}
