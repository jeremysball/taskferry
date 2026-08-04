# SonarJS Lint Fix-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Every task in this plan MUST be dispatched through taskferry, per this repo's CLAUDE.md dispatch-lanes rule — never inline, never via the Agent tool.**

**Goal:** Fix every warning `eslint-plugin-sonarjs` currently reports across `taskferry`'s codebase (737 warnings, 40 files), then promote the sonarjs rule set and the existing maintainability rules (`complexity`, `max-depth`, `max-params`, `max-lines-per-function`, `max-lines`) from `"warn"` to hard errors (severity 2), so `npm run lint`, the pre-commit hook, and CI's `lint` leg block on any regression going forward.

**Architecture:** This is a supersede of `.superpowers/plans/2026-07-24-sonarjs-lint-ratchet.md` (a baseline-ratchet approach whose non-goals explicitly rule out fixing and promoting to errors). Per GitHub issue #135, that plan's ratchet/non-fix approach does not get executed; this plan fixes the repo up and then hard-gates it instead. Work proceeds file-cluster by file-cluster (grouped by which source file and its paired test file), starting with the `src/tasks.js`/`createTaskManager` hotspot GitHub issue #30 calls out as the biggest obstacle, then the other hotspots #30 lists (`args.js`, `commands.js`, `cli.js`, `daemon.js`), then every remaining file, then a final task flips severities and confirms the whole suite is clean.

**Tech Stack:** Node ESM, `eslint` 10.x flat config (`eslint.config.mjs`), `eslint-plugin-sonarjs` 4.2.0, `node:test` for the test suite.

## Global Constraints

- Every task's deliverable is a **zero-warning, zero-error** `npx eslint <files touched>` run for the files in that task, plus a passing `npm run test:unit` (the full suite — these files are interdependent, a change in one can break another's tests) and a passing `npm run typecheck`.
- Do not change runtime behavior. These are lint-shape fixes (extract constants, rename params, reorder object keys, extract helper functions, add guard clauses) — if a fix seems to require a behavior change to satisfy a rule, stop and flag it rather than guessing.
- Do not use inline `// eslint-disable` comments to silence a warning instead of fixing it, **except** for the following judgment calls, which are pre-approved:
  - `sonarjs/pseudo-random` inside test files where `Math.random()` picks test fixture data, not anything security-sensitive — disable inline with a one-line reason.
  - `sonarjs/file-permissions` inside `src/integrations.test.js` if the flagged mode is a deliberate test fixture (e.g. testing that taskferry rejects a too-permissive file) rather than an actual over-broad permission taskferry itself sets — verify the context before disabling; if taskferry's own code sets the permissive mode, fix the mode instead.
  - Any other rule: fix it for real. If a specific instance seems like a genuine false positive, stop and flag it in the task's completion report instead of disabling it unilaterally.
