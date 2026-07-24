# Sonarjs Lint Ratchet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `eslint-plugin-sonarjs` to taskferry as warnings, plus a baseline-ratchet script that fails `npm run lint` (and therefore CI's existing `lint` leg and the pre-commit hook) only when a `file|rule` warning bucket count increases versus a committed baseline — never on pre-existing warnings.

**Architecture:** A new sonarjs config block in `eslint.config.mjs` (rules forced to `'warn'`, scoped like taskferry's existing maintainability-rules block). A Node port of token-burn-dashboard's `scripts/lint-baseline.mjs` reading `config/eslint-baseline.json`. `npm run lint` becomes a two-step pipeline (`eslint --format json` then the baseline compare); a separate `npm run lint:raw` keeps the old plain-eslint behavior for local iteration. The pre-commit hook runs the same baseline check against the staged tree after its existing eslint/tsc step.

**Tech Stack:** Node.js (ESM, `type: "module"` in package.json), ESLint 10, `eslint-plugin-sonarjs`, `node:test`.

## Global Constraints

- Sonarjs rules must be warnings, never errors (spec: "Turning any sonarjs rule into a hard error" is a non-goal).
- Do not change taskferry's existing complexity/max-lines/max-params/max-depth thresholds.
- Baseline ratchet must not block on pre-existing violations — only on `count > previousCount` for a bucket, or a brand-new bucket.
- A hard eslint error (severity 2) or fatal parse error must always fail, regardless of baseline state.
- `.lint-report.json` is ephemeral output — must be gitignored, never committed.
- No hardcoded absolute paths in any new script.

---

### Task 1: Add eslint-plugin-sonarjs and wire it into eslint.config.mjs

**Files:**
- Modify: `package.json` (devDependencies, add `lint:raw` script placeholder — full script rewiring happens in Task 2)
- Modify: `eslint.config.mjs`
- Test: manual (`npx eslint .` run showing sonarjs warnings appear)

**Interfaces:**
- Produces: `eslint.config.mjs` exports a config array whose sonarjs block is scoped to `files: ["**/*.js"], ignores: ["**/*.test.js", "**/*-test.js"]` (same ignore pattern as the existing maintainability block at line 31), with every `sonarjs.configs.recommended.rules` entry forced to `"warn"` (or left `"off"` if it already was).

- [ ] **Step 1: Install the dependency**

Run: `cd /workspace/taskferry && npm install --save-dev eslint-plugin-sonarjs`

Expected: `package.json`'s `devDependencies` gains `"eslint-plugin-sonarjs": "^<version>"` and `package-lock.json` updates. Confirm with:

```bash
node -e "console.log(require('./package.json').devDependencies['eslint-plugin-sonarjs'])"
```

Expected output: a version string (not `undefined`).

- [ ] **Step 2: Add the sonarjs block to eslint.config.mjs**

Read the current file first (`eslint.config.mjs` is 55 lines). Add this import at the top alongside the existing `js`/`globals` imports:

```js
import sonarjs from "eslint-plugin-sonarjs";
```

Then, directly above the `export default [` array's closing test-file block (i.e. after the maintainability-rules block that ends around line 39, before the `**/*.js` languageOptions block), insert:

```js
  // sonarjs: cross-cutting bug-pattern/code-smell rules (duplicate strings,
  // identical branches, cognitive complexity, etc). Forced to warnings --
  // see scripts/lint-baseline.mjs for how new warnings get caught without
  // blocking on the ones that already exist in the tree.
  {
    files: ["**/*.js"],
    ignores: ["**/*.test.js", "**/*-test.js"],
    plugins: { sonarjs },
    rules: Object.fromEntries(
      Object.entries(sonarjs.configs.recommended.rules).map(([ruleId, setting]) => {
        if (setting === "off" || setting === 0) return [ruleId, setting];
        return [ruleId, Array.isArray(setting) ? ["warn", ...setting.slice(1)] : "warn"];
      })
    ),
  },
```

- [ ] **Step 3: Run eslint to confirm it loads and produces sonarjs warnings**

Run: `npx eslint . 2>&1 | tail -30`

Expected: exits with output showing at least one `sonarjs/*` warning somewhere in the tree (taskferry's `src/` is large enough that `sonarjs/no-duplicate-string` or similar will fire), and no fatal "Cannot find module 'eslint-plugin-sonarjs'" or config-parsing error. If zero sonarjs warnings appear, spot-check by temporarily adding a duplicated string literal 3x in a scratch file, re-running, then removing it — confirms the plugin is actually active before moving on.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json eslint.config.mjs
git commit -m "feat(lint): add eslint-plugin-sonarjs as warnings"
```

---

### Task 2: Port the baseline-ratchet script and wire it into npm scripts

**Files:**
- Create: `scripts/lint-baseline.mjs`
- Create: `scripts/lint-baseline.test.js`
- Modify: `package.json` (scripts block)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing from Task 1 directly (works against any eslint JSON report file).
- Produces: `getPolicyHash(): string`, `compareReport(report: Array, baseline: {policyHash, warnings}): {ok: boolean, violations: string[]}` — both exported for the test file to import. CLI entrypoint reads `process.argv` per the usage below.

- [ ] **Step 1: Write scripts/lint-baseline.mjs**

```js
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const baselinePath = "config/eslint-baseline.json";
const policyFiles = ["eslint.config.mjs", "package-lock.json"];

export function getPolicyHash() {
  const hash = createHash("sha256");
  for (const file of policyFiles) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(resolve(file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateBaseline(baseline) {
  if (!isObject(baseline) || typeof baseline.policyHash !== "string" || !isObject(baseline.warnings)) {
    return "malformed lint baseline";
  }
  for (const [bucket, count] of Object.entries(baseline.warnings)) {
    if (!bucket || !Number.isSafeInteger(count) || count < 0) {
      return "malformed lint baseline";
    }
  }
  return null;
}

function relativeFilePath(filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  const path = relative(process.cwd(), resolve(filePath));
  if (!path || path === ".." || path.startsWith(`..${sep}`)) return null;
  return path.split(sep).join("/");
}

function inspectReport(report) {
  if (!Array.isArray(report)) {
    return { violations: ["malformed lint report"], warnings: {} };
  }

  const violations = [];
  const warnings = {};

  for (const fileResult of report) {
    if (!isObject(fileResult) || !Array.isArray(fileResult.messages)) {
      violations.push("malformed lint report");
      continue;
    }

    const filePath = relativeFilePath(fileResult.filePath);
    if (!filePath) {
      violations.push("malformed lint report");
      continue;
    }

    for (const message of fileResult.messages) {
      if (!isObject(message) || !Number.isInteger(message.severity)) {
        violations.push("malformed lint report");
        continue;
      }

      const ruleId = typeof message.ruleId === "string" && message.ruleId ? message.ruleId : "unknown";
      if (message.fatal === true) {
        violations.push(`fatal lint message: ${filePath}`);
      }
      if (message.severity === 2) {
        violations.push(`lint error: ${filePath}|${ruleId}`);
      } else if (message.severity === 1) {
        if (ruleId === "unknown") {
          violations.push("malformed lint report");
          continue;
        }
        const bucket = `${filePath}|${ruleId}`;
        warnings[bucket] = (warnings[bucket] ?? 0) + 1;
      } else if (message.severity !== 0) {
        violations.push("malformed lint report");
      }
    }
  }

  return { violations, warnings };
}

export function compareReport(report, baseline) {
  const comparison = inspectReport(report);
  const baselineError = validateBaseline(baseline);

  if (baselineError) {
    comparison.violations.push(baselineError);
  } else {
    if (baseline.policyHash !== getPolicyHash()) {
      comparison.violations.push("lint policy hash changed");
    }

    for (const [bucket, count] of Object.entries(comparison.warnings)) {
      const previousCount = baseline.warnings[bucket];
      if (previousCount === undefined) {
        comparison.violations.push(`new warning bucket: ${bucket}`);
      } else if (count > previousCount) {
        comparison.violations.push(`increased warning bucket: ${bucket} (${previousCount} -> ${count})`);
      }
    }
  }

  return { ok: comparison.violations.length === 0, violations: comparison.violations };
}

function parseReport(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`unable to read lint report ${path}: ${error.message}`, { cause: error });
  }
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (error) {
    throw new Error(`unable to read lint baseline ${baselinePath}: ${error.message}`, { cause: error });
  }
}

function run() {
  const args = process.argv.slice(2);
  const update = args[0] === "--update";
  const reportPath = update ? args[1] : args[0];
  if (!reportPath || args.length !== (update ? 2 : 1)) {
    throw new Error("usage: node scripts/lint-baseline.mjs [--update] <eslint-json-report>");
  }

  const report = parseReport(reportPath);
  if (update) {
    const inspection = inspectReport(report);
    if (inspection.violations.length > 0) {
      throw new Error(inspection.violations.join("\n"));
    }
    const warnings = Object.fromEntries(
      Object.entries(inspection.warnings).sort(([left], [right]) => left.localeCompare(right))
    );
    writeFileSync(baselinePath, `${JSON.stringify({ policyHash: getPolicyHash(), warnings }, null, 2)}\n`);
    return;
  }

  const result = compareReport(report, readBaseline());
  if (!result.ok) {
    throw new Error(result.violations.join("\n"));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 2: Write the failing test first — scripts/lint-baseline.test.js**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareReport, getPolicyHash } from "./lint-baseline.mjs";

test("compareReport passes when warnings match baseline exactly", () => {
  const baseline = { policyHash: getPolicyHash(), warnings: { "src/foo.js|sonarjs/no-duplicate-string": 2 } };
  const report = [
    {
      filePath: `${process.cwd()}/src/foo.js`,
      messages: [
        { severity: 1, ruleId: "sonarjs/no-duplicate-string" },
        { severity: 1, ruleId: "sonarjs/no-duplicate-string" },
      ],
    },
  ];
  const result = compareReport(report, baseline);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("compareReport fails when a bucket's warning count increases", () => {
  const baseline = { policyHash: getPolicyHash(), warnings: { "src/foo.js|sonarjs/no-duplicate-string": 1 } };
  const report = [
    {
      filePath: `${process.cwd()}/src/foo.js`,
      messages: [
        { severity: 1, ruleId: "sonarjs/no-duplicate-string" },
        { severity: 1, ruleId: "sonarjs/no-duplicate-string" },
      ],
    },
  ];
  const result = compareReport(report, baseline);
  assert.equal(result.ok, false);
  assert.match(result.violations[0], /increased warning bucket/);
});

test("compareReport fails on a brand-new warning bucket not in baseline", () => {
  const baseline = { policyHash: getPolicyHash(), warnings: {} };
  const report = [
    {
      filePath: `${process.cwd()}/src/foo.js`,
      messages: [{ severity: 1, ruleId: "sonarjs/no-identical-functions" }],
    },
  ];
  const result = compareReport(report, baseline);
  assert.equal(result.ok, false);
  assert.match(result.violations[0], /new warning bucket/);
});

test("compareReport always fails on a severity-2 error, baseline notwithstanding", () => {
  const baseline = { policyHash: getPolicyHash(), warnings: {} };
  const report = [
    {
      filePath: `${process.cwd()}/src/foo.js`,
      messages: [{ severity: 2, ruleId: "no-undef" }],
    },
  ];
  const result = compareReport(report, baseline);
  assert.equal(result.ok, false);
  assert.match(result.violations[0], /lint error/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test scripts/lint-baseline.test.js`

Expected: FAIL — `lint-baseline.mjs` doesn't exist yet, or (if Step 1 was already saved) the test should actually pass since the implementation is already written above. If Step 1's file is already in place, instead verify the test fails first by temporarily renaming `scripts/lint-baseline.mjs` aside, confirming a "Cannot find module" failure, then restoring it. This keeps the TDD red/green cycle honest even though this plan writes the implementation and test in the same task.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/lint-baseline.test.js`

Expected: all 4 tests pass, e.g. `# pass 4`, `# fail 0`.

- [ ] **Step 5: Add package.json scripts**

Modify the `"scripts"` block: rename the existing `"lint": "eslint ."` entry to `"lint:raw": "eslint ."`, and add:

```json
"lint:json": "eslint . --format json --output-file .lint-report.json",
"lint": "npm run lint:json && node scripts/lint-baseline.mjs .lint-report.json",
"lint:baseline:update": "npm run lint:json && node scripts/lint-baseline.mjs --update .lint-report.json",
"test:scripts": "node --test scripts/lint-baseline.test.js",
```

Also update the top-level `"test"` script to include the new suite:
`"test": "npm run test:unit && npm run test:scripts"`.

- [ ] **Step 6: Gitignore the ephemeral report**

Add to `.gitignore` (after the `.claude/` line):

```
.lint-report.json
```

- [ ] **Step 7: Seed the baseline**

Run: `npm run lint:baseline:update`

Expected: creates `config/eslint-baseline.json`. Confirm it's valid JSON with a `policyHash` string and a non-empty `warnings` object (taskferry's tree is large enough that at least the existing `no-unused-vars`/maintainability warnings populate it, plus whatever sonarjs found in Task 1 Step 3):

```bash
node -e "const b = require('./config/eslint-baseline.json'); console.log(typeof b.policyHash, Object.keys(b.warnings).length)"
```

Expected output: `string <N>` where N > 0.

- [ ] **Step 8: Verify the ratchet passes clean and catches a regression**

Run: `npm run lint`

Expected: exits 0 (matches the just-seeded baseline).

Then temporarily add a throwaway duplicated-string block to any `src/*.js` file to trigger a new/increased sonarjs bucket, run `npm run lint` again, expect a non-zero exit with `new warning bucket:` or `increased warning bucket:` in the output, then revert the throwaway change (`git checkout -- <file>`).

- [ ] **Step 9: Commit**

```bash
git add scripts/lint-baseline.mjs scripts/lint-baseline.test.js package.json .gitignore config/eslint-baseline.json
git commit -m "feat(lint): add baseline-ratchet script and wire into npm run lint"
```

---

### Task 3: Enforce the ratchet in the pre-commit hook

**Files:**
- Modify: `.githooks/pre-commit`

**Interfaces:**
- Consumes: `npm run lint:json` / `node scripts/lint-baseline.mjs` from Task 2, run against the same staged-tree checkout (`$tmp/tree`) the hook already builds for eslint/tsc.

- [ ] **Step 1: Extend the eslint/tsc block in .githooks/pre-commit**

The current block (inside `if [ -x "$repo/node_modules/.bin/eslint" ]; then ... fi`) runs:

```sh
    cd "$tmp/tree" || exit 1
    ./node_modules/.bin/eslint . && ./node_modules/.bin/tsc --noEmit
```

Change it to also run the baseline check after eslint/tsc succeed, and point the failure message at the update escape hatch:

```sh
    cd "$tmp/tree" || exit 1
    ./node_modules/.bin/eslint . --format json --output-file .lint-report.json
    eslint_status=$?
    if [ "$eslint_status" -ne 0 ] && [ ! -s .lint-report.json ]; then
      # eslint itself crashed (not just reported errors) — no report to check.
      exit 1
    fi
    node scripts/lint-baseline.mjs .lint-report.json || {
      echo "New sonarjs/lint warnings introduced. Run 'npm run lint:baseline:update' if intentional." >&2
      exit 1
    }
    ./node_modules/.bin/tsc --noEmit
```

Note: `eslint --format json` still writes the report file even when eslint finds errors (exit code 1), so the baseline script sees those as `severity === 2` violations and fails independently of `$eslint_status`. Keep the `$eslint_status`/`-s .lint-report.json` guard only to catch a genuine eslint crash (config error, missing plugin) where no report is produced at all.

- [ ] **Step 2: Manually verify the hook end-to-end**

Stage a throwaway change that introduces a new sonarjs warning (e.g. a duplicated string literal), run:

```bash
git add -A && git commit -m "test: trigger hook" --no-verify=false
```

Expected: the commit is blocked with the "New sonarjs/lint warnings introduced" message. Then `git reset` and discard the throwaway change, confirm a clean commit of real work still succeeds.

- [ ] **Step 3: Commit**

```bash
git add .githooks/pre-commit
git commit -m "fix(hooks): enforce lint baseline ratchet in pre-commit"
```

---

### Task 4: Update sourcemap documentation

**Files:**
- Modify: `docs/sourcemap.md`

**Interfaces:** none (documentation-only).

- [ ] **Step 1: Add a short section**

Read `docs/sourcemap.md` first to find where lint/quality tooling is currently documented (search for "eslint" or "lint"), and add 3-5 lines next to it describing: `eslint-plugin-sonarjs` runs as warnings; `npm run lint` enforces a baseline ratchet via `scripts/lint-baseline.mjs` + `config/eslint-baseline.json` (new warnings/increases fail, pre-existing ones don't); `npm run lint:baseline:update` is the intentional-change escape hatch; `npm run lint:raw` gives a plain eslint run with no ratchet.

- [ ] **Step 2: Commit**

```bash
git add docs/sourcemap.md
git commit -m "docs: document the sonarjs lint ratchet"
```
