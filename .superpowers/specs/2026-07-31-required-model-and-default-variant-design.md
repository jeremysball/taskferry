# Required --model and default variant (pi effort vocabulary)

Status: DRAFT, parked 2026-07-31. Design decisions were made in session but
this spec never got its user review pass, and no implementation plan was
written. Resume from the checklist at the bottom.

Supersedes `2026-07-28-default-variant-effort-design.md` (a supersession
note is added to that file in the same commit). Same feature, second design
pass. The 2026-07-31 session did not know the earlier spec existed when it
started; several of its verified findings are carried forward below, and
two of today's decisions deliberately replace it.

## Scope

Two coupled changes to `src/tasks.js`'s `dispatch()`, plus a
pi-faithful effort-mapping layer for the opencode executor:

1. `--model` becomes required on a fresh `dispatch` and `advisor` call.
   The implicit per-executor default model and the hardcoded `"high"`
   variant it dragged along are deleted outright.
2. A new `defaultVariant` config (`TASKFERRY_DEFAULT_VARIANT` env var /
   `defaultVariant` config.json key) sets the reasoning effort used when
   `--variant` is omitted. It takes concrete pi effort-level values, not
   abstract tokens.
3. The opencode executor translates those pi levels into the target
   model's real variant values using a vendored copy of pi's own
   per-model mapping table. The pi executor passes levels through
   untouched (pi maps internally).

This is a breaking CLI change. Dispatches that previously omitted
`--model` to get an implicit default model plus forced `"high"` variant
now error with `--model is required` instead. That deletion is the point,
not a side effect.

## Relationship to the 2026-07-28 spec

Carried forward unchanged (verified in the earlier pass, still valid):

- Explicit `--variant` values are never reinterpreted by config
  resolution. Evidence from the old spec: `opencode models --verbose`
  shows 28 real models with a variant key literally named `"default"`, so
  abstract-looking words can be real provider values.
- A `--session-id` resume with no explicit `--variant` inherits
  `priorSessionTask.variant`, same as it inherits the model. Continuing
  known state wins over fresh defaults.
- The docs surface list (cli-reference, config.md, sourcemap, canonical
  SKILL.md plus `npm run skill:generate`).
- `defaultSummaryModel` on the executor typedef is dead code (summaries
  use `config.summaryModel` / `TASKFERRY_SUMMARY_MODEL`). Separate
  cleanup, not part of this feature.

Replaced by this pass:

- Config shape: the old spec's abstract two-value enum
  (`defaultVariantEffort: "default" | "highest"`) is replaced by a
  concrete value drawn from pi's six-level vocabulary
  (`defaultVariant: "off" | "minimal" | "low" | "medium" | "high" |
  "xhigh"`). Directive from the 2026-07-31 session: use pi's effort
  levels as the canonical vocabulary.
- Mapping mechanism: the old spec resolved opencode's highest variant
  via a live, cached shell-out to `opencode models --verbose` with
  reasoningEffort ranking. That required making `dispatch()` async,
  which the old spec correctly identified as its largest cost: 169
  `.dispatch(` callsites in `src/tasks.test.js` alone (162 not awaited,
  including `assert.throws` patterns that would become
  `await assert.rejects`), plus events/activity/plugin/daemon tests.
  This pass maps through a vendored, generated copy of pi's own table
  instead. The lookup is synchronous, so `dispatch()` stays sync and
  that entire test migration disappears. The old spec's
  `opencodeVariantsCache`, in-flight dedup, and `resolveMaxVariant`
  executor method are all dropped.
- Model fallback: both specs delete the dispatch-time
  `executor.defaultModel` fallback. (The 2026-07-31 session briefly
  proposed keeping the field "because summaries and tests use it"; that
  claim was not backed by code. The old spec's verified finding stands:
  summaries read `activitySummaryModel` from config, never
  `defaultModel`. Delete the field and its `src/executor.test.js`
  assertion. Re-verify at implementation time, since line numbers have
  already drifted once between the two specs.)

## Current behavior (being replaced)

`src/tasks.js:1178-1188` inside `dispatch()`:

```js
const usingDefaultModel = !model;
const resolvedModel = model || priorSessionTask?.model || executor.defaultModel;
...
variant: usingDefaultModel ? "high" : variant || null,
```

- Omitting `--model` (no resumable `--session-id` either) silently falls
  back to `executor.defaultModel` (`minimax/MiniMax-M2.7` for pi,
  `openai/gpt-5.6-luna` for opencode; `src/executor.js:178,279`) and
  forces `variant: "high"`.
- An explicit `--variant` passed without `--model` is ignored entirely.
  `docs/cli-reference.md:58` documents this as intentional.
- Passing `--model` but no `--variant` sends no variant flag at all.
- A `--session-id` that matches no prior task also silently falls back
  to the executor default model instead of erroring.

