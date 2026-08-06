# Task 1 report — `.taskferry.toml` loader (`src/project-config.js`)

## What I implemented

Created the first module of the 11-task check-gate plan: a
`.taskferry.toml` loader that later tasks will lean on for dispatch-time
prompt injection, spawn-time read-only binds, and settle-time gate
execution.

**Files created / modified:**

- `src/project-config.js` (new, 121 lines) — exports
  `resolveProjectConfigPath()`, `loadProjectConfig()`,
  `verificationPromptBlock()`, and `_resetProjectConfigCache()` per the
  brief. Loads/parses/validates `.taskferry.toml` against a fixed
  `KNOWN_KEYS = {check, check_timeout_seconds, read_only_paths}` allow-list
  via `smol-toml`'s `parse()` + a `TomlError` catch, then validates each
  field type (`check` must be a string; `check_timeout_seconds` must be a
  positive integer; `read_only_paths` must be an array of strings) and
  flags unrecognized keys. Mtime-based per-path cache mirroring
  `config.js`'s shape (`mtimeMs: number | null`, null = ENOENT), with
  `statFn`/`readFileFn` injection points for tests. An absent file
  returns an `EMPTY_CONFIG`-shaped result (no gate, no injection, no
  extra binds); an unparseable or schema-invalid file also returns
  `EMPTY_CONFIG` but with `parseError` set so callers surface a loud
  warning instead of silently guessing a partial config — dispatch
  proceeds with no gate, per the design's error table.
- `src/project-config.test.js` (new, 102 lines) — the 10 tests from the
  brief's Step 2, verbatim (the seven loadProjectConfig cases plus the
  caches-by-mtime / cache-invalidation pair, plus the
  verificationPromptBlock assertion). Imports `beforeEach` from `node:test`
  and adds a `beforeEach(() => _resetProjectConfigCache())` to each
  describe block so the brief's `_resetProjectConfigCache` import isn't
  dead (see Deviations).
- `package.json` — adds `"smol-toml": "^1.7.1"` to `dependencies` (sits
  next to the existing `@toon-format/toon` entry) and registers
  `src/project-config.test.js` in the `test:unit` script, placed
  alphabetically near `src/protocol.test.js` (immediately after it).
- `package-lock.json` — the matching `smol-toml@^1.7.1` lock entry
  + transitive closure.
- `docs/sourcemap.md` — new file-by-file row for `project-config.js`
  placed next to `config.js` (conceptually related — same
  mtime-cached-per-path loader shape) and a new "Where do I look for X"
  row pointing future readers at `loadProjectConfig()` /
  `verificationPromptBlock()`.

## Commit hash

```
a78547e feat(config): add .taskferry.toml loader (project-config.js)
```

On branch `check-gate-project-config`, parent `00856e3`. (Originally
written as `12fb0dd`; corrected after the controller's applied-and-
committed step landed under `a78547e`.)

## Test command + output summary

```
$ env -i HOME="$HOME" PATH="$PATH" env -u TASKFERRY_CHILD \
    node --test src/project-config.test.js
ℹ tests 10
ℹ suites 2
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 109.29
```

10/10 pass (9 in `loadProjectConfig`, 1 in `verificationPromptBlock`).
The failing-test step (Step 3) was also confirmed earlier — `node --test
src/project-config.test.js` failed with
`Cannot find module './project-config.js'` (`ERR_MODULE_NOT_FOUND`) before
the implementation file existed, exactly as the brief predicted.

For regression confidence I also ran the full `test:unit` script with a
clean env (`env -i HOME=... PATH=...` to avoid the ambient
`XDG_DATA_HOME`/`TASKFERRY_*` vars from concurrent sessions bleeding
into other worktree's sandbox tests, per CLAUDE.md's "Isolate your own
taskferry runs" note):

```
$ env -i HOME="$HOME" PATH="$PATH" npm run test:unit
ℹ tests 981
ℹ pass 981
ℹ fail 0
ℹ duration_ms 15896
```

981/981 pass — 10 of those are the new project-config tests, the
remaining 971 are the pre-existing suite with no regressions introduced.
Lint (`npm run lint`) and typecheck (`npm run typecheck`) are clean.

## Concerns / deviations from the brief

Two minor lint-vs-brief deviations, both benign and following existing
precedent in the codebase:

1. **`validateAndNormalize` complexity** (brief Step 4 has it at 18,
   project ESLint caps `complexity` at 15 and `sonarjs/cyclomatic-
   complexity` at 10). I followed the precedent of
   `src/tasks.js:1670` (`// eslint-disable-next-line sonarjs/
   cyclomatic-complexity -- ...`) and added a single
   `// eslint-disable-next-line complexity, sonarjs/cyclomatic-complexity
   -- brief-mandated shape; ...` comment immediately above the
   function. The function body itself is unchanged from the brief's
   verbatim spec — the comment is the only addition. Splitting the
   per-field checks into helper functions would have changed the
   brief's spec without a behavior win (the `EMPTY_CONFIG`-shaped
   `parseError` would still have to live in one place), so the
   suppression comment is the smaller deviation.

