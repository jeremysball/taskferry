## Task 1: `config.js` validates a `defaultVariant` field

**Files:**
- Modify: `src/config.js:24-49` (`CONFIG_FIELD_TYPES`), and the validation block around `src/config.js:155-158`
- Test: `src/config.test.js`

**Interfaces:**
- Produces: `defaultVariant` becomes a recognized `config.json` key, string type, validated against `KNOWN_VARIANT_LEVELS = ["highest", "off", "minimal", "low", "medium", "high", "xhigh", "max"]` exported from `src/config.js`. `loadConfig()` returns it verbatim.

- [ ] **Step 1: Write the failing tests**

Add to `src/config.test.js`, inside the existing `describe("loadConfig()", ...)` block (after the `providerLimits` tests):

```js
  test("accepts the highest sentinel for defaultVariant", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: "highest" }));
    assert.deepEqual(loadConfig({ configPath }), { defaultVariant: "highest" });
  });

  test("accepts each of pi's concrete thinking levels for defaultVariant", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const dir = tmpConfigDir();
      const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: level }));
      assert.deepEqual(loadConfig({ configPath }), { defaultVariant: level });
    }
  });

  test("rejects an unrecognized defaultVariant string", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: "medium-plus" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "defaultVariant" in .* must be one of highest, off, minimal, low, medium, high, xhigh, max \(got "medium-plus"\)\nhelp:/);
  });

  test("rejects an empty or whitespace-only defaultVariant", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: "   " }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "defaultVariant".*must be one of/);
  });

  test("rejects a non-string defaultVariant", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: 5 }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "defaultVariant" in .* must be a string \(got 5\)\nhelp:/);
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "defaultVariant"`
Expected: FAIL — `defaultVariant` is not a recognized config key yet.

- [ ] **Step 3: Implement the validator**

In `src/config.js`, add `defaultVariant: "string",` to `CONFIG_FIELD_TYPES` (after `defaultExecutor: "string",`):

```js
const CONFIG_FIELD_TYPES = {
  maxConcurrentTasks: "number",
  maxDispatchesPerWindow: "number",
  dispatchWindowMs: "number",
  noOutputTimeoutMs: "number",
  postOutputNoOutputTimeoutMs: "number",
  preOutputMaxMs: "number",
  summaryModel: "string",
  activitySummariesEnabled: "boolean",
  summarizerTimeoutMs: "number",
  activityMaxWords: "number",
  advisorSessionTtlMs: "number",
  watchdogGraceMs: "number",
  lowerdirStaggerMs: "number",
  sandboxEnabled: "boolean",
  overlayEnabled: "boolean",
  allowedDirs: "string",
  rwBind: "string",
  roBind: "string",
  envDenylist: "string",
  sandboxDenylist: "string",
  waitDefaultTimeoutMs: "number",
  cancelGraceMs: "number",
  defaultExecutor: "string",
  defaultVariant: "string",
  advisorContextChars: "number",
  envFile: "string",
  profilingEnabled: "boolean",
  providerLimits: "object",
};

export const KNOWN_VARIANT_LEVELS = /** @type {readonly string[]} */ (["highest", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
```

Then, right after the existing `defaultExecutor` special-case block in `parseAndValidateConfig()`:

```js
  if (parsed.defaultExecutor !== undefined && !KNOWN_EXECUTORS.includes(parsed.defaultExecutor)) {
    throw new Error(`error: config key "defaultExecutor" in ${configPath} must be one of ${KNOWN_EXECUTORS.join(", ")} (got ${JSON.stringify(parsed.defaultExecutor)})\nhelp: fix the value in ${configPath}`);
  }

  if (parsed.defaultVariant !== undefined && !KNOWN_VARIANT_LEVELS.includes(parsed.defaultVariant.trim())) {
    throw new Error(`error: config key "defaultVariant" in ${configPath} must be one of ${KNOWN_VARIANT_LEVELS.join(", ")} (got ${JSON.stringify(parsed.defaultVariant)})\nhelp: fix the value in ${configPath}`);
  }
```

Note the type check on line ~148 (`typeof value !== expectedType`) already rejects the non-string case before this block runs, so the "rejects a non-string" test is covered by existing code, not new code — verify its message matches (`must be a string (got 5)`) rather than adding a redundant check.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "defaultVariant"`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full config test file to check for regressions**

Run: `npm test src/config.test.js`
Expected: PASS, all tests

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/config.test.js
git commit -m "feat(config): validate a defaultVariant field"
```

---

