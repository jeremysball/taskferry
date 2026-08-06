# Prettified CLI output for human terminals

## Problem

Every `taskferry` command's result reaches stdout through one function,
`writeToon()` in `src/output.js`. Today that function does one thing
regardless of who's reading it: encode the value as TOON (a compact,
machine-oriented text format) and, if stdout is a TTY, wrap five specific
field values (`status`, `direction`, `healthy`/`installed`/`isolated`,
`warnings`, `info`) in plain ANSI foreground color codes. Nothing about the
*layout* changes for a human — same TOON text either way, just a thin color
hint layered on top. The color itself is weak: two of the five palette
entries (`ANSI_GRAY`, `ANSI_DIM`) are the dimmest codes available, there's no
bold/bright variant anywhere, and a long array (e.g. `warnings`) renders as a
string of individually-reset color spans rather than one visually distinct
block.

A human running `taskferry doctor` or `taskferry list` at a real terminal
should see something that reads like a report — sections, grouping, pass/fail
glyphs — not TOON with a light tint. A harness (this agent's own CLI calls,
scripts, CI) must keep getting exactly today's plain TOON output, unchanged,
since it's parsed downstream.

## Goals

- A human at a real terminal gets genuinely restructured output: section
  headers, grouped task lists, pass/fail glyphs, aligned columns — not just
  color on the same TOON text.
- A non-TTY consumer (pipe, harness, script) gets byte-identical output to
  today — no flag, no opt-out needed, nothing to relearn.
- The same visual "vibe" (bold labels, colored status words, dim secondary
  text) is consistent across every command, even ones with no list or report
  structure to build.
- `watch`'s live event stream is untouched — it already TTY-gates color and
  never colors ndjson; that's a separate, already-correct code path.

## Non-goals

- No `--pretty`/`--plain` flag. TTY detection is the only signal, same as
  today's color gating. (YAGNI — nobody has asked to force one mode from the
  other side of a pipe; add the flag later if that need shows up.)
- No change to the underlying data any command returns. This is a rendering
  change only — `commands.js` handler return values are untouched.
- No restructuring of `watch`'s streaming renderer (`formatWatchEvent`).

## Design

### Trigger

Unchanged: `Boolean(io.stdout.isTTY)`, checked once in `writeToon()`. Human
terminal → pretty renderer. Anything else → today's TOON encode, unchanged.

### Visual style ("minimal accent")

Validated via mockups (brainstorming session, 2026-08-06):

- Bold section/field labels, no box-drawing borders.
- Colored status words: green = `done`/`healthy`/`isolated`/`true`, red =
  `crashed`/`cancelled`/not-isolated/`false`, yellow = `running`/`queued`/
  `warning`.
