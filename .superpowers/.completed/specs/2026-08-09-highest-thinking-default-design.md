# Highest-thinking default + required `--model`

Status: DRAFT, 2026-08-09. Supersedes
`2026-07-31-required-model-and-default-variant-design.md` (which itself
superseded `2026-07-28-default-variant-effort-design.md`). Same feature,
third design pass. Two user decisions from the 2026-08-09 session are
already folded in and are not open questions:

1. Ship the required-`--model` breaking change **together with** the
   variant work, in one PR.
2. The opencode variant table is **warmed by the daemon**; `dispatch()`
   never blocks on it.

The mechanism changed again because a live check of both worker CLIs
(evidence below) showed the 2026-07-31 vendored-table approach solves a
problem pi does not have, and does not solve the one opencode does.

## Scope

1. `--model` becomes required on a fresh `dispatch`. The implicit
   `executor.defaultModel` fallback and the hardcoded `"high"` variant it
   drags along are deleted. (`advisor` already enforces this at both
   layers — see "Already done" below.)
2. When `--variant` is omitted, taskferry asks for **the highest thinking
   level the target model actually supports**, instead of sending no flag
   at all.
3. `defaultVariant` config / `TASKFERRY_DEFAULT_VARIANT` env var makes
   that default overridable, taking either the sentinel `"highest"`
   (built-in default) or a concrete pi level.
4. For opencode, "highest" is resolved from a daily-refreshed cache of
   `opencode models --verbose`. For pi, no cache exists or is needed.

Breaking: a dispatch that previously omitted `--model` to get an implicit
model plus a forced `"high"` now errors. That deletion is the point.

Also breaking, more quietly: a dispatch that passes `--model` and omits
`--variant` previously sent no reasoning flag and got the provider's own
default. It now asks for the model's highest level. That is the feature.

## Evidence (verified 2026-08-09 against the installed CLIs)

Everything in this section was run, not inferred.

### pi already resolves "highest" itself

`pi --thinking <level>` is clamped by `clampThinkingLevel()` in
`@earendil-works/pi-ai/dist/models.js:404-422`: it walks the ordered
level list **upward from the request first, then downward**, so a request
for the top level always lands on the model's highest supported level.
`EXTENDED_THINKING_LEVELS` (line 391) is
`["off","minimal","low","medium","high","xhigh","max"]`, and
`pi --help` lists exactly those seven for `--thinking`.

Run directly against the installed registry:

```
minimax/MiniMax-M2.7   supported=["off","minimal","low","medium","high"]  clamp("max")=high
openai/gpt-4           supported=["off"]                                  clamp("max")=off
anthropic/claude-fable-5 supported=[...,"xhigh","max"]                    clamp("max")=max
```

So for pi, `--thinking max` **is** "highest supported," including
collapsing to `off` on a non-reasoning model. `pi-coding-agent`'s
`agent-session.js:1275-1277` applies that clamp on every
`setThinkingLevel`, and `dist/main.js` calls it with the CLI's level at
session creation.

Consequence: the whole vendored-table apparatus in the 2026-07-31 spec
(`src/variant-map.generated.json`, `scripts/gen-variant-map.js`, the
`resolveOpencodeVariant` fidelity boundaries) is unnecessary **and worse
than passthrough** — a vendored copy of the bundled registry cannot see
extension providers. Confirmed: `ollama/deepseek-v4-flash:0731` appears
in `pi --list-models` but `MODELS.ollama` in the bundled registry is
empty `{}`. pi's own runtime sees the extension; a vendored copy never
would. Delete that whole branch of the design.

### opencode exposes real per-model variants, and silently ignores bad ones

`opencode models --verbose` (3.4s, 431 models) prints `provider/model` at
column 0 followed by an indented JSON block carrying a `variants` object:

```
opencode/deepseek-v4-flash-free
{ ... "variants": {"low": {"reasoningEffort": "low"}, "high": {...}, "max": {...}} }
```

- 174 of 431 models declare variants; 257 declare none.
- Key vocabulary across all 174: `high` (164), `low` (110), `medium`
  (106), `max` (76), `xhigh` (57), `none` (47), `minimal` (23), and
  `thinking` (7). All but `thinking` are pi's vocabulary.
- The 7 `thinking` models are the MiniMax-M3 family, all shaped
  `{none, thinking}` (an Anthropic-style budget toggle, inner value
  `{"thinking": {"type": "enabled", "budgetTokens": N}}`).
- **Declaration order is ascending by effort on all 174 models.** Checked
  mechanically: ranking `none/off < minimal < low < medium < high <
  xhigh < max`, the only 7 models whose key order is not non-decreasing
  are exactly the `{none, thinking}` seven, where `thinking` (unranked)
  is still last.

And the failure mode that forces the lookup:

