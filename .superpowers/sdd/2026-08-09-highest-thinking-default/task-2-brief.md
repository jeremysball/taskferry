## Task 2: `src/variants.js` — pure variant resolution

**Files:**
- Create: `src/variants.js`
- Test: `src/variants.test.js`

**Interfaces:**
- Consumes: nothing external — pure function over its own inputs.
- Produces:
  - `export function rankOpencodeVariants(keys: string[]): string` — given an opencode model's declared variant keys **in declaration order**, returns the single key representing "highest."
  - `export function resolveVariant({ executorId, requested, opencodeVariants }: { executorId: "pi"|"opencode", requested: string, opencodeVariants?: string[] }): string|null` — `opencodeVariants` is that one model's key list from the cache (or `undefined`/`[]` when the model is not in the table).

- [ ] **Step 1: Write the failing tests**

Create `src/variants.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rankOpencodeVariants, resolveVariant } from "./variants.js";

describe("rankOpencodeVariants()", () => {
  test("picks the highest-ranked known name regardless of declaration order", () => {
    assert.equal(rankOpencodeVariants(["low", "high", "medium"]), "high");
    assert.equal(rankOpencodeVariants(["high", "max"]), "max");
  });

  test("picks xhigh over high", () => {
    assert.equal(rankOpencodeVariants(["low", "medium", "high", "xhigh"]), "xhigh");
  });

  test("an unknown trailing key outranks the known key before it", () => {
    // The verified real-world case: MiniMax-M3's {none, thinking} pair.
    assert.equal(rankOpencodeVariants(["none", "thinking"]), "thinking");
  });

  test("an unknown leading key is outranked by a known key after it", () => {
    assert.equal(rankOpencodeVariants(["mystery", "high"]), "high");
  });

  test("a single unknown key is returned as-is", () => {
    assert.equal(rankOpencodeVariants(["mystery"]), "mystery");
  });

  test("ties on rank break toward the later-declared key", () => {
    assert.equal(rankOpencodeVariants(["alpha", "beta"]), "beta");
  });

  test("empty list returns null", () => {
    assert.equal(rankOpencodeVariants([]), null);
  });
});

describe("resolveVariant()", () => {
  test("a concrete requested level passes through untouched for pi", () => {
    assert.equal(resolveVariant({ executorId: "pi", requested: "medium" }), "medium");
  });

  test("a concrete requested level passes through untouched for opencode, even if not in the table", () => {
    assert.equal(resolveVariant({ executorId: "opencode", requested: "medium", opencodeVariants: ["low", "high"] }), "medium");
  });

  test("highest on pi always resolves to max (pi clamps per-model itself)", () => {
    assert.equal(resolveVariant({ executorId: "pi", requested: "highest" }), "max");
  });

  test("highest on opencode resolves to the model's ranked-highest key", () => {
    assert.equal(resolveVariant({ executorId: "opencode", requested: "highest", opencodeVariants: ["low", "high", "max"] }), "max");
  });

  test("highest on opencode with no table entry sends no flag", () => {
    assert.equal(resolveVariant({ executorId: "opencode", requested: "highest", opencodeVariants: [] }), null);
    assert.equal(resolveVariant({ executorId: "opencode", requested: "highest" }), null);
  });

  test("highest on opencode resolving to none/off sends no flag", () => {
    assert.equal(resolveVariant({ executorId: "opencode", requested: "highest", opencodeVariants: ["none"] }), null);
    assert.equal(resolveVariant({ executorId: "opencode", requested: "highest", opencodeVariants: ["off"] }), null);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "rankOpencodeVariants|resolveVariant"`
Expected: FAIL — `src/variants.js` does not exist yet.

- [ ] **Step 3: Implement `src/variants.js`**

```js
// Rank table for opencode's known variant vocabulary, observed across the
// installed catalog (`opencode models --verbose`): none/off < minimal <
// low < medium < high < xhigh < max. An unknown name (e.g. MiniMax-M3's
// "thinking") has no fixed rank -- it takes the rank of the key declared
// immediately before it, plus 0.5, so it reads as "one step up from
// whatever came before," matching the observed invariant that every
// model's variants are declared in ascending-effort order.
const KNOWN_RANKS = { none: 0, off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

/**
 * Picks the single "highest" key from a model's declared opencode variant
 * keys, given in the order opencode declared them.
 * @param {string[]} keys
 * @returns {string|null}
 */
export function rankOpencodeVariants(keys) {
  if (keys.length === 0) return null;
  let bestKey = keys[0];
  let bestRank = Object.hasOwn(KNOWN_RANKS, keys[0]) ? KNOWN_RANKS[keys[0]] : -0.5;
  let prevRank = bestRank;
  for (let i = 1; i < keys.length; i++) {
    const key = keys[i];
    const rank = Object.hasOwn(KNOWN_RANKS, key) ? KNOWN_RANKS[key] : prevRank + 0.5;
    if (rank >= bestRank) {
      bestRank = rank;
      bestKey = key;
    }
    prevRank = rank;
  }
  return bestKey;
}

/**
 * Resolves what `--variant`/`--thinking` value (if any) to send for a
 * dispatch, given the level the caller requested (a concrete level, or the
 * `"highest"` sentinel from `defaultVariant`).
 *
 * A concrete `requested` value is never reinterpreted on either executor --
 * the worker CLI is the backstop for an invalid one.
 *
 * `"highest"` on pi always becomes `"max"`: pi's own `clampThinkingLevel`
 * walks up-then-down over its ordered level list at runtime, so requesting
 * the top level is already "give me whatever this model supports,"
 * including on extension providers taskferry cannot see the registry for.
 *
 * `"highest"` on opencode looks up `opencodeVariants` (that model's variant
 * keys from the cached `opencode models --verbose` table, in declaration
 * order) and ranks them. No table entry, an empty list, or a ranked result
 * of `none`/`off` all mean "send no flag" -- opencode silently ignores an
 * unrecognized `--variant`, so guessing is worse than omitting.
 *
 * @param {{executorId: "pi"|"opencode", requested: string, opencodeVariants?: string[]}} params
 * @returns {string|null}
 */
export function resolveVariant({ executorId, requested, opencodeVariants }) {
  if (requested !== "highest") return requested;
  if (executorId === "pi") return "max";
  const ranked = rankOpencodeVariants(opencodeVariants ?? []);
  return ranked === "none" || ranked === "off" ? null : ranked;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "rankOpencodeVariants|resolveVariant"`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add src/variants.js src/variants.test.js
git commit -m "feat(variants): add resolveVariant() for the highest-thinking default"
```

---

