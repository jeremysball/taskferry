## Task 2: `TASKFERRY_PROVIDER_LIMITS` env grammar parser

**Files:**
- Modify: `src/tasks.js` (add near `parseAllowedDirs`/`parseEnvDenylist`, around line 536-551)
- Test: `src/tasks.parse.test.js`

**Interfaces:**
- Produces: `export function parseProviderLimitsEnv(spec: string|undefined): Map<string, {concurrencyLimit: number, dispatchLimit: number}>` — parses the `provider:maxConcurrentTasks[:maxDispatchesPerWindow]` comma-separated grammar (spec §4). `dispatchLimit` defaults to `Infinity` when the third field is omitted. Throws a two-line `error:`/`help:` message on any malformed entry (empty provider name, non-integer/non-positive limit, more than 3 colon-separated fields).

- [ ] **Step 1: Write the failing tests**

Add to `src/tasks.parse.test.js` (after the existing `parseEnvDenylist()` describe block; import `parseProviderLimitsEnv` alongside the existing imports at the top of the file):

```js
import { parseEnvDenylist, parseSandboxDenylist, parseProviderLimitsEnv } from "./tasks.js";

describe("parseProviderLimitsEnv()", () => {
  test("returns an empty Map for undefined or empty input", () => {
    assert.deepEqual(parseProviderLimitsEnv(undefined), new Map());
    assert.deepEqual(parseProviderLimitsEnv(""), new Map());
  });

  test("parses a single provider:concurrency entry with an unbounded dispatch limit", () => {
    const result = parseProviderLimitsEnv("minimax:4");
    assert.deepEqual(result, new Map([["minimax", { concurrencyLimit: 4, dispatchLimit: Infinity }]]));
  });

  test("parses a provider:concurrency:dispatchesPerWindow entry", () => {
    const result = parseProviderLimitsEnv("minimax:4:10");
    assert.deepEqual(result, new Map([["minimax", { concurrencyLimit: 4, dispatchLimit: 10 }]]));
  });

  test("parses multiple comma-separated entries, trimming whitespace", () => {
    const result = parseProviderLimitsEnv("minimax:4:10, ollama:3");
    assert.deepEqual(result, new Map([
      ["minimax", { concurrencyLimit: 4, dispatchLimit: 10 }],
      ["ollama", { concurrencyLimit: 3, dispatchLimit: Infinity }],
    ]));
  });

  test("throws error:/help: on an empty provider name", () => {
    assert.throws(() => parseProviderLimitsEnv(":4"), /error: malformed TASKFERRY_PROVIDER_LIMITS entry ":4": empty provider name\nhelp:/);
  });

  test("throws error:/help: on a non-integer concurrency limit", () => {
    assert.throws(() => parseProviderLimitsEnv("minimax:four"), /error: malformed TASKFERRY_PROVIDER_LIMITS entry "minimax:four": maxConcurrentTasks must be a positive integer\nhelp:/);
  });

  test("throws error:/help: on a zero concurrency limit", () => {
    assert.throws(() => parseProviderLimitsEnv("minimax:0"), /maxConcurrentTasks must be a positive integer/);
  });

  test("throws error:/help: on a non-integer dispatch-window limit", () => {
    assert.throws(() => parseProviderLimitsEnv("minimax:4:x"), /maxDispatchesPerWindow must be a positive integer/);
  });

  test("throws error:/help: on more than three colon-separated fields", () => {
    assert.throws(() => parseProviderLimitsEnv("minimax:4:10:20"), /error: malformed TASKFERRY_PROVIDER_LIMITS entry "minimax:4:10:20"\nhelp:/);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "parseProviderLimitsEnv"`
Expected: FAIL — `parseProviderLimitsEnv` is not exported from `tasks.js` yet.

- [ ] **Step 3: Implement `parseProviderLimitsEnv`**

In `src/tasks.js`, right after `parseEnvDenylist` (the function ending at line 551, `export function parseEnvDenylist(spec) { return parseAllowedDirs(spec); }`), add:

```js
/**
 * Parses `TASKFERRY_PROVIDER_LIMITS`'s comma-separated grammar:
 * `provider:maxConcurrentTasks[:maxDispatchesPerWindow]` per entry. A
 * provider's `dispatchLimit` is `Infinity` (unbounded) when the third
 * field is omitted -- see the design spec's §4. Throws a two-line
 * `error:`/`help:` message on any malformed entry, matching config.js's
 * no-silent-typo-tolerance posture, since a malformed provider limit is a
 * daemon-startup-time config error, not a runtime one.
 * @param {string|undefined} spec
 * @returns {Map<string, {concurrencyLimit: number, dispatchLimit: number}>}
 */
export function parseProviderLimitsEnv(spec) {
  const map = new Map();
  if (!spec) return map;
  for (const entry of spec.split(",").map((e) => e.trim()).filter(Boolean)) {
    const parts = entry.split(":");
    const help = "help: use provider:maxConcurrentTasks[:maxDispatchesPerWindow], comma-separated";
    if (parts.length < 2 || parts.length > 3) {
      throw new Error(`error: malformed TASKFERRY_PROVIDER_LIMITS entry "${entry}"\n${help}`);
    }
    const [provider, concurrencyStr, dispatchStr] = parts;
    if (!provider) {
      throw new Error(`error: malformed TASKFERRY_PROVIDER_LIMITS entry "${entry}": empty provider name\n${help}`);
    }
    const concurrencyLimit = Number(concurrencyStr);
    if (!Number.isInteger(concurrencyLimit) || concurrencyLimit <= 0) {
      throw new Error(`error: malformed TASKFERRY_PROVIDER_LIMITS entry "${entry}": maxConcurrentTasks must be a positive integer\n${help}`);
    }
    let dispatchLimit = Infinity;
    if (dispatchStr !== undefined) {
      dispatchLimit = Number(dispatchStr);
      if (!Number.isInteger(dispatchLimit) || dispatchLimit <= 0) {
        throw new Error(`error: malformed TASKFERRY_PROVIDER_LIMITS entry "${entry}": maxDispatchesPerWindow must be a positive integer\n${help}`);
      }
    }
    map.set(provider, { concurrencyLimit, dispatchLimit });
  }
  return map;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "parseProviderLimitsEnv"`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.parse.test.js
git commit -m "feat(tasks): parse TASKFERRY_PROVIDER_LIMITS grammar"
```

---

