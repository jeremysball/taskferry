import js from "@eslint/js";
import globals from "globals";
import sonarjs from "eslint-plugin-sonarjs";

// Taskferry is a Node ESM project: the AXI CLI entrypoint (src/cli.js),
// the daemon that owns task processes (src/daemon.js), its task manager
// (src/tasks.js), node:test test files, and standalone smoke-test
// scripts run directly with `node`. Everything runs under Node, so one
// language-options block covers the whole tree.
export default [
  { ignores: ["node_modules/**", ".claude/**", ".worktrees/**"] },

  js.configs.recommended,

  // Project-wide rule tuning: keep the high-signal bug catchers as errors
  // (no-undef, no-redeclare, no-const-assign, no-dupe-keys, no-unreachable…
  // — these block the commit), demote stylistic noise to warnings so it
  // informs without halting work.
  {
    rules: {
      "no-unused-vars": ["warn", { caughtErrors: "none", argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
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
      // Taskferry's whole job is sandboxing: os.tmpdir()/`/tmp` use and
      // PATH-resolved spawns of bwrap/git/opencode/pi are expected,
      // reviewed patterns here, not accidental exposure -- disabled rather
      // than generating permanent noise no fix can resolve.
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

  // taskferry#510 regression coverage keeps all dispatch rollback cases in one
  // file for atomic verification; the suite has grown past sonarjs' 1000-line
  // soft cap but remains the right place for these tightly-coupled cases.
  {
    files: ["src/tasks.dispatch.test.js"],
    rules: {
      "sonarjs/max-lines": "off",
      "sonarjs/max-lines-per-function": "off",
      "sonarjs/no-duplicate-string": "off",
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