- `✓`/`✗` glyphs for pass/fail checks (doctor's health/integration checks).
- Dim gray for secondary/informational text (`info` lines, timestamps,
  summary/footer lines).
- Same enum → color mapping as today's `ANSI_BY_STATUS` /
  `ANSI_BY_TREND_DIRECTION` / pass-fail logic — the mapping doesn't change,
  only where and how richly it's applied.

### Libraries

- **picocolors** for color codes, replacing the hand-rolled `ANSI_*`
  constants in `output.js`. Zero-dependency, ~1kb, matches the project's
  existing "minimal deps" posture (currently one runtime dependency,
  `@toon-format/toon`).
- **cli-table3**, configured with all border characters blanked out
  (`style: { border: [] }` and empty `chars`), used only for column-width
  calculation inside the grouped-list renderer. Not used for its box-drawing
  — purely for reliable alignment given variable-width IDs/models/timestamps.

### Renderer routing — shape-based, not command-name-based

`writeToon()`'s pretty path inspects the *shape* of the value being printed,
the same way today's `markColorableFields()` already keys off field names
rather than which command produced them. This keeps the renderer decoupled
from `commands.js` — a new command that returns a list-shaped or
report-shaped payload gets the right treatment automatically.

1. **Grouped-list renderer** — value has a `tasks` key (array, or the
   already-existing "none found in this workspace" string sentinel) and a
   `counts` key. Covers `list`, `home`, `context`.
   - One bold, colored section header per status present in the data, e.g.
     `running (8)`, `done (474)`, in the same status → color mapping as
     today.
   - Rows under each header indented, columns (`id`, `model`, `startedAt`,
     and `failureReason` when present) aligned via `cli-table3`'s width
     calculation, no header row repeated per group.
   - Trailing dim line for `next` / truncation hints, same content as today
     (`projectList`/`projectContext`/`homeView` already compute this).

2. **Doctor report renderer** — value has an `integrations` key. Covers
   `doctor` (not `doctor --stats`).
   - Bold section labels: `Daemon`, `Claude integration`, `MCP isolation`,
     `bwrap sandbox` (skip a section if platform/response omits it, same as
     today's conditional spread in `shapeDoctorResult`).
   - `✓ <label>` / `✗ <label>` per check, green/red respectively.
   - `warnings` rendered as a yellow-glyph bulleted block, `info` as a dim
     bulleted block — same content, computed by the existing
     `collectDoctorDiagnostics`.

3. **Stats report renderer** — value has a `trend` or `byModel` key. Covers
   `doctor --stats`.
   - Same section-label style as the doctor renderer for the summary fields.
   - `byModel` rendered as an aligned `cli-table3` block (model name, rate
     columns already formatted as percentages by `formatRate`).
   - `trend.direction` colored via the existing `ANSI_BY_TREND_DIRECTION`
     mapping (`flat` stays uncolored/dim, matching today's "no evidence, no
     color" rule).

4. **Light-touch renderer** — fallback for everything else: `dispatch`,
   `cancel`, `accept`, `reject`, `wait`, `status`, `result`, `tail`,
   `summary`, `version`.
   - One line per top-level field: `bold(label)` then a space then the
     value.
   - Enum/pass-fail values (matching the existing `ENUM_KEYS`/
     `colorForStatus`/`colorForPassFailToken` logic) colored the same as
     everywhere else.
   - One level of nested-object flattening (e.g. `logBytesWritten` /
     `logLastWriteAt` siblings), not deep recursion — these payloads are
     shallow today and don't need general tree rendering.
   - No section headers, no glyphs — confirmed in the visual-companion
     mockup that this stays "same family, different weight" rather than
     inventing structure the data doesn't have.
   - Also the fallback for a non-object value (`null`, a bare string/array) —
     none of today's command handlers return one at the top level (verified:
     every `writeToon()` call site passes an object), but the dispatcher
     should degrade to a direct/plain write rather than throwing if that ever
     changes.

### Where it lives

`src/output.js` stays the single entry point. `writeToon()`'s branch,
illustrative rather than final:

```js
export function writeToon(value, io = process) {
  if (io.stdout.isTTY) return writePretty(value, io);
  io.stdout.write(`${encode(value)}\n`);
}
```

The four renderers (plus the shape-detection dispatcher) are added to
`output.js` as new functions, or split into a sibling `pretty.js` imported by
`output.js` if the file's line count grows enough to warrant it (existing
project convention per `docs/sourcemap.md` — split when a file is doing too
much, not preemptively).

`formatWatchEvent()` (used by `watch`) is untouched — it already takes its
own `useColor` param sourced from `io.stdout.isTTY` and explicitly never
colors ndjson output.

### Error output

`writeError()` (also in `output.js`) calls `writeToon(errorValue(error), io)`
just like every command handler — there's no separate error code path to
design for. `errorValue()`'s `{error, help}` shape doesn't match the
grouped-list/doctor/stats shapes, so on a TTY it falls through to the
light-touch fallback renderer automatically: bold `error`/`help` labels
instead of today's raw `error: ...` / `help: ...` TOON lines. That's a
real, intentional visual change (consistent with the "light touch
everywhere" goal), not an oversight — call it out during implementation
rather than let it land as an unreviewed side effect.

## Testing

- Existing tests in `output.test.js` that assert non-TTY output is
  byte-identical TOON must keep passing unchanged — this is the contract
  that guarantees harness/script consumers see no behavior change.
- New tests per renderer: given a representative payload for each of the
  four shapes, assert the pretty-path output contains the expected section
  headers / colored tokens / grouping, with `isTTY: true` in a fake `io`
  (same `fakeStdoutIo` pattern already used in `output.test.js`).
- A `--stats` fallback-shape test (the version-skew reconstruction path in
  `runDoctorStats`) should still route to the stats renderer, not fall
  through to light-touch, since it produces the same `trend`/`byModel` shape
  via a different code path.

## Open questions / follow-ups (not blocking this spec)

- No `--pretty`/`--plain` override flag is included (see Non-goals). If a
  concrete need for one shows up later, it's a small addition to `args.js` +
  a check in `writeToon()`, not a redesign.
- `writeError()`'s formatting is unchanged by this spec; a future pass could
  extend the same "minimal accent" vibe to error output for consistency, but
  it's not required for this design to land.
