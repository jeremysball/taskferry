# Task 2 Report: Create `src/pretty.js` — shape-based pretty renderer

## What I did

Implemented the shape-based pretty renderer following the brief's 21 steps, with four incremental commits (one per renderer: fallback, grouped-list, doctor, stats).

### Commits

```
4d40e22 feat(cli): add stats report pretty renderer
491b339 feat(cli): add doctor report pretty renderer
02b3f73 feat(cli): add grouped-list pretty renderer
bfa8fbd feat(cli): add fallback pretty renderer for TTY output
```

### Files created

- `src/pretty.js` — 230 lines. Exports `renderPretty(value)` which detects the shape of a command result object and delegates to the appropriate renderer:
  - **fallback** (light-touch): bold-label/value lines, recursive indent for nested objects/arrays. Covers dispatch/cancel/accept/reject/wait/status/result/tail/summary/version/help.
  - **list** (grouped-list): tasks grouped by status (most-active first via `STATUS_ORDER`), rendered as a borderless `cli-table3` table with id/model/startedAt columns. Leading scalar fields (e.g. `directory`), a dim counts summary line, and dim `next` hints.
  - **doctor** (report): check-glyph lines (✓/✗/? in green/red/dim) for daemon health, Claude integration, and MCP isolation. Yellow-glyph dim bulleted warnings block, dim bulleted info block, fallback to generic scalar fields for extras.
  - **stats** (report): trend section (direction colored by `TREND_TONE`), by-model table (borderless `cli-table3`), overall status mix dim summary, top failure reasons, unknown backlog count.
- `src/pretty.test.js` — 204 lines. 28 tests across 4 `describe` blocks covering all four shapes plus edge cases (empty arrays, undefined fields, string-sentinel tasks, empty stats).

### Design decisions matching the brief

- `pc.createColors(true)` forced on unconditionally (not bare `picocolors` default) since `renderPretty()` is only called from the TTY-gated branch and the injectable `io` tests use needs to be independent of the real process's TTY state.
- `STATUS_TONE`/`TREND_TONE` maps are separate from `output.js`'s `ANSI_BY_STATUS` — same status→meaning mapping, different rendering mechanism (picocolors functions vs raw ANSI strings).
- `FALLBACK_BOOL_KEYS` deliberately excludes `checked` (false means "couldn't verify", not "failed").

## Test results

```
$ node --test src/pretty.test.js
ℹ tests 28
ℹ suites 4
ℹ pass 28
ℹ fail 0
```

Full-repo `npm run lint` is clean.

## Deviations from the brief

The brief's tests had three issues that needed fixing to pass (the brief itself acknowledged this pattern for the "scalar array" test):

1. **"does not color a status value with no known tone"** — the assertion `!out.includes("\x1b[")` was too broad: the bold key label always produces ANSI codes. Fixed to `!out.includes("\x1b[3")` which checks no *color* tones are applied (the actual intent).

2. **"flattens a nested object under an indented bold label"** — used `integrations` as the test key, which triggers doctor shape detection. Renamed the key to `metadata` to exercise the fallback path.

3. **"colors the trend direction red for worsening"** — expected `\x1b[31mworsening\x1b[39m` but the implementation wraps the direction in `tone(c.bold(direction))`, producing `\x1b[31m\x1b[1mworsening\x1b[22m\x1b[39m` (red + bold). Fixed the assertion to match the actual (correct) nesting.

## Lint fixes required during implementation

- Removed unused `Table` import before Step 5 commit (re-added when list renderer was implemented in Step 8).
- Replaced `/\x1b\[[0-9;]*m/g` regex literal with `new RegExp(...)` using `String.fromCharCode(0x1b)` to satisfy `no-control-regex`.
- Replaced `exitCode: undefined` with `exitCode: void 0` to satisfy `sonarjs/no-undefined-assignment`.
- Extracted `"minimax/MiniMax-M3"` into a `MODEL_MINIMAX` constant to satisfy `sonarjs/no-duplicate-string` (appeared 4 times).
- Extracted `renderMcpIsolationSection()` and `renderDoctorExtras()` helpers from `renderDoctorReport` to bring cyclomatic complexity under the `sonarjs/cyclomatic-complexity` threshold of 10.

## Concerns

None. The implementation matches the brief's design, all 28 tests pass, and lint is clean. The four test deviations above are straightforward assertion/data fixes that preserve test intent.

## Fix round 1: narrow doctor shape detection

**Commit:** `4d51f40 fix(cli): narrow detectShape's doctor check to avoid colliding with setup's output`

**Problem:** `detectShape()` identified doctor payloads by the presence of a top-level `integrations` key. `src/setup.js`'s result also carries a top-level `integrations: { claude, codex }` key (plus a separate top-level `playwrightMcpIsolation`), which would be misclassified as a doctor report once Task 3 wires `renderPretty()` into `writeToon()`. The doctor renderer would silently drop the `codex` field.

**Fix:** Changed the doctor check from `"integrations" in value` to `value.integrations && "playwrightMcpIsolation" in value.integrations`. Doctor payloads always nest `playwrightMcpIsolation` inside `integrations`; setup payloads have `playwrightMcpIsolation` as a sibling, not a child.

**Test added:** "setup-shaped value (top-level integrations + playwrightMcpIsolation) falls through to fallback, not doctor" — asserts that a setup-shaped payload's `codex` field appears in the output (which the doctor renderer would silently drop).

Extracted `"opencode.json not found"` into a `MCP_UNCHECKED_REASON` constant to satisfy `sonarjs/no-duplicate-string` (now appeared 3 times across tests).

**Verification:** 29/29 tests pass, lint clean.
