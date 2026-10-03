# 01 — Research Questions: Fleet-Management Skill

Slug: `fleet-management-skill`
Source: case study of session `ses_fdeb4bc58ffegCMH814TXUj5d6` (Muse 8-issue fleet #507–#514, 2026-08-19/21) + taskferry GitHub issues. Evidence file: `case-study.md` in the research worktree.

## Q1 — Gap analysis: what does using-taskferry already cover for fleets, and what is missing?

Why it matters: a fleet-management skill must not duplicate the existing skill's dispatch/wait/verify contract; it should own only the multi-ferry layer. We need the exact boundary: what `using-taskferry` + `resources/monitoring-progress.md` (fleet watch, wait rules) + `resources/failure-modes.md` already say about fleets, and which fleet failure modes from the case study have no coverage anywhere.

Source: `integrations/claude/skills/using-taskferry/` (SKILL.md + resources/), case-study FM-9/FM-10/FM-11/FM-18.

## Q2 — Which fleet failure modes from the case study are already encoded as taskferry issues, and which are pure operator discipline?

Why it matters: the skill's content splits into "tooling gaps to file/request" vs "procedure the skill must teach." Every FM in the case study maps to either a GitHub issue (#515 zombie daemons, #501 sqlite contention, #434 top, #410 providers --stats, #416 slugged names, #505 doctor block, #235 provider limits, #134 summarizer pool) or an operator error (no ledger, no pre-flight check, force-accept reflex, unvalidated dispatch loops). The skill must teach the operator-discipline half and reference the tooling half.

Source: case-study FM-1..FM-18, issue list in `gh-axi issue list`.

## Q3 — What fleet-management primitives exist in taskferry today, and what is their exact contract?

Why it matters: the skill's commands must be real and current. Verify against source: `taskferry watch` (scoping, --all, --summaries, --flush-interval, pid-file guard), `taskferry list` (--class, --status, --directory filters), `taskferry cancel`, `taskferry doctor`, `taskferry providers` (does --stats exist?), `--class` tagging, `--parent-task` chaining, `wait` loop semantics. Which of #434 (top), #410 (providers --stats), #416 (slugged names), #505 (doctor status block) are open vs shipped?

Source: `src/commands.js`, `src/command-specs.js`, `docs/cli-reference.md`, `taskferry --help`, open issue list.

## Q4 — What pre-flight checks does a fleet need before the first dispatch, and what does each catch?

Why it matters: the case study's cross-cutting root cause was "no pre-flight checks" — 3 zombie daemons deleted 8 overlays (#515), wrong executor on 8 dispatches, provider quota exhausted mid-batch (#410 would have caught it), toolchain missing in worktrees (lint/typecheck theater), stale branches carrying flaky tests. The skill needs a concrete pre-flight checklist: daemon single-ownership, provider limits/credits, executor-model compatibility, worktree toolchain, branch freshness.

Source: case-study FM-2/FM-3/FM-13/FM-17, `docs/daemon.md`, `~/.config/taskferry/config.json` providerLimits.

## Q5 — What fleet lifecycle discipline does the case study demand (ledger, settlement watcher, batch validation, accept policy, merge sequencing)?

Why it matters: the operator lost fleet state across compactions (FM-18), left settled tasks unprocessed (FM-10), dispatched 4 re-reviews with no watcher (FM-9), force-accepted 4 times (FM-4), raced PR merges (FM-8), and validated nothing before fan-out (FM-1). The skill must encode: a fleet ledger artifact, one settlement watcher per fleet, validate-one-then-loop dispatch, force-accept as last resort, deterministic merge order with rebase-after-each-merge.

Source: case-study FM-1/FM-4/FM-5/FM-6/FM-7/FM-8/FM-9/FM-10/FM-11/FM-12/FM-16/FM-18.

## Q6 — What is the right shape for the fleet skill, and what precedent exists?

Why it matters: the deliverable must fit the existing skill ecosystem. Options: (a) new standalone skill `managing-ferry-fleets`, (b) a resource file in using-taskferry, (c) an addendum. Precedents: `using-taskferry-addendum` (conventions preamble), `ferrying-code-review` (orchestrator skill that stays inline), `monitoring-progress.md` (fleet watch section). Also: does the case study suggest the skill should be a controller-style skill (dispatcher-only) per the A/B session's finding that the skill is for the dispatcher, not the leaf?

Source: `~/.claude/skills/using-taskferry-addendum/`, `~/.claude/skills/ferrying-code-review/`, `integrations/claude/skills/using-taskferry/resources/monitoring-progress.md`, A/B session `ses_fc11a469affe2n5ed1eUBwYcRT` controller findings.