Executor arg emission (`src/executor.js:196,290`): pi pushes
`--thinking <variant>`, opencode pushes `--variant <variant>`, both
gated on `!ctx.isSummary && ctx.variant`. Summary tasks are built on a
separate path (`summarize()`, `src/tasks.js:1667`) with `variant: null`
and no variant on their launch record, so nothing in this design can
leak into summaries.

## Fix 1: --model required on fresh dispatch and advisor

- In `dispatch()`: `resolvedModel = model || priorSessionTask?.model`.
  If neither is available, throw (error text in the Error UX section).
  `usingDefaultModel` is deleted.
- Enforcement lives in `tasks.js`, not `args.js` or `protocol.js`:
  whether a given `--session-id` resolves to a prior task with a model
  is only knowable daemon-side. `--model` stays parse-optional and
  envelope-optional, same division of labor as the existing
  prompt-required check.
- `advisor()` funnels through `dispatch()`, so it gets the rule for
  free. The 2026-07-28 spec states advisor already has a `--model is
  required` rule at the args layer (`src/args.js:433` per its text);
  re-verify that claim at implementation time and reconcile the two
  layers if it holds (args-layer check stays as the early error,
  dispatch-layer check covers RPC callers).
- A `--session-id` matching nothing plus no `--model` errors instead of
  silently falling back. A `--session-id` mismatch with an explicit
  `--model` behaves as today (no new validation there).
- Delete `defaultModel` from the `WorkerExecutor` typedef and both
  implementations, and the `src/executor.test.js` assertion pinning it.

## Fix 2: defaultVariant config

### Surface and precedence

- `CONFIG_FIELD_TYPES.defaultVariant: "string"` in `src/config.js`,
  validated against `KNOWN_VARIANT_LEVELS = ["off", "minimal", "low",
  "medium", "high", "xhigh"]`, following the exact
  `defaultExecutor` / `KNOWN_EXECUTORS` pattern at `src/config.js:24,76`.
  Empty or whitespace-only values are rejected.
- `TASKFERRY_DEFAULT_VARIANT` env var override, resolved in
  `createTaskManager()` with the same env-over-config precedence
  `defaultExecutor` uses (`src/tasks.js:473-474`). Built-in default:
  unset (no configured variant). Unset config means today's behavior
  for explicit-model dispatches: no variant flag.
- Precedence when building the task record: explicit `--variant` >
  resumed session's variant (resume only) > configured `defaultVariant`
  > `null`. The variant line at `src/tasks.js:1188` collapses to
  roughly `variant: variant || priorSessionTask?.variant ||
  defaultVariant || null`. The hardcoded `"high"` is gone.
- Applies to both dispatch and advisor. Never to summaries (separate
  construction path, see above).

### Canonical vocabulary

The six levels are pi's ordered extended-thinking scale, read from the
installed `@mariozechner/pi-coding-agent`'s bundled `pi-ai`
(`dist/models.js`, `EXTENDED_THINKING_LEVELS`). The config surface
accepts exactly these six. Whether the explicit `--variant` flag is
also restricted to these six is an open question; see "Open conflict"
below.

## The opencode mapping

### How pi's table works (reference, verified 2026-07-31)

Shape: `pi-ai/dist/models.generated.js` is a static registry,
`MODELS[provider][modelId]`, each entry carrying `reasoning: boolean`
and an optional `thinkingLevelMap`, a flat `{level: string|null}` over
the six-level vocabulary. The file header says it is auto-generated by
pi-ai's own `scripts/generate-models.ts` (`npm run generate-models`);
the script is not shipped in the npm package, so the committed artifact
is the ground truth at install time.

Three meaning rules (`pi-ai/dist/models.js`,
`getSupportedThinkingLevels`):

- `reasoning: false` means supported levels are exactly `["off"]`;
  anything requested clamps to off.
- A map value of `null` means the level does not exist on this model
  (103 models use this).
- `xhigh` exists only where explicitly mapped. The other five levels
  are assumed present on any reasoning model without being listed.

Clamp (`clampThinkingLevel`): requested level unsupported means walk
the ordered list upward first, then downward, else the first supported
level. Pi deliberately gives more thinking than asked for rather than
less.

Provider translation (level becomes provider-specific API shape,
map-first):

- OpenAI-style providers (`providers/openai-responses.js:182-194`):
  `model.thinkingLevelMap?.[level] ?? level` is sent literally as the
  reasoning-effort word; an unrequested default sends `map.off ??
  "none"`.
- Anthropic adaptive models (`providers/anthropic.js:536-552`): same
  `map[level]` precedence with a hardcoded fallback (`minimal|low` to
  `"low"`, `medium` to `"medium"`, `high|default` to `"high"`). A code
  comment there explains the xhigh split: effort `"max"` is only valid
  on Opus 4.6 while Opus 4.7 supports `"xhigh"`, which is why the table
  has `xhigh: "max"` on some models and `xhigh: "xhigh"` on others.