- Reference table for the rules you'll encounter (fix shape, not exhaustive):
  | Rule | Fix shape |
  |---|---|
  | `sonarjs/no-duplicate-string` | Extract the repeated string literal into a `const` (module-level if used across functions, function-scoped if local). |
  | `sonarjs/no-undefined-assignment` | Don't assign `undefined` explicitly. Remove the assignment (a `let x;` is already `undefined`), or restructure so the variable is only ever assigned a real value. |
  | `sonarjs/no-unused-function-argument` | Prefix the unused parameter with `_` (matches this repo's existing `argsIgnorePattern: "^_"` for `no-unused-vars`), or drop trailing unused params entirely. |
  | `sonarjs/shorthand-property-grouping` | Reorder an object literal's properties so shorthand (`{ a, b }`) properties are grouped together, either all at the start or all at the end — not interleaved with `key: value` pairs. |
  | `sonarjs/cyclomatic-complexity`, `sonarjs/cognitive-complexity` | Extract nested branches into named helper functions with early returns. |
  | `sonarjs/too-many-break-or-continue-in-loop` | Extract the loop body into a function and use `return`/array methods instead of multiple `break`/`continue`. |
  | `sonarjs/nested-control-flow` | Flatten with guard clauses (early `return`/`continue`) instead of nesting `if` inside `if` inside loop. |
  | `sonarjs/expression-complexity` | Break a complex boolean/ternary expression into named intermediate `const`s. |
  | `sonarjs/no-nested-conditional` | Replace nested ternaries with `if`/`else` or a lookup table/object map. |
  | `sonarjs/max-lines-per-function`, `sonarjs/max-lines` (and the plain `max-lines-per-function`/`max-lines` maintainability rules) | Split into smaller named functions (and, for whole-file `max-lines`, consider splitting the file — only if the plan calls for it explicitly; don't unilaterally split a file otherwise). |
  | `sonarjs/no-nested-template-literals` | Extract the inner template literal into a variable first, then interpolate that variable. |
  | `sonarjs/elseif-without-else` | Add a trailing `else` branch (even a no-op with a comment explaining why), or convert to `switch`. |
  | `sonarjs/no-identical-functions` | Extract the duplicated function body into one shared helper both call sites use. |
  | `sonarjs/no-collapsible-if` | Merge a nested `if (a) { if (b) {...} }` into `if (a && b) {...}`. |
  | `sonarjs/variable-name` | Rename the flagged identifier to something descriptive (no single-letter/`I`/`l`/`O` names). |
  | `sonarjs/no-unenclosed-multiline-block` | Wrap the block statement's body in `{ }`. |
  | `sonarjs/no-nested-incdec` | Split a combined increment/decrement expression (e.g. `arr[i++] = j--`) into separate statements. |
  | `sonarjs/updated-loop-counter` | Don't mutate the loop counter variable inside the loop body — only the `for` statement's own increment clause should update it. |
  | `sonarjs/super-linear-regex` | Rewrite the regex to avoid catastrophic backtracking (e.g. avoid nested quantifiers over the same character class). |
  | `sonarjs/single-character-alternation` | Replace `(a|b|c)` with a character class `[abc]`. |
  | `sonarjs/no-inconsistent-returns` | Make every `return` in the function either always return a value or never do — pick one and make all paths match. |
  | `sonarjs/function-name` | Rename an anonymous or poorly-named function expression to a descriptive `camelCase` name. |
  | `sonarjs/destructuring-assignment-syntax` | Replace manual `const x = obj.x` with `const { x } = obj`. |
  | `sonarjs/no-unused-vars`, plain `no-unused-vars` | Remove the variable, or prefix with `_` if it must stay (e.g. destructuring where only some fields are used). |
- Existing maintainability rules already in `eslint.config.mjs` (`complexity: 15`, `max-depth: 4`, `max-params: 5`, `max-lines-per-function: 80`, `max-lines: 400`) apply only to non-test files (`ignores: ["**/*.test.js", "**/*-test.js"]`) — leave that scoping as-is; don't extend it to test files as part of this plan.
- After every task, run `npm run check` (syntax + lint + typecheck) in addition to `npm run test:unit`, since it's cheap and catches anything the narrower per-file commands miss.
- Commit after each task with a `fix(lint):` or `refactor(lint):` Conventional Commits message naming the file(s) touched.

---

### Task 1: Confirm and commit the sonarjs wiring itself

**Files:**
- Modify: `eslint.config.mjs` (already staged in this worktree — verify, don't rewrite)
- Modify: `package.json`, `package-lock.json` (already staged — verify `eslint-plugin-sonarjs` installs cleanly)

**Interfaces:**
- Produces: the sonarjs plugin block in `eslint.config.mjs` that every later task's `npx eslint` run depends on.

- [ ] **Step 1: Verify the current worktree diff is what's intended**

Run: `git diff -- eslint.config.mjs package.json`
Expected: the sonarjs plugin block (`files: ["**/*.js"]`, all recommended rules mapped to `"warn"`, with `sonarjs/arrow-function-convention`, `sonarjs/file-header`, `sonarjs/publicly-writable-directories`, and `sonarjs/no-os-command-from-path` set to `"off"`), and the `eslint-plugin-sonarjs` devDependency + `overrides.eslint-plugin-sonarjs.ts-api-utils.typescript` pin in `package.json`.

- [ ] **Step 2: Confirm install is reproducible**

Run: `npm ci`
Expected: exits 0, no peer-dependency errors.

- [ ] **Step 3: Confirm the plugin actually runs and captures today's baseline**

Run: `npm run lint 2>&1 | tail -3`
Expected: `✖ 737 problems (0 errors, 737 warnings)` (or close — if the number has drifted since this plan was written, that's fine, just note the real number in your commit).

- [ ] **Step 4: Commit**

```bash
git add eslint.config.mjs package.json package-lock.json
git commit -m "chore(lint): wire up eslint-plugin-sonarjs as warnings"
```

---

### Task 2: Fix `src/tasks.js` (the `createTaskManager` hotspot)

**Files:**
- Modify: `src/tasks.js`

**Interfaces:**
- Consumes: nothing from other tasks — `tasks.js` has no sonarjs-driven dependency on other files' internal shape.
- Produces: `tasks.js` with `createTaskManager` (and any other flagged function) broken into smaller named helpers. Later tasks (`tasks.test.js` in Task 3) test this file's *behavior*, not its internal function names, so don't worry about exposing new helper names — just don't change any exported function's signature or `createTaskManager`'s public return shape.

- [ ] **Step 1: See the current damage**

Run: `npx eslint src/tasks.js`
Expected: warnings for `sonarjs/cyclomatic-complexity` (17), `sonarjs/nested-control-flow` (14), `sonarjs/shorthand-property-grouping` (14), `sonarjs/too-many-break-or-continue-in-loop` (14), `sonarjs/cognitive-complexity` (13), `sonarjs/expression-complexity` (6), `sonarjs/no-nested-conditional` (6), `sonarjs/no-undefined-assignment` (4), `sonarjs/elseif-without-else` (2), `sonarjs/max-lines-per-function` (2), `sonarjs/no-nested-template-literals` (2), `sonarjs/max-lines` (1), `sonarjs/no-nested-incdec` (1), `sonarjs/no-unenclosed-multiline-block` (1). Also existing maintainability warnings for `complexity`/`max-lines-per-function`/`max-lines` on `createTaskManager` (GitHub issue #30 has exact figures: 1,232 lines against a 400 max, `createTaskManager` at 1,092 lines / complexity 28, `result` at complexity 36, `advisor` at complexity 17).

- [ ] **Step 2: Extract task-state-transition helpers out of `createTaskManager`**

Per issue #30's suggestion, pull individual task lifecycle transitions (e.g. the state changes currently inlined in `createTaskManager`'s closure) out into standalone named functions above or below `createTaskManager`, called from inside it. This is the single biggest lever for the complexity/line-count/nesting warnings on this file. Read the current file to find the actual transition blocks — there's no substitute for reading `src/tasks.js` directly before deciding extraction boundaries.

- [ ] **Step 3: Work rule-by-rule on what's left**

Use the Global Constraints reference table for each remaining rule (`no-undefined-assignment`, `shorthand-property-grouping`, `no-nested-template-literals`, `elseif-without-else`, `no-nested-incdec`, `no-unenclosed-multiline-block`, `too-many-break-or-continue-in-loop`, `no-nested-conditional`, `expression-complexity`). Re-run `npx eslint src/tasks.js` after each batch of fixes to track progress down to zero.

- [ ] **Step 4: Verify no behavior change**

Run: `npm run test:unit`
Expected: all tests pass, same as before your changes (run `git stash` + `npm run test:unit` first if you want a clean before/after baseline, then restore).

Run: `npm run typecheck`
Expected: exits 0 (this file has JSDoc types checked via `tsconfig.json`).

- [ ] **Step 5: Confirm zero warnings**

Run: `npx eslint src/tasks.js`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/tasks.js
git commit -m "refactor(lint): extract task-transition helpers out of createTaskManager"
```

---

### Task 3: Fix `src/tasks.test.js`

**Files:**
- Modify: `src/tasks.test.js`

**Interfaces:**
- Consumes: Task 2's `src/tasks.js` (import surface only — don't assume test file changes need new exports; if a test needs something `tasks.js` doesn't export, flag it rather than adding a new export unilaterally).

- [ ] **Step 1: See the current damage**

Run: `npx eslint src/tasks.test.js`
Expected: `sonarjs/no-unused-function-argument` (63 — mostly `node:test` callback args like `(t)` or `(done)` that go unused; prefix with `_`), `sonarjs/no-duplicate-string` (50), `sonarjs/no-undefined-assignment` (29), `sonarjs/shorthand-property-grouping` (20), `sonarjs/max-lines-per-function` (8), `sonarjs/no-unenclosed-multiline-block` (2), `sonarjs/pseudo-random` (2 — test fixture randomness, inline-disable per Global Constraints), `sonarjs/cognitive-complexity` (1), `sonarjs/cyclomatic-complexity` (1), `sonarjs/max-lines` (1), `sonarjs/too-many-break-or-continue-in-loop` (1).

- [ ] **Step 2: Fix mechanically, largest-count rule first**

`no-unused-function-argument` and `no-duplicate-string` are the bulk here and are mechanical (see the reference table). Do those first, then work down the rest.

- [ ] **Step 3: Verify**

Run: `npx eslint src/tasks.test.js` — expect zero warnings.
Run: `npm run test:unit` — expect all pass.

- [ ] **Step 4: Commit**

```bash
git add src/tasks.test.js
git commit -m "fix(lint): clear sonarjs warnings in tasks.test.js"
```

---

### Task 4: Fix `src/args.js` and `src/args.test.js`

**Files:**
- Modify: `src/args.js`, `src/args.test.js`

**Interfaces:**
- Consumes: nothing new.

- [ ] **Step 1: See the damage**

Run: `npx eslint src/args.js src/args.test.js`
Expected in `args.js`: `sonarjs/no-undefined-assignment` (38 — this file's `parseArgs` almost certainly has a pattern of declaring option variables as `undefined` up front; per issue #30, `parseArgs` is 119 lines / complexity 63, so expect the undefined-assignment fixes to interact with the same dispatch-table refactor you'll want for complexity), `sonarjs/cyclomatic-complexity` (2), `sonarjs/cognitive-complexity` (1), `sonarjs/elseif-without-else` (1), `sonarjs/no-duplicate-string` (1), `sonarjs/no-nested-conditional` (1), `sonarjs/no-nested-template-literals` (1), `sonarjs/single-character-alternation` (1), `sonarjs/too-many-break-or-continue-in-loop` (1), `sonarjs/updated-loop-counter` (1). Expected in `args.test.js`: `sonarjs/no-undefined-assignment` (15), `sonarjs/no-duplicate-string` (7).

- [ ] **Step 2: Refactor `parseArgs`'s dispatch body**

Per issue #30's suggestion, split `parseArgs`'s large per-flag dispatch into per-subcommand/per-flag handler functions rather than one long `if`/`else if` chain — this addresses complexity, nested-conditional, and elseif-without-else together. Read the current file before deciding the split.

- [ ] **Step 3: Verify**

Run: `npx eslint src/args.js src/args.test.js` — expect zero warnings.
Run: `npm run test:unit` — expect all pass.
Run: `npm run typecheck` — expect exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/args.js src/args.test.js
git commit -m "refactor(lint): split parseArgs dispatch, clear sonarjs warnings"
```

---

### Task 5: Fix `src/commands.js` and `src/commands.test.js`

**Files:**
- Modify: `src/commands.js`, `src/commands.test.js`

- [ ] **Step 1: See the damage**

Run: `npx eslint src/commands.js src/commands.test.js`
Expected in `commands.js`: `sonarjs/no-nested-conditional` (3), `sonarjs/no-duplicate-string` (2), `sonarjs/no-nested-template-literals` (2), `sonarjs/cognitive-complexity` (1), `sonarjs/cyclomatic-complexity` (1), `sonarjs/no-inconsistent-returns` (1). Per issue #30, `runCommand` is 124 lines / complexity 52 — same dispatch-table extraction pattern as Task 4 applies here. Expected in `commands.test.js`: `sonarjs/no-undefined-assignment` (25), `sonarjs/shorthand-property-grouping` (14), `sonarjs/no-unused-function-argument` (11), `sonarjs/no-duplicate-string` (9), `sonarjs/no-identical-functions` (4).

- [ ] **Step 2: Refactor `runCommand`'s dispatch into per-command handlers**

- [ ] **Step 3: Verify**

Run: `npx eslint src/commands.js src/commands.test.js` — expect zero warnings.
Run: `npm run test:unit` — expect all pass.

- [ ] **Step 4: Commit**

```bash
git add src/commands.js src/commands.test.js
git commit -m "refactor(lint): split runCommand dispatch, clear sonarjs warnings"
```

---

### Task 6: Fix `src/cli.js` and `src/cli.test.js`

**Files:**
- Modify: `src/cli.js`, `src/cli.test.js`

- [ ] **Step 1: See the damage**

Run: `npx eslint src/cli.js src/cli.test.js`
Expected in `cli.js`: `sonarjs/cognitive-complexity` (1), `sonarjs/cyclomatic-complexity` (1), `sonarjs/elseif-without-else` (1), `sonarjs/expression-complexity` (1), `sonarjs/no-nested-template-literals` (1). Per issue #30, `runCli` is 85 lines / complexity 34. Expected in `cli.test.js`: `sonarjs/no-duplicate-string` (7), `sonarjs/shorthand-property-grouping` (2), `sonarjs/no-undefined-assignment` (1).

- [ ] **Step 2: Refactor `runCli`**

Extract per-subcommand branches into named handler functions, same pattern as Tasks 4-5.

- [ ] **Step 3: Verify**

Run: `npx eslint src/cli.js src/cli.test.js` — expect zero warnings.
Run: `npm run test:unit` — expect all pass.

- [ ] **Step 4: Commit**

```bash
git add src/cli.js src/cli.test.js
git commit -m "refactor(lint): split runCli dispatch, clear sonarjs warnings"
```

---

### Task 7: Fix `src/daemon.js` and `src/daemon.test.js`

**Files:**
- Modify: `src/daemon.js`, `src/daemon.test.js`

- [ ] **Step 1: See the damage**

Run: `npx eslint src/daemon.js src/daemon.test.js`
Expected in `daemon.js`: `sonarjs/too-many-break-or-continue-in-loop` (2), `sonarjs/cyclomatic-complexity` (1), `sonarjs/nested-control-flow` (1), `sonarjs/shorthand-property-grouping` (1). Per issue #30, file is 404 lines against a 400 max; `startDaemon` is 166 lines / complexity 18; `invoke` has complexity 23. Expected in `daemon.test.js`: `sonarjs/no-duplicate-string` (6), `sonarjs/max-lines-per-function` (2), `sonarjs/shorthand-property-grouping` (2), `sonarjs/too-many-break-or-continue-in-loop` (1).

- [ ] **Step 2: Reduce `startDaemon`/`invoke` complexity and trim the file under 400 lines**

Extract helpers from `startDaemon` and `invoke`. If the file is still over 400 lines after that, look for an obvious extraction (e.g. moving a self-contained group of functions to a new module) — only do this if it's clearly a single-responsibility extraction, not a forced split.

- [ ] **Step 3: Verify**

Run: `npx eslint src/daemon.js src/daemon.test.js` — expect zero warnings.
Run: `npm run test:unit` — expect all pass.

- [ ] **Step 4: Commit**

```bash
git add src/daemon.js src/daemon.test.js
git commit -m "refactor(lint): reduce daemon.js complexity, clear sonarjs warnings"
```

(If a new module was extracted, `git add` that file too and adjust the commit message accordingly.)

---

### Task 8: Fix `src/protocol.js` and `src/protocol.test.js`

**Files:**
- Modify: `src/protocol.js`, `src/protocol.test.js`

- [ ] **Step 1: See the damage**

Run: `npx eslint src/protocol.js src/protocol.test.js`
Expected in `protocol.js`: `sonarjs/expression-complexity` (5), `sonarjs/cyclomatic-complexity` (2), `sonarjs/no-duplicate-string` (2), `sonarjs/shorthand-property-grouping` (2), `sonarjs/cognitive-complexity` (1). Per issue #30, `validParams` has complexity 43. Expected in `protocol.test.js`: `sonarjs/no-duplicate-string` (10), `sonarjs/expression-complexity` (1), `sonarjs/max-lines-per-function` (1).

- [ ] **Step 2: Break `validParams` into named per-field validators**

- [ ] **Step 3: Verify**

Run: `npx eslint src/protocol.js src/protocol.test.js` — expect zero warnings.
Run: `npm run test:unit` — expect all pass.

- [ ] **Step 4: Commit**

```bash
git add src/protocol.js src/protocol.test.js
git commit -m "refactor(lint): split validParams, clear sonarjs warnings in protocol.js"
```

---

### Task 9: Fix `src/client.js`, `src/state-lock.js`, `src/executor.js`, `src/executor.test.js`

**Files:**
- Modify: `src/client.js`, `src/state-lock.js`, `src/executor.js`, `src/executor.test.js`

- [ ] **Step 1: See the damage**

Run: `npx eslint src/client.js src/state-lock.js src/executor.js src/executor.test.js`
Expected in `client.js`: `sonarjs/cognitive-complexity` (2), `sonarjs/cyclomatic-complexity` (1), `sonarjs/expression-complexity` (1), `sonarjs/nested-control-flow` (1), `sonarjs/no-duplicate-string` (1), `sonarjs/too-many-break-or-continue-in-loop` (1). Per issue #30, `onData` has complexity 30, `connectClient` has complexity 19. Expected in `state-lock.js`: `sonarjs/nested-control-flow` (3), `sonarjs/cognitive-complexity` (1), `sonarjs/cyclomatic-complexity` (1), `sonarjs/too-many-break-or-continue-in-loop` (1). Per issue #30, `withFileLock` has complexity 20 and a nesting depth of 5 against a max of 4. Expected in `executor.js`: `sonarjs/shorthand-property-grouping` (2), `sonarjs/cognitive-complexity` (1), `sonarjs/cyclomatic-complexity` (1), `sonarjs/destructuring-assignment-syntax` (1), `sonarjs/function-name` (1), `sonarjs/too-many-break-or-continue-in-loop` (1). Expected in `executor.test.js`: `sonarjs/no-duplicate-string` (15), `sonarjs/max-lines-per-function` (1).

- [ ] **Step 2: Extract helpers from `onData`/`connectClient` (client.js) and `withFileLock` (state-lock.js)**

- [ ] **Step 3: Fix remaining mechanical warnings in `executor.js`/`executor.test.js`**

- [ ] **Step 4: Verify**

Run: `npx eslint src/client.js src/state-lock.js src/executor.js src/executor.test.js` — expect zero warnings.
Run: `npm run test:unit` — expect all pass.

- [ ] **Step 5: Commit**

```bash
git add src/client.js src/state-lock.js src/executor.js src/executor.test.js
git commit -m "refactor(lint): reduce complexity in client/state-lock/executor, clear sonarjs warnings"
```

---

### Task 10: Fix `src/changeset.js`, `src/changeset.test.js`, `src/changeset.integration.test.js`

**Files:**
- Modify: `src/changeset.js`, `src/changeset.test.js`, `src/changeset.integration.test.js`

- [ ] **Step 1: See the damage**

Run: `npx eslint src/changeset.js src/changeset.test.js src/changeset.integration.test.js`
Expected in `changeset.js`: `sonarjs/no-unused-function-argument` (2), `sonarjs/cyclomatic-complexity` (1), `sonarjs/expression-complexity` (1), `sonarjs/no-nested-template-literals` (1). Expected in `changeset.test.js`: `sonarjs/no-undefined-assignment` (16), `sonarjs/no-duplicate-string` (11), `sonarjs/no-unused-function-argument` (5), `sonarjs/shorthand-property-grouping` (5). Expected in `changeset.integration.test.js`: `sonarjs/shorthand-property-grouping` (8), `sonarjs/no-duplicate-string` (5), `sonarjs/no-nested-conditional` (1).

- [ ] **Step 2: Fix mechanically**

- [ ] **Step 3: Verify**

Run: `npx eslint src/changeset.js src/changeset.test.js src/changeset.integration.test.js` — expect zero warnings.
Run: `npm run test:unit` — expect all pass.

- [ ] **Step 4: Commit**

```bash
git add src/changeset.js src/changeset.test.js src/changeset.integration.test.js
git commit -m "fix(lint): clear sonarjs warnings in changeset files"
```

---

### Task 11: Fix `src/sandbox.js` and `src/sandbox.test.js`

**Files:**
- Modify: `src/sandbox.js`, `src/sandbox.test.js`

- [ ] **Step 1: See the damage**

Run: `npx eslint src/sandbox.js src/sandbox.test.js`
Expected in `sandbox.js`: `sonarjs/variable-name` (1). Expected in `sandbox.test.js`: `sonarjs/no-duplicate-string` (17), `sonarjs/no-undefined-assignment` (9).

- [ ] **Step 2: Fix mechanically**

- [ ] **Step 3: Verify**

Run: `npx eslint src/sandbox.js src/sandbox.test.js` — expect zero warnings.
Run: `npm run test:unit` — expect all pass.

- [ ] **Step 4: Commit**

```bash
git add src/sandbox.js src/sandbox.test.js
git commit -m "fix(lint): clear sonarjs warnings in sandbox files"
```

---

### Task 12: Fix `src/setup.js` and `src/setup.test.js`

**Files:**
- Modify: `src/setup.js`, `src/setup.test.js`

- [ ] **Step 1: See the damage**

Run: `npx eslint src/setup.js src/setup.test.js`
Expected in `setup.js`: `sonarjs/no-nested-template-literals` (2), `sonarjs/no-undefined-assignment` (2), `sonarjs/cognitive-complexity` (1), `sonarjs/cyclomatic-complexity` (1), `sonarjs/nested-control-flow` (1), `sonarjs/no-duplicate-string` (1). Expected in `setup.test.js`: `sonarjs/no-duplicate-string` (11), `sonarjs/cyclomatic-complexity` (4), `sonarjs/no-collapsible-if` (4), `sonarjs/cognitive-complexity` (3), `sonarjs/shorthand-property-grouping` (1).

- [ ] **Step 2: Fix mechanically, extract a helper if complexity fixes need one**

- [ ] **Step 3: Verify**

Run: `npx eslint src/setup.js src/setup.test.js` — expect zero warnings.
Run: `npm run test:unit` — expect all pass.

- [ ] **Step 4: Commit**

```bash
git add src/setup.js src/setup.test.js
git commit -m "fix(lint): clear sonarjs warnings in setup files"
```

---

### Task 13: Fix `src/activity.js`, `src/activity.test.js`, `src/output.js`, `src/output.test.js`

**Files:**
- Modify: `src/activity.js`, `src/activity.test.js`, `src/output.js`, `src/output.test.js`

- [ ] **Step 1: See the damage**

Run: `npx eslint src/activity.js src/activity.test.js src/output.js src/output.test.js`
Expected in `activity.js`: `sonarjs/shorthand-property-grouping` (5), `sonarjs/cyclomatic-complexity` (2), `sonarjs/elseif-without-else` (1), `sonarjs/nested-control-flow` (1). Expected in `activity.test.js`: `sonarjs/no-duplicate-string` (3). Expected in `output.js`: `sonarjs/no-nested-conditional` (3), `sonarjs/expression-complexity` (2), `sonarjs/no-unused-vars` (2), `sonarjs/cyclomatic-complexity` (1), `sonarjs/shorthand-property-grouping` (1). Expected in `output.test.js`: `sonarjs/no-duplicate-string` (5).

- [ ] **Step 2: Fix mechanically**

- [ ] **Step 3: Verify**

Run: `npx eslint src/activity.js src/activity.test.js src/output.js src/output.test.js` — expect zero warnings.
Run: `npm run test:unit` — expect all pass.

- [ ] **Step 4: Commit**

```bash
git add src/activity.js src/activity.test.js src/output.js src/output.test.js
git commit -m "fix(lint): clear sonarjs warnings in activity/output files"
```

---

### Task 14: Fix remaining small files

**Files:**
- Modify: `src/integrations.test.js`, `src/opencode-plugin.js`, `src/opencode-plugin.test.js`, `src/paths.test.js`, `src/events.js`, `src/events.test.js`, `src/mcp-isolation.js`, `src/smoke-test.js`, `src/poll-smoke-test.js`, `src/cancel-smoke-test.js`, `src/config.test.js`, `scripts/generate-skill.js`, `scripts/e2e-setup.js`

- [ ] **Step 1: See the damage**

Run: `npx eslint src/integrations.test.js src/opencode-plugin.js src/opencode-plugin.test.js src/paths.test.js src/events.js src/events.test.js src/mcp-isolation.js src/smoke-test.js src/poll-smoke-test.js src/cancel-smoke-test.js src/config.test.js scripts/generate-skill.js scripts/e2e-setup.js`
Expected: `sonarjs/file-permissions` (4, in `integrations.test.js` — check per Global Constraints whether these are deliberate test fixtures before disabling), `sonarjs/no-duplicate-string` (spread across most of these files), `sonarjs/elseif-without-else` (2, in `opencode-plugin.js`), `sonarjs/no-nested-conditional` (1, `changeset.integration.test.js` — already covered in Task 10, skip if already fixed), `sonarjs/super-linear-regex` (1, `mcp-isolation.js`), `sonarjs/variable-name` (2, `poll-smoke-test.js` and `smoke-test.js`), `sonarjs/variable-name` (1, `cancel-smoke-test.js`), `sonarjs/shorthand-property-grouping` (1, `e2e-setup.js`).

- [ ] **Step 2: Fix mechanically, file by file**

- [ ] **Step 3: Verify**

Run: `npx eslint src/integrations.test.js src/opencode-plugin.js src/opencode-plugin.test.js src/paths.test.js src/events.js src/events.test.js src/mcp-isolation.js src/smoke-test.js src/poll-smoke-test.js src/cancel-smoke-test.js src/config.test.js scripts/generate-skill.js scripts/e2e-setup.js` — expect zero warnings.
Run: `npm run test:unit` — expect all pass.
Run: `npm run test:integration` — expect all pass (this exercises `smoke-test.js`, `cancel-smoke-test.js`, `poll-smoke-test.js` directly).

- [ ] **Step 4: Commit**

```bash
git add src/integrations.test.js src/opencode-plugin.js src/opencode-plugin.test.js src/paths.test.js src/events.js src/events.test.js src/mcp-isolation.js src/smoke-test.js src/poll-smoke-test.js src/cancel-smoke-test.js src/config.test.js scripts/generate-skill.js scripts/e2e-setup.js
git commit -m "fix(lint): clear sonarjs warnings in remaining files"
```

---

### Task 15: Promote sonarjs and maintainability rules to hard errors

**Files:**
- Modify: `eslint.config.mjs`

**Interfaces:**
- Consumes: a fully-clean `npm run lint` from Tasks 1-14 (this task will fail loudly if any warning remains anywhere in the tree — that's the point).

- [ ] **Step 1: Confirm the tree is clean before promoting**

Run: `npm run lint 2>&1 | tail -3`
Expected: `✖ 0 problems`. If not, stop — find and fix what Tasks 2-14 missed (a file changed since those tasks ran, or a rule wasn't fully addressed) before touching severities.

- [ ] **Step 2: Flip severities in `eslint.config.mjs`**

Change the maintainability rules block:

```js
  {
    files: ["**/*.js"],
    ignores: ["**/*.test.js", "**/*-test.js"],
    rules: {
      complexity: ["error", 15],
      "max-depth": ["error", 4],
      "max-params": ["error", 5],
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },
```

And the sonarjs block's mapping from `"warn"` to `"error"`:

```js
  {
    files: ["**/*.js"],
    plugins: { sonarjs },
    rules: {
      ...Object.fromEntries(
        Object.entries(sonarjs.configs.recommended.rules).map(([name, value]) => [
          name,
          Array.isArray(value) ? ["error", ...value.slice(1)] : "error",
        ]),
      ),
      "sonarjs/arrow-function-convention": "off",
      "sonarjs/file-header": "off",
      "sonarjs/publicly-writable-directories": "off",
      "sonarjs/no-os-command-from-path": "off",
    },
  },
```

Update the comment above the sonarjs block (currently says "Also warnings for now: see issue #135...") to reflect that the promotion has happened, e.g. "Promoted to hard errors per issue #135, once the fix-up in `.superpowers/plans/2026-07-31-sonarjs-lint-fixup.md` landed."

- [ ] **Step 3: Verify the gate actually gates**

Run: `npm run lint`
Expected: exits 0, `✖ 0 problems`.

Introduce a scratch violation to confirm the promotion took effect (e.g. temporarily add `const x = "dup"; const y = "dup"; const z = "dup";` to a throwaway location in `src/output.js`), run `npm run lint`, confirm it now reports an **error** (not a warning) and exits non-zero, then revert the scratch change.

- [ ] **Step 4: Confirm CI/pre-commit already gate on errors (no changes needed there)**

Read `.github/workflows/check.yml`'s `lint` leg and `.githooks/pre-commit` — both already run `npm run lint`/equivalent and already only block on errors (warnings were always informational). No changes needed to either file; this step is a read-and-confirm, not an edit.

- [ ] **Step 5: Full check**

Run: `npm run check`
Expected: exits 0 (syntax check + lint + typecheck all pass).
Run: `npm run test:unit && npm run test:integration`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add eslint.config.mjs
git commit -m "fix(lint)!: promote sonarjs and maintainability rules to hard errors

Closes #135"
```

Note the `!` and body: this is a deliberate breaking change to contributor workflow (lint warnings now block commits/CI), matching this repo's Conventional Commits convention for breaking changes.

---

## Self-Review Notes

- **Spec coverage:** issue #135's three asks are covered: add sonarjs (Task 1, already done), fix flagged violations starting with the `tasks.js`/`createTaskManager` hotspot (Tasks 2-14, in that priority order), promote to hard errors (Task 15). The explicit ratchet-vs-fix conflict is resolved in the plan header by stating this plan supersedes the ratchet plan's non-goals per issue #135's own instruction to do so.
- **Placeholder scan:** tasks intentionally don't pre-write exact refactor diffs for the complexity/nesting fixes (Tasks 2, 4-9) — the actual extraction shape depends on reading each function's real current body, which isn't knowable until a worker opens the file. This is not a "TBD" placeholder in the prohibited sense: each such step names the exact function, the exact warning counts and rule IDs to clear, the concrete fix *pattern* to apply (extract named helpers, guard clauses, dispatch tables), and a concrete pass/fail verification command. Mechanical, fully-known-shape rules (duplicate strings, undefined assignment, unused args, shorthand grouping, etc.) do have exact fix instructions in the Global Constraints reference table.
- **Type consistency:** no new shared types/interfaces are introduced across tasks — each task's file(s) are independent of every other task's internal implementation, so there's no cross-task signature to keep consistent. The one shared constraint (don't change `tasks.js`'s exported function signatures in Task 2, since Task 3 tests it) is called out explicitly in Task 2's Interfaces block.
