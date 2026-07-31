# defaultVariantEffort design

**Superseded 2026-07-31** by
`2026-07-31-required-model-and-default-variant-design.md`. The second pass
keeps this spec's required-`--model` fix, resume-inheritance rules, and the
"explicit `--variant` is never reinterpreted" finding, and replaces the
`default`/`highest` abstract config plus the live `opencode models
--verbose` lookup (and the async-`dispatch()` test migration it forced)
with a concrete pi-level config value mapped through a vendored copy of
pi's own table. Kept for its verified findings; do not implement from it.

## Scope

Replace the current hardcoded, `--model`-presence-coupled reasoning-effort
default with an explicit, documented config setting, and make `--model`
required on a fresh dispatch (deleting the implicit per-executor default
model it currently falls back to).

Two independent but related fixes, both targeting the same block of code in
`src/tasks.js`'s `dispatch()`:

1. **`--model` becomes required** on a fresh dispatch (no `--session-id`),
   matching `advisor`'s existing `--model is required` rule. A
   `--session-id` resume with no `--model` still legitimately inherits
   `priorSessionTask.model` — that is continuing known state, not
   fabricating a model, and stays allowed.
2. **New `defaultVariantEffort` config** (`"default"` | `"highest"`,
   default `"default"`) governs what `--variant`/`--thinking` flag is sent
   when `--variant` is omitted. This no longer depends on whether `--model`
   was given, because after fix (1) a model is always resolvable.

This is a **breaking CLI change**: any dispatch that previously omitted
`--model` to get an implicit default model + forced `"high"` variant will
now error with `--model is required` instead. This is intentional — the
implicit-default-model fallback is being removed outright, not preserved
under a flag.

## Current behavior (being replaced)

`src/tasks.js` around line 1049-1074, inside `dispatch()`:

```js
const usingDefaultModel = !model;
const resolvedModel = model || priorSessionTask?.model || executor.defaultModel;
...
variant: usingDefaultModel ? "high" : variant || null,
```

- Omitting `--model` (no `--session-id` either) silently falls back to
  `executor.defaultModel` (`minimax/MiniMax-M2.7` for **pi**,
  `openai/gpt-5.6-luna` for **opencode** — `src/executor.js:178,279`) **and**
  forces `variant: "high"`, regardless of whether the caller wanted that
  effort.
- Passing `--model` explicitly but omitting `--variant` sends no
  `--variant`/`--thinking` flag at all (`null`) — the executor/provider
  picks its own default.
- This couples two unrelated things (which model to use, and how hard to
  think) through the same omitted-`--model` signal, and gives no way to
  intentionally request "run the model I named, but as hard as it goes."

## Fix 1: `--model` required on fresh dispatch

- Delete the `defaultModel` field from `WorkerExecutor`'s typedef and both
  implementations (`src/executor.js:81,178,279`).
- In `dispatch()`: `resolvedModel = model || priorSessionTask?.model`. If
  neither is available, throw `error: --model is required\nhelp: pass
  --model <provider/model>, or --session-id to resume a session that
  already has one` (mirroring the existing `advisor` validation in
  `src/args.js:433`, but enforced in `tasks.js`/`dispatch()` since
  resume-inheritance is a dispatch-time concept, not an args-parsing one —
  `args.js` cannot know whether a given `--session-id` will resolve to a
  prior task with a model).
- Delete the `usingDefaultModel` local entirely.
- Update `src/args.js:12`'s help text for `dispatch`'s `--model` flag from
  `"use the default model when omitted"` to `"required unless resuming via
  --session-id"`.
- Update `skills/using-taskferry/SKILL.md` (canonical copy only —
  regenerate the two integration copies via `npm run skill:generate`,
  never hand-edit them) and `docs/cli-reference.md`, both of which
  currently document `--model` as optional for `dispatch`.

## Fix 2: `defaultVariantEffort` config

### Config surface

