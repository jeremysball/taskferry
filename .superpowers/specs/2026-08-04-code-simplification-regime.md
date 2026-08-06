# Code simplification regime

Status: proposed, awaiting tranche-by-tranche approval
Date: 2026-08-04
Baseline commit: 7e3232d (v3.0.0)

## The problem

taskferry is 12,432 lines of non-test source. `src/tasks.js` holds 5,261
of them, 42% of the codebase in one file, carrying about 180 functions,
117 of which take a `ctx` god-object as a parameter. Comments are 32% of
non-test source and 46% of `tasks.js`.

That shape is not organic growth. The file says so itself:

> Extracted from `resolveFilesystemOptions` so that helper's `??`/`||`
> count stays under the complexity ceiling.

> Extracted out of `createTaskManager`'s parameter destructuring so the
> factory's own body doesn't carry the env-var/config/default ternaries
> that drove the cyclomatic and overall complexity counts above the rule
> ceilings.

PR #303 promoted `complexity: 15` and `max-lines-per-function: 80` to
hard errors. The fix-up that followed satisfied them the only way a
per-function cap can be satisfied: by cutting functions in half until
each half fit. Nothing got simpler. The work moved out of the functions
and into the seams between them.

The clearest artifact is `buildTaskManagerApi`, which hand-rolls a
dependency-injection layer for functions living in the same file:

```js
dispatch: (params) => dispatchTask(params, {
  ensureStateLoaded: () => ctx.helpers.ensureStateLoaded(),
  tasks: ctx.maps.tasks,
  defaultExecutor: ctx.opts.defaultExecutor,
  LOG_DIR: ctx.paths.LOG_DIR,
  persistTask: (taskId) => ctx.helpers.persistTask(taskId),
  pendingLaunches: ctx.maps.pendingLaunches,
  launchQueue: ctx.maps.launchQueue,
  launchQueuedTasks: () => ctx.helpers.launchQueuedTasks(),
}),
```

Twenty methods look like that. `dispatchTask` moved to module scope so
`createTaskManager` would fit under 80 lines, and the state it used to
close over now gets handed back to it by hand, one property at a time,
at every call site.

Nine functions resolve one options object: `resolveCoreOptions`,
`resolveTimeoutOptions`, `resolveToggleOptions`, `resolveStringOptions`,
`resolveEnvFileOptions`, `resolveFilesystemOptions`,
`resolveFilesystemSimpleOptions`, `resolveFilesystemDerivedOptions`, and
`resolveFilesystemDenylists`. Six of the nine open with the same line,
`const config = rawOptions.config || {}`.

Seventy-four comment lines in non-test source exist only to explain a
lint workaround. They document a constraint, not a decision.

## Baseline

Measured at 7e3232d. "Effective" excludes blank and comment lines,
matching how ESLint's `max-lines` counts under the project's options.

| Metric | Value |
|---|---|
| Non-test source, raw | 12,432 |
| Non-test source, effective | 7,674 |
| Test source, raw | 17,023 |
| `src/tasks.js`, raw / effective | 5,261 / 2,620 |
| Functions in `src/tasks.js` | ~180 |
| Functions taking `ctx` | 117 |
| Distinct `*For(…, ctx)` DI wrappers | 20 |
| Comment lines, non-test source | 4,029 (32%) |
| Comment lines, `src/tasks.js` | 2,430 (46%) |
| Lint-workaround comment lines | 74 |
| Open issues covering duplication, dead code, or consolidation | 28 of 111 |
| `docs/sourcemap.md` | 241 lines, 8,066 words |
| `docs/sourcemap.md`, `tasks.js` row alone | 1,123 words |

Every non-test file except `tasks.js` already fits under 400 effective
lines. The next largest are `daemon.js` at 393 and `client.js` at 374,
so the cap is tight but violated in exactly one place.

## Principles

These govern all future work in this repo, not only the tranches below.

1. **Delete before you refactor.** The cheapest simplification is
   removal. Check whether code is used before improving how it reads.
2. **Never split a function to satisfy a linter.** Split modules along
   domain seams and let function size fall out of cohesion. A function
   that runs long because it does one thing linearly is fine.
3. **State belongs in a closure, not in a parameter.** A helper that
   needs `ctx` belongs inside the module owning that state. Threading a
   context object through module scope is what a size cap forces, not a
   design anyone chose.
4. **When a complexity rule fires, ask whether the thing is complex or
   whether it is a data table wearing code's clothing.** Prefer
   converting it to data, a declarative spec object plus one generic
   resolver, over splitting the function in half. `args.js`'s `FLAGS`
   table is the pattern. The nine `resolve*Options` functions are what
   happens without it.
