# Strict sonarjs lint checks with a warning-count ratchet

## Goal

Bring taskferry's lint setup in line with token-burn-dashboard's: add
`eslint-plugin-sonarjs` (code-smell/bug-pattern rules) as warnings, and add a
baseline-ratchet mechanism so CI and local commits fail only when the number
of warnings in any `file|rule` bucket *increases* from a committed baseline.
Existing violations don't block anything; new ones can't be introduced
without a deliberate baseline update.

## Non-goals

- Turning any sonarjs rule into a hard error.
- Retroactively fixing existing sonarjs violations.
- Changing taskferry's existing complexity/max-lines/max-params thresholds
  (15/400/5/80) — those stay as-is; sonarjs is additive.

## Components

### 1. `eslint.config.mjs` — sonarjs plugin block

Add `eslint-plugin-sonarjs` as a devDependency. Add a new config block,
ported from token-burn-dashboard's pattern:

```js
import sonarjs from "eslint-plugin-sonarjs";

const sonarjsRecommendedWarnings = Object.fromEntries(
  Object.entries(sonarjs.configs.recommended.rules).map(([ruleId, setting]) => {
    if (setting === "off" || setting === 0) return [ruleId, setting];
    return [ruleId, Array.isArray(setting) ? ["warn", ...setting.slice(1)] : "warn"];
  })
);
```

...applied in a block scoped to `files: ["**/*.js"], ignores: ["**/*.test.js", "**/*-test.js"]`
(reusing taskferry's existing test-exclusion pattern — no separate test-file
rule-off block needed, since taskferry doesn't turn off maintainability rules
for tests today either).

### 2. `scripts/lint-baseline.mjs` — ported to Node

Same logic as token-burn-dashboard's `scripts/lint-baseline.mjs`
(`inspectReport`, `compareReport`, `getPolicyHash`, `validateBaseline`), with
these Bun→Node adaptations:

- Policy files hashed: `eslint.config.mjs` + `package-lock.json` (taskferry's
  lockfile-equivalent of the dashboard's `bun.lock`).
- Entrypoint guard: `if (import.meta.url === \`file://${process.argv[1]}\`)` instead
  of `import.meta.main`.
- No other behavior change: still buckets warnings as `path/to/file.js|rule-id`,
  still treats any `severity === 2` (error) or `fatal === true` message as an
  unconditional violation regardless of baseline.

Baseline file: `config/eslint-baseline.json`, format unchanged
(`{ policyHash, warnings: { "bucket": count } }`).

### 3. `package.json` scripts

```json
"lint": "eslint .",
"lint:json": "eslint . --format json --output-file .lint-report.json",
"lint:baseline": "npm run lint:json && node scripts/lint-baseline.mjs .lint-report.json",
"lint:baseline:update": "npm run lint:json && node scripts/lint-baseline.mjs --update .lint-report.json",
```

`npm run check` (and the CI `lint` leg) changes from `eslint .` to
`npm run lint:baseline`, so `npm run lint` alone still gives a plain
human-readable eslint run (useful when iterating locally), while `check` and
CI enforce the ratchet.

### 4. CI (`.github/workflows/check.yml`)

The `lint` leg's step changes from `run: npm run lint` to
`run: npm run lint:baseline`. No new matrix leg.

### 5. `.githooks/pre-commit`

After the existing `eslint . && tsc --noEmit` step succeeds against the
staged tree, add: `npm run lint:json -- ... && node scripts/lint-baseline.mjs .lint-report.json`
run from the same `$tmp/tree` staged checkout, so a new sonarjs warning
blocks the commit exactly like a lint error does today. Failure message
points at `npm run lint:baseline:update` as the escape hatch for a
deliberate addition.

### 6. Seeding the baseline

After the plugin/config land, run `npm run lint:baseline:update` once against
current `main` and commit the resulting `config/eslint-baseline.json` in the
same PR — this captures today's warning counts as the floor, so the ratchet
only bites on regressions from this point forward.

### 7. `.gitignore`

Add `.lint-report.json` (ephemeral eslint JSON output, regenerated each run).

## Testing

- `npm run lint:baseline` passes on a clean checkout right after seeding.
- Manually introduce a new sonarjs warning (e.g. duplicate a string 3+ times)
  in a scratch file, confirm `npm run lint:baseline` fails with
  `new warning bucket: ...` and pre-commit blocks the commit.
- Confirm `npm run lint:baseline:update` regenerates the baseline and clears
  the failure.
- Confirm a hard eslint error (e.g. `no-undef`) still fails immediately
  regardless of baseline state (unconditional violation, not baseline-gated).