- Older Anthropic models: the level instead indexes a token budget
  (per-level numbers from settings) plus a maxTokens adjustment. Same
  level, different wire shape entirely.

Extensions (`pi-coding-agent/dist/core/model-registry.js:106-124,
205-208`): custom providers declare their own optional `reasoning` and
`thinkingLevelMap`, shallow-merged over any base model. That is how
`cheapestinference/*`-style providers participate in pi, and it is the
one thing a vendored copy of the bundled registry structurally cannot
see.

Map value distribution as of pi-ai's current bundled registry: 157
models carry maps. Common shapes: `{off: null, xhigh: "xhigh"}` (46),
`{off: null}` (41), `{xhigh: "xhigh"}` (34), `{xhigh: "max"}` (12),
plus rarer ones like `{minimal: "low"}` and uppercase spellings
(`{low: "LOW", high: "HIGH", ...}`, 9 models total).

### taskferry's resolver

New `src/variant-map.js` exporting `resolveOpencodeVariant(model,
level)`, with `src/variant-map.generated.json` as its data:

- Parse `provider/name` from the model string.
- Model in the table: apply pi semantics exactly. Mapped string value
  means use it. `null` means clamp up-then-down over the table's
  supported set. Level missing from the map on a reasoning model means
  pass the level name through. No reasoning means omit the flag.
- Model not in the table (custom providers: `opencode/*`,
  `cheapestinference/*`, anything the bundled registry lacks): pass the
  level through untouched, exactly today's behavior. This is the
  correct analog of pi's extension path, not a lazy fallback: those
  models carry their maps in extension code taskferry cannot see, so
  opencode's own provider layer is the honest translator.
