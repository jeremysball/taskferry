# Choosing a model for a dispatch

Every dispatch needs an explicit `--model`. This file covers how to pick
one: the capability tiers, which tier each role needs, what to sort on
within a tier, and how effort/variant interacts with all of it.

**Account-specific state deliberately lives outside this file** — which
providers are live on your account, per-provider time windows, key state,
rate limits, current outages, and today's specific model picks all drift on
a timescale no checked-in file can track. Keep those in whatever your host
reads for standing instructions (`CLAUDE.md` for Claude Code, `AGENTS.md` for
Codex, or a personal skill) and check them before dispatching to a gated
provider.
When a provider you wanted is gated shut, pick an equivalent-tier model on
another provider rather than waiting idle or dispatching outside the allowed
window. Everything below is the stable logic that sits on top.

## The governing principle

**Use the least powerful model that can handle each role, not reflexively
the strongest one available.** Escalate tier when the task is
architecturally risky, security-sensitive, or has already failed on a
lighter model — and never let the review role inherit the implementer's
tier just because the diff being reviewed was mechanical.

## The three tiers

Tier is about the model's own capability, not the price of the route you
reach it through.

**Cheapest** — transcription-grade, no judgment required. Free tiers
(`opencode/*-free`, `openrouter/*:free`) and genuinely lightweight models.

**Standard** — genuine reasoning; the floor for anything judgment-heavy.
Mid-tier paid models, and whatever taskferry's own dispatch default
currently is (a useful calibration point — but never rely on an *omitted*
`--model` to land there; always pass one explicitly).

**Most-capable** — architecture, security-sensitive work, advisor opinions,
final whole-branch review. The strongest model a provider offers, run at its
highest effort/variant.

**Route ≠ capability.** The same underlying model can be reachable both at
full price and through a cheap, discounted, or time-gated route. A
restricted or discounted route says nothing about the model's actual tier —
don't downgrade your estimate of a model because you reached it cheaply, and
don't upgrade a weak model because its usual route is expensive. Provider
namespaces span multiple tiers, so check the specific model against
`opencode models` or recent dispatch history rather than treating the
namespace as the tier signal.

## Role → tier mapping

| Role | Tier | Why |
|---|---|---|
| Implementer, brief has complete code to write, or a single-file mechanical fix | Cheapest | Transcription plus testing — no design judgment needed |
| Implementer, working from a prose spec / multi-file integration | Standard | Requires interpreting intent, not just typing out given code |
| Architecture / design task | Most-capable | Wrong structural decisions are expensive to unwind later |
| **Task reviewer** | **Standard floor, always** | The reviewer's job is to catch what the implementer missed — that takes judgment even when the diff itself was mechanical. The review role does not inherit the implementer's cost tier. |
| Final whole-branch review | Most-capable | Broadest blast radius of any review in the workflow |
| Advisor opinion (statistical / security / correctness-critical) | Most-capable, domain-relevant | The point of an advisor pass is a second opinion strong enough to catch what the first pass couldn't |
| Exploration / research (broad codebase or doc reading, multi-file classification against evidence, status synthesis) | Standard floor | Requires holding a lot of context and weighing evidence, not just transcribing. A cheapest-tier model asked to classify dozens of files tends to pattern-match on titles instead of actually checking |

**The anti-pattern this table exists to head off:** dispatching a
cheapest-tier model as task reviewer because "the implementer tasks were
cheap-tier, so the matching reviewers can be too." That reasoning is
backwards — the implementer's task was cheap because the brief already
contained the exact code to write; the reviewer has no such brief to
transcribe from, it has to actually judge the diff. If six implementer
dispatches all used the cheapest tier because their briefs were verbatim,
the six reviewer dispatches checking their work still need the standard
floor.

## Scope the task to the tier, not just the role

The mapping above answers "how much judgment does this role need" — not
"how much scope can this tier take in one dispatch." A cheapest- or
standard-tier model can be exactly the right tier for an implementer role
and still struggle, because the brief itself is an undecomposed
multi-hotspot refactor instead of a single bite-sized deliverable.

**Before dispatching a nontrivial refactor or multi-file task to anything
below most-capable tier, decompose it to one-file/one-function granularity
at plan or dispatch time.** Don't dispatch the full undecomposed scope and
let a string of fix-round crashes discover the decomposition reactively —
that costs more wall time and more ferry rounds than splitting it up front,
and it's indistinguishable from a tier problem until someone reads the whole
trail of sub-dispatches.

This is a rule about *scope*, not a second tier rule that overrides the table
above. The table's "multi-file integration → Standard" assumes the task has
already been decomposed to a coherent unit of work. Order of operations:

1. Decompose first. Split until each brief is one coherent change — usually
   one file or one function.
2. Then tier from the table. A decomposed multi-file integration (several
   files that must change together to be correct, like a rename across a
   call site and its definition) is Standard tier; it does not escalate just
   because it touches more than one file.
3. Escalate to most-capable only when the task genuinely *cannot* be
   decomposed — the change is irreducibly whole-system, and no smaller unit
   passes the check on its own.

