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

  // SonarJS bug/code-smell detectors, layered on top of the maintainability
  // rules above. Also warnings for now: see issue #135 for the plan to
  // promote both rule sets to errors once the backlog they report is clear.
  {
    files: ["**/*.js"],
    plugins: { sonarjs },
    rules: {
      ...Object.fromEntries(
        Object.entries(sonarjs.configs.recommended.rules).map(([name, value]) => [
          name,
          Array.isArray(value) ? ["warn", ...value.slice(1)] : "warn",
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