5. **A comment explaining a lint workaround is a bug report.** Remove the
   workaround, then the comment.
6. **One concept, one implementation.** The second copy gets fixed or
   filed. Never a third.
7. **No behavior change inside a simplification PR.** Refactor and fix
   ship separately. A simplification diff has to be provably
   behavior-preserving, and that claim is unprovable with a bugfix riding
   along.
8. **Measure, don't assert.** Every tranche reports the metrics table
   above, before and after. "This is much cleaner" is not a result.

## Guardrail change

Per-function caps give way to module-level cohesion limits.

```diff
   {
     files: ["**/*.js"],
     ignores: ["**/*.test.js", "**/*-test.js"],
     rules: {
-      complexity: ["error", 15],
-      "max-depth": ["error", 4],
-      "max-params": ["error", 5],
-      "max-lines-per-function": ["error", { max: 80, ... }],
       "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
     },
   },
-
-  // src/tasks.js is a user-approved permanent exception ...
-  {
-    files: ["src/tasks.js"],
-    rules: { "max-lines": "off", "sonarjs/max-lines": "off" },
-  },
```

What stays a hard error and does the real work:

- `max-lines` at 400, with no per-file exemptions.
- `sonarjs/max-lines` at its 1000 default.
- `sonarjs/cognitive-complexity` at its 15 default. This becomes the
  load-bearing complexity guard, and it is kept deliberately. It suits
  this codebase better than cyclomatic `complexity` because it discounts
  the flat, linear branching that made `complexity` fire on plain options
  tables.
- The remaining sonarjs rules, 217 of the 279 in `recommended` are on,
  including `no-identical-functions`, `no-duplicated-branches`,
  `no-all-duplicated-branches`, and `no-identical-expressions`. Those are
  the detectors that catch copy-paste.

**Verified, not assumed.** Running the proposed config against the tree
at 7e3232d produces exactly two errors, both stating the same fact:

```
src/tasks.js
  0:1  error  This file has 2628 lines, which is greater than 1000 authorized  sonarjs/max-lines
983:1  error  File has too many lines (2628). Maximum allowed is 400            max-lines
```

Removing the four per-function rules introduces zero violations, because
the tree already satisfies them. At this point they are pure ratchet:
they constrain future shape without catching anything present. The
cognitive-complexity guard is likewise already clean, so keeping it costs
nothing.

### Temporary carve-out, with a self-closing deadline

Tranche 0 lands the rule swap but keeps the `tasks.js` `max-lines`
waiver, because deleting it before the split would break `npm run lint`
on `main`. The waiver comment gets rewritten to name the tracking issue
and state that it expires. **Deleting the waiver is the exit criterion
for Tranche 3.** The split is not done until the file passes the same
rule as everything else. That is the only per-file exemption this regime
permits, and it exists so the rule change and the refactor can be
reviewed separately.

## Tranches

Each tranche is its own branch, PR, and review, per CLAUDE.md. Effort
level scales with the diff. Tranches 0 and 1 are small and mechanical;
Tranche 3 is the one needing a high-effort review.

### Tranche 0: guardrails and instrumentation

Small, mechanical, and it unblocks everything else.

- Swap the ESLint rule set as above.
- Rewrite the `tasks.js` waiver comment to reference the tracking issue
  and its expiry condition.
- Add `npm run metrics`: a script printing the baseline table (raw and
  effective lines per file, function count, `ctx` parameter count,
  comment ratio, count of files over the cap). Every later tranche pastes
  its before/after output into the PR body.
- Add the principles above to `CLAUDE.md` as a short "Simplification
  regime" section, so they govern incoming work and not only this
  backlog.

Exit: `npm run check` green, `npm run metrics` produces the table.

### Tranche 1: dead code

- #49, `defaultTaskManager` is dead code with import-time side effects
  and a stale comment.
- Audit the exports flagged as having no importer outside their own file:
  `sanitizeActivityText`, `dispatchRequest`, `TOOL_EVENT_TRUNCATE_CHARS`,
  `truncateForNarration`, `colorForStatus`, `markStatuses`,
  `colorizeText`, `replaceManagedSymlink`, `defaultNpmInstall`,
  `installClaude`, `registerCodex`, and `parseAllowedDirs`. Each one is
  dead (delete it), test-only (keep it, and say so in a one-line
  comment), or a gap in coverage (file it). The audit result is the
  deliverable; the deletions are whatever survives it.

Exit: no unreferenced export remains unexplained.

### Tranche 2: duplication backlog outside `tasks.js`

The filed consolidation issues that leave `tasks.js` alone, so they land
before the split without conflicting with it. Bucketed by the file each
issue names; the tranche opens by reading each issue to confirm the
bucket:

| Area | Issues |
|---|---|
| `mcp-isolation.js`, `setup.js` | #186, #214 |
| `executor.js` | #181, #182, #183, #177 |
| `sandbox.js` | #172, #180 |
| `daemon.js` | #175, #184, #167 |
| `args.js`, `command-specs.js` | #173 |
| `output.js` | #163 |
| `config.js` | #161 |
| cross-file | #170, the `mkdirSync`+`chmodSync` 0700 pattern in three files |

Several share one shape: a hardcoded enumeration that wants to be a table
(#180, #181, #182, #184), or two functions that are one function with a
parameter (#172, #186). Principle 4 covers all of them. Handle them as a
group so the resulting table shape stays consistent instead of getting
invented four times.

Exit: each issue closed with a reference to the commit, per CLAUDE.md's
post-merge issue sweep.

### Tranche 3: split `src/tasks.js`

The main event, and the only tranche carrying real regression risk.

**Why the risk is smaller than the line count suggests.** The public
surface of `tasks.js` is six symbols:

```
createTaskManager, DEFAULT_SUMMARY_MODEL, bucketFor,
isOutsideDirectory, parseEnvDenylist, parseSandboxDenylist
```

Thirteen files import them, 12 test files plus `daemon.js`. `tasks.js`
stays as a barrel re-exporting exactly those six, so no importer changes
and the 17,023-line test suite keeps running against an unchanged
interface. The split is entirely internal.

Effective line counts by domain region, measured at 7e3232d:

| Region | Effective | Raw |
|---|---|---|
| imports + constants | 47 | 230 |
| failure classification + small utils | 146 | 305 |
| spawn plan / sandbox / overlay binds | 173 | 406 |
| child stdout / exit / error lifecycle | 207 | 356 |
| result + log parsing | 133 | 278 |
| dispatch validate / build / queue | 106 | 203 |
| summarize | 193 | 346 |
| advisor | 97 | 162 |
| persist load + overlay sweep | 74 | 152 |
| row shaping + launch queue | 54 | 112 |
| accept validation + watchdog | 95 | 217 |
| options resolution | 114 | 238 |
| manager ctx / api assembly | 244 | 636 |
| log readers + row shaping | 250 | 390 |
| env build / overlay release / signals | 66 | 163 |
| persist / changeset / model / capability | 198 | 315 |
| `*For(ctx)` API implementations | 423 | 752 |
| **Total** | **2,620** | **5,261** |

One region exceeds 400 effective lines, and it is the DI layer this
tranche deletes. The `*For(ctx)` implementations redistribute into the
domain module owning their state, where `xFor(taskId, ctx)` becomes
`x(taskId)` closing over it. That is also what removes the `ctx` object
rather than merely relocating it.

Proposed modules, each under the 400 cap:

```
src/tasks.js               factory + the six-symbol barrel
src/tasks-options.js       options resolution (nine resolve* fns -> one table)
src/tasks-spawn.js         spawn plan, sandbox/overlay binds, child lifecycle
src/tasks-dispatch.js      dispatch validation, task construction, launch queue
src/tasks-failure.js       provider/boot failure classification, buckets
src/tasks-log.js           log parsing, narration readers, tail
src/tasks-result.js        result detail, projection, diffstat
src/tasks-summarize.js     summarize + activity paths
src/tasks-advisor.js       advisor
src/tasks-changeset.js     accept/reject, extraction, overlay sweep/release
src/tasks-watchdog.js      watchdog, running-watcher, failure escalation
src/tasks-persist.js       tasks.json load/flush/persist
src/tasks-env.js           sanitized/dispatch/summary env building
```

Sequencing inside the tranche, one PR per group so review stays
tractable:

1. Leaf modules owning no manager state: `tasks-failure`, `tasks-log`,
   `tasks-options`. Pure moves.
2. `tasks-env`, `tasks-persist`, `tasks-changeset`. State-owning, but
   narrow.
3. `tasks-spawn`, `tasks-dispatch`, `tasks-watchdog`. The child-process
   core.
4. `tasks-summarize`, `tasks-advisor`, `tasks-result`.
5. Collapse `buildTaskManagerApi`'s inline mini-`ctx` literals,
   `buildManagerInternalHelpers`, and `createManagerContext`'s
   mutate-in-place forward-reference dance. Delete the `tasks.js`
   `max-lines` waiver.

Fold in, while the code is already open, the duplication issues living
inside `tasks.js`: #45, #58, #165, #189, #190, #192, #193, and #146.
Fixing them during the move avoids a second pass over the same lines.
Each lands as its own commit, per principle 7, so the
behavior-preserving moves stay separable from the behavior-changing
fixes in review.

**Verification, stated explicitly.** `npm test` is 17,023 lines of
mocked suite that injects `spawnFn` everywhere; it never spawns `bwrap`.
Per CLAUDE.md, a green mocked run is no evidence that a change to the
spawn/sandbox boundary works. Every PR in this tranche also runs
`npm run test:integration`, the three smoke tests that boot a real daemon
and perform a real sandboxed dispatch, and the PR body records that
result alongside the unit count.

Exit: `tasks.js` passes `max-lines` at 400 with no exemption, the
`sonarjs/max-lines` waiver is gone, and the integration smoke tests are
green.

### Tranche 4: comments and docs

Runs after Tranche 3, because the split invalidates most of what needs
rewriting anyway.

- Delete the 74 lint-workaround comment lines. Their subject no longer
  exists.
- Rewrite `docs/sourcemap.md`. At 241 lines and 8,066 words it falls
  short of the "one-page orientation" its own opening line promises, and
  the `tasks.js` row alone runs 1,123 words, longer than most of the
  files it describes. The new layout gives it a real chance: one short
  row per module, with the deep behavioral notes moved into each module's
  own header comment, next to the code they describe.
- Audit comments against principle 6 on the files the earlier tranches
  touched. This targets comments that restate the code, not comments in
  general. The "why" comments, the ones recording a taskferry#NNN
  incident, an ordering constraint, or a kernel quirk, are the most
  valuable prose in the repo and they stay.
- Sync line counts, closing #245.

Exit: the sourcemap is accurate against the new module list and readable
in one sitting.

### Tranche 5: test suite

17,023 lines, 58% of the tree, and outside the maintainability rules
entirely via `ignores: ["**/*.test.js"]`.

- #147, a test hand-reimplements `piExecutor().sandboxAuthFile()` instead
  of importing it.
- #148, a redundant pi-executor sandbox test.
- #149, eleven duplicated `fakeExecutor` literals that want one shared
  helper.
- Decide whether `max-lines` applies to test files at a higher threshold.
  Four test files exceed 900 raw lines. This is an open question, not a
  foregone conclusion: test files legitimately grow with the surface they
  cover, and splitting them under lint pressure would repeat the exact
  mistake this regime exists to undo. Default to leaving them ignored
  unless the audit turns up a better reason.

Exit: shared fixtures consolidated, and an explicit recorded decision on
test file limits.

## Non-goals

- **Performance work**, except where a filed issue is already a perf
  issue that doubles as a duplication issue (#175, #177, #178, #192). No
  speculative optimization.
- **Feature work.** #316, reducing the CLI surface, is real
  simplification, but it changes the user-facing contract, so it needs
  its own design spec rather than a tranche here.
- **Rewriting tests for style.** Tranche 5 consolidates duplicated
  fixtures and stops there.
- **Touching `.superpowers/` history.** Archived plans keep their own
  rot.

## Risks

| Risk | Mitigation |
|---|---|
| Tranche 3 breaks the child-process/sandbox path while the mocked suite stays green | `npm run test:integration` on every PR in the tranche, result recorded in the PR body |
| Removing per-function caps lets complexity creep back | `sonarjs/cognitive-complexity` stays a hard error, and `max-lines` at 400 with no exemptions is a harder ceiling than this codebase has ever had |
| A genuine consolidation trips `cognitive-complexity` | Principle 4: convert to a data table plus one resolver. Re-splitting the function is the wrong answer, and it is what got us here |
| Merge conflicts against in-flight feature work | Tranche 3 is sequenced into five PRs; land them back to back rather than in parallel with unrelated `tasks.js` work |
| Doc rot, and the sourcemap drifts again | CLAUDE.md already requires updating it in the same PR, and Tranche 4's shorter rows make that cheap enough to happen |

## What "done" looks like

| Metric | Baseline | Target |
|---|---|---|
| Largest non-test file, effective | 2,620 | < 400 |
| Files over the 400 cap | 1 | 0 |
| Per-file lint exemptions | 1 | 0 |
| Functions taking a `ctx` god-object | 117 | 0 |
| Hand-rolled DI wrappers | 20 | 0 |
| Options-resolution functions | 9 | 1 |
| Lint-workaround comments | 74 | 0 |
| Open duplication and dead-code issues | 28 | 0 |
| `docs/sourcemap.md` | 8,066 words | fits its own "one-page" claim |

Non-test line count is deliberately absent from that table. It will fall,
but it is a symptom rather than a goal. A regime measured on line count
invites gaming it with dense code, which is the opposite of the point.
