# Model/Provider Tags and Routing — Design

Date: 2026-08-19. Status: proposed, ready for an implementation plan.

## Background

Task Ferry's `--model` flag today takes a free-text `provider/model-slug`
string with no structure taskferry itself understands. Which models are
good for what, which are live, which are excluded from a given provider,
lives entirely in prose — the `choosing-a-model` skill's `working-report.md`
— that has to be read and cross-checked by hand on every dispatch decision.

Two incidents on 2026-08-19 trace to exactly that gap:

- `jeeves`'s `fallback_model` was set to `ollama/kimi-k2.7-code` on the
  strength of "different provider than the primary, so it's failover
  diversity." That's true, but it also violated a standing rule scoped to
  the `ollama` provider specifically ("flash and nothing else — no other
  `ollama/*` model is a fallback option on this provider at all"). Nothing
  in the dispatch path could see that rule; it lived only in
  `working-report.md` prose, and the config comment citing it referenced a
  `cheat-sheet.md` that doesn't exist. It fired on every primary failure
  for over a week before being caught.
- The `using-sisyphus` skill's doc example hardcoded
  `meta/muse-spark-1.2` (missing the `-contributor` suffix that names the
  standing cheap-tier default). Copy-pasted verbatim into a real dispatch,
  it routed to the non-free OpenRouter variant and spent ~$12 on a task
  budgeted for ~$3.

Both are the same shape: a model name reached a dispatch through a path
that had no way to check it against a rule that already existed elsewhere.
This design pushes that rule-checking into taskferry's own config and
routing logic, so "which model, on which provider" becomes something
taskferry can validate and resolve instead of something a human (or an
agent under time pressure) has to get right by memory every time.

## Goals

- A structured, per-provider place to declare "here is the `<tier>` model
  on this provider" that dispatch tooling reads directly, instead of prose.
- Four dispatch modes: exact (model+provider), model-only (taskferry picks
  the provider), tag-only (taskferry picks provider and model), and
  provider+tag (taskferry picks the model on a named provider).
- Exclusion by omission: a model that must never be auto-selected on a
  given provider (the `ollama`/`kimi-k2.7-code` case) is excluded simply by
  never appearing in that provider's tag lists — no separate denylist
  construct.
- No loss of the existing exact-dispatch escape hatch: a user who types a
  precise `--provider`+`--model` pair can still reach any model, tagged or
  not. This is a deliberate, explicit override, not a hole in the guard —
  see "We build for ourselves" below.

## Non-goals (v1)

- Live network probing before dispatch (liveness stays reactive: a dead
  route fails the way it does today, mid-task).
- Cross-provider tag aliasing or renaming.
- Per-tag cost budgets or spend limits.
- Automatic migration of `working-report.md`'s prose into config — this
  spec adds the mechanism; populating it from the current standing rules is
  a follow-up, not part of this change.

## Config shape

New top-level `tags` and `providers` keys in
`~/.config/taskferry/config.json`:

```jsonc
{
  "tags": ["cheap", "most-capable"],

  "providers": {
    "ollama": {
      "maxConcurrentTasks": 3,
      "priority": 1,
      "tags": {
        "cheap": ["deepseek-v4-flash:0731"],
        "most-capable": ["kimi-k3"]
      }
    },
    "openrouter": {
      "priority": 2,
      "tags": {
        "cheap": ["deepseek/deepseek-v4-flash-0731"],
        "most-capable": ["anthropic/claude-sonnet-4.5"]
      }
    }
  }
}
```

**`tags` is a global registry, not a per-provider free-for-all.** It's the
one place tag names are declared. Each provider's `tags` object may only
use keys drawn from that registry — enforced at config-load time, so a
typo on one provider (`"chep"` vs `"cheap"`) is a load-time error instead
of a silently orphaned key that a tag-only dispatch can never match on that
provider. This is what makes cross-provider tag lookup (modes 2 and 3,
below) correct by construction instead of by naming discipline.

**Tags are provider-scoped on purpose, not model-scoped.** A tag means "the
model to reach for at this tier, on this provider" — `most-capable` under
`ollama` names ollama's best option, not a claim that `kimi-k3` is the most
capable model in any absolute sense. This is why the same tag can point at
different models across providers without contradiction
(`ollama.most-capable → kimi-k3`, `openrouter.most-capable →
claude-sonnet-4.5`), and it's why a flat `model → tag` map would be the
wrong shape even though it looks simpler: it forces one global ranking, and
it can't represent a model that's `cheap` on one provider and simply absent
— not worth using at all — on another. Overlap across providers is
expected and fine; the scoping exists for the cases where there isn't any.

**One tag per model, per provider — enforced at load time.** A model slug
appearing in two tag arrays under the same provider's `tags` object is a
config error naming the duplicate, not last-wins.

**A tag's array is ordered.** The first entry is the provider's preferred
model for that tag. This ordering is what mode 3/4 resolution uses to pick
a model once a provider is chosen (see below).

**`providers.<name>.maxConcurrentTasks` replaces `providerLimits.<name>`
outright.** No dual-reading, no deprecation shim. This is a one-time manual
edit to a single local config file, not a public API with a compatibility
contract — consistent with building for a power user who edits config
directly rather than one insulated behind migration tooling.

**Exclusion is omission, not a denylist.** `ollama.tags` simply never lists
`kimi-k2.7-code` in any tag's array. Since every auto-routing mode (2, 3, 4
below) only ever selects from within a provider's declared tag lists, an
omitted model can never be reached by auto-routing — no separate "excluded
models" list to keep in sync or forget to update.