2. **Test file imports `_resetProjectConfigCache` but the brief's tests
   never call it** — `sonarjs/unused-import` flagged it. Added a
   `beforeEach(() => _resetProjectConfigCache())` to each `describe`
   block so the import isn't dead and the cache state is reset between
   tests (the brief's tests each use a unique tmpdir so cross-test
   contamination isn't observable today, but the reset is good hygiene
   and exercises the brief's intent of exporting the reset function for
   test use).

A separate note, not a deviation but worth flagging:

3. **Pre-existing test fragility unrelated to this task**: running
   `npm run test:unit` with `XDG_DATA_HOME` already set in the shell
   (a leaked env from a concurrent session — `check-gate-sdd` here)
   makes `src/tasks.sandbox.test.js`'s
   "leaves XDG_DATA_HOME untouched when sandboxing is disabled" test
   fail because the sandbox test compares against the literal
   `XDG_DATA_HOME` it sees. Per CLAUDE.md's "Isolate your own
   taskferry runs" guidance I worked under `env -i HOME=... PATH=...`
   (with `TASKFERRY_STATE_DIR`/`RUNTIME_DIR`/`CACHE_DIR` redirected
   under `/tmp/taskferry-dev-check-gate-pc/`) and the full suite went
   981/981 green. Worth keeping in mind for the next 10 tasks in this
   plan: tests must be run with a clean env or with the dev
   `TASKFERRY_*` redirect to avoid cross-session pollution.

No other deviations. The implementation file is the brief's Step 4
verbatim except for the eslint-disable comment described above; the
test file is the brief's Step 2 verbatim plus the `beforeEach`
described above; the package.json test:unit insertion is in the brief's
recommended location; the smol-toml install + lockfile are the brief's
Step 1 verbatim.

---

## Fix round 1/5

Reviewer flagged two Important findings and one Minor. All three
addressed. Fix commit:

```
8c93075 fix(config): document _resetProjectConfigCache return type and bump engines.node to >=18
```

### Important 1 — `src/project-config.js` JSDoc

`_resetProjectConfigCache()` was exported with a bare
`/** Exported for test use only. */` JSDoc and no `@returns {void}`
tag, breaking this repo's typed-JSDoc convention that every exported
function documents its return type. Cited precedent was
`src/tasks.js:3386-3387` (`/** @returns {void} */` immediately above
the void-returning `launchQueuedTasks`).

**Change** (`src/project-config.js:20-22`): collapsed the doc into a
single JSDoc block that carries both notes:

```js
/** Clears the per-path cache. Exported for test use only. @returns {void} */
export function _resetProjectConfigCache() {
  _projectConfigCache.clear();
}
```

### Important 2 — `package.json` `engines.node`

`package.json` declared `"engines": { "node": ">=16.9" }`, but the
newly added `smol-toml@1.7.1` dependency declares
`"engines": { "node": ">= 18" }` (`package-lock.json:1382-1384`,
confirmed). The repo's declared engine range silently overstated
compatibility — a Node 17 install would `npm install` successfully
and then fail at runtime the first time `project-config.js` is
imported.

**Change** (`package.json:25`): `">=16.9"` → `">=18"`. Nothing else
in `engines` touched.

### Minor — report commit hash

Updated the audit-trail `## Commit hash` section in this report from
`12fb0dd` to `a78547e` (the hash the controller actually applied
after the applied-and-committed step), with a parenthetical noting
the correction. Cheap one-line fix.

### Verification

Re-ran the three required gates under the same clean env as before
(`env -i HOME=... PATH=...`, `TASKFERRY_STATE_DIR`/`RUNTIME_DIR`/
`CACHE_DIR` redirected under `/tmp/taskferry-dev-check-gate-pc/`,
`npm_config_cache` redirected because `/home/jeremy/.npm/_cacache`
is on a read-only fs).

```
$ env -u TASKFERRY_CHILD node --test src/project-config.test.js
ℹ tests 10
ℹ pass 10
ℹ fail 0
ℹ duration_ms 91.79   (exit 0)
```

```
$ npm run test:unit
ℹ tests 981
ℹ pass 981
ℹ fail 0
ℹ duration_ms 14352.3   (exit 0)
```

```
$ npm run lint
> eslint .                (exit 0, no output)
```

```
$ npm run typecheck
> tsc --noEmit            (exit 0, no output)
```

All four commands exit 0 with no failures. The 981/981 number is
unchanged from round 1 — both fixes are doc/manifest changes that
don't alter runtime behavior, and the JSDoc change is observable to
the typecheck (which is clean) but doesn't add or remove any tests.

One incidental note worth recording for the rest of this 11-task
plan: between rounds the controller reset the worktree's
`node_modules` from a real directory (with `smol-toml` installed) back
to the symlink pointing at `/workspace/taskferry/node_modules` (the
main worktree's install, which does NOT have `smol-toml`). I had to
re-run `npm install smol-toml@^1.7.1` before the tests would load
the module. Future tasks in this plan that don't touch `node_modules`
won't be affected, but anything that exercises the new
`smol-toml`-using code path will need a similar `npm install` step
between rounds unless the dependency gets installed at the main
worktree's `node_modules` instead.
