// The full sentinel/concrete variant vocabulary a caller (CLI flag, config.json's
// `defaultVariant` key, or the TASKFERRY_DEFAULT_VARIANT env var) can name.
// Lives here (not config.js) so tasks.js -- whose in-repo type-check root the
// build's tsconfig.json scopes to `src/tasks.js` -- can import it without
// pulling config.js's own (separately tracked) type errors into that check.
export const KNOWN_VARIANT_LEVELS = /** @type {readonly string[]} */ (["highest", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Rank table for opencode's known variant vocabulary, observed across the
// installed catalog (`opencode models --verbose`): none/off < minimal <
// low < medium < high < xhigh < max. An unknown name (e.g. MiniMax-M3's
// "thinking") has no fixed rank -- it takes the rank of the key declared
// immediately before it, plus 0.5, so it reads as "one step up from
// whatever came before," matching the observed invariant that every
// model's variants are declared in ascending-effort order.
/** @type {Record<string, number>} */
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
