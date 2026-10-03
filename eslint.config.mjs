import js from "@eslint/js";
import globals from "globals";
import sonarjs from "eslint-plugin-sonarjs";

// Taskferry is a Node ESM project: the AXI CLI entrypoint (src/cli.js),
// the daemon that owns task processes (src/daemon.js), its task manager
// (src/tasks.js), node:test test files, and standalone smoke-test
// scripts run directly with `node`. Everything runs under Node, so one
// language-options block covers the whole tree.

// The test/harness surface: node:test files plus the non-`.test.js`
// scaffolding they share (fixture builders, the smoke-test runners invoked
// directly with `node`, the eval harness). Named once because two separate
// blocks below carve it out, and the two lists drifting apart is how a rule
// silently stops covering production code.
const TEST_SURFACE = [
  "**/*.test.js",
  "**/*-test.js",
  "**/*.test-helpers.js",
  "src/smoke-test-support.js",
  "evals/**",
];

export default [
  { ignores: ["node_modules/**", ".claude/**", ".worktrees/**"] },

  js.configs.recommended,

  // Project-wide rule tuning: keep the high-signal bug catchers as errors
  // (no-undef, no-redeclare, no-const-assign, no-dupe-keys, no-unreachable…
  // — these block the commit).
  //
  // `no-unused-vars` sat at "warn" here on the theory that it was stylistic
  // noise. It isn't: an unused binding is usually a half-finished rename or
  // a dropped call, and the `^_` escape hatches below already cover the
  // deliberate cases. The tree has been clean of it for long enough that
  // promoting it to "error" cost zero fixes -- it now blocks the commit
  // instead of scrolling past in a warning list nobody reads.
  {
    rules: {
      "no-unused-vars": ["error", { caughtErrors: "none", argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // Maintainability rules: flag files/functions that have grown hard to
  // hold in your head (or in an agent's context window) in one pass.
  // Promoted to hard errors per issue #135, once the fix-up in
  // .superpowers/plans/2026-07-31-sonarjs-lint-fixup.md landed.
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

  // SonarJS bug/code-smell detectors, layered on top of the maintainability
  // rules above. Promoted to hard errors per issue #135, once the fix-up in
  // .superpowers/plans/2026-07-31-sonarjs-lint-fixup.md landed.
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
      // Pure style preference (parens around single-arg arrows), not a bug
      // or maintainability signal -- disabled rather than fixed.
      "sonarjs/arrow-function-convention": "off",
      // Wants a license header block on every file; this project doesn't
      // use one.
      "sonarjs/file-header": "off",
    },
  },

  // `sonarjs/publicly-writable-directories` and `sonarjs/no-os-command-from-path`
  // used to be off across the whole tree, justified as "taskferry's whole
  // job is sandboxing, so os.tmpdir() use and PATH-resolved spawns of
  // bwrap/git/opencode are expected here." Measured, that justification did
  // not describe the actual hits. Enabling both project-wide flags 23 files,
  // and the production sandbox path is not among them: src/sandbox.js,
  // src/executor.js and src/tasks.js trigger neither rule, because sandbox.js
  // spawns through a variable (`spawnSync(command, ...)`) that the rule
  // cannot resolve statically. What the rules actually catch is fixture
  // scaffolding -- tmpdir scratch directories and literal `git`/`npm` spawns
  // in tests and smoke-test harnesses.
  //
  // So the exemption is scoped to that surface instead of the whole tree,
  // which leaves both rules live on every production file. The single
  // production hit (`spawnSync("npm", ...)` in src/setup.js) carries its own
  // inline disable, where the reason is visible at the call site rather than
  // buried in this config.
  {
    files: TEST_SURFACE,
    rules: {
      "sonarjs/publicly-writable-directories": "off",
      "sonarjs/no-os-command-from-path": "off",
    },
  },

  // src/tasks.js was a user-approved exception to the whole-file max-lines
  // caps (originally judged a materially bigger architectural change than
  // the rest of the lint-fixup plan was worth -- see
  // .superpowers/.completed/plans/2026-07-31-sonarjs-lint-fixup.md for that
  // original call). That call has since been reversed (2026-08-08): the
  // split is judged worth doing after all -- see GitHub issue #30. This
  // override stays in place only until that split lands; remove it in the
  // same PR that splits createTaskManager()'s home file into multiple
  // modules. Every per-function rule (complexity, max-lines-per-function,
  // etc.) still applies and is clean on this file -- only the two
  // whole-file line-count rules are relaxed in the meantime.
  {
    files: ["src/tasks.js"],
    rules: {
      "max-lines": "off",
      "sonarjs/max-lines": "off",
    },
  },

  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },

  {
    files: ["**/*.test.js"],
    languageOptions: { globals: { ...globals.node } },
  },
];
