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
