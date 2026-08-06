# Dry-cleanup red-team issue list

Source: whole-repo Simplicity/Reduction review of `taskferry`, followed by an
independent GLM-5.2 correctness review of the resulting diff (branch
`chore/dry-cleanup-redteam-findings`, merged as `PR #43`).

## Findings from the Simplicity/Reduction pass (10 total)

**Implemented (9):**

1. **State/runtime dir resolution triplicated** across `daemon.js`, `client.js`,
   `tasks.js` → extracted to `src/paths.js` (`resolveStateDir`,
   `resolveRuntimeDir`).
2. **`errCode(err)` duplicated** in `tasks.js` and `state-lock.js` → extracted
   to `src/errors.js`.
3. **Narration truncation/formatting duplicated** identically in `activity.js`
   and `tasks.js` (`TOOL_EVENT_TRUNCATE_CHARS`, `truncateForNarration`,
   `formatToolEventForNarration`) → extracted to `src/narration-format.js`.
4. **`isPositiveInteger`/`isNonNegativeInteger` duplicated** as ad hoc
   fallback wrappers in `tasks.js`, informally duplicating `protocol.js`'s
   validators → extracted to `src/numbers.js` as TS type-predicate functions.
5. **`RESULT_FIELDS` duplicated** across `protocol.js` (module-private),
   `tasks.js`, and `args.js` → `protocol.js` now exports one copy.
6. **Dead code**: `MANAGER_METHODS` object and `managerMethodFor()` in
   `protocol.js` → deleted (confirmed dead; `daemon.js`'s `invoke()`
   hand-writes its own switch with real per-method param transforms and never
   called `managerMethodFor`).
7. **Dead code**: `export const createClient = connectClient;` alias in
   `client.js` → deleted (zero callers across `src/` and `docs/`).
8. **No-op self-assignment** in `tasks.js`'s `summarizeTask()`
   (`options.x === undefined ? undefined : options.x`, twice) → replaced with
   a plain destructure.
9. **Unnecessarily exported internal**: `daemon.js`'s `resolveSocketPath` had
   no external callers → changed from `export function` to module-private.

**Deferred (1), left as a documented follow-up:**

10. **5-way narration-indexing duplication** — a messageID-accumulation loop
    duplicated across `src/activity.js` (`narrationFromRaw`) and four sites in
    `src/tasks.js` (`parseNarration`, `readNarration`, `extractFinalMessage`,
    inline in `result()`). Not implemented: the loops have a subtle
    difference (a `"__unknown_message__"` fallback key used in one place, no
    fallback in another) that needs careful handling to consolidate safely.
    GLM's correctness pass (below) confirmed the dry-cleanup diff doesn't
    touch any of these five sites and nothing else silently depends on the
    duplication being resolved.

## GLM-5.2 correctness review of the diff (`oc_mrrcabnd_4ed3b5f7`)

**Verdict: safe to commit.** Verified every module-by-module claim against
the live files (`paths.js`, `numbers.js`, `errors.js`, `narration-format.js`,
`protocol.js`'s new JSDoc types and `RESULT_FIELDS` export, the `client.js`/
`daemon.js` dead-code/export removals, and the `summarizeTask()` destructure)
— no behavioral regressions found, no call site left on an old local copy.

**One inaccuracy flagged, not a regression:** the review dispatch prompt
claimed "278/278 tests passing"; GLM's own `npm run test:unit` run showed
272/278 with 6 failures in `opencode-plugin.test.js`, and it confirmed via
`git stash` that the same 6 failures reproduce on a clean tree too — so no
regression, but a wrong number in the prompt.

**Root cause, found and fixed separately (not by GLM):** those 6 failures are
not a real pre-existing bug. `taskferry` sets `TASKFERRY_CHILD=1` on every
dispatched child, and `opencode-plugin.js:57` short-circuits its whole hook
setup to `{}` whenever that var is `"1"` — so *any* taskferry-dispatched
reviewer's own test run fails that file's tests, including GLM's "clean
tree" stash comparison, because the ambient env var doesn't change with git
state. Fixed by prefixing `package.json`'s `test:unit` script with
`env -u TASKFERRY_CHILD`; verified with `TASKFERRY_CHILD=1 npm run test:unit`
afterward — 278/278 clean. See the `automating-repo-review` skill's
`lessons.md` for the generalized writeup.

## Verification (post-fix, on the merged diff)

- `npm run test:unit` — 310/310 passing (test count grew from 278 with later
  unrelated commits picked up during the `origin/main` rebase)
- `npm run check` (node --check, eslint, tsc) — 0 errors, 28 warnings, tsc
  clean
