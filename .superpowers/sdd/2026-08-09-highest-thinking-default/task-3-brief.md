## Task 3: opencode executor exposes `listModelVariantsFn`

**Files:**
- Modify: `src/executor.js:312-320` (top of `opencodeExecutor()`)
- Test: `src/executor.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `opencodeExecutor().listModelVariantsFn(env: NodeJS.ProcessEnv): Promise<Map<string, string[]>>` — shells out to `opencode models --verbose`, parses its `provider/model\n{...json...}` block format, returns a map of `provider/model` to that model's `Object.keys(variants)` in declaration order. Only defined on the opencode executor; pi's executor object has no `listModelVariantsFn` property at all — its absence is the statement that pi needs no such table.

- [ ] **Step 1: Write the failing tests**

Add to `src/executor.test.js`, inside `describe("opencodeExecutor()", ...)`:

```js
describe("opencodeExecutor().listModelVariantsFn", () => {
  const FIXTURE = [
    "opencode/deepseek-v4-flash-free",
    '{"id":"deepseek-v4-flash-free","variants":{"low":{"reasoningEffort":"low"},"high":{"reasoningEffort":"high"},"max":{"reasoningEffort":"max"}}}',
    "opencode/no-variants-model",
    '{"id":"no-variants-model","variants":{}}',
    "minimax/MiniMax-M3",
    '{"id":"MiniMax-M3","variants":{"none":{"thinking":{"type":"disabled"}},"thinking":{"thinking":{"type":"enabled","budgetTokens":16000}}}}',
  ].join("\n");

  test("parses provider/model blocks into an ordered variant-key map", async () => {
    const ex = opencodeExecutor();
    const result = await ex.listModelVariantsFn(process.env, { execFileFn: async () => ({ stdout: FIXTURE, stderr: "" }) });
    assert.deepEqual(result.get("opencode/deepseek-v4-flash-free"), ["low", "high", "max"]);
    assert.deepEqual(result.get("minimax/MiniMax-M3"), ["none", "thinking"]);
  });

  test("omits models with no variants from the map", async () => {
    const ex = opencodeExecutor();
    const result = await ex.listModelVariantsFn(process.env, { execFileFn: async () => ({ stdout: FIXTURE, stderr: "" }) });
    assert.equal(result.has("opencode/no-variants-model"), false);
  });

  test("skips a malformed JSON block instead of throwing", async () => {
    const ex = opencodeExecutor();
    const malformed = "opencode/broken-model\n{not valid json\nopencode/deepseek-v4-flash-free\n" + FIXTURE.split("\n")[1];
    const result = await ex.listModelVariantsFn(process.env, { execFileFn: async () => ({ stdout: malformed, stderr: "" }) });
    assert.equal(result.has("opencode/broken-model"), false);
    assert.deepEqual(result.get("opencode/deepseek-v4-flash-free"), ["low", "high", "max"]);
  });
});

test("piExecutor() has no listModelVariantsFn -- pi needs no variant table", () => {
  assert.equal(piExecutor().listModelVariantsFn, undefined);
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "listModelVariantsFn"`
Expected: FAIL — `listModelVariantsFn` is not defined on `opencodeExecutor()`.

- [ ] **Step 3: Implement the parser and shell-out**

In `src/executor.js`, add near the top of the file (after `SUMMARY_PREFLIGHT_TIMEOUT_MS`):

```js
const LIST_MODEL_VARIANTS_TIMEOUT_MS = 30000;

// `opencode models --verbose` prints one model per block: a `provider/model`
// line at column 0 with no leading whitespace, followed by that model's
// full JSON description (always indented -- a JSON body line is never
// mistaken for the next model-id line). A block that fails to JSON.parse
// is skipped rather than aborting the whole listing; one malformed model
// must not cost every other model's variant data.
const OPENCODE_MODEL_ID_LINE = /^(\S+\/\S+)$/;

/**
 * @param {string} verboseOutput - raw stdout of `opencode models --verbose`
 * @returns {Map<string, string[]>}
 */
function parseOpencodeModelVariants(verboseOutput) {
  /** @type {Map<string, string[]>} */
  const result = new Map();
  const lines = verboseOutput.split("\n");
  let currentModel = null;
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
    }
  }
  flush();
  return result;
}
```

Then, inside `opencodeExecutor()`'s returned object (after `listModelsFn`, before `buildSpawnArgs`):

```js
    /** @param {NodeJS.ProcessEnv} env @param {{execFileFn?: typeof execFileAsync}} [options] @returns {Promise<Map<string, string[]>>} */
    listModelVariantsFn: async (env, { execFileFn = execFileAsync } = {}) => {
      const { stdout } = await execFileFn("opencode", ["models", "--verbose"], { encoding: "utf8", timeout: LIST_MODEL_VARIANTS_TIMEOUT_MS, env, maxBuffer: 32 * 1024 * 1024 });
      return parseOpencodeModelVariants(stdout);
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "listModelVariantsFn"`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full executor test file to check for regressions**

Run: `npm test src/executor.test.js`
Expected: PASS, all tests

- [ ] **Step 6: Commit**

```bash
git add src/executor.js src/executor.test.js
git commit -m "feat(executor): opencode listModelVariantsFn parses opencode models --verbose"
```

---