- Resolved `"off"`: omit the flag (equivalent to pi's no-reasoning
  outcome on opencode's surface).
- `opencodeExecutor().buildSpawnArgs` calls the resolver;
  `piExecutor().buildSpawnArgs` is unchanged (`--thinking <level>`,
  pi's own registry and extensions do the mapping).

### The generator

New `scripts/gen-variant-map.js`:

- Locates the installed pi package by resolving the `pi` binary's
  realpath and walking to its package root (overridable by an env var,
  e.g. `PI_PACKAGE_DIR`, for CI and non-standard installs). No
  hardcoded absolute paths in the script, per the standing rule.
- Reads `dist/models.generated.js` (import or parse) and emits
  `src/variant-map.generated.json`: `{provider/model: {reasoning,
  map}}`, restricted to entries that carry `reasoning: false` or a
  non-empty `thinkingLevelMap`. Stamped with pi's package version.
- Committed artifact, reviewed in the PR that regenerates it.
  Regenerate on pi upgrades; drift between the artifact and installed
  pi is a review-time concern, not a runtime one.

### Fidelity boundaries (documented, not solved)

- Budget-translated models (older Anthropic) cannot be faithfully
  reproduced through opencode's `--variant` word surface at all.
  Opencode's own provider layer decides for those; the resolver's
  passthrough-or-mapped-word is best effort.
- The ~9 models with uppercase mapped values (`LOW`, `HIGH`) carry
  pi's provider spelling. If opencode's provider layer disagrees, the
  dispatch fails fast at the worker CLI. A per-provider override table
  in the resolver is the fix if and when that bites; not pre-built.

## Open conflict: enum scope for explicit --variant

Unresolved as of parking. The 2026-07-31 session approved enum
validation ("accept exactly pi's six levels") for both `--variant` and
`defaultVariant`, but before the 2026-07-28 spec's evidence was on the
table:

- 28 real opencode models expose a variant literally named `"default"`.
- opencode's binary string table shows variant lists containing `max`
  (outside pi's six) in some provider contexts, and its `--variant`
  help calls values "provider-specific reasoning effort".

Restricting explicit `--variant` to six words breaks real, addressable
model configurations. Recommendation for the resume pass: the enum
binds the config surface only (`defaultVariant`); an explicit
`--variant` stays a literal, unvalidated passthrough exactly as the
2026-07-28 spec specifies, with the executor's own error as the
backstop for genuinely invalid values. State the final call in this
section when made.

## Error UX

Enforced in `dispatch()` so CLI, RPC, and advisor get identical AXI
`error:/help:` pairs:

```
error: --model is required
help: name the model, e.g. --model provider/model (taskferry models lists
      what's available); to resume an existing session and inherit its
      model, pass --session-id instead

error: no task found for session id "abc123" to inherit a model from
help: pass --model explicitly, or check the session id with taskferry list
```

(Verify the `taskferry models` command exists under that name before
freezing the first help text.)

Invalid configured `defaultVariant` fails at config load with the same
shape as the existing `defaultExecutor` rejection, listing the six
levels.

## Documentation surface

- `docs/cli-reference.md`: `--model` rows for dispatch and advisor gain
  "required unless resuming via `--session-id`"; both `--variant` rows
  (currently lines 58 and 130) lose the forced-high and ignored-flag
  prose and describe the fallback chain (flag, then resumed session,
  then env, then config, then none).
- `docs/config.md`: `defaultVariant` row (`TASKFERRY_DEFAULT_VARIANT`,
  string enum of the six levels, default unset), with the same
  "daemon reads config at startup" note the other keys carry.
- `docs/sourcemap.md`: env-var table row, plus the `tasks.js`
  responsibility cell and `config.js` row, per the repo's same-PR
  rule.
- `skills/using-taskferry/SKILL.md`: canonical file, then `npm run
  skill:generate`, commit the regenerated integration copies. Note
  `--model` is required and that a configured default variant covers
  the omitted-flag case.
- README dispatch examples: sweep for model-less invocations and fix.

## Tests

`dispatch()` stays synchronous, so there is no callsite migration; the
2026-07-28 spec's 169-callsite concern does not apply to this design.

- `src/tasks.test.js`: `makeManager` grows a `defaultVariant`
  passthrough. New cases: fresh dispatch with no model throws; no model
  plus non-matching `--session-id` throws; matching resume inherits
  model and variant; precedence chain (flag > resumed variant > config
  > none) verified through spawned args for both executors; advisor
  gets the same three model cases; config default reaches opencode
  spawns only through `resolveOpencodeVariant`. Flip every existing
  test asserting the hardcoded `"high"` or the `defaultModel`
  fallback (locate at implementation time; the scenario shapes change,
  not just assertions).
- `src/config.test.js`: accepts each of the six levels; rejects other
  strings, empty/whitespace, and wrong types.
- New `src/variant-map.test.js`: resolver unit tests over a fixture
  table: mapped value used; `null` entry clamps upward first then
  downward; unlisted level on a reasoning model passes through;
  `reasoning: false` and resolved `"off"` omit the flag; table miss
  passes through untouched.
- `src/executor.test.js`: delete the `defaultModel` assertion;
  opencode `buildSpawnArgs` routes the variant through the resolver
  (inject a stub); pi `buildSpawnArgs` unchanged.
- Generator script: smoke test over a fixture `models.generated.js`
  fragment, asserting the emitted JSON shape and version stamp.
- Protocol tests: `model` stays envelope-optional (enforcement is
  manager-level).
- Smoke tests: add `--model` to any dispatch that relied on the
  fallback.

## Shipping

- One `feat(cli)!:` commit with a `BREAKING CHANGE:` footer spelling
  out the migration (add `--model` to scripts and integrations, or
  lean on session-id inheritance). The `!` marker is what tooling
  parses; prose alone does not count.
- Code changes auto-restart the idle daemon, but the new env var only
  takes hold after a kill/respawn. One doc line in `docs/config.md`,
  same caveat `defaultExecutor` has.
- Sourcemap updated in the same PR (repo rule).
- Post-merge: open-issue sweep (repo rule), and update the
  explicit-variant-naming memory entry, which a configured default
  partly retires.

## Non-goals

- No budget-token reproduction for budget-translated models. Opencode's
  provider layer is the only honest translator for those.
- No per-provider override table for the uppercase-spelling models
  until a dispatch actually fails there.
- No runtime dependency on `@mariozechner/pi-ai`. Rejected: couples
  taskferry to pi's global-upgrade churn and gains zero coverage, since
  extension models are not in the bundled registry either. The
  generated artifact carries the same data without the coupling.
- No `taskferry config` subcommand. Matches every existing config
  key's hand-edit-the-file pattern.
- No deletion of `defaultSummaryModel` in this pass (dead code,
  separate cleanup, worth its own issue).
- No retrofitted in-flight dedup on the existing `modelsCache`
  (carried from the old spec's non-goals; still unrelated).

## Resume checklist

- [ ] User review of this spec (never happened; parked first).
- [ ] Resolve the enum-scope conflict above (recommendation recorded).
- [ ] Re-verify the advisor args-layer `--model is required` claim
      (`src/args.js` around line 433) and the `defaultModel` deletion
      scope; line numbers drifted between the two specs already.
- [ ] Verify `taskferry models` is the real command name for the help
      text, and what opencode does with an unknown `--variant`
      (hard error vs. ignore).
- [ ] Invoke `superpowers:writing-plans` for the implementation plan.
      Do NOT reuse `.superpowers/plans/2026-07-28-default-variant-effort.md`
      (committed for history but superseded; its async-dispatch
      migration tasks no longer exist).
- [ ] After implementation: supersession note in the old spec can stay
      permanent; move both specs to `.superpowers/.completed/specs/`
      only after the work is verifiably merged.
