# Task 6 Report: Wire `resolveVariant()` and the variants cache into `dispatchTask`

**Status: DONE_WITH_CONCERNS**

**Commit:** `1dd573c` — `feat(cli): default an omitted --variant to the model's highest supported level`

## What was done

All 10 brief steps, with the fallout sweep the brief's Step 9 demanded:

1. **Tests first** — added the 6 brief-specified tests to `src/tasks.dispatch.test.js`
   (omitted `--variant` on pi → `--thinking max`; opencode ranked-highest from a
   cached table; no cache entry → no flag; explicit `--variant` never
   reinterpreted; resumed session inherits its own variant; concrete
   `defaultVariant` requested verbatim). Verified they failed before the wiring
   (the `opencodeVariantsTable`/`defaultVariant` options were unrecognized and
   `buildDispatchTask` still hardcoded `variant: null`).
2. **`resolveStringOptions`** — added `defaultVariant` with the
   raw-option → `TASKFERRY_DEFAULT_VARIANT` → `config.defaultVariant` →
   `"highest"` chain.
3. **Test seam** — `opencodeVariantsTable` passthrough in
   `buildManagerOptions()` (`src/tasks.test-helpers.js`) and in
   `resolveCoreOptions()` (`src/tasks.js`).
4. **`buildDispatchTask`** — replaced the Task 5 `variant: null` placeholder
   with the real precedence chain (explicit `--variant` > resumed task's own
   variant > `defaultVariant`) through `resolveVariant()`, with
   `resolveOpencodeVariants(resolvedModel)` feeding the opencode table.
5. **Threading** — `defaultVariant`/`resolveOpencodeVariants` added to
   `dispatchTask`'s ctx typedef, the `ctx.dispatch` wiring, and
   `ctx.helpers.resolveOpencodeVariants` (test seam short-circuit, else
   `readVariantsCache({ cacheDir, env: process.env })`). Confirmed
   `dispatchAdvisorTask` funnels through the same `ctx.dispatch` reference
   (src/tasks.js:2590), so no separate advisor ctx object needed updating.

## Step 9 fallout sweep (the brief's sharp edge)

Ran the **entire** suite, not a pattern. Three tests asserted a specific argv
shape with an explicit `variant: "max"` passed to `dispatch()`/`advisor()` but
were written against Task 5's placeholder that dropped the variant — they now
correctly see `--variant max` in the spawned argv and were fixed by updating
the expected argv:

- `src/tasks.dispatch.test.js:20` — "passes the right argv and spawn options
  through to spawnFn" (opencode, `variant: "max"`)
- `src/tasks.advisor.test.js:43` — "dispatches with the given model/variant and
  resolves inline once the task finishes" (opencode, `variant: "max"`)
- `src/tasks.sandbox.test.js:30` — "wraps the spawn command in bwrap when
  sandboxing is enabled and available" (opencode, `variant: "max"`)

No test in `tasks.executor.test.js` needed changes: its argv-shape assertions
use fake executors whose `buildSpawnArgs` ignores `ctx.variant`, and its
default-executor tests assert only `captured.cmd`/model, not the variant flag.

## Concerns

1. **`npm run check` exits 1 on 6 pre-existing environmental failures** — all
   six fail identically on the clean HEAD tree (verified by checking out HEAD
   and re-running). This test run is itself inside a taskferry dispatch, so the
   ambient env carries `TASKFERRY_TASK_ID`, `XDG_DATA_HOME`, and
   `XDG_CONFIG_HOME` (all pointing at the taskferry cache dir), which breaks:
   - `tasks.env.test.js` "TASKFERRY_TASK_ID is absent from summary spawns"
     (ambient `TASKFERRY_TASK_ID` leaks into the sanitized summary env)
   - `tasks.sandbox.test.js` "opencode's real config entries are ro-bound…",
     "ro-binds the real opencode auth.json…", "--rw-bind at the real auth.json
     path…", "leaves XDG_DATA_HOME untouched…" (ambient `XDG_DATA_HOME`/
     `XDG_CONFIG_HOME` point at the taskferry cache, so the real
     `~/.local/share/opencode`/`~/.config/opencode` paths the tests mock are
     shadowed)
   - `daemon-client.test.js` "client.js's direct-execution guard runs
     ensureDaemonStarted() when invoked through a symlink" (flaky boot-error
     file timing; fails on clean HEAD too)
   Lint, typecheck, and skill:check all pass. `npm test` on my tree: 1204
   tests, 1198 pass, 6 fail (the same 6). The 6 new tests all pass.
2. **`src/variants.js` needed a one-line type annotation** — importing it into
   `src/tasks.js` pulled it into the typecheck program (tsconfig includes only
   `src/tasks.js`), surfacing two latent TS7053 errors from Task 2's commit
   (`KNOWN_RANKS[key]` indexing a literal object type). Fixed with
   `/** @type {Record<string, number>} */` — a type annotation only, no logic
   change, per the brief's "do not modify its logic" constraint.
3. **`buildDispatchTask` complexity** — the brief's verbatim code pushed the
   function to 17 cyclomatic complexity (core `complexity` rule, max 15). The
   existing eslint-disable comment was extended to cover both rules
   (`sonarjs/cyclomatic-complexity, complexity`), matching the file's existing
   pattern for this function.
4. **`sonarjs/no-duplicate-string`** — the brief's verbatim tests use
   `"--thinking"` three times; hoisted to a `THINKING_FLAG` const in the new
   describe block.

## Verification

- `npm test` — 1204 total / 1198 pass / 6 fail (all 6 pre-existing
  environmental, identical on clean HEAD; the 6 new tests pass)
- `npm run check` — lint, typecheck, skill:check pass; overall exit 1 solely
  from the same 6 pre-existing test failures