- New `CONFIG_FIELD_TYPES.defaultVariantEffort: "string"` in
  `src/config.js`, validated against a `KNOWN_VARIANT_EFFORTS = ["default",
  "highest"]` enum, following the exact `defaultExecutor`/`KNOWN_EXECUTORS`
  validation pattern already at `src/config.js:81-83`.
- `TASKFERRY_DEFAULT_VARIANT_EFFORT` env var override, resolved in
  `createTaskManager()` with the same env-over-config-over-built-in-default
  precedence `defaultExecutor` already uses. Built-in default: `"default"`.
- Explicit `--variant <name>` on the CLI always wins outright over this
  config, regardless of value.

### Resolution when `--variant` is omitted

- `"default"` → no `--variant`/`--thinking` flag is sent at all, for
  either executor. The model/provider picks its own baseline reasoning
  effort.
- `"highest"` → resolved per-executor, and the **concrete resolved value**
  (never the abstract `"highest"` token) is what gets stored on
  `task.variant` and passed to `buildSpawnArgs`, for both executors
  consistently:
  - **pi**: static mapping, `"highest"` → `"xhigh"` (pi's actual ceiling on
    its fixed 6-level scale `off, minimal, low, medium, high, xhigh` —
    confirmed via `pi --help`). No model lookup; pi's thinking levels are
    executor-wide, not per-model.
  - **opencode**: the target model's supported variants differ per model
    (confirmed via `opencode models --verbose`: each model's JSON has a
    `"variants"` object keyed by valid `--variant` name strings, each
    mapping to `{"reasoningEffort": "<none|low|medium|high|max|...>"}`;
    some models have `variants: {}` — no variants supported at all).
    Resolve by: (1) fetch the model's variants via a live, cached call to
    `opencode models --verbose`; (2) rank the present variant keys by their
    `reasoningEffort` value against canonical order `none/off < low <
    medium < high < xhigh < max` and pick whichever key ranks highest —
    confirmed directly against a real `opencode models --verbose` capture:
    `openai/gpt-5.6-luna` and other models exposing both `xhigh` and `max`
    variants list them in that relative order, so `xhigh` sits strictly
    between `high` and `max`, not below the whole scale. Also confirmed:
    at least one model (`anthropic/claude-fable-latest`) nests its value
    as `{"reasoning": {"effort": "xhigh"}}` instead of the flat
    `{"reasoningEffort": "xhigh"}` shape most models use — the parser must
    accept both shapes, checking the flat field first and falling back to
    the nested one. A value outside this known set (a future opencode
    release adding a new rung) should rank below every known value rather
    than crashing or silently winning by object-key order; (3) if
    `variants` is empty, or the target model has no entry in the verbose
    output at all, omit `--variant` entirely — same effective result as
    `"default"` for that model, since there's nothing to escalate to.
  - This lookup only ever runs for opencode dispatches. A pi-only install
    never shells out to `opencode` and never needs it installed — pi's
    `resolveMaxVariant`-equivalent is synchronous and model-independent.

### Implementation shape

