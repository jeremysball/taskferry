# Final review fix-wave report — 2026-08-05

Three findings from the final whole-branch review, all fixed.

## Finding 1 (Important): spec still mandates the rejected --class allowlist design

**File:** `.superpowers/specs/2026-08-04-livebench-first-model-selection.md:314-320`

Rewrote item 1 in the "Instrumentation design" section to describe the
shipped freeform contract: `--class <name>` accepts any non-empty string
(validated via `protocol.js`'s `isNonEmptyString`), persisted per task, no
fixed-list validation. Removed the "mistyped class corrupts telemetry"
framing — a typo just becomes its own distinct class bucket.

## Finding 2 (Important): --class undocumented in 3 places

### 2a. `docs/cli-reference.md`

- **dispatch options table** (line 64): added `--class <name>` row before
  `--no-sandbox`, matching sibling flag format.
- **advisor options table** (line 133): added `--class <name>` row after
  `--session-id`.

### 2b. `skills/using-taskferry/SKILL.md`

- **Line 97**: added `--class <name>` documentation alongside the existing
  `--executor` documentation in the Worker Contract section.
- Regenerated `integrations/claude/skills/using-taskferry/SKILL.md` and
  `integrations/codex/skills/using-taskferry/SKILL.md` via
  `npm run skill:generate`.

### 2c. `docs/sourcemap.md`

- **Line 34**: fixed stale prose `tasks.js (5212 lines)` → `tasks.js (5287 lines)`.
- **Line 44**: fixed `command-specs.js` line count 108 → 109.
- **Line 45**: fixed `commands.js` line count 481 → 482.
- **Line 54 (tasks.js row)**: added `--class` task-classification tag mention
  (validation, persistence, surfacing, propagation).
- **Line 58 (tasks.dispatch.test.js row)**: fixed line count 796 → 730; added
  mention of `dispatch() class tag persistence and summary surfacing` describe
  block.
- **Line 122 (Where do I look for X?)**: added row for `--class` validation,
  persistence, and surfacing.

## Finding 3 (Minor): ResultDetail typedef missing `class`

**File:** `src/tasks.js:159`

Added `@property {string|null} [class]` to the `ResultDetail` typedef,
matching the style of adjacent `finalStatus` and `finalMarker` properties.
The field is already emitted by `computeResultDetail()` at line 1517.

## Verification output

- **`npm run lint`**: FAILED — environment issue (`@eslint/js` package
  resolution error), unrelated to this fix wave's docs/JSDoc changes.
- **`npm run typecheck`**: PASSED (no errors).
- **`npm test`**: 751 pass, 8 fail. All 8 failures are pre-existing
  environment/package issues (`@toon-format/toon` resolution, sandbox auth
  tests hitting real home dir, `TASKFERRY_TASK_ID` summary test). None
  related to this fix wave's changes.
- **`npm run skill:generate -- --check`**: PASSED after regeneration.
