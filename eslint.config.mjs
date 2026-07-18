import js from "@eslint/js";
import globals from "globals";

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
  // Warnings, not errors -- they inform without blocking a commit, since
  // fixing them usually means a real refactor, not a one-line change.
  {
    files: ["**/*.js"],
    ignores: ["**/*.test.js", "**/*-test.js"],
    rules: {
      complexity: ["warn", 15],
      "max-depth": ["warn", 4],
      "max-params": ["warn", 5],
      "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
      "max-lines": ["warn", { max: 400, skipBlankLines: true, skipComments: true }],
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