```
opencode run -m opencode/laguna-s-2.1-free --variant bogusnonsense -- "say OK"
→ completes normally, no error
```

opencode neither rejects nor clamps an unknown `--variant`. So blindly
sending `max` everywhere would silently do nothing on the ~100 models
that lack it — the exact opposite of "highest." opencode's variant list
is the only thing that says what to send.

### No models.dev or raw-API fallback is needed

Both fallbacks named in the 2026-08-09 request are unnecessary: pi
resolves highest internally, and opencode publishes the table locally.
Neither path is designed here.

### Already done, do not redo

- `advisor` enforces `--model is required` at **both** layers already:
  `src/args.js:375` (parse-time) and `src/tasks.js:2710` (manager-level,
  message `error: model is required`). Only `dispatch` needs the new
  check. The 2026-07-31 spec's "re-verify this claim" item is closed.
- There is **no `taskferry models` command** (`src/command-specs.js`
  lists dispatch, cancel, accept, reject, wait, advisor, status, tail,
  summary, result, list, watch, context, doctor, setup, init). Error help
  text must not reference one.
- `docs/sourcemap.md` no longer exists (retired in 8d4e1ee). The
  2026-07-31 spec's sourcemap doc tasks are void.

## Current behavior (being replaced)

`src/tasks.js:2109-2119`, inside `buildDispatchTask()`:

```js
const usingDefaultModel = !model;
const resolvedModel = model || priorSessionTask?.model || executor.defaultModel;
...
variant: usingDefaultModel ? "high" : variant || null,
```

Executor emission (`src/executor.js:237,331`): pi pushes
`--thinking <variant>`, opencode pushes `--variant <variant>`, both gated
on `!ctx.isSummary && ctx.variant`. Summaries are built on a separate
path (`summarize()`) with `variant: null`, so nothing here reaches them.

## Fix 1: `--model` required on a fresh dispatch

- `resolvedModel = model || priorSessionTask?.model`; throw when neither
  exists. `usingDefaultModel` is deleted.
- Enforced in `dispatch()`/`buildDispatchTask()`, not `args.js`: whether a
  given `--session-id` resolves to a prior task with a model is only
  knowable daemon-side. `--model` stays parse-optional for `dispatch`,
  same division of labor as the existing prompt-required check.
- A `--session-id` matching no prior task, with no `--model`, errors
  instead of silently falling back.
- Delete `defaultModel` from the `WorkerExecutor` typedef
  (`src/executor.js:80`) and both implementations (`:214`, `:320`), and
  the assertion at `src/executor.test.js:31`. Test fixtures set
  `defaultModel` on fake executors in 5 files (`tasks.executor.test.js`
  ×11, `tasks.failure.test.js` ×3, `tasks.summarize.test.js` ×2,
  `tasks.dispatch.test.js` ×1, `executor.test.js` ×1) — those fixture
  lines go away and the affected dispatches gain an explicit `--model`.
- `defaultSummaryModel` stays (dead code, separate cleanup, its own
  issue).

### Error UX

```
error: --model is required
help: name the model, e.g. --model provider/model (opencode models or
      pi --list-models lists what's available); to resume an existing
      session and inherit its model, pass --session-id instead

error: no task found for session id "abc123" to inherit a model from
help: pass --model explicitly, or check the session id with taskferry list
```

## Fix 2: default variant = highest supported

### Config surface and precedence

- `CONFIG_FIELD_TYPES.defaultVariant: "string"` in `src/config.js`,
  validated against `"highest"` plus pi's seven levels (`off`, `minimal`,
  `low`, `medium`, `high`, `xhigh`, `max`), following the
  `defaultExecutor`/`KNOWN_EXECUTORS` pattern. Empty/whitespace rejected.
- `TASKFERRY_DEFAULT_VARIANT` env override resolved in
  `createTaskManager()`, same env-over-config precedence `defaultExecutor`
  uses. **Built-in default: `"highest"`.**
- `"highest"` is safe as a sentinel: it appears in neither pi's seven
  levels nor any of the 8 variant key names opencode publishes. (This is
  why the 2026-07-28 spec's rejected `"default"` token is not reused —
  28 real opencode models expose a variant literally named `default`.)
- Precedence: explicit `--variant` > resumed session's variant (resume
  only) > `defaultVariant` > `"highest"`. An explicit `--variant` is
  never reinterpreted, never validated against any enum, and passes
  through literally — the worker CLI is the backstop. This closes the
  2026-07-31 spec's one open conflict, in favor of its own recommendation.
- Applies to dispatch and advisor. Never to summaries.

### Where resolution happens

At **dispatch time**, in `tasks.js`, not in `buildSpawnArgs`. The task
record then stores what was actually requested, so `taskferry status`
tells the truth and executors stay dumb passthroughs.

New `src/variants.js`:

