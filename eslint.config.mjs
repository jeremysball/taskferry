import js from "@eslint/js";
import globals from "globals";

// Taskferry is a Node ESM project: an MCP server (src/server.js), its task
// manager (src/tasks.js), node:test test files, and standalone smoke-test
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
