# LiveBench-first model selection with per-task-class axes

Status: proposed — v3 after two review rounds (round 1: luna max, mimo pro,
minimax M3; round 2: luna max, verdict "Needs changes", all findings applied
in v3; the round-2 explorer pass returned empty and was not used). Premise
survived both rounds; the findings below are the precision fixes that made it
implementable. Tranche 0 (scrape-livebench.py) implemented 2026-08-04; first
report in `reports/livebench/`.
Date: 2026-08-04
Applies to: `~/.claude/skills/choosing-a-model`

## The problem

`choosing-a-model` ranks models on a single blended scalar — Artificial
Analysis's Intelligence Index — and picks tiers by that ranking plus
price-per-1M-tokens. That fails the decision the skill actually exists to
make, for four reasons.

1. **A single scalar washes out class differences.** An implementer and a
   reviewer need different faculties, and a model strong on coding but weak
   on reasoning can carry the same index as one with the opposite profile.
   Picking "the model for implementer work" off a blended index is picking
   blind; we want the category that predicts success for that *class* of
   work.
2. **AA's index is a black box.** It is a commercial, versioned moving
   target (the v4.0 → v4.1 re-basings are documented in `research-notes.md`),
   blended from opaque weights.
3. **No cost-per-task signal.** The skill ranks on price-per-1M-tokens, not
   what a dispatch actually costs. taskferry records per-task `tokens` and
   `cost` (`result()`, taskferry#201) — the skill ignores its own telemetry.
4. **No feedback from our use case.** Live dispatch history is a dataset we
   already own that could rank models by actual performance per class of
   work — the data that matters most is the data we generated, not a
   benchmark.

**Why LiveBench as the primary replacement:** an open benchmark, scored
objectively (regex/unit-test grading, no LLM judge), with contamination
resistance from fresh question sets on each release. **The category set and
data source are verified as of 2026-08-04, not assumed** (below). AA is
downgraded, not deleted: it stays as the secondary source for the axes
LiveBench genuinely lacks, and as a cross-check.

## Verified: the LiveBench data source

Fetched 2026-08-04 from livebench.ai. The site is client-rendered (Create
React App), but the data it fetches is plain static files, directly
curl-able — no Playwright, no RSC-chunk decoding:

- `https://livebench.ai/table_<release>.csv` — per-model × per-subtask scores
- `https://livebench.ai/categories_<release>.json` — category → subtask mapping
- `https://livebench.ai/cost_<release>.csv` — per-model × per-subtask cost

The `<release>` slug is a date (e.g. `2026_06_25`, i.e. `2026-06-25` with
`-`→`_`), fetched with a cache-busting `?v=…` query. The slug must be
discovered each run from the latest entry in the release-date list embedded
in the JS bundle — the observed release cadence is ~six months, so
hardcoding it rots. There are **seven categories**: Reasoning, Coding,
**Agentic Coding**, Mathematics, Data Analysis, Language, IF (Instruction
Following) — the six-category ICLR-2025 list is stale. Category score =
mean of that category's subtask columns.

**Model coverage is partial and handled explicitly, not assumed.** Verified
present (2026-06-25 release): `minimax-m3`, `kimi-k3`, `kimi-k2.7-code`,
`gpt-5.6-luna-max`, `gpt-5.6-terra-max`, `gpt-5.6-sol-max`,
`deepseek-v4-flash` and `deepseek-v4-flash-0731`, `grok-4.5`, `glm-5.2`,
`qwen3.7-max`, `qwen3.8-max`, `claude-sonnet-5-xhigh-effort`,
`claude-opus-5-max-effort`, `muse-spark-1.1-xhigh`. **Absent** (no
per-category scores): `mimo-v2.5-pro` — a load-bearing standard-tier
workhorse on this account. A model missing from LiveBench needs the explicit
fallback chain under "Recommendation logic".

**Example data, release 2026-06-25 (mean of subtask columns), demonstrating
why axis-per-class is not a false dichotomy:**

| Model | Reasoning | Coding | Agentic Coding | Mathematics | Data Analysis | Language | IF |
|---|---:|---:|---:|---:|---:|---:|---:|
| gpt-5.6-luna-max | 85.6 | 82.9 | 48.4 | 87.2 | 78.0 | 72.6 | 60.1 |
| kimi-k3 | 90.7 | 81.4 | **62.2** | 84.4 | 78.7 | 85.5 | 71.4 |
| minimax-m3 | 74.5 | 68.2 | 40.7 | 76.9 | 76.2 | 76.8 | 57.5 |
| deepseek-v4-flash | 70.6 | 69.2 | 37.6 | 79.6 | 68.0 | 70.1 | 63.1 |
| deepseek-v4-flash-0731 | 86.6 | 75.0 | 46.8 | 86.8 | 79.3 | 79.2 | 65.5 |

Three things jump out: models are genuinely differently-shaped (m3 beats
v4-flash on Reasoning/Language/Data Analysis; v4-flash beats it on IF);
**Agentic Coding is a brutal separator** (kimi-k3 62.2, everyone else
≤56.5, m3 at 40.7) — exactly the discrimination an implementer seat wants;
and the live `deepseek-v4-flash-0731` build beats the older listed
`deepseek-v4-flash` on nearly every axis.

## Principles

1. **Pick an axis per task class, never a global ranking.** The question is
   always "what's the best cheap model for *this class of work*," never
   "what's the smartest model."
2. **The axis is a discriminator, not a quality claim.** We are not
   asserting implementers don't need reasoning. We are choosing the
   LiveBench category whose within-class spread best predicts success for
   that class and sorting on it, with a secondary axis guarding the other
   half of the job.
3. **Cost per task, not price per 1M.** Decisions sort on estimated cost per
   successful task. The `cost` field is provider-reported and may be null,
   and on subscription-backed routes it is not literal account spend — it is
   a proxy, and the spec defines its handling rather than pretending.
4. **Our dispatch history is a posterior adjustment, not a hard benchmark
   replacement.** Telemetry overrides the benchmark only where it has enough
   signal and the signal is trustworthy (see "Telemetry override").
5. **AA downgraded, not deleted.** Keep the axes LiveBench genuinely lacks
   and cross-check the ones it covers; drop the blended index as a ranking
   or tiebreaker (it is the thing this spec criticizes).
6. **Tier and axis are orthogonal.** The existing role → tier mapping (how
   *much* judgment a role needs) survives unchanged; this adds the axis (what
   *kind* of signal to sort on).

## Task classes → axis mapping

The classes that recur across `using-taskferry`, `ferrying-code-review`,
`ferrying-feature-dev`, and `subagent-driven-development`. **Per-class floors
live in working-report.md, with a derivation rule** (see "Floor derivation").

| Class | Examples | Primary axis | Secondary axis | Why |
|---|---|---|---|---|
| Implementer | write code from a prose spec, multi-file integration | **Agentic Coding** | Coding | Success = correct code landed + tests pass. Agentic Coding is the sharper implementer discriminator than competition-style Coding. |
| Transcription / mechanical | verbatim code in the brief, single-file fix | IF | — | No design judgment; the bar is following the brief exactly. |
| Fixer / debugger | repair failing tests, diagnose a crash | Agentic Coding | Reasoning | Half correct code, half reasoning about why it broke; the secondary axis guards the reasoning half. |
| Task reviewer | review a diff for what the implementer missed | Reasoning | Agentic Coding | Catching bugs and edge cases is adversarial reasoning. |
| Final whole-branch review | verdict on a merged branch | Reasoning | Coding | Broadest blast radius; needs both. |
| Advisor — statistical/security | correctness-critical math or data reasoning | Reasoning | Mathematics | Statistical/security judgment is Math-anchored. |
| Advisor — design | architecture opinions, structural calls | Reasoning | Language | Design judgment is prose-heavy; no Math requirement. |
| Architecture / design | structural decisions, wrong call is expensive | Reasoning | Language | Largest design judgment; already Most-capable tier in the skill. |
| Code-review finder / explorer | scan a diff across angles | Reasoning | Language | Cheap parallel coverage; the discriminator is finding real defects vs. noise. |
| Code-review verifier | confirm / refute a specific finding | Reasoning | Agentic Coding | Focused adversarial check of one claim. |
| Researcher / synthesis | classify docs, weigh evidence, status report | **Language** | Reasoning | The failure mode is title-matching — a comprehension failure. LiveBench Data Analysis is table/join/reformat structural work, not reading synthesis; it maps poorly here. |

**Two deliberate corrections from review round 1, retained:** implementer
axis is Agentic Coding (LiveBench has it, and it separates models where
plain Coding doesn't); researcher axis is Language (the actual failure mode
is comprehension, not table work).

## Data sources

### Primary (new): LiveBench per-category scores

`scrape-livebench.py`, mirroring `scrape-pareto.py`'s structure but hardened
(see "Tranche 0" for the implementable spec). Reports land in
**`reports/livebench/`** — a separate directory, so AA and LiveBench reports
never mix. Fail closed on partial data; validate row/category coverage;
fixture tests for the subtask→category mapping.

### Secondary (downgraded): AA

Keep `scrape-pareto.py`, re-scoped to what it is still the only or better
source for: `agenticIndex` (independent cross-check on the axis LiveBench
now covers), price per 1M, verbosity, speed, context. **Drop `codingIndex`**
(it overlaps LiveBench Coding) and the blended Intelligence Index as a
ranking or tiebreaker. **The scraper change is explicit, not implied:**
extract `agenticIndex` plus verbosity/speed/context, and stop silently
skipping malformed chunks — surface a named diagnostic and fail, or count
and report the skips. Re-verify the `price1mBlended0To3To1` blend before
relying on it (price volatility since 2026-07-30).

### Tertiary (the "improved data for our use case"): taskferry telemetry

- **Instrument first, aggregate second.** There is no `--class` flag in
  taskferry (`src/args.js`, `src/protocol.js` `task.dispatch` params), and
  the task `status` field is only `{done, crashed, cancelled}`
  (`resolveChildExitStatus` in `src/tasks.js`) — `done` means exit code 0,
  not "work was correct." The aggregation therefore has two honest layers:
  - *Completion rate* (available today) = `done` over settled dispatches
    (`done` + `crashed` + `cancelled`), including `incomplete: true` and
    pending-changeset tasks as non-success.
  - *Outcome rate* (requires instrumentation) = per-class outcome, defined
    below. Until it lands, the telemetry *override* stays disabled and
    telemetry is a shadow/reference table.
- **The marker contract is not the status field.** `DONE |
  DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT` are final-marker strings a
  worker writes in its message (enforced by `--require-final-marker`); they
  are not task statuses. Outcome parsing must read the marker, never assume
  the status field encodes it.
- **Grain is `(underlying_model, route, executor, variant, class)`**, used
  everywhere — including the cost signature and report schema, which must
  carry all five fields. taskferry's `model` is the *route slug*
  (`xiaomi-tknplan/mimo-v2.5-pro`), not an underlying-model identity; a
  canonical-alias table maps route slug → underlying model
  (`mimo-v2.5-pro`) so `xiaomi-tknplan/mimo-v2.5-pro` and
  `opencode-go/mimo-v2.5-pro` are recognized as the same model on different
  routes with different real cost.

**Outcome definition per class (for the outcome-rate layer):**

| Class | Outcome signal |
|---|---|
| Implementer / Fixer | changeset accepted (`taskferry accept`) and status `done` |
| Task / final reviewer, verifier | a usable review produced: `done` with a final marker of `DONE` or `DONE_WITH_CONCERNS` and non-empty findings |
| Advisor | `done` with a non-empty final report |
| Researcher / explorer | `done` with a final marker of `DONE` or `DONE_WITH_CONCERNS` |

Until changeset-accept and marker signals are persisted in a queryable form,
outcome rate is computed from what exists and labeled provisional.

## Cost per task

- `cost_per_task(class, route, model)` = **median** of the settled
  dispatches' `cost` field (robust), grouped by the grain above.
- **Explicit handling, not deferred:**
  - *Cancelled* and provider-failure (auth/boot `spawnError`) tasks are
    excluded from the cost aggregation — they carry no usable cost.
  - *Null `cost`* on a settled task → fall back to the estimate formula
    below for that task.
  - *Zero `cost`* is valid (free-tier routes) and included as a real zero.
  - If a grain cell is **all-null**, the cell reports "estimate" and is
    flagged, never silently blank.
- **`cost` is a proxy, not account spend.** It is provider-reported usage
  (`src/executor.js`), and on subscription-backed routes (`openai/*` via
  ChatGPT Plus, `xiaomi-tknplan/*`, `minimax/*`) it is the provider's
  rate-card computation, not dollars out of the account. The tables label it
  as such.
- Thin telemetry (< minimum sample): estimate as
  `(median_input_tokens_per_class × input_price) + (median_output_tokens_per_class × output_price)`,
  tokens-per-class seeded from telemetry across models, output verbosity
  corrected by AA's verbosity metric. LiveBench's `cost_<release>.csv`
  (per-subtask cost) is a secondary cross-check.
- `cost_per_successful_task = cost_per_task / max(outcome_rate, 0.05)`; a
  rate at or below the floor produces an explicit "insufficient data /
  likely unsuitable" flag rather than a division-by-zero or an exploded
  ranking.

## Recommendation logic (updated procedure)

Given a dispatch class, in order — each step is a filter or a sort, and the
order is the contract:

1. **Axis floor** (per class, working-report): exclude models below the
   primary-axis floor. A model can be cheapest-tier globally yet fail the
   implementer Agentic-Coding floor.
2. **Coverage fallback chain**, in order: (a) LiveBench per-category score
   if covered; (b) else AA per-axis score mapped to the class axis
   (`agenticIndex` → Agentic-Coding proxy, `codingIndex` → Coding, etc.);
   (c) else telemetry-only ranking, marked provisional; (d) no signal in any
   source → excluded from that class with a named "no data" flag. The chain
   is exclusive — one branch wins, never two.
3. **Provider availability**: exclude routes not live on the account.
4. **Role → tier floor**: apply the existing tier floor unchanged (a task
   reviewer never inherits the implementer's tier).
5. **Provider policy**: the existing hierarchy (Token Plan route before
   `opencode-go/*`, free tier where the class allows) is a *filter with a
   predicate*, not a post-sort override: a preferred route is skipped only
   when an equivalent model is actually available on it; if exactly one
   route can serve the chosen model, it passes regardless.
6. **Sort** the survivors by `cost_per_successful_task`.
7. **Tiebreak** by primary-axis score, then secondary-axis score. "Near
   tied" is defined: within 1.0 axis point of the next model, cost decides.

Report the pick with its evidence: axis scores, cost/task, outcome
(completion) rate, coverage flag, and data date. The Pareto frontier is
re-rendered per class on (axis score, cost-per-successful-task).

## Floor derivation

Each class floor is derived, not asserted: median primary-axis score of
models with ≥ the minimum sample of *successful* outcomes in that class
(outcome rate layer), rounded, pinned to a release; if telemetry is thin,
the floor is a hand-set value that records its basis; if no floor evidence
exists at all, the floor is "unset" and that class requires telemetry to
rank at all. Every floor records the release and date it was set.

## Telemetry override

- **Concrete decision rule, not a vibe.** Model the outcome count as
  Beta-binomial: `p̂ = (k + α) / (n + α + β)`, where `k`/`n` are observed
  successes/settled dispatches and `α`, `β` encode a prior anchored to the
  benchmark: prior mean = the class axis floor, prior strength `w = α + β =
  25`. **Telemetry overrides the benchmark for a class only when n ≥ 20
  (minimum effective sample) AND the 95% lower credible bound of the
  posterior exceeds the class floor.** Below either condition, the benchmark
  dominates and telemetry is reported as provisional. This replaces the
  earlier N≈10 threshold (a binomial at n=10 cannot separate 9/10 from
  7/10).
- **Guards:** recency weighting (provider prices and builds drift — the
  2026-07-30 OpenAI price cut and the 0731 flash build are both live
  examples); retained negative evidence (a model retired for poor
  performance keeps its bad record instead of vanishing); difficulty
  stratification (a model only ever dispatched on easy work does not get to
  look good — gate on a difficulty proxy such as prompt length or tokens);
  and a small standing exploration allocation so never-retried models still
  generate data.
- **Selection bias is structural and acknowledged:** the router already
  biases which model sees which task. Telemetry entrenching that bias is
  exactly why the override stays a posterior adjustment with the guards
  above, not a replacement.

## Working-report changes

- New section: per-model LiveBench category scores (decision table,
  release-pinned).
- New section: per-class floors (with basis) and recommended model with
  evidence.
- New section: the telemetry table (underlying model × route × effort ×
  class → completion rate, outcome rate, median cost), labeled
  completion-vs-outcome honestly.
- Existing AA tables re-labeled secondary; blended-index rows removed from
  the ranking path.
- Provider availability / keys / time windows are account state, orthogonal
  to the data-source change — untouched.

## Instrumentation design (written in Tranche 0, built in Tranche 2)

The telemetry the spec relies on (outcome rate, per-class ranking) needs one
new persisted signal plus a class tag on a dispatch. Both are a taskferry
feature, not a skill change — they touch `src/args.js`, `src/protocol.js`
(`task.dispatch` params), `src/tasks.js` (persistence), and the output
projection, so per CLAUDE.md they land as their own branch/PR/review before
Tranche 2 can aggregate real outcome data.

1. **Class tag.** A `--class <name>` option on `dispatch` and `advisor`,
   accepted as any non-empty string (validated only as non-empty at the
   protocol boundary — `protocol.js`'s `isNonEmptyString` check, same
   pattern as `variant`/`sessionId`), persisted per task. taskferry does not
   validate against a fixed list — it stores whatever string it's given. If
   consumers (e.g. the choosing-a-model skill's telemetry aggregation) need
   a controlled vocabulary, that's the aggregator's concern to enforce on
   read, not taskferry's concern to enforce on write. A typo simply becomes
   its own distinct class bucket, visible in the data.
2. **Outcome signal.** Two parts; only the second is new persisted state:
   - *Changeset acceptance* for implementer/fixer classes: `taskferry
     accept`/`reject` already persist this as the existing `changesetStatus`
     field (`none | pending | accepted | rejected`). No new field —
     telemetry aggregation (in the choosing-a-model skill, outside
     taskferry) reads `changesetStatus` directly for these classes. A
     duplicate `outcome` field would only drift out of sync with it.
   - *Final marker* for reviewer/advisor/researcher classes: parse the
     closing `Status:` marker (DONE | DONE_WITH_CONCERNS | BLOCKED |
     NEEDS_CONTEXT) from the task message at settlement and persist it as a
     new `finalStatus` field — it is a worker-written line, distinct from
     both the task `status` field and the existing `finalMarker` field
     (which already means the stored regex *source* from
     `--require-final-marker`, used only as a match/no-match gate; it is
     not a parsed outcome value and Tranche 2 must not repurpose it).
3. **Backfill stance.** Historical tasks carry neither signal, so outcome
   rate starts empty and accrues only on newly tagged dispatches. No
   speculative backfill from prompt text or standing model role — the
   explicit tag is the only class source that feeds the ranking.
4. **Grain.** The telemetry record key is `(underlying_model, route,
   executor, variant, class)`; the canonical underlying-model alias table
   lives in the choosing-a-model skill and maps route slugs to the
   underlying model so cross-route aggregation is correct.

## Rollout (tranches)

Strict dependencies: `0 → 1 → 2 → 3`. Tranche 1 needs Tranche 0's report
and floors; Tranche 2 needs Tranche 1's class definitions; Tranche 3 needs
Tranche 2's instrumentation. Tranche 1 states *policy* (the floor→filter→sort
procedure); Tranche 3 wires *execution* (cost/success into live decisions) —
the two are distinct and are not split mid-tranche.

- **Tranche 0 — LiveBench pipeline.** **Implemented 2026-08-04:** 
  `scrape-livebench.py` (with `test_scrape_livebench.py`, 15 fixtures green)
  and the first report at `reports/livebench/2026-08-04_claude-sonnet-5.md`
  (release 2026-06-25, 38 models). The implementable spec it shipped to:
  - *Release discovery:* parse the JS bundle for the release-date list;
    select the latest; slug = date with `-`→`_`. Fail with a named
    diagnostic if the list can't be found (mirrors the AA RSC gotcha
    table).
  - *Fetch:* the three static files with the cache-busting query pattern.
  - *Schema:* table CSV header = subtask ids; categories JSON =
    category→subtask; category score = mean of the category's subtask
    columns; per-model output = one row per model, one column per category.
  - *Model aliasing:* a small table in the skill mapping LiveBench model ids
    (`gpt-5.6-luna-max`, `deepseek-v4-flash-0731`) to taskferry route slugs;
    the coverage check walks this table, not free text.
  - *Coverage validation:* fail-closed if any aliased model known to be
    dispatched is absent from the table, unless the alias table marks it
    "known absent" (e.g. `mimo-v2.5-pro`).
  - *Freshness:* no-op when the latest `reports/livebench/` report is < 3
    days old; every report carries the release slug and fetch date.
  - *Atomic failure:* on any fetch/parse failure, write no report and exit
    non-zero with a named diagnostic.
  - *Fixture tests:* subtask→category mapping and the mean aggregation.
  - **Exit:** fresh report in `reports/livebench/`, no-op-when-fresh,
    coverage check passing, fixtures green.
- **Tranche 1 — Axis mapping + AA re-label.** Add the class → axis table,
  floor derivation rule, and the floor → filter → sort procedure to
  SKILL.md; set initial floors against the real release scores; re-label AA
  as secondary in the same tranche so two ranking systems never coexist with
  unclear precedence. Pure doc change. *Exit:* decision-logic section
  rewritten, every claim data-backed or flagged.
- **Tranche 2 — Telemetry instrumentation + shadow aggregation.** Build the
  class/outcome instrumentation (the `--class` tag and the outcome signals
  in the outcome-definition table — a taskferry feature if it needs to
  persist new fields), then the aggregation into a shadow table that is
  reported but does not yet drive decisions. *Exit:* shadow table populated,
  override still disabled.
- **Tranche 3 — Cost wiring + enable overrides after backtesting.** Wire
  `cost_per_successful_task` into the decision tables; enable the telemetry
  override only after offline backtesting against the shadow table shows it
  beats the benchmark-only ranking. *Exit:* tables carry cost/outcome from
  telemetry where available, override live.

## Risks

| Risk | Mitigation |
|---|---|
| LiveBench Agentic Coding still isn't a real-repo edit-run-test loop | The gap is now narrow and named; the telemetry override is the eventual ground truth |
| A dispatched model is missing from LiveBench (`mimo-v2.5-pro` today) | Exclusive coverage fallback chain + "not covered" flag; never silently ranked as covered |
| `done` ≠ correct — completion rate overstates success | Outcome instrumentation is a prerequisite for the override; tables labeled completion-vs-outcome until it lands |
| `cost` is provider-reported, nullable, and not real spend on subscription routes | Defined as a proxy with explicit cancelled/null/zero/all-null handling; never presented as account spend |
| Telemetry entrenching router selection bias | Beta-binomial lower-bound override, difficulty gating, retained negatives, exploration allocation |
| The release slug changes and the scraper reads a stale release | Release discovery each run, pinned release in every report, coverage validation |
| Per-category scores become the new single-number trap | Decision output always pairs a score with cost/task, coverage, and class; frontier is per-class |

## What "done" looks like

- SKILL.md's decision logic picks a model for a dispatch class via: axis
  floor → coverage fallback chain → provider-availability filter → tier
  floor → provider-policy filter → cost-per-successful-task sort →
  axis-score tiebreak, with the evidence printed.
- working-report.md carries release-pinned LiveBench scores, per-class
  floors with basis, and a telemetry table honest about completion-vs-outcome.
- AA is explicitly secondary; the blended index no longer ranks or tiebreaks.
- A model whose benchmark looks good but whose outcome rate in a class is
  poor loses to a cheaper, more reliable model in that class — once the
  instrumentation that makes "outcome rate" real has landed.