```js
resolveVariant({ executorId, model, requested, table })  // → string|null
```

- `requested` is a concrete level (not `"highest"`): return it verbatim,
  whatever the executor. No validation, no mapping.
- `requested === "highest"`, `executorId === "pi"`: return `"max"`. pi
  clamps to the model's real ceiling at runtime, including extension
  providers taskferry cannot see.
- `requested === "highest"`, `executorId === "opencode"`: look up
  `provider/model` in `table`.
  - Model absent from the table, or present with no variants: return
    `null` (send no flag). Correct for the 257 variant-less models, and
    the honest answer for a model the cache has never seen.
  - Otherwise pick the highest key (algorithm below). If that key is
    `none` or `off`, return `null` — asking for no reasoning is the same
    as sending no flag on opencode's surface, and never what "highest"
    means.

### Picking the highest key

Rank the known names `none/off=0, minimal=1, low=2, medium=3, high=4,
xhigh=5, max=6`. An unknown name takes the rank of the previously
declared key plus 0.5 (or −0.5 when it is first). Pick the maximum;
ties break toward the later-declared key.

This is a documented heuristic, not a guess: it reproduces the correct
answer on all 174 models with variants today, including the 7
`{none, thinking}` models where the unknown `thinking` key is the one
meant (`none`=0, `thinking`=0.5 → `thinking`). It degrades to plain
declaration order if opencode ever introduces vocabulary wholesale, which
matches the observed ascending-order invariant.

## The opencode variants cache

### Shape and location

`<cacheDir>/opencode-variants.json` (`resolveCacheDir()`,
`src/paths.js:104` — `TASKFERRY_CACHE_DIR` or
`$XDG_CACHE_HOME/taskferry`; regenerable data, correctly not the state
dir):

```json
{
  "schema": 1,
  "generatedAt": "2026-08-09T22:00:00.000Z",
  "fingerprint": "<modelsCacheFingerprint(env)>",
  "models": { "opencode/deepseek-v4-flash-free": ["low", "high", "max"] }
}
```

Values are variant key names **in opencode's declaration order** — the
order is load-bearing for the ranking heuristic, so it must be preserved,
not sorted.

### Staleness: mtime, plus fingerprint

- Stale when `Date.now() - statSync(file).mtimeMs > 24h`. The TTL is a
  constant with a `TASKFERRY_VARIANT_CACHE_TTL_MS` override for tests and
  for anyone who wants a tighter window.
- Also stale when the stored `fingerprint` differs from
  `modelsCacheFingerprint(env)` (`src/tasks.js:4707`) — the existing
  helper that already captures every `*_API_KEY`/`*_BASE_URL`,
  `OPENCODE_CONFIG*`, `OPENCODE_MODELS_*`, and `PI_CODING_AGENT_DIR`.
  Different credentials mean a different model catalog; reuse the helper
  rather than inventing a second notion of "same environment."
- A malformed or wrong-`schema` file is treated as absent, and gets
  overwritten by the next refresh. No partial parsing, no repair.

### Reading it (sync, on the dispatch path)

`dispatch()` is synchronous and stays synchronous. It reads the cache
through an in-process memo keyed on the file's `mtimeMs`, exactly the
pattern `loadConfig()`'s `_configCache` already uses
(`src/config.js:9-15`): stat the file (cheap), reuse the parsed table
when the mtime is unchanged, re-read when it moved. A background refresh
that rewrites the file is therefore picked up on the very next dispatch
with no invalidation call.

Cache absent or model missing → variant `null`, and a **once-per-model
per-daemon-lifetime** warning on stderr:

```
warning: no cached opencode variants for openai/gpt-5.6-luna; dispatching with no variant flag
help: the daemon refreshes the variant cache at startup and every 24h; run taskferry doctor to check it
```

Once-per-model, because a 50-ferry fleet on one unknown model would
otherwise write 50 identical lines into the daemon log.

### Refreshing it (async, daemon-side, never on the dispatch path)

- New `listModelVariantsFn` on the **opencode executor only**
  (`src/executor.js`): shells out to `opencode models --verbose`, parses,
  returns the map. The pi executor does not define it — the absence is
  the statement that pi needs no table.
- Parsing: a line at column 0 matching `/^\S+\/\S+$/` starts a new model
  entry; every following line is part of its JSON block (verified: JSON
  body lines are always indented, model-id lines never are). `JSON.parse`
  the accumulated block, take `Object.keys(entry.variants ?? {})`. A
  block that fails to parse is skipped, not fatal — one malformed model
  must not cost the whole refresh.
- `startDaemon()` (`src/daemon.js:404`) kicks off one refresh after the
  socket is bound, awaited by nothing, and schedules an `unref()`'d
  interval that re-checks staleness. Both are no-ops when the file is
  fresh. A refresh failure logs and leaves the previous file in place;
  it never takes the daemon down and never blocks a dispatch.