## What to sort on within a tier

Tier says how *much* judgment a role needs; the axis below says what *kind*
of signal to rank candidates on. An implementer and a reviewer need
different faculties, and a model strong on coding but weak on reasoning can
carry the same blended "intelligence index" as one with the opposite
profile — so rank per class on a per-category axis, not on one blended
scalar.

| Class | Primary axis | Secondary axis |
|---|---|---|
| Implementer (code from a prose spec, multi-file integration) | Agentic coding | Coding |
| Transcription / mechanical (verbatim code in the brief, single-file fix) | Instruction following | — |
| Fixer / debugger (repair failing tests, diagnose a crash) | Agentic coding | Reasoning |
| Task reviewer (find what the implementer missed) | Reasoning | Agentic coding |
| Final whole-branch review | Reasoning | Coding |
| Advisor — statistical / security | Reasoning | Mathematics |
| Advisor — design / architecture | Reasoning | Language |
| Review finder / explorer (scan a diff across angles) | Reasoning | Language |
| Review verifier (confirm or refute one specific finding) | Reasoning | Agentic coding |
| Researcher / synthesis | Language | Reasoning |

The axis is a *discriminator*, not a quality claim: picking agentic coding
for implementers doesn't assert they need no reasoning — it picks the
category whose within-class spread best predicts success, with the secondary
axis guarding the other half of the job.

Prefer open, mechanically-graded benchmarks (unit-test or regex scored) over
LLM-judged leaderboards for these axes, and re-check any specific number
before quoting it as fact — scores drift with every release.

## Effort and variant

- A higher effort/variant (`high`, `max`) buys more reasoning depth and more
  wall-clock, **not** a higher capability ceiling. It cannot turn a
  cheapest-tier model into a substitute for a standard-tier one on
  judgment-heavy work — escalate the tier, not just the dial.
- Higher effort increases the risk of a false-positive `no_output_timeout`
  crash (see `resources/failure-modes.md`): the model goes quiet
  mid-reasoning and the watchdog kills it while real work is happening
  underneath. Don't read a crash on a maxed-out cheap model as proof the
  task was too hard for it — check for a resumable session first.
- Don't over-provision effort on mechanical work either. A transcription
  task doesn't need `max` effort; it needs the model to type what the brief
  already specifies.
- **Pass `--variant` explicitly.** Leaving it unset leaves the effort level
  to a default you didn't choose, which is exactly where a cheap model's
  behavior is least predictable.

## Mixed-strength review panels

For multiple independent reviewers on the same diff, run 2–5 cheapest-tier
"explorer" passes alongside one standard-or-above "heavyweight" pass, rather
than paying for N standard-tier reviews. Cheap explorers are individually
weaker at judgment, but several in parallel — cross-checked against each
other and the real diff — catch real defects and surface each other's false
positives.

- Cross-check every explorer finding against the actual diff yourself. An
  explorer working from a stale local `main` will confidently report
  already-merged work as a defect. Findings confirmed by two or more seats
  (especially one explorer plus the heavyweight) are the strongest signal.
- This does not relax the standard floor for a *single* reviewer. The
  heavyweight seat covers the judgment floor; explorer seats add coverage on
  top of it, not instead of it.
- One or two most-capable seats in a finder panel are fine — "finder role =
  standard tier" is a floor, not a ceiling. What's wrong is reflexively
  routing the *entire* panel through one most-capable model.
- **Mix distinct models across seats, independent of tier.** Different
  models share different blind spots; an all-one-model panel correlates its
  misses across every seat.

## Cost is turns and wall-clock, not just token price

- **Turn count beats token price.** The cheapest models routinely take 2–3×
  the turns on multi-step work, costing more overall in wall-clock and
  context than a standard-tier model that finishes clean.
- **Reliability is part of "good enough."** A model that crashes or times
  out on a large fraction of its dispatches costs more in retries than a
  slightly pricier model that finishes clean the first time. Two or more
  `no_output_timeout` crashes on the same model+task shape is a signal to
  switch model or provider, not to keep retrying unchanged.
- **A wide parallel fan-out onto a shared free pool is where free stops
  being cheap** — concurrent load on a free tier is exactly what trips
  `no_output_timeout` even when the model is fine on a single dispatch. When
  a dispatch is part of a bigger fan-out, or reliability under load matters,
  take a paid route at the tier the task already needs.
- **Prefer the newest generation within a model family.** When a provider
  exposes several generations side by side, default to the newest unless
  you've checked a real gap (worse score on the relevant axis, a price
  difference big enough to change the tier call). Tab-complete proximity to
  a stale generation is the actual risk here.
- When unsure which model fits, check recent `taskferry list` / `taskferry
  context` history for how that model has actually performed on similar work
  in this workspace, rather than defaulting to habit or reaching for the
  biggest name.

## Verify before trusting

Listing a model is not the same as reaching it. Before relying on a route:

```sh
opencode models | rg -e ':free$' -e '-free$'      # what's actually offered
opencode run -m <id> "Reply with: PONG"           # what actually responds
```
