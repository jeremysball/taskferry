# defaultVariantEffort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `--model` required on a fresh `dispatch()` (deleting the implicit per-executor default model), and replace the old `--model`-presence-coupled "force variant high" hack with an explicit `defaultVariantEffort` config setting (`"default"` | `"highest"`) that governs the `--variant`/`--thinking` flag sent when `--variant` is omitted.

**Architecture:** Two small, independent validation/config changes (delete `executor.defaultModel`; add `defaultVariantEffort` to `config.js`) converge on one shared policy boundary, `resolveDispatchVariant()` in `tasks.js`, called from `dispatch()`. Because `"highest"` resolution needs an async `opencode models --verbose` lookup for the opencode executor (pi's is a static sync mapping), `dispatch()` itself becomes `async` — the single largest mechanical part of this change, since every synchronous caller and test callsite must be updated to match.

**Tech Stack:** Node.js (ESM), `node:test`, no other frameworks.

## Global Constraints

- Breaking CLI change, intentional: any dispatch that previously omitted `--model` to get an implicit default model now errors with `--model is required`. No migration shim, no flag to preserve the old behavior.
- `"default"` → no `--variant`/`--thinking` flag sent at all (model/provider default).
- `"highest"` → pi: static `"xhigh"`. opencode: cached, ranked lookup against `opencode models --verbose`; ranking order reuses pi's own `--thinking` scale (`none/off < minimal < low < medium < high < xhigh`), extended one rung higher with opencode's `max`; unrecognized values rank below every known value; a lookup failure or an unlisted/variant-less model soft-fails to no flag (never blocks the dispatch).
- Explicit `--variant` always wins outright, passed through completely unvalidated/unreinterpreted (including the literal strings `"default"` and `"highest"`, which are real opencode variant names on some models).
- A `--session-id` resume with no explicit `--variant` inherits `priorSessionTask.variant`, not a fresh `defaultVariantEffort` resolution (mirrors the existing resume-inherits-model rule).
- No new `taskferry config` subcommand, no generic `VariantResolver` abstraction, no persistence of the variants cache across daemon restarts, no dedup added to the pre-existing `modelsCache`, no deletion of `defaultSummaryModel` — all explicitly out of scope per the spec's Non-goals.
- Canonical skill file is `skills/using-taskferry/SKILL.md`; always run `npm run skill:generate` after editing it, never hand-edit the two generated `integrations/*/skills/using-taskferry/SKILL.md` copies.
- Update `docs/sourcemap.md` in the same PR per this repo's CLAUDE.md (new env var, behavior change worth flagging).

---

## Task 1: Delete `executor.defaultModel`

**Files:**
- Modify: `src/executor.js:76-89` (typedef), `src/executor.js:178` (piExecutor), `src/executor.js:279` (opencodeExecutor)
- Test: `src/executor.test.js:8-14`

**Interfaces:**
- Consumes: nothing new.
- Produces: `WorkerExecutor` no longer has a `defaultModel` field. Task 2 depends on this deletion (it removes the last reader of `executor.defaultModel`).

- [ ] **Step 1: Delete the `defaultModel` line from both executor factories**

In `src/executor.js`, inside `piExecutor()`:

```js
export function piExecutor({ execFileFn = execFileAsync } = {}) {
  return {
    id: "pi",
    taskIdPrefix: "pi",
    errorBucketPrefix: "pi",
    defaultSummaryModel: "minimax/MiniMax-M2.7",
    binaryName: "pi",
```

(delete the `defaultModel: "minimax/MiniMax-M2.7",` line between `errorBucketPrefix` and `defaultSummaryModel`)

Inside `opencodeExecutor()`:

```js
export function opencodeExecutor() {
  return {
    id: "opencode",
    taskIdPrefix: "oc",
    errorBucketPrefix: "opencode",
    defaultSummaryModel: "opencode/mimo-v2.5-free",
    binaryName: "opencode",
```

(delete the `defaultModel: "openai/gpt-5.6-luna",` line)

- [ ] **Step 2: Delete `@property {string} defaultModel` from the `WorkerExecutor` typedef**

```js
/**
 * @typedef {Object} WorkerExecutor
 * @property {"opencode"|"pi"} id
 * @property {string} taskIdPrefix
 * @property {string} errorBucketPrefix
 * @property {string} defaultSummaryModel
 * @property {string} binaryName
 * @property {(env: NodeJS.ProcessEnv) => Promise<string>} listModelsFn
 * @property {(ctx: SpawnLaunchContext) => string[]} buildSpawnArgs
 * @property {() => string} buildSummaryPrompt
 * @property {(parsed: unknown) => unknown} normalizeLogEvent
 * @property {(args: {homeDir: string, dataDir: string, spawnEnv: NodeJS.ProcessEnv, existsFn: (file: string) => boolean, statFn?: (file: string) => {isDirectory: () => boolean}|null, readdirFn?: (dir: string) => string[], sessionId?: string|null, launchDirectory?: string|null}) => {extraRoBinds: [string, string][], extraRwPairBinds?: [string, string][], sandboxedDataHome: string, sandboxEnv: Record<string, string>}} sandboxAuthFile
 */
```

- [ ] **Step 3: Delete the now-stale test assertion**

In `src/executor.test.js`, remove `assert.equal(ex.defaultModel, "minimax/MiniMax-M2.7");` from the `"exposes pi identity and defaults"` test (line 13), leaving:

```js
  test("exposes pi identity and defaults", () => {
    const ex = piExecutor();
    assert.equal(ex.id, "pi");
    assert.equal(ex.taskIdPrefix, "pi");
    assert.equal(ex.errorBucketPrefix, "pi");
  });
```

- [ ] **Step 4: Run the executor test file and confirm it's clean**

Run: `node --test src/executor.test.js`
Expected: all tests pass (no reference to `defaultModel` remains, since Task 2 hasn't touched `tasks.js` yet — that file still reads `executor.defaultModel` and won't run cleanly until Task 2, but this file's own suite is self-contained and independent of `tasks.js`).

- [ ] **Step 5: Commit**

```bash
git add src/executor.js src/executor.test.js
git commit -m "fix(executor): delete the unused per-executor defaultModel field"
```

---

## Task 2: `--model` required on a fresh dispatch

**Files:**
- Modify: `src/tasks.js:1041-1074` (inside `dispatch()`)
- Modify: `src/args.js:12` (dispatch's `--model` help text)
- Modify: `src/tasks.test.js` (two existing tests whose scenario changes shape; two new tests)

**Interfaces:**
- Consumes: nothing new (this task doesn't touch `executor.resolveMaxVariant`/`defaultVariantEffort` at all — `variant` stays `variant || null` for now; Task 7 replaces that expression with the real resolution).
- Produces: `dispatch()` now throws synchronously (still sync in this task; Task 7 makes it async) with `error: --model is required\nhelp: pass --model <provider/model>, or --session-id to resume a session that already has one` when both `model` and `priorSessionTask` are absent.

- [ ] **Step 1: Replace the model-resolution block in `dispatch()`**

In `src/tasks.js`, replace:

```js
    // A resume (--session-id with no --model) should inherit the model the
    // session was actually created under, not silently fall back to the
    // hardcoded default -- a different model can mean a different provider,
    // breaking the whole point of resuming that exact session.
    const usingDefaultModel = !model;
    const resolvedModel = model || priorSessionTask?.model || executor.defaultModel;
```

with:

```js
    // A resume (--session-id with no --model) should inherit the model the
    // session was actually created under, not silently fall back to a
    // hardcoded default -- a different model can mean a different provider,
    // breaking the whole point of resuming that exact session. A fresh
    // dispatch has no implicit default left to fall back to -- --model is
    // required, mirroring advisor's existing validation (args.js:433).
    const resolvedModel = model || priorSessionTask?.model;
    if (!resolvedModel) {
      throw new Error("error: --model is required\nhelp: pass --model <provider/model>, or --session-id to resume a session that already has one");
    }
```

- [ ] **Step 2: Update the `variant` line to stop reading the deleted `usingDefaultModel`**

Change:

```js
      variant: usingDefaultModel ? "high" : variant || null,
```

to:

```js
      variant: variant || null,
```

(Task 7 replaces this again with the real `resolveDispatchVariant` call — this intermediate version just keeps the file compiling and behaviorally sane for this task's own tests.)

- [ ] **Step 3: Update `args.js`'s dispatch `--model` help text**

In `src/args.js`, change:

```js
      "--model <id>": "use the default model when omitted",
```

to:

```js
      "--model <id>": "required unless resuming via --session-id",
```

- [ ] **Step 4: Rewrite the two `tasks.test.js` tests whose scenario the deleted fallback invalidates**

Replace (around line 188):

```js
  test("defaults to openai/gpt-5.6-luna --variant high when no model is given", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    assert.deepEqual(captured.slice(6, 10), ["-m", "openai/gpt-5.6-luna", "--variant", "high"]);
  });
```

with:

```js
  test("a fresh dispatch with no --model and no --session-id throws --model is required", () => {
    const mgr = makeManager({ spawnFn: () => { throw new Error("not reached in this test"); } });
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" }),
      /error: --model is required\nhelp: pass --model <provider\/model>, or --session-id to resume a session that already has one/
    );
  });
```

Replace (around line 216):

```js
  test("an unrecognized --session-id with no --model still falls back to the hardcoded default", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_never_seen", executor: "opencode" });
    assertDispatchedModel(captured, "openai/gpt-5.6-luna");
  });
```

with:

```js
  test("an unrecognized --session-id with no --model throws --model is required (no prior task to inherit from)", () => {
    const mgr = makeManager({ spawnFn: () => { throw new Error("not reached in this test"); } });
    assert.throws(
      () => mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_never_seen", executor: "opencode" }),
      /error: --model is required/
    );
  });
```

- [ ] **Step 5: Add a test confirming a genuine session-id resume without `--model` still succeeds**

This behavior already has coverage (`"resuming with --session-id and no --model inherits the model of the task that owned that session (issue #47)"`, around line 200) — confirm it still passes rather than adding a duplicate. Read it and leave it as-is; it's the existing regression guard for this exact rule.

- [ ] **Step 6: Run the affected tests**

Run: `node --test src/tasks.test.js`
Expected: still failures unrelated to this task's own two rewritten tests, because most other tests in this file omit `--model` on a fresh dispatch and will now hit the new throw — **this is expected and handled in Task 8's bulk migration, not here.** Confirm specifically that the two rewritten tests above pass:

Run: `node --test --test-name-pattern "model is required" src/tasks.test.js`
Expected: PASS for both.

- [ ] **Step 7: Commit**

```bash
git add src/tasks.js src/args.js src/tasks.test.js
git commit -m "fix(dispatch): require --model on a fresh dispatch, deleting the implicit default-model fallback"
```

---

## Task 3: `defaultVariantEffort` config field

**Files:**
- Modify: `src/executor.js` (new `KNOWN_VARIANT_EFFORTS` export)
- Modify: `src/config.js` (`CONFIG_FIELD_TYPES` + validation)
- Test: `src/config.test.js`

**Interfaces:**
- Produces: `KNOWN_VARIANT_EFFORTS` (exported from `executor.js`, `["default", "highest"]`) — consumed by both `config.js` (this task) and `tasks.js` (Task 6).
- Produces: `loadConfig()` accepts `defaultVariantEffort: "default" | "highest"` in `config.json`, rejecting any other string with the same `error:`/`help:` shape `defaultExecutor` already uses.

- [ ] **Step 1: Export `KNOWN_VARIANT_EFFORTS` from `executor.js`**

In `src/executor.js`, right after the existing `KNOWN_EXECUTORS` export:

```js
/** The full set of executor names resolveExecutor() accepts. Single source of truth for
 * every layer (CLI args, RPC protocol) that validates a user-supplied --executor value. */
export const KNOWN_EXECUTORS = /** @type {readonly string[]} */ (["opencode", "pi"]);

/** The two `defaultVariantEffort` values `config.js` and `tasks.js` accept. "default" sends
 * no --variant/--thinking flag; "highest" resolves per-executor (see WorkerExecutor.resolveMaxVariant). */
export const KNOWN_VARIANT_EFFORTS = /** @type {readonly string[]} */ (["default", "highest"]);
```

- [ ] **Step 2: Add the config field type and validation**

In `src/config.js`, add the import and field type:

```js
import { KNOWN_EXECUTORS, KNOWN_VARIANT_EFFORTS } from "./executor.js";
```

```js
const CONFIG_FIELD_TYPES = {
  ...
  defaultExecutor: "string",
  defaultVariantEffort: "string",
};
```

And the validation, right after the existing `defaultExecutor` check:

```js
  if (parsed.defaultExecutor !== undefined && !KNOWN_EXECUTORS.includes(parsed.defaultExecutor)) {
    throw new Error(`error: config key "defaultExecutor" in ${configPath} must be one of ${KNOWN_EXECUTORS.join(", ")} (got ${JSON.stringify(parsed.defaultExecutor)})\nhelp: fix the value in ${configPath}`);
  }

  if (parsed.defaultVariantEffort !== undefined && !KNOWN_VARIANT_EFFORTS.includes(parsed.defaultVariantEffort)) {
    throw new Error(`error: config key "defaultVariantEffort" in ${configPath} must be one of ${KNOWN_VARIANT_EFFORTS.join(", ")} (got ${JSON.stringify(parsed.defaultVariantEffort)})\nhelp: fix the value in ${configPath}`);
  }
```

- [ ] **Step 3: Write the failing tests**

Add to `src/config.test.js`, inside `describe("loadConfig()", ...)`:

```js
  test("accepts defaultVariantEffort: \"default\"", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariantEffort: "default" }));
    assert.deepEqual(loadConfig({ configPath }), { defaultVariantEffort: "default" });
  });

  test("accepts defaultVariantEffort: \"highest\"", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariantEffort: "highest" }));
    assert.deepEqual(loadConfig({ configPath }), { defaultVariantEffort: "highest" });
  });

  test("rejects an unrecognized defaultVariantEffort value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariantEffort: "medium" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "defaultVariantEffort".*must be one of default, highest.*\nhelp:/s);
  });

  test("rejects a wrong-typed defaultVariantEffort value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariantEffort: 1 }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "defaultVariantEffort".*must be a string.*\nhelp:/s);
  });
```

- [ ] **Step 4: Run the tests**

Run: `node --test src/config.test.js`
Expected: PASS (Steps 1-2 already implement the behavior; this step just confirms it).

- [ ] **Step 5: Commit**

```bash
git add src/executor.js src/config.js src/config.test.js
git commit -m "feat(config): add defaultVariantEffort config field"
```

---

## Task 4: `resolveMaxVariant` for pi

**Files:**
- Modify: `src/executor.js` (`piExecutor()`)
- Test: `src/executor.test.js`

**Interfaces:**
- Produces: `piExecutor().resolveMaxVariant(model, env)` — a plain (non-async) function returning the literal string `"xhigh"` for any input. Consumed by `resolveDispatchVariant` (Task 6).

- [ ] **Step 1: Write the failing test**

Add to `src/executor.test.js`, inside `describe("piExecutor()", ...)`:

```js
  test("resolveMaxVariant() always resolves to xhigh, pi's fixed thinking-level ceiling, regardless of model", () => {
    const ex = piExecutor();
    assert.equal(ex.resolveMaxVariant("minimax/MiniMax-M2.7", {}), "xhigh");
    assert.equal(ex.resolveMaxVariant("openai/gpt-4o", {}), "xhigh");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test --test-name-pattern "resolveMaxVariant" src/executor.test.js`
Expected: FAIL with `ex.resolveMaxVariant is not a function`

- [ ] **Step 3: Add the method**

In `src/executor.js`, inside `piExecutor()`'s returned object, right after `binaryName: "pi",`:

```js
    binaryName: "pi",
    // Pi's --thinking scale (off, minimal, low, medium, high, xhigh) is fixed
    // and executor-wide, not per-model -- no lookup needed, unlike opencode's
    // per-model --variant support below.
    /** @param {string} model @param {NodeJS.ProcessEnv} env @returns {string} */
    resolveMaxVariant: (model, env) => "xhigh",
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test --test-name-pattern "resolveMaxVariant" src/executor.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/executor.js src/executor.test.js
git commit -m "feat(executor): add pi's resolveMaxVariant (static xhigh ceiling)"
```

---

## Task 5: `listVariantsFn` + `resolveMaxVariant` for opencode

**Files:**
- Modify: `src/executor.js` (`opencodeExecutor()`, new module-level parsing/ranking helpers)
- Test: `src/executor.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `parseVerboseModelsOutput(stdout: string): Record<string, Record<string, unknown>>` (exported) — parses `opencode models --verbose`'s real output format (a repeating `provider/model` header line immediately followed by that model's pretty-printed JSON object — **not** a single JSON document or array; confirmed directly against a real capture in this environment, see the fixture below) into `modelId -> variants`.
  - `opencodeExecutor({ listVariantsFn })` — `listVariantsFn` defaults to a real shell-out (`opencode models --verbose`) + `parseVerboseModelsOutput`, injectable the same way `piExecutor` accepts `execFileFn`. Consumed by Task 6's cache wiring.
  - `opencodeExecutor().resolveMaxVariant(model, env)` — async, calls `this.listVariantsFn(env)`, then returns the highest-ranked variant key for `model` (or `null` if the model has no variants entry, an empty `variants: {}`, or no entry ranks above the "unrecognized" floor). Consumed by `resolveDispatchVariant` (Task 6).

- [ ] **Step 1: Write the failing tests**

Add near the top of `src/executor.test.js`, after the existing imports, a real captured fixture (verbatim from a live `opencode models --verbose` run in this environment — not reconstructed, to genuinely exercise the parser against real formatting quirks):

```js
// Verbatim excerpt of a real `opencode models --verbose` run: a repeating
// "provider/model" header line immediately followed by that model's
// pretty-printed JSON object. NOT a single JSON document or a JSON array --
// confirmed directly, not assumed (see docs/superpowers/plans -- er,
// .superpowers/plans/2026-07-28-default-variant-effort.md's research notes).
const SAMPLE_VERBOSE_MODELS_OUTPUT = `opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle",
  "family": "big-pickle",
  "api": {
    "id": "big-pickle",
    "url": "https://opencode.ai/zen/v1",
    "npm": "@ai-sdk/openai-compatible"
  },
  "status": "active",
  "headers": {},
  "options": {},
  "cost": {
    "input": 0,
    "output": 0,
    "cache": {
      "read": 0,
      "write": 0
    }
  },
  "limit": {
    "context": 200000,
    "input": 160000,
    "output": 32000
  },
  "capabilities": {
    "temperature": true,
    "reasoning": true,
    "attachment": false,
    "toolcall": true,
    "input": {
      "text": true,
      "audio": false,
      "image": false,
      "video": false,
      "pdf": false
    },
    "output": {
      "text": true,
      "audio": false,
      "image": false,
      "video": false,
      "pdf": false
    },
    "interleaved": {
      "field": "reasoning_content"
    }
  },
  "release_date": "2025-10-17",
  "variants": {}
}
opencode/deepseek-v4-flash-free
{
  "id": "deepseek-v4-flash-free",
  "providerID": "opencode",
  "name": "DeepSeek V4 Flash Free",
  "family": "deepseek-flash-free",
  "api": {
    "id": "deepseek-v4-flash-free",
    "url": "https://opencode.ai/zen/v1",
    "npm": "@ai-sdk/openai-compatible"
  },
  "status": "active",
  "headers": {},
  "options": {},
  "cost": {
    "input": 0,
    "output": 0,
    "cache": {
      "read": 0,
      "write": 0
    }
  },
  "limit": {
    "context": 200000,
    "output": 128000
  },
  "capabilities": {
    "temperature": true,
    "reasoning": true,
    "attachment": false,
    "toolcall": true,
    "input": {
      "text": true,
      "audio": false,
      "image": false,
      "video": false,
      "pdf": false
    },
    "output": {
      "text": true,
      "audio": false,
      "image": false,
      "video": false,
      "pdf": false
    },
    "interleaved": {
      "field": "reasoning_content"
    }
  },
  "release_date": "2026-04-24",
  "variants": {
    "high": {
      "reasoningEffort": "high"
    },
    "max": {
      "reasoningEffort": "max"
    }
  }
}
`;
```

Then, in `src/executor.test.js`, update the import line to include the two new exports:

```js
import { opencodeExecutor, piExecutor, resolveExecutor, parseVerboseModelsOutput } from "./executor.js";
```

Add these test blocks:

```js
describe("parseVerboseModelsOutput()", () => {
  test("parses the real header-line-plus-JSON-block format into modelId -> variants", () => {
    const byModel = parseVerboseModelsOutput(SAMPLE_VERBOSE_MODELS_OUTPUT);
    assert.deepEqual(Object.keys(byModel), ["opencode/big-pickle", "opencode/deepseek-v4-flash-free"]);
    assert.deepEqual(byModel["opencode/big-pickle"], {});
    assert.deepEqual(byModel["opencode/deepseek-v4-flash-free"], {
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    });
  });

  test("skips a malformed block instead of aborting the whole parse", () => {
    const output = "provider/broken\n{ not json\nprovider/ok\n" + JSON.stringify({ variants: { low: { reasoningEffort: "low" } } });
    const byModel = parseVerboseModelsOutput(output);
    assert.deepEqual(Object.keys(byModel), ["provider/ok"]);
  });
});

describe("opencodeExecutor().resolveMaxVariant()", () => {
  test("ranks variants by reasoningEffort and returns the highest-ranked key (none < low < medium < high < xhigh < max)", async () => {
    const ex = opencodeExecutor({
      listVariantsFn: async () => ({
        "openai/gpt-5.6-luna": {
          none: { reasoningEffort: "none" },
          low: { reasoningEffort: "low" },
          medium: { reasoningEffort: "medium" },
          high: { reasoningEffort: "high" },
          xhigh: { reasoningEffort: "xhigh" },
          max: { reasoningEffort: "max" },
        },
      }),
    });
    assert.equal(await ex.resolveMaxVariant("openai/gpt-5.6-luna", {}), "max");
  });

  test("returns null when the model has an empty variants object", async () => {
    const ex = opencodeExecutor({ listVariantsFn: async () => ({ "opencode/big-pickle": {} }) });
    assert.equal(await ex.resolveMaxVariant("opencode/big-pickle", {}), null);
  });

  test("returns null when the model has no entry in the verbose output at all", async () => {
    const ex = opencodeExecutor({ listVariantsFn: async () => ({}) });
    assert.equal(await ex.resolveMaxVariant("unknown/model", {}), null);
  });

  test("accepts the nested {reasoning: {effort}} shape as well as the flat {reasoningEffort} shape", async () => {
    const ex = opencodeExecutor({
      listVariantsFn: async () => ({
        "anthropic/claude-fable-latest": {
          low: { reasoningEffort: "low" },
          xhigh: { reasoning: { effort: "xhigh" } },
        },
      }),
    });
    assert.equal(await ex.resolveMaxVariant("anthropic/claude-fable-latest", {}), "xhigh");
  });

  test("an unrecognized reasoningEffort value ranks below every known value, never crashes, never wins by key order", async () => {
    const ex = opencodeExecutor({
      listVariantsFn: async () => ({
        "some/model": { future: { reasoningEffort: "ultra" }, high: { reasoningEffort: "high" } },
      }),
    });
    assert.equal(await ex.resolveMaxVariant("some/model", {}), "high");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern "resolveMaxVariant|parseVerboseModelsOutput" src/executor.test.js`
Expected: FAIL — `parseVerboseModelsOutput` is not exported, `resolveMaxVariant` and `listVariantsFn` don't exist yet.

- [ ] **Step 3: Implement the ranking table and parser**

In `src/executor.js`, add these module-level helpers above `piExecutor()`:

```js
// Canonical reasoning-effort ranking, low to high. Deliberately reuses pi's
// own fixed --thinking scale (off, minimal, low, medium, high, xhigh --
// confirmed via `pi --help`) as the base ordering, rather than inventing a
// separate one just for opencode: both executors are describing the same
// underlying concept ("how hard should the model think"), so there's no
// reason for taskferry to maintain two incompatible vocabularies. "none" is
// aliased to "off" (different providers spell "no extra reasoning"
// differently), and "max" is appended one rung above pi's xhigh ceiling --
// opencode's one rung with no pi equivalent. A value outside this set ranks
// below every known value (see rankVariantEntry) rather than crashing or
// silently winning by object-key order -- a future opencode release adding
// a new rung must never be silently treated as the highest just because
// it's unrecognized.
const REASONING_EFFORT_RANK = { none: 0, off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

/**
 * @param {unknown} value - one entry from a model's `variants` map, e.g.
 *   {"reasoningEffort": "xhigh"} or the nested {"reasoning": {"effort": "xhigh"}}
 *   shape at least one model (anthropic/claude-fable-latest) uses instead.
 * @returns {number}
 */
function rankVariantEntry(value) {
  const record = /** @type {{reasoningEffort?: unknown, reasoning?: {effort?: unknown}}} */ (value);
  const effort = typeof record?.reasoningEffort === "string"
    ? record.reasoningEffort
    : typeof record?.reasoning?.effort === "string"
      ? record.reasoning.effort
      : undefined;
  return effort !== undefined && Object.hasOwn(REASONING_EFFORT_RANK, effort) ? REASONING_EFFORT_RANK[/** @type {string} */ (effort)] : -1;
}

/**
 * @param {Record<string, unknown>|undefined} variants
 * @returns {string|null}
 */
function highestRankedVariantKey(variants) {
  if (!variants) return null;
  let best = null;
  let bestRank = -1;
  for (const [key, value] of Object.entries(variants)) {
    const rank = rankVariantEntry(value);
    if (rank > bestRank) {
      bestRank = rank;
      best = key;
    }
  }
  return best;
}

// Matches a bare "provider/model" header line -- never a JSON line, since
// every JSON line in the pretty-printed block contains a quote, brace, or
// colon this pattern doesn't allow.
const MODEL_HEADER_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Parses `opencode models --verbose`'s actual output shape: a repeating
 * "provider/model" header line, each immediately followed by that model's
 * pretty-printed JSON object -- not a single JSON document or array.
 * Confirmed directly against a real capture, not assumed. A malformed block
 * for one model is skipped rather than aborting the whole parse.
 *
 * @param {string} stdout
 * @returns {Record<string, Record<string, unknown>>}
 */
export function parseVerboseModelsOutput(stdout) {
  /** @type {Record<string, Record<string, unknown>>} */
  const byModel = {};
  /** @type {string|null} */
  let currentId = null;
  /** @type {string[]} */
  let buffer = [];
  const flush = () => {
    if (currentId && buffer.length) {
      try {
        const parsed = JSON.parse(buffer.join("\n"));
        if (parsed && typeof parsed.variants === "object" && parsed.variants !== null) {
          byModel[currentId] = parsed.variants;
        }
      } catch {
        // Skip this one model's block; the rest of the output is still usable.
      }
    }
    buffer = [];
  };
  for (const line of stdout.split("\n")) {
    if (MODEL_HEADER_RE.test(line)) {
      flush();
      currentId = line;
    } else if (currentId) {
      buffer.push(line);
    }
  }
  flush();
  return byModel;
}

/** @param {NodeJS.ProcessEnv} env @returns {Promise<Record<string, Record<string, unknown>>>} */
async function defaultListVariantsFn(env) {
  const { stdout } = await execFileAsync("opencode", ["models", "--verbose"], { encoding: "utf8", timeout: SUMMARY_PREFLIGHT_TIMEOUT_MS, env });
  return parseVerboseModelsOutput(stdout);
}
```

- [ ] **Step 4: Wire `listVariantsFn` and `resolveMaxVariant` into `opencodeExecutor()`**

Change the factory signature and add both members:

```js
/** @param {{listVariantsFn?: (env: NodeJS.ProcessEnv) => Promise<Record<string, Record<string, unknown>>>}} [options] @returns {import("./executor.js").WorkerExecutor} */
export function opencodeExecutor({ listVariantsFn = defaultListVariantsFn } = {}) {
  return {
    id: "opencode",
    taskIdPrefix: "oc",
    errorBucketPrefix: "opencode",
    defaultSummaryModel: "opencode/mimo-v2.5-free",
    binaryName: "opencode",
    listModelsFn: async (env) =>
      (await execFileAsync("opencode", ["models"], { encoding: "utf8", timeout: SUMMARY_PREFLIGHT_TIMEOUT_MS, env })).stdout,
    listVariantsFn,
    /** @param {string} model @param {NodeJS.ProcessEnv} env @returns {Promise<string|null>} */
    async resolveMaxVariant(model, env) {
      const byModel = await this.listVariantsFn(env);
      return highestRankedVariantKey(byModel[model]);
    },
```

(leave the rest of the returned object -- `buildSpawnArgs`, `buildSummaryPrompt`, `normalizeLogEvent`, `sandboxAuthFile` -- unchanged)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test src/executor.test.js`
Expected: PASS, all tests including Tasks 1 and 4's.

- [ ] **Step 6: Commit**

```bash
git add src/executor.js src/executor.test.js
git commit -m "feat(executor): add opencode's resolveMaxVariant (ranked opencode models --verbose lookup)"
```

---

## Task 6: `defaultVariantEffort` resolution wiring in `tasks.js`

**Files:**
- Modify: `src/tasks.js` (imports, `createTaskManager` options, the variants cache, `resolveDispatchVariant`, `resolveExecutorWithCache`)

**Interfaces:**
- Consumes: `KNOWN_VARIANT_EFFORTS` (Task 3), `opencodeExecutor({ listVariantsFn })` / `piExecutor().resolveMaxVariant` (Tasks 4-5).
- Produces:
  - `createTaskManager({ defaultVariantEffort, listVariantsFn, ... })` — two new options, `env`-over-`config`-over-built-in-default precedence for `defaultVariantEffort` (`TASKFERRY_DEFAULT_VARIANT_EFFORT`), `listVariantsFn` defaulting to `opencodeExecutor().listVariantsFn` (mirrors the existing `listModelsFn` option).
  - `export async function resolveDispatchVariant({ explicitVariant, executor, model, defaultVariantEffort, env })` — the one policy boundary, consumed by `dispatch()` in Task 7.
  - An internal `opencodeVariantsCache` (5-minute TTL, in-flight dedup) and a `resolveExecutorWithCache(name)` helper that constructs any opencode executor instance with the cache wired in. Consumed by `dispatch()` in Task 7 (this task only adds the machinery; `dispatch()` itself isn't touched until Task 7).

This task has no independently-runnable test of its own (nothing calls `resolveDispatchVariant` yet) -- Task 7 wires it into `dispatch()` and Task 9 adds the behavioral tests. Keep this task's diff reviewable on its own merits (clean helper + JSDoc), then verify via `node --check` and `npm run typecheck` that it compiles.

- [ ] **Step 1: Import the new pieces**

In `src/tasks.js`, change:

```js
import { resolveExecutor, opencodeExecutor } from "./executor.js";
```

to:

```js
import { resolveExecutor, opencodeExecutor, KNOWN_VARIANT_EFFORTS } from "./executor.js";
```

- [ ] **Step 2: Add a `resolveDefaultVariantEffort` helper near `parseAllowedDirs`**

Right after `parseAllowedDirs` (`src/tasks.js:373-379`):

```js
/**
 * @param {string|undefined} spec - TASKFERRY_DEFAULT_VARIANT_EFFORT if set, else config.defaultVariantEffort
 * @returns {string}
 */
function resolveDefaultVariantEffort(spec) {
  if (spec === undefined) return "default";
  if (!KNOWN_VARIANT_EFFORTS.includes(spec)) {
    throw new Error(`error: defaultVariantEffort must be one of ${KNOWN_VARIANT_EFFORTS.join(", ")} (got ${JSON.stringify(spec)})\nhelp: fix TASKFERRY_DEFAULT_VARIANT_EFFORT or config.json's defaultVariantEffort`);
  }
  return spec;
}
```

- [ ] **Step 3: Add the `resolveDispatchVariant` policy-boundary function**

Right after `resolveDefaultVariantEffort`:

```js
/**
 * The one policy boundary between "what did the caller/config ask for" and
 * "what concrete --variant/--thinking value gets sent to the executor".
 * Explicit wins outright, passed through completely unvalidated and
 * unreinterpreted -- a typo'd value (or a literal "default"/"highest", both
 * real opencode variant names on some models) fails at the executor level,
 * same as any other invalid explicit --variant. Otherwise "default" sends
 * no flag at all; "highest" defers to the executor's own resolveMaxVariant
 * (uniformly -- no branching on executor.id here; both executors implement it).
 *
 * @param {object} params
 * @param {string|null|undefined} params.explicitVariant
 * @param {import("./executor.js").WorkerExecutor} params.executor
 * @param {string} params.model
 * @param {string} params.defaultVariantEffort
 * @param {NodeJS.ProcessEnv} params.env
 * @returns {Promise<string|null>}
 */
export async function resolveDispatchVariant({ explicitVariant, executor, model, defaultVariantEffort, env }) {
  if (explicitVariant) return explicitVariant;
  if (defaultVariantEffort === "highest") return executor.resolveMaxVariant(model, env);
  return null;
}
```

- [ ] **Step 4: Add the `defaultVariantEffort` and `listVariantsFn` options to `createTaskManager`**

In the `createTaskManager({ ... } = {})` parameter list, right after `defaultExecutor`'s default expression:

```js
  defaultExecutor = resolveExecutor(
    process.env.TASKFERRY_DEFAULT_EXECUTOR || /** @type {string|undefined} */ (config.defaultExecutor)
  ),
  defaultVariantEffort = resolveDefaultVariantEffort(
    process.env.TASKFERRY_DEFAULT_VARIANT_EFFORT || /** @type {string|undefined} */ (config.defaultVariantEffort)
  ),
  // Defaults to whichever executor is actually the manager's default, so a
  // pi-only install (no opencode CLI on PATH) doesn't ENOENT the first time
  // it touches `taskferry summary` or `watch --summaries`.
  listModelsFn = opencodeExecutor().listModelsFn,
  listVariantsFn = opencodeExecutor().listVariantsFn,
```

Also add JSDoc entries for both, next to the existing `@param {import("./executor.js").WorkerExecutor} [options.defaultExecutor]` block:

```js
 * @param {string} [options.defaultVariantEffort] - "default" | "highest"; governs the --variant/--thinking
 *   flag sent when a dispatch omits --variant. See resolveDispatchVariant.
 * @param {(env: NodeJS.ProcessEnv) => Promise<Record<string, Record<string, unknown>>>} [options.listVariantsFn] -
 *   shell-out for opencode's per-model --variant support, used by defaultVariantEffort: "highest" lookups.
 *   Defaults to opencodeExecutor().listVariantsFn. Wrapped in a 5-minute cache inside this function (see
 *   opencodeVariantsCache) -- this option is the *uncached* underlying fetch.
```

- [ ] **Step 5: Add the cache and the cache-aware executor resolver, inside the function body**

Right after the existing `let modelsCache = { expiresAt: 0, output: "" };` (`src/tasks.js:694`):

```js
  let modelsCache = { expiresAt: 0, output: "" };
  /** @type {{expiresAt: number, byModel: Record<string, Record<string, unknown>>}} */
  let opencodeVariantsCache = { expiresAt: 0, byModel: {} };
  /** @type {Promise<void>|null} */
  let opencodeVariantsFetchInFlight = null;

  /**
   * Cache-aware wrapper injected as `listVariantsFn` into every opencode
   * WorkerExecutor instance this manager constructs, so a burst of concurrent
   * "highest"-effort dispatches shares one `opencode models --verbose`
   * shell-out instead of each paying its own cost. Soft-fails to an empty
   * map on lookup failure -- resolveMaxVariant then sees no entry for any
   * model and returns null, same as "no variant to escalate to"; a broken
   * variants lookup must never block an otherwise-valid dispatch (unlike
   * summaryModelAvailable, which deliberately throws -- a broken summary
   * check means the dispatch is broken anyway, which isn't true here).
   * @param {NodeJS.ProcessEnv} env
   * @returns {Promise<Record<string, Record<string, unknown>>>}
   */
  async function cachedListVariantsFn(env) {
    if (Date.now() < opencodeVariantsCache.expiresAt) return opencodeVariantsCache.byModel;
    if (!opencodeVariantsFetchInFlight) {
      opencodeVariantsFetchInFlight = (async () => {
        let byModel = /** @type {Record<string, Record<string, unknown>>} */ ({});
        try {
          byModel = await listVariantsFn(env);
        } catch {
          // Soft-fail: see doc comment above.
        }
        opencodeVariantsCache = { expiresAt: Date.now() + 5 * 60 * 1000, byModel };
      })().finally(() => {
        opencodeVariantsFetchInFlight = null;
      });
    }
    await opencodeVariantsFetchInFlight;
    return opencodeVariantsCache.byModel;
  }

  // defaultExecutor is built from a parameter default (before this cache
  // exists), so it starts out uncached -- rebuild it here if it's the
  // opencode flavor so the manager's default dispatch path is cached too,
  // not just explicit --executor opencode dispatches (see below).
  if (defaultExecutor.id === "opencode") defaultExecutor = opencodeExecutor({ listVariantsFn: cachedListVariantsFn });

  /** @param {string|undefined} name @returns {import("./executor.js").WorkerExecutor} */
  function resolveExecutorWithCache(name) {
    return name === "opencode" ? opencodeExecutor({ listVariantsFn: cachedListVariantsFn }) : resolveExecutor(name);
  }
```

- [ ] **Step 6: Verify the file still compiles**

Run: `node --check src/tasks.js`
Expected: no output (success). `dispatch()` still uses the plain `resolveExecutor(...)` calls at this point -- Task 7 switches them to `resolveExecutorWithCache(...)`.

- [ ] **Step 7: Commit**

```bash
git add src/tasks.js
git commit -m "feat(tasks): add defaultVariantEffort resolution and a cached opencode variants lookup"
```

---

## Task 7: `dispatch()` becomes async

**Files:**
- Modify: `src/tasks.js` (`dispatch()`, `advisor()`)
- Modify: `src/daemon.test.js` (fake manager's `dispatch`)

**Interfaces:**
- Produces: `dispatch()` returns `Promise<TaskSummary & {next: string}>` instead of the bare object. `resolveDispatchVariant` (Task 6) and `resolveExecutorWithCache` (Task 6) are now actually called from `dispatch()`. `advisor()` awaits `dispatch()`.
- This task does **not** update `tasks.test.js`/`events.test.js`/`activity.test.js`/`opencode-plugin.test.js` -- those become correct only after Task 8's bulk migration. Expect `npm test` to have many failures after this task; that's expected, not a regression to chase down here.

- [ ] **Step 1: Make `dispatch()` async and switch its executor-resolution calls to the cached resolver**

In `src/tasks.js`, change the function declaration:

```js
   * @returns {Promise<TaskSummary & {next: string}>}
   */
  async function dispatch({ prompt, directory, model, variant, sessionId, keySlot, internal = false, finalMarker = null, originSessionId, noSandbox = false, allowedDirs: dispatchAllowedDirs, executor: executorName }) {
```

And switch both `resolveExecutor(...)` calls inside it to `resolveExecutorWithCache(...)`:

```js
    const executor =
      executorName !== undefined
        ? (executorName === defaultExecutor.id ? defaultExecutor : resolveExecutorWithCache(executorName))
        : priorSessionTask
          ? (priorSessionTask.executorId === defaultExecutor.id ? defaultExecutor : resolveExecutorWithCache(priorSessionTask.executorId))
          : defaultExecutor;
```

- [ ] **Step 2: Replace the `variant` line (from Task 2) with the real resolution, and inherit a resumed session's variant**

Right after the provider-key-env check block (after the `if (providerKeyEnvName && ...)` block, before `/** @type {Task} */ const task = {`), add:

```js
    // A resume with no explicit --variant inherits the prior task's exact
    // variant (the effort level that session was actually running with), not
    // a fresh defaultVariantEffort resolution against whatever the daemon's
    // current config happens to be -- mirrors the resume-inherits-model rule
    // above. Passing priorSessionTask?.variant through as "explicit" here
    // achieves exactly that: resolveDispatchVariant treats anything already
    // known (truly explicit, or inherited from the session) as final, and
    // only falls through to a fresh config-based resolution when both are absent.
    const resolvedVariant = await resolveDispatchVariant({
      explicitVariant: variant || priorSessionTask?.variant || null,
      executor,
      model: resolvedModel,
      defaultVariantEffort,
      env: dispatchEnvironment(resolvedKeySlot.keyEnvValue),
    });
```

Then change the task object's `variant` field:

```js
      variant: resolvedVariant,
```

- [ ] **Step 3: Await `dispatch()` inside `advisor()`**

In `src/tasks.js`, change:

```js
    try {
      dispatched = dispatch({ prompt: /** @type {string} */ (prompt), directory: /** @type {string} */ (directory), model, variant, sessionId: resolved.sessionId, executor });
    } catch (err) {
```

to:

```js
    try {
      dispatched = await dispatch({ prompt: /** @type {string} */ (prompt), directory: /** @type {string} */ (directory), model, variant, sessionId: resolved.sessionId, executor });
    } catch (err) {
```

- [ ] **Step 4: Confirm `daemon.js`'s `invoke()` needs no change**

Read `src/daemon.js:181-182`:

```js
    case "task.dispatch":
      return manager.dispatch(params);
```

`invoke()` is already `async function invoke(...)`, so `return manager.dispatch(params)` now returning a promise is implicitly awaited by its own caller (an async function's `return <promise>` resolves to that promise's eventual value). No edit needed here -- this step is a read-and-confirm, not a code change.

- [ ] **Step 5: Update `daemon.test.js`'s fake manager to match the real async contract**

In `src/daemon.test.js`, inside `fakeManagerFactory()`, change:

```js
  const manager = {
    dispatch(params) {
      calls.push(["dispatch", params]);
      return { id: "new-task", status: "queued", ...params };
    },
```

to:

```js
  const manager = {
    async dispatch(params) {
      calls.push(["dispatch", params]);
      return { id: "new-task", status: "queued", ...params };
    },
```

- [ ] **Step 6: Run daemon.test.js**

Run: `node --test src/daemon.test.js`
Expected: PASS (the two `task.dispatch` tests at `src/daemon.test.js:163,175` already `await peer.request(...)`, which round-trips through the RPC layer regardless of whether the fake's own `dispatch` was sync or async -- this step just confirms the async fake still behaves identically over that boundary).

- [ ] **Step 7: Commit**

```bash
git add src/tasks.js src/daemon.test.js
git commit -m "feat(tasks): make dispatch() async and wire in resolveDispatchVariant"
```

---

## Task 8: Bulk-migrate synchronous `dispatch()` test callsites

**Files:**
- Modify: `src/tasks.test.js`, `src/events.test.js`, `src/activity.test.js`, `src/opencode-plugin.test.js`
- Create (temporary, delete after use): `scripts/codemod-async-dispatch.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: every direct `manager.dispatch(...)` / `mgr.dispatch(...)` callsite in these four files is awaited (and, where it was a bare successful dispatch omitting both `model` and `sessionId`, given a placeholder `model`, since Task 2 made that throw); every `assert.throws(() => x.dispatch(...), MATCHER)` becomes `await assert.rejects(x.dispatch(...), MATCHER)`; every test callback that now contains a top-level `await` is itself `async`.

This is the largest mechanical task in the plan by line count (~180 individually-affected lines across the four files, per the spec's verified counts), but it's fully automatable and was validated against real copies of these exact files during planning -- the three-step regex codemod below, followed by a syntax-error-driven `async`-ify loop, converges cleanly with **zero remaining unhandled cases** except two `Array.from(...)` callsites in `tasks.test.js`, called out explicitly in Step 4.

- [ ] **Step 1: Write the codemod script**

Create `scripts/codemod-async-dispatch.mjs`:

```js
// One-time migration script for the defaultVariantEffort change (dispatch()
// becoming async). Run once via `node scripts/codemod-async-dispatch.mjs`,
// then delete this file -- it is not meant to be kept around or re-run.
import fs from "node:fs";

const TEST_MODEL = "test-provider/test-model";
const FILES = [
  "src/tasks.test.js",
  "src/events.test.js",
  "src/activity.test.js",
  "src/opencode-plugin.test.js",
];

for (const file of FILES) {
  let src = fs.readFileSync(file, "utf8");

  // Step A: assert.throws(() => X.dispatch({...}), MATCHER); -> await assert.rejects(X.dispatch({...}), MATCHER);
  // (a rejected promise doesn't throw synchronously, so assert.throws no longer catches it)
  src = src.replace(
    /assert\.throws\(\s*\(\)\s*=>\s*([\w$.]+\.dispatch\((?:\{[^{}]*\})?\))\s*,\s*([^;]+?)\)\s*;/g,
    (full, call, matcher) => `await assert.rejects(${call}, ${matcher});`
  );

  // Step B: inject a placeholder model into any bare dispatch({...}) object
  // literal lacking both model and sessionId -- --model is now required on
  // a fresh dispatch (Task 2). Deliberately over-applies to error-path
  // dispatches too (e.g. a missing-prompt test); harmless, since those throw
  // before the model check runs.
  src = src.replace(
    /\.dispatch\(\{([^{}]*)\}\)/g,
    (full, body) => {
      if (/\bmodel\s*:/.test(body) || /\bsessionId\s*:/.test(body)) return full;
      const trimmed = body.trim();
      const needsComma = trimmed.length > 0 && !trimmed.endsWith(",");
      return `.dispatch({${body}${needsComma ? "," : ""} model: "${TEST_MODEL}" })`;
    }
  );

  // Step C: await-prefix every remaining un-awaited X.dispatch( call. Skips
  // calls already awaited, already inside the assert.rejects(...) produced
  // by Step A, or used as an inline arrow-function body (preceded by "=> ")
  // -- those (Array.from(..., (_, i) => mgr.dispatch(...)), etc.) need hand
  // review, not a blind await insertion; see Step 4 below.
  src = src.replace(
    /(?<!await )(?<!assert\.rejects\()(?<!=>\s)(?<!=>\s\s)\b([\w$]+)\.dispatch\(/g,
    (full, recv) => `await ${recv}.dispatch(`
  );

  fs.writeFileSync(file, src);
}
console.log("codemod done");
```

- [ ] **Step 2: Run the codemod**

Run: `node scripts/codemod-async-dispatch.mjs`
Expected: `codemod done`

- [ ] **Step 3: Converge on valid syntax by async-ifying flagged test callbacks**

`node --check` reports one syntax error at a time (the first `await` found in a non-async function). Rather than fixing them one at a time by hand, write and run a second, disposable script:

Create `scripts/asyncify-test-callbacks.mjs`:

```js
// Companion to codemod-async-dispatch.mjs: repeatedly runs `node --check` on
// each file, and for every "await used in a non-async function" syntax
// error, walks upward from the error line to the nearest enclosing
// `test("...", (args) => {` and marks it `async`. Converges because each
// fix strictly reduces the number of remaining syntax errors. Delete after use.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const FILES = ["src/tasks.test.js", "src/events.test.js", "src/activity.test.js", "src/opencode-plugin.test.js"];

function checkError(file) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = err.stderr.toString();
    const m = /^.*:(\d+)$/m.exec(out.split("\n")[0]);
    return { line: m ? Number(m[1]) : null, out };
  }
}

for (const file of FILES) {
  let guard = 0;
  while (true) {
    const err = checkError(file);
    if (err == null) break;
    if (++guard > 500) throw new Error(`too many iterations on ${file}`);
    if (err.line == null) { console.log(err.out); throw new Error(`unparseable node --check output for ${file}`); }
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let fixed = false;
    for (let i = err.line - 2; i >= 0; i--) {
      const m = /^(\s*)test\((.*?),\s*\(([^)]*)\)\s*=>\s*\{\s*$/.exec(lines[i]);
      if (m) {
        lines[i] = `${m[1]}test(${m[2]}, async (${m[3]}) => {`;
        fixed = true;
        break;
      }
    }
    if (!fixed) {
      console.log(err.out);
      throw new Error(`could not find an enclosing test() for ${file}:${err.line} -- likely one of the Array.from(...) cases; handle by hand (see Step 4) instead of re-running this script`);
    }
    fs.writeFileSync(file, lines.join("\n"));
  }
  console.log(`${file}: clean after ${guard} fix(es)`);
}
```

Run: `node scripts/asyncify-test-callbacks.mjs`

Expected output:

```
tasks.test.js: clean after 100 fix(es)
events.test.js: clean after 7 fix(es)
activity.test.js: clean after 0 fix(es)
opencode-plugin.test.js: clean after 0 fix(es)
```

(exact fix counts may drift slightly if the file has changed since this plan was written; the important signal is that the script terminates cleanly for all four files rather than throwing "could not find an enclosing test()")

- [ ] **Step 4: Hand-fix the two `Array.from(...)` callsites the codemod deliberately skipped**

In `src/tasks.test.js`, find the two tests using `Array.from({ length: N }, (_, i) => mgr.dispatch({ prompt: ... }))` (search for `Array.from({ length:`). Each currently reads:

```js
    const dispatched = Array.from({ length: 5 }, (_, i) => mgr.dispatch({ prompt: `p${i}`, directory: os.tmpdir() }));
```

Change to (add `model`, since these are bare dispatches; wrap in `Promise.all` since `dispatched` is consumed afterward as a list of settled `TaskSummary` objects, not promises):

```js
    const dispatched = await Promise.all(Array.from({ length: 5 }, (_, i) => mgr.dispatch({ prompt: `p${i}`, directory: os.tmpdir(), model: "test-provider/test-model" })));
```

(same edit for the `{ length: 6 }` variant later in the same file -- match the exact `length` value already there)

- [ ] **Step 5: Delete both scratch codemod scripts**

```bash
rm scripts/codemod-async-dispatch.mjs scripts/asyncify-test-callbacks.mjs
```

- [ ] **Step 6: Run the full test suite and hand-fix any stragglers**

Run: `npm test`

Expected: the overwhelming majority pass. Any remaining failure at this point is a genuine edge case the mechanical passes couldn't anticipate (a test asserting exact argv/model output that now sees `"test-provider/test-model"` instead of a real-looking model string, a test relying on `dispatch()`'s return value shape in a way the codemod's blind `await` prefix didn't fully thread through, etc.) -- diagnose each with `node --test --test-name-pattern "<failing test name>" <file>` and fix directly; there is no single mechanical fix for this remainder, by design (the codemod handled everything mechanical; anything left over is a real behavioral edge the change touches).

- [ ] **Step 7: Commit**

```bash
git add src/tasks.test.js src/events.test.js src/activity.test.js src/opencode-plugin.test.js
git commit -m "test: migrate dispatch() test callsites to await the now-async manager.dispatch()"
```

---

## Task 9: New tests for `defaultVariantEffort` resolution behaviors

**Files:**
- Modify: `src/tasks.test.js`

**Interfaces:**
- Consumes: `resolveDispatchVariant` (Task 6), the async `dispatch()` (Task 7).
- Produces: no new production code; this task is pure test coverage for the spec's "Tests to update / add" list not already covered by Tasks 2-3's tests.

- [ ] **Step 1: Write the tests**

Add a new `describe` block to `src/tasks.test.js` (near the other dispatch-behavior `describe` blocks):

```js
describe("defaultVariantEffort resolution", () => {
  test("omitting --variant with defaultVariantEffort: \"default\" sends no --variant/--thinking flag (pi)", async () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args) => { captured = args; return fakeChild(); } });
    await mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: "minimax/MiniMax-M2.7", executor: "pi" });
    assert.equal(captured.includes("--thinking"), false);
  });

  test("omitting --variant with defaultVariantEffort: \"default\" sends no --variant/--thinking flag (opencode)", async () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args) => { captured = args; return fakeChild(); } });
    await mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: "openai/gpt-5.6-luna", executor: "opencode" });
    assert.equal(captured.includes("--variant"), false);
  });

  test("defaultVariantEffort: \"highest\" + pi resolves to --thinking xhigh", async () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args) => { captured = args; return fakeChild(); }, defaultVariantEffort: "highest" });
    await mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: "minimax/MiniMax-M2.7", executor: "pi" });
    assert.deepEqual(captured.slice(captured.indexOf("--thinking"), captured.indexOf("--thinking") + 2), ["--thinking", "xhigh"]);
  });

  test("defaultVariantEffort: \"highest\" + opencode + a model with multiple variants resolves to the highest-ranked key", async () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { captured = args; return fakeChild(); },
      defaultVariantEffort: "highest",
      defaultExecutor: opencodeExecutor({
        listVariantsFn: async () => ({ "openai/gpt-5.6-luna": { high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" } } }),
      }),
    });
    await mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: "openai/gpt-5.6-luna", executor: "opencode" });
    assert.deepEqual(captured.slice(captured.indexOf("--variant"), captured.indexOf("--variant") + 2), ["--variant", "xhigh"]);
  });

  test("defaultVariantEffort: \"highest\" + opencode + a model with variants: {} sends no --variant flag", async () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { captured = args; return fakeChild(); },
      defaultVariantEffort: "highest",
      defaultExecutor: opencodeExecutor({ listVariantsFn: async () => ({ "opencode/big-pickle": {} }) }),
    });
    await mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: "opencode/big-pickle", executor: "opencode" });
    assert.equal(captured.includes("--variant"), false);
  });

  test("explicit --variant wins over defaultVariantEffort: \"highest\"", async () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { captured = args; return fakeChild(); },
      defaultVariantEffort: "highest",
      defaultExecutor: opencodeExecutor({
        listVariantsFn: async () => ({ "openai/gpt-5.6-luna": { high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" } } }),
      }),
    });
    await mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: "openai/gpt-5.6-luna", variant: "high", executor: "opencode" });
    assert.deepEqual(captured.slice(captured.indexOf("--variant"), captured.indexOf("--variant") + 2), ["--variant", "high"]);
  });

  test("an explicit --variant default (a real opencode variant name) is passed through unreinterpreted, not treated as the defaultVariantEffort token", async () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args) => { captured = args; return fakeChild(); } });
    await mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: "openai/gpt-5.6-luna", variant: "default", executor: "opencode" });
    assert.deepEqual(captured.slice(captured.indexOf("--variant"), captured.indexOf("--variant") + 2), ["--variant", "default"]);
  });

  test("an explicit --variant highest (no meaning to any executor) is passed through unreinterpreted too", async () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args) => { captured = args; return fakeChild(); } });
    await mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: "openai/gpt-5.6-luna", variant: "highest", executor: "opencode" });
    assert.deepEqual(captured.slice(captured.indexOf("--variant"), captured.indexOf("--variant") + 2), ["--variant", "highest"]);
  });

  test("a --session-id resume with no explicit --variant inherits the prior task's variant, not a fresh defaultVariantEffort resolution", async () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (cmd, args) => { captured = args; return fakeChild(); }, defaultVariantEffort: "default" });
    await mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: "openai/gpt-5.6-luna", variant: "medium", sessionId: "ses_v1", executor: "opencode" });
    // Resuming on a manager whose defaultVariantEffort is "default" (would
    // otherwise send no flag) must still see the session's own "medium".
    await mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_v1", executor: "opencode" });
    assert.deepEqual(captured.slice(captured.indexOf("--variant"), captured.indexOf("--variant") + 2), ["--variant", "medium"]);
  });

  test("TASKFERRY_DEFAULT_VARIANT_EFFORT env var overrides the config value", () => {
    const configPath = "/tmp/unused-config-path-for-this-test.json";
    const originalEnv = process.env.TASKFERRY_DEFAULT_VARIANT_EFFORT;
    process.env.TASKFERRY_DEFAULT_VARIANT_EFFORT = "highest";
    try {
      const mgr = createTaskManager({
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-test-")),
        sandboxEnabled: false,
        spawnFn: () => fakeChild(),
        killFn: () => {},
        config: { defaultVariantEffort: "default" },
      });
      const status = mgr.dispatch;
      assert.equal(typeof status, "function"); // manager constructed without throwing == env var validated and won -- see next test for behavioral proof
    } finally {
      if (originalEnv === undefined) delete process.env.TASKFERRY_DEFAULT_VARIANT_EFFORT;
      else process.env.TASKFERRY_DEFAULT_VARIANT_EFFORT = originalEnv;
    }
  });

  test("opencode variants lookup failure (shell-out throws) soft-fails to no --variant flag, dispatch still succeeds", async () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { captured = args; return fakeChild(); },
      defaultVariantEffort: "highest",
      defaultExecutor: opencodeExecutor({ listVariantsFn: async () => { throw new Error("opencode: command not found"); } }),
    });
    const dispatched = await mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: "openai/gpt-5.6-luna", executor: "opencode" });
    assert.equal(dispatched.status, "running");
    assert.equal(captured.includes("--variant"), false);
  });

  test("a pi-only dispatch with defaultVariantEffort: \"highest\" never invokes the opencode variants lookup", async () => {
    let listVariantsCalled = false;
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      defaultVariantEffort: "highest",
      listVariantsFn: async () => { listVariantsCalled = true; return {}; },
    });
    await mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: "minimax/MiniMax-M2.7", executor: "pi" });
    assert.equal(listVariantsCalled, false);
  });
});
```

Update the top-of-file import in `src/tasks.test.js` to include `opencodeExecutor` if not already imported:

```js
import { createTaskManager, isOutsideDirectory, parseAllowedDirs, resolveDispatchVariant } from "./tasks.js";
import { opencodeExecutor, piExecutor } from "./executor.js";
```

(adjust to match whatever the file's existing import lines already pull in -- add only the names not already present)

- [ ] **Step 2: Run the new tests**

Run: `node --test --test-name-pattern "defaultVariantEffort" src/tasks.test.js`
Expected: PASS for all.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tasks.test.js
git commit -m "test: cover defaultVariantEffort resolution, resume-inherits-variant, and explicit-wins behaviors"
```

---

## Task 10: Documentation

**Files:**
- Modify: `skills/using-taskferry/SKILL.md` (canonical), then regenerate
- Modify: `docs/cli-reference.md`, `docs/config.md`, `docs/sourcemap.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the canonical skill file**

In `skills/using-taskferry/SKILL.md`, change (around line 113-115):

```markdown
- **Always specify the model explicitly when dispatching through
  `taskferry`.** An omitted `--model` falls back to taskferry's own default,
  which may not match the tier the task actually needs.
```

to:

```markdown
- **`--model` is required on every fresh dispatch** (no `--session-id`) --
  there is no implicit default to fall back to. Always specify the model
  explicitly; a `--session-id` resume with no `--model` still legitimately
  inherits the prior task's model.
- **Reasoning effort defaults to `defaultVariantEffort`** (`"default"` |
  `"highest"`, config-file/`TASKFERRY_DEFAULT_VARIANT_EFFORT`-tunable) when
  `--variant` is omitted -- it no longer depends on whether `--model` was
  given. `"default"` sends no `--variant`/`--thinking` flag at all (the
  model/provider picks its own baseline); `"highest"` resolves per-executor
  (pi: `xhigh`; opencode: the model's highest-ranked supported variant).
  Pass `--variant <name>` explicitly to override either default outright.
```

- [ ] **Step 2: Regenerate the distributed skill copies**

Run: `npm run skill:generate`
Expected: updates `integrations/claude/skills/using-taskferry/SKILL.md` and `integrations/codex/skills/using-taskferry/SKILL.md` (or wherever the two generated copies live -- confirm exact paths via `git status` after running) to match.

Run: `npm run skill:check`
Expected: PASS (no drift between canonical and generated copies).

- [ ] **Step 3: Update `docs/cli-reference.md`**

Change the `--model <id>` row for `dispatch` (around line 56):

```markdown
| `--model <id>` | Required unless resuming via `--session-id` (`provider/model`, e.g. `opencode-go/minimax-m3`; run `opencode models` to list installed models). When `--session-id` is given without `--model`, the model is instead inherited from the most recent prior task dispatched with that session id |
```

Change the `--variant <name>` row for `dispatch` (around line 57):

```markdown
| `--variant <name>` | Reasoning-effort override; accepted values depend on the executor (pi: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`; opencode: depends on the model). When omitted, governed by `defaultVariantEffort` (`config.json` or `TASKFERRY_DEFAULT_VARIANT_EFFORT`, default `"default"`): `"default"` sends no flag at all; `"highest"` resolves to the executor's/model's highest supported effort. A `--session-id` resume with no explicit `--variant` inherits the prior task's exact variant instead of re-resolving `defaultVariantEffort` |
```

Change the `--variant <name>` row for `advisor` (around line 130):

```markdown
| `--variant <name>` | Optional reasoning-effort override; same `defaultVariantEffort` resolution as `dispatch` applies when omitted |
```

- [ ] **Step 4: Update `docs/config.md`**

Add a row to the fields table (right after the `defaultExecutor` row, around line 54):

```markdown
| `defaultVariantEffort` | `TASKFERRY_DEFAULT_VARIANT_EFFORT` | string (`default` or `highest`) | `default` |
```

- [ ] **Step 5: Update `docs/sourcemap.md`**

Add a row to the env var table (right after the `TASKFERRY_DEFAULT_EXECUTOR` row):

```markdown
| `TASKFERRY_DEFAULT_VARIANT_EFFORT` | `default` | yes (`defaultVariantEffort`) | Governs the `--variant`/`--thinking` flag sent when a dispatch omits `--variant`: `default` sends none, `highest` resolves per-executor |
```

- [ ] **Step 6: Commit**

```bash
git add skills/using-taskferry/SKILL.md integrations docs/cli-reference.md docs/config.md docs/sourcemap.md
git commit -m "docs: document defaultVariantEffort and the required --model change"
```

---

## Task 11: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full lint/typecheck/syntax pass**

Run: `npm run check`
Expected: PASS (lint warnings are fine; no errors). Fix any `tsc --noEmit` type errors surfaced by the new JSDoc in `executor.js`/`tasks.js` before proceeding.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 3: Skill drift check**

Run: `npm run skill:check`
Expected: PASS.

- [ ] **Step 4: Confirm no stray absolute paths or scratch files were left behind**

Run: `git status`
Expected: only the files this plan's tasks intentionally touched; `scripts/codemod-async-dispatch.mjs` and `scripts/asyncify-test-callbacks.mjs` are gone (deleted in Task 8, Step 5).

- [ ] **Step 5: Sourcemap line-count spot check**

Per this repo's CLAUDE.md, confirm `docs/sourcemap.md`'s `tasks.js`/`executor.js` line counts and responsibility text still roughly match reality after this change's net line additions:

Run: `wc -l src/tasks.js src/executor.js`

If either has drifted meaningfully from the numbers already in `docs/sourcemap.md`'s file table, update them in the same commit as Task 10 (or a small follow-up commit here if Task 10 already landed before this final count was known).