- Refreshes are single-flight per daemon (one in-flight promise), same
  concern the existing `modelsCacheInFlight` map solves for the summary
  model check.
- The daemon writes the file atomically (temp file in the same dir +
  `rename`) so a concurrent sync reader never sees a half-written JSON.

## Documentation surface

- `docs/cli-reference.md`: `--model` rows for dispatch gain "required
  unless resuming via `--session-id`"; both `--variant` rows (currently
  ~58 and ~130) lose the forced-`high`/ignored-flag prose and describe
  the chain (flag → resumed session → `defaultVariant` → highest).
- `docs/config.md`: `defaultVariant` row
  (`TASKFERRY_DEFAULT_VARIANT`, enum, default `highest`) plus the
  `TASKFERRY_VARIANT_CACHE_TTL_MS` knob, both with the existing
  "daemon reads config at startup" caveat.
- `docs/daemon.md` "Things that look like bugs but aren't" (repo rule —
  same PR) gets two entries:
  - A pi task's record says `variant: "max"` but the provider ran
    `high`. pi clamps per model at runtime; taskferry records the request,
    not the clamp, because taskferry cannot see pi's extension registry.
  - A model added by a provider today may dispatch with no variant flag
    until the daily refresh runs. Deliberate: the alternative is a 3.4s
    shell-out on the daemon's single thread mid-dispatch.
- `skills/using-taskferry/SKILL.md`: canonical file only, then
  `npm run skill:generate`, commit the regenerated integration copies.
  `--model` is required; omitted `--variant` now means "hardest this
  model thinks."
- `README.md`: sweep dispatch examples for model-less invocations.

## Tests

`dispatch()` stays synchronous — no callsite migration, and the
2026-07-28 spec's 169-callsite async concern still does not apply.

- New `src/variants.test.js`: ranking over a fixture table (known-name
  max; `{none, thinking}` picks `thinking`; ties break later; `none`-only
  → `null`; empty/absent model → `null`); pi always returns `"max"` for
  `"highest"`; concrete requested levels pass through untouched on both
  executors.
- New coverage for the cache module: mtime memo reuses without re-reading
  and re-reads after a touch; TTL expiry; fingerprint mismatch; malformed
  JSON and wrong `schema` treated as absent; atomic write leaves no
  partial file; the `--verbose` parser handles a multi-model fixture,
  a variant-less model, and a malformed block mid-stream.
- `src/tasks.dispatch.test.js`: fresh dispatch with no model throws; no
  model + non-matching `--session-id` throws; matching resume inherits
  model and variant; the full precedence chain verified through spawned
  args for both executors; warning emitted once per model, not once per
  dispatch.
- `src/config.test.js`: accepts `highest` and each of the seven levels;
  rejects other strings, empty/whitespace, wrong types.
- `src/executor.test.js`: drop the `defaultModel` assertion; opencode
  gains `listModelVariantsFn`, pi does not.
- `src/daemon.test.js`: startup schedules a refresh; a failing refresh
  does not fail startup; the interval is `unref()`'d.
- Smoke tests and every fake-executor fixture: add explicit `--model`.

## Shipping

- One `feat(cli)!:` commit with a `BREAKING CHANGE:` footer covering both
  breaks (missing `--model` now errors; omitted `--variant` now requests
  highest). The `!` marker is what release-please parses.
- Code changes auto-restart the idle daemon, but the two new env vars
  only take hold after a kill/respawn — one line in `docs/config.md`,
  same caveat `defaultExecutor` carries.
- Post-merge: open-issue sweep (repo rule). This should close **#137**
  (`--variant` can't turn reasoning off — `defaultVariant: "off"` and an
  explicit `--variant off`/`none` now express it) only if a real check
  confirms it, and it substantially answers **#236** (codifying pi's
  effort vocabulary as the config syntax). Verify both against the diff
  before closing either.
- Update the `feedback_explicit_variant_naming` memory entry, which a
  working default largely retires.
- Move all three specs (`2026-07-28`, `2026-07-31`, this one) to
  `.superpowers/.completed/specs/` once merged.

## Non-goals

- No vendored copy of pi's registry, no `scripts/gen-variant-map.js`, no
  runtime dependency on `@earendil-works/pi-ai`. pi resolves highest
  itself, extensions included.
- No models.dev lookup and no raw provider API calls.
- No validation of an explicit `--variant`. The worker CLI decides; note
  that opencode's decision for an unknown value is to ignore it.
- No budget-token reproduction for the `{none, thinking}` models beyond
  sending `--variant thinking`.
- No `taskferry config` subcommand; every config key is hand-edited today.
- No deletion of `defaultSummaryModel` (dead code, its own issue).