## CLI

New flags on `taskferry dispatch`:

- `--provider <name>` — new, separate from `--model`.
- `--tag <name>` — new. Mutually exclusive with `--model` (naming a tag
  already means "pick the model for me").
- `--model <slug>` — now takes a **bare** model slug when used without
  `--provider`. The existing compound `provider/model` string is still
  accepted for one deprecation cycle, parsed internally into
  `--provider`+`--model`, with a one-line deprecation notice printed on
  use. (This deprecation applies to the CLI flag format only — see above
  for why the *config key* gets no equivalent shim.)

Validation:

- `--tag` and `--model` together → CLI usage error.
- `--provider` may combine with either `--model` or `--tag`.
- At least one of `--model`/`--tag` is required; behavior when neither is
  given is unchanged from today.

## Resolution algorithm

**Mode 1 — `--provider` + `--model` (exact).** Dispatch directly to that
pair. If the model isn't listed under any of that provider's tags, dispatch
still proceeds — this is a deliberate, explicit override, and the point of
tags is to guide auto-routing, not to hard-gate a user who typed an exact
pair on purpose — but a warning prints naming the tags that *are* declared
on that provider, so a typo or a stale doc example is visible immediately
instead of silently reaching production. (This is precisely the failure
class from both incidents: a stale/mistyped model reaching a real dispatch
with nothing to flag it. Mode 1 can't refuse an exact ask, but it can make
a wrong one loud.)

**Mode 2 — `--model` only (no provider).** Search every provider's `tags`
for a matching slug.
- Exactly one match → dispatch there.
- Multiple matches → break the tie by explicit `priority` first (lower
  number wins; a provider with no `priority` set sorts after every provider
  that has one); among providers tied on priority (including "no priority
  set" as its own tier), by least-loaded (current in-flight task count
  against `maxConcurrentTasks` — cheap and local, no network probe).
- Zero matches → **hard error**: `"<model>" isn't tagged on any provider —
  use --provider to dispatch explicitly, or add it to a provider's tags`.
  This is the direct fix for the doc-staleness/typo failure class: an
  untagged model can never be silently auto-routed to; it has to be named
  explicitly (mode 1) or added to a tag first.

**Mode 3 — `--tag` only (no model, no provider).** Among providers whose
`tags` registry includes this tag, pick a provider the same way as mode
2's tie-break (`priority`, then least-loaded). Then take the first entry
in that provider's `tags[tag]` array.

**Mode 4 — `--provider` + `--tag`.** No provider-selection step. Take the
first entry in `providers[provider].tags[tag]`. Error if that provider
doesn't declare the tag at all.

"Least-loaded" is deliberately cheap in v1: current in-flight task count
against `maxConcurrentTasks`, not an actual liveness probe. A dead route
still fails the way it does today — mid-dispatch — rather than being
predicted upfront; see Non-goals.

## Discovery

- `taskferry providers list` — providers, their `priority`, and current
  load vs. `maxConcurrentTasks`.
- `taskferry tags list` — the global tag registry and, per tag, which
  providers declare it and what model they map it to.

Both exist so tag/provider state is inspectable without opening
`config.json` by hand — the same instinct that put the original knowledge
in a human-readable doc in the first place, but now backed by the config
taskferry actually dispatches against.

## Error handling summary

| Condition | Behavior |
|---|---|
| Provider's `tags` object uses a key not in the global `tags` registry | Config load-time error |
| Same model slug in two tags under one provider | Config load-time error |
| `--tag` and `--model` both given | CLI usage error |
| `--model` given alone, matches no provider | Dispatch-time error (mode 2) |
| `--tag` given alone, matches no provider | Dispatch-time error (mode 3) |
| `--provider`+`--tag`, provider doesn't declare that tag | Dispatch-time error (mode 4) |
| `--provider`+`--model`, model untagged on that provider | Dispatch proceeds, warning printed (mode 1) |

## Migration path

- Config: `providerLimits` is replaced by `providers.<name>.maxConcurrentTasks`
  in the same edit that adds `tags`/`priority`. No compatibility shim.
- CLI: the compound `--model provider/model-slug` string keeps working for
  one deprecation cycle, printing a notice pointing at `--provider`+bare
  `--model`.
- Populating `tags` from the current standing rules in
  `choosing-a-model/working-report.md` is manual, incremental follow-up
  work, not part of this change — this spec adds the mechanism; it doesn't
  attempt to transcribe the current prose in one pass.

## Testing

- Config validation: unknown tag key under a provider; duplicate model
  across two tags on one provider; malformed `tags`/`providers` shapes.
- Resolution algorithm, one test per mode (1–4), including the
  multi-match tie-break (priority, then least-loaded) and each
  dispatch-time error case in the table above.
- CLI: `--tag`+`--model` rejected; compound `provider/model` string still
  parses and prints the deprecation notice; bare `--model` with no
  `--provider` resolves via mode 2.
- `taskferry providers list` / `taskferry tags list` output shape.
