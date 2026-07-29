# defaultVariantEffort design

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
  `executor.defaultModel` (`minimax/MiniMax-M2.7` for opencode,
  `openai/gpt-5.6-luna` for pi — `src/executor.js:178,279`) **and** forces
  `variant: "high"`, regardless of whether the caller wanted that effort.
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
    medium < high < max` and pick whichever key ranks highest; (3) if
    `variants` is empty, omit `--variant` entirely — same effective result
    as `"default"` for that model, since there's nothing to escalate to.
  - This lookup only ever runs for opencode dispatches. A pi-only install
    never shells out to `opencode` and never needs it installed — pi's
    `resolveMaxVariant`-equivalent is synchronous and model-independent.

### Implementation shape

- `dispatch()` becomes `async` (it already calls into async work
  elsewhere in the surrounding function; the opencode variant lookup is
  the only new async edge). `advisor()` already `await`s `dispatch()`;
  the daemon RPC path in `src/commands.js` already awaits the manager
  call — no caller needs to change its own sync/async shape.
- Add a `resolveMaxVariant` optional method to `WorkerExecutor`, following
  the same optional-capability pattern already used for `listModelsFn`:
  - `piExecutor().resolveMaxVariant = async () => "xhigh"` — the entire pi
    delta, one line, no cache, no lookup.
  - opencode does not get a `resolveMaxVariant` field directly; instead
    `opencodeExecutor()` gains a `listVariantsFn(env)` (parallel to the
    existing `listModelsFn`, shelling out to `opencode models --verbose`
    and parsing into `Record<modelId, Record<variantKey,
    {reasoningEffort}>>>`), and `tasks.js` owns the cache-aware resolution
    on top of it — mirroring how `modelsCache` +
    `summaryModelAvailable` already live in `tasks.js` while
    `listModelsFn` lives on the executor.
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
  boundary: explicit wins outright; otherwise `"default"` → `null`;
  otherwise `"highest"` → `executor.resolveMaxVariant` for pi, or the
  cache-aware opencode lookup, keyed off `executor.id`.
- `buildSpawnArgs` in both executors stays exactly as it is today (`pi`:
  `args.push("--thinking", ctx.variant)`; `opencode`: `args.push
  ("--variant", ctx.variant)`) — it only ever receives an already-resolved
  concrete value or `null`, never the abstract `"highest"` token. This
  keeps `buildSpawnArgs` a pure argv builder with no config/cache/lookup
  awareness.

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

- `src/tasks.test.js`: the existing test asserting `--variant high` is
  sent when no model is given must change — omitting `--model` with no
  `--session-id` now throws `--model is required`, so that whole scenario
  changes shape rather than just its assertion.
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
