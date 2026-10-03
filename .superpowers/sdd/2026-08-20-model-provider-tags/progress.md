# SDD ledger — plan: .superpowers/plans/2026-08-20-model-provider-tags.md

## Pre-flight conflict scan (2026-08-20)

File-overlap table (task pairs sharing a file):

| Task A | Task B | Shared file | Produces (A) | Consumes (B) | Finding |
|---|---|---|---|---|---|
| 1 | 2 | (none directly) | `config.providers` shape | reads `config.providers` | No file overlap; ordering dependency only (2 must run after 1). Plan already sequences them 1→2. OK. |
| 1 | 5 | (none directly) | `config.providers`/`config.tags` | `resolveDispatchModel({providers})` | Ordering dependency only, plan sequences 1 before 3/5. OK. |
| 1 | 6 | (none directly) | `config.providers`/`config.tags` | `runProvidersList`/`runTagsList` read `deps.config` | Ordering dependency only, plan sequences 1 before 6. OK. |
| 2 | 5 | `src/tasks.js`, `src/tasks.dispatch.test.js` | Task 2 rewrites `providerLimitsFromConfig`/`resolveProviderLimitsOption` (~line 660-709) and its doc comment | Task 5 adds `providerRunningCount` helper "next to `providerOf` (line 641)" and edits the dispatch call site — different region of the same file, but Task 2 shifts line numbers Task 5's brief cites (641, 6788) as approximate | Real risk: Task 5's brief cites line numbers from the plan's original read of `src/tasks.js`, which will have drifted after Task 2's edit lands. **Ruling:** the task-5 brief must instruct the implementer to relocate `providerOf` and the `ctx.launchScheduler.providerQueues` usage by name/grep rather than trusting the plan's line numbers, since those numbers predate Task 2's edit. Executing strictly sequentially (2 fully committed before 5 starts) avoids any working-tree conflict; only the stale-line-number risk remains, and is mitigated by brief wording. |
| 2 | 5 | `src/tasks.dispatch.test.js` | Task 2 reshapes 5 existing tests' `config:` literals from `providerLimits` to `providers` | Task 5 adds 3 new tests to the same file | No conflict — additive, sequential, same rationale as above (2 commits before 5 starts). OK. |
| 3 | 5 | (none directly) | `resolveDispatchModel` export | imports it | Ordering dependency only (3 before 5). Plan already sequences this. OK. |
| 4 | 5 | (none directly) | `options.provider`/`options.tag` on parsed args | consumed at the dispatch call site | Ordering dependency only (4 before 5). Plan already sequences this. OK. |
| 4 | 6 | `src/args.js` | Task 4 adds `--provider`/`--tag` flag defs and the `--tag`+`--model` exclusivity check | Task 6 adds `providers`/`tags` to the local-command recognition table and positional-arg validation — different region of the same file | No real overlap (different additions, same file); sequential execution (4 fully committed before 6) means no working-tree conflict. OK. |
| — | — | Task 3 self-consistency | `src/model-routing.js` full implementation is given verbatim in the plan | tests given verbatim in the plan | Read both blocks: test expectations (mode 1 exact-pair-untagged warning regex, mode 2/3 tie-break, mode 4 error messages) match the implementation's actual thrown/returned strings line-for-line. No contradiction found. |
| — | — | Task 4 self-consistency | Plan explicitly flags: "read that existing code path... reuse its actual function name... instead of inventing `deprecationNotices` if the real one differs; update the Step 1 test to match" | Step 1 test literally asserts `result.deprecationNotices?.join("\n")` | **Known plan gap, not a contradiction to rule on now** — the plan itself anticipates the placeholder may be wrong and tells the implementer to fix it. No ruling needed; implementer follows the plan's own escape hatch. |
| — | — | Task 5 self-consistency | Plan explicitly flags: "Read the actual dispatch call site's existing local variable names... before pasting this in, and adjust names to match" | Step 3's pasted code uses placeholder names (`config`, `provider`, `tag`, `model`, `ctx.launchScheduler.providerQueues`) | Same as above — plan already tells the implementer these are placeholders to verify against the real call site. No ruling needed. |

**Overall verdict:** scan is clean. The only non-trivial finding (Task 2/Task 5 line-number drift in `src/tasks.js`) is mitigated by strict sequential execution (this session dispatches one task at a time, never in parallel) plus a note carried into Task 5's dispatch brief to grep/read rather than trust cited line numbers. No plan-text contradictions found requiring a ruling before execution begins.

## Model assignments (per `choosing-a-model` role→tier mapping)

- Implementer default: `ollama/deepseek-v4-flash:0731 --variant max` (cheapest tier) for tasks whose plan text is complete verbatim code (1, 2, 3, 6, 7).
- Implementer escalation: `minimax/MiniMax-M3 --executor opencode` (standard/harder tier) for tasks the plan itself flags as needing live verification against real code rather than pasting placeholders verbatim (4, 5).
- Task reviewer (all tasks): `openai/gpt-5.6-luna --executor opencode` (standard floor, per standing reviewer-tier-floor rule).
- Final whole-branch review: most-capable available model, decided at that point.

## Task log