- **`dispatch()` becomes `async` — this is the largest, not the smallest,
  part of this change, and every caller's shape must be audited, not
  assumed compatible.** `dispatch()` at `src/tasks.js:983` is fully
  synchronous today (no `await`, no `Promise` anywhere in it) — verified
  directly, not assumed. `task.variant` (and the rest of the returned
  `TaskSummary`) is part of `dispatch()`'s **immediate** return value,
  which the CLI/RPC caller prints right away — the "state the exact
  model/variant being dispatched" UX convention already documented in
  `skills/using-taskferry/SKILL.md` depends on that value being known
  synchronously by the time `dispatch()` returns. That rules out the
  cheaper-looking alternative of deferring the opencode lookup into
  `startTask` (which runs later, off `launchQueuedTasks`'s timer) and
  leaving `dispatch()` itself sync — the caller would print a variant
  that isn't resolved yet. `dispatch()` must genuinely become `async`.
  - `advisor()` (`src/tasks.js:2356`) currently calls `dispatch({...})`
    with **no** `await` — this line must gain one.
  - `daemon.js:182`'s `return manager.dispatch(params);` sits inside an
    `async invoke()`, so it already works correctly once `dispatch`
    returns a promise (the `return` implicitly gets awaited by the
    caller) — no code change needed there, just confirm via lint/test
    that nothing downstream of `invoke()` assumed a non-promise return.
  - **Every test that calls `mgr.dispatch(...)` synchronously must be
    updated.** Verified directly by count: `src/tasks.test.js` alone has
    169 `.dispatch(` callsites, 162 of them not currently `await`ed —
    including `assert.throws(() => mgr.dispatch(...), /error: .../)`
    patterns (e.g. lines 136, 149, 2535) that must become
    `await assert.rejects(mgr.dispatch(...), /error: .../)` instead, since
    a rejected promise doesn't throw synchronously. `src/activity.test.js`
    (3 callsites, already `await`ed — minimal touchup),
    `src/events.test.js` (9 callsites, currently sync),
    `src/opencode-plugin.test.js` (1 callsite), and `src/daemon.test.js`
    (1 callsite — its fake `dispatch(params)` returns synchronously today
    and should become `async dispatch(params)` to match the new real
    contract, even though it happens to still work either way under
    `await`). Treat this migration as its own explicit, sizable task in
    the implementation plan, not a footnote — budget for ~180 mechanical
    but individually-reviewed test edits, concentrated in
    `src/tasks.test.js`.
- Add a `resolveMaxVariant(model, env)` method to **both** executors —
  `listModelsFn` is itself defined on both (`src/executor.js:182,282`),
  not just opencode, so `resolveMaxVariant` follows that same
  both-executors-implement-it shape rather than being pi-only:
  - `piExecutor().resolveMaxVariant = (model, env) => "xhigh"` — a plain,
    non-async function (no cache, no lookup, model-independent). It does
    not need to be `async` even though the overall helper that calls it
    is — a sync function's return value is a valid value to `await`.
  - `opencodeExecutor().resolveMaxVariant = async (model, env) => {...}`
    internally calls a new `listVariantsFn(env)` (parallel to the
    existing `listModelsFn`, shelling out to `opencode models --verbose`
    and parsing into `Record<modelId, Record<variantKey,
    {reasoningEffort}>|{reasoning:{effort}}>>`) plus the ranking logic
    above. The 5-minute-TTL cache itself still lives in `tasks.js`
    (mirroring how `modelsCache` + `summaryModelAvailable` already live in
    `tasks.js` while `listModelsFn` lives on the executor) — `tasks.js`
    passes a cache-aware wrapper as the `env`/lookup dependency, or the
    opencode executor factory accepts an injected `listVariantsFn` the
    same way `piExecutor` accepts an injected `execFileFn`.
  - The dispatch-time policy boundary in `tasks.js` calls
    `executor.resolveMaxVariant(model, env)` uniformly — no branching on
    `executor.id` — since both executors now implement the same optional
    method.
- Add a sibling cache in `tasks.js`, parallel to the existing
  `modelsCache` (5-minute TTL, same pattern): `opencodeVariantsCache = {
  expiresAt, byModel }`. Kept **separate** from `modelsCache` rather than
  merged into it — different consumers (`summaryModelAvailable`'s
  line-equality check vs. this ranking lookup), different content shapes
  (raw stdout string vs. parsed JSON), different failure handling
  (`summaryModelAvailable` throws on failure since a broken summary-model
  check means the dispatch is broken anyway; the variant lookup soft-fails
  to "no flag" since a lookup failure shouldn't block an otherwise-valid
  dispatch). Concurrent lookups during a cache miss are deduped via a
  shared in-flight promise (not left to race and double-fetch).
- A single `resolveDispatchVariant({ explicitVariant, executor, model,
  defaultVariantEffort, env })` helper in `tasks.js` is the one policy
  boundary: explicit wins outright, passed through **completely
  unvalidated and unreinterpreted** (see "Explicit `--variant` literal
  values" below); otherwise `"default"` → `null`; otherwise `"highest"` →
  `executor.resolveMaxVariant(model, env)`, now defined uniformly on both
  executors (see above), so no `executor.id` branching is needed here.
- `buildSpawnArgs` in both executors stays exactly as it is today (`pi`:
  `args.push("--thinking", ctx.variant)`; `opencode`: `args.push
  ("--variant", ctx.variant)`) — it only ever receives an already-resolved
  concrete value or `null`, never the abstract `"highest"` token. This
  keeps `buildSpawnArgs` a pure argv builder with no config/cache/lookup
  awareness.

### Explicit `--variant` literal values are never reinterpreted

`"default"` and `"highest"` are abstract tokens meaningful only to
`defaultVariantEffort` resolution — they are not reserved strings at the
`--variant` CLI layer. If a caller passes `--variant default` or
`--variant highest` explicitly, it is passed straight through to the
executor exactly as typed, with no special-casing, exactly like any other
explicit `--variant` value today (a typo'd value fails with whatever error
the executor itself gives). This matters concretely: `opencode models
--verbose` shows 28 real models with a variant key literally named
`"default"` — a caller targeting one of those means it literally, and
`resolveDispatchVariant` must not intercept or reinterpret it. `--variant
highest` has no meaning to either executor and will simply fail at the
executor level, the same as any other invalid explicit value — this is
acceptable and requires no new validation in `args.js`.

### `--session-id` resume inherits the prior task's variant, not a fresh resolution

A `--session-id` resume with no explicit `--variant` must inherit
`priorSessionTask.variant` (the exact value that session was actually
running with), not re-run `defaultVariantEffort` resolution against
whatever the daemon's current config happens to be. Concretely:
`task.variant = explicitVariant ?? priorSessionTask?.variant ??
resolvedFromConfig`. Without this, a resume on a daemon whose
`defaultVariantEffort` was changed (or across a daemon restart with a
different config) would silently change the effort level of an
in-progress session. This mirrors the existing resume-inherits-model
rule (fix 1 above) — model and variant should follow the same
"continuing known state wins over fresh defaults" principle. Cross-executor
resume (a prior task's executor differs from the one requested — allowed
by existing code when the executor matches) is out of scope for this spec
to fully resolve; note it as a known edge case: the inherited
`priorSessionTask.variant` string may not be valid for a different
executor's flag, and this spec does not add new validation for that case
beyond what already exists.

### Documentation

- `skills/using-taskferry/SKILL.md` (canonical only, then `npm run
  skill:generate`): update the `--variant` mention in the worker contract
  to describe `defaultVariantEffort`, note that `--model` is now required,
  and flag the removed implicit-high-effort-on-omitted-model behavior as
  an intentional deletion, not a bug.
- `docs/cli-reference.md`: fix the `--variant` rows for both `dispatch`
  and `advisor` (currently wrong — they describe the old
  omitted-`--model`-forces-`high` coupling), and the `--model` row for
  `dispatch` (currently says "use the default model when omitted").
- `docs/config.md`: add a `defaultVariantEffort` /
  `TASKFERRY_DEFAULT_VARIANT_EFFORT` row to the config fields table.
- `docs/sourcemap.md`: add `TASKFERRY_DEFAULT_VARIANT_EFFORT` to the env
  var index.

## Tests to update / add

- **`dispatch()` becoming `async` requires touching every test callsite
  that calls it synchronously — this is the largest single item in this
  list, not a footnote.** Verified counts: `src/tasks.test.js` has 169
  `.dispatch(` callsites (162 not currently `await`ed, including
  `assert.throws(() => mgr.dispatch(...), ...)` patterns at lines 136,
  149, 2535 that must become `await assert.rejects(mgr.dispatch(...),
  ...)`); `src/events.test.js` has 9 sync callsites; `src/activity.test.js`
  has 3 (already `await`ed, minor touchup only);
  `src/opencode-plugin.test.js` has 1. `src/daemon.test.js`'s fake
  manager's `dispatch(params)` should become `async dispatch(params)` to
  match the real contract, even though it happens to work either way
  under `await`.
- `src/executor.test.js`: delete the existing test asserting
  `ex.defaultModel === "minimax/MiniMax-M2.7"` (or equivalent for
  opencode) — the field is being deleted, so this test must go, not just
  the code under test.
- `src/tasks.test.js`: the existing test asserting `--variant high` is
  sent when no model is given must change — omitting `--model` with no
  `--session-id` now throws `--model is required`, so that whole scenario
  changes shape rather than just its assertion.
- New: a `--session-id` resume with no explicit `--variant` inherits
  `priorSessionTask.variant` rather than re-resolving from
  `defaultVariantEffort` (see "resume inherits the prior task's variant"
  above).
- New: an explicit `--variant default` (a real opencode variant name on
  28+ models) or `--variant highest` is passed through to the executor
  completely unreinterpreted — not intercepted by
  `defaultVariantEffort`'s resolution.
- New: omitting `--variant` with `defaultVariantEffort: "default"` sends
  no `--variant`/`--thinking` flag (both executors).
- New: `defaultVariantEffort: "highest"` + pi → `--thinking xhigh`.
- New: `defaultVariantEffort: "highest"` + opencode + a model with
  multiple variants → `--variant <highest-ranked-key>`.
- New: `defaultVariantEffort: "highest"` + opencode + a model with
  `variants: {}` → no `--variant` flag.
- New: explicit `--variant` wins over `defaultVariantEffort: "highest"`.
- New: `TASKFERRY_DEFAULT_VARIANT_EFFORT` env var overrides config value.
- New: opencode variants lookup failure (shell-out throws) → dispatch
  still succeeds, with no `--variant` flag.
- New: a pi-only dispatch with `defaultVariantEffort: "highest"` never
  invokes the opencode variants lookup.
- New: `--session-id` resume with no `--model` still succeeds (inherits
  `priorSessionTask.model`); a fresh dispatch (no `--session-id`, no
  `--model`) throws `--model is required`.
- `src/config.test.js`: accepts `defaultVariantEffort: "default"` /
  `"highest"`; rejects any other string; rejects wrong type.
- `src/executor.test.js`: `piExecutor().resolveMaxVariant()` returns
  `"xhigh"`; `opencodeExecutor().listVariantsFn` parses a sample `opencode
  models --verbose` output into the expected shape.

## Non-goals

- No `taskferry config` CLI subcommand for editing `config.json` — out of
  scope, matches existing config keys' hand-edit-the-file pattern.
- No generic `VariantResolver`/executor-capabilities abstraction beyond
  the one optional `resolveMaxVariant` method — two executors, two simple
  rules (static mapping vs. cached lookup) don't justify a new interface
  layer. Revisit if a third executor lands.
- No persistence of `opencodeVariantsCache` across daemon restarts — same
  as the existing `modelsCache`, which also doesn't persist.
- No migration shim preserving the old implicit-high-on-omitted-model
  behavior — it is being deleted, not flagged.
- **No in-flight-promise dedup added to the existing `modelsCache`/
  `summaryModelAvailable`.** The new `opencodeVariantsCache` gets dedup
  (concurrent cache-miss callers share one in-flight fetch rather than
  each shelling out) because it's new code with no established pattern to
  match; the existing `modelsCache` at `src/tasks.js:694,1123-1130` has no
  such dedup today and this spec does not retrofit it — that's a
  pre-existing, separate inconsistency, not something this change needs
  to fix. A future pass could unify both under the same dedup treatment.
- **No deletion of `defaultSummaryModel`** (`src/executor.js:82,179,280`)
  in this pass, even though it is genuinely dead code (defined on the
  typedef and both executors, never read outside test fixtures —
  `summarizeTask` hardcodes `activitySummaryModel` from
  `config.summaryModel`/`TASKFERRY_SUMMARY_MODEL` instead). It sits right
  next to `defaultModel`, which this spec does delete, but removing it is
  out of scope here — a separate, unrelated dead-code cleanup, not part
  of the variant-effort feature. Worth its own follow-up issue.
