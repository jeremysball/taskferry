# Task 4 Report: Replace MCP With The AXI CLI

## What I Implemented

- Added strict parsing for every Task 4 command, including command-specific flags, defaults, required values, concise help, migration hints, and exit-code classification.
- Added the CLI entrypoint and daemon client routing for dispatch, cancel, wait, advisor, status, tail, summary, result, list, watch, context, doctor, and the no-argument workspace view.
- Added TOON output for data, help, and errors. Operational errors use exit code 1. Usage errors use exit code 2. Successful no-ops use exit code 0.
- Normalized workspace paths with `fs.realpathSync` and rejected missing paths and file paths before connecting to the daemon.
- Added four-field list projections, explicit empty-workspace output, contextual next actions, and CLI-side `leanStatus` and `leanResult` projections migrated from `src/server.js`.
- Added CLI-boundary migration for daemon-era hint strings while preserving explicit migration errors for retired MCP tool names.
- Repointed the package entrypoint and binary to `src/cli.js`, added the forward package export to `src/opencode-plugin.js`, removed MCP and `zod` dependencies, retained TOON, and regenerated the lockfile.
- Deleted `src/server.js` and `src/server.test.js`.

## Tests

TDD evidence:

- RED: `node --test src/args.test.js src/cli.test.js` failed because the new CLI modules did not exist.
- GREEN: `node --test src/args.test.js src/cli.test.js` passed with 19 tests.

Final verification:

- `node --test src/args.test.js src/cli.test.js`: 19 passed.
- `npm test`: 154 passed.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `node --check` for all four new runtime files: passed.
- `git diff --check`: passed.
- Real CLI-to-daemon smoke check for `list` and `doctor --full`: passed.
- `npm install`: completed with no vulnerabilities.

## Files Changed

- Added `src/cli.js`.
- Added `src/args.js`.
- Added `src/commands.js`.
- Added `src/output.js`.
- Added `src/args.test.js`.
- Added `src/cli.test.js`.
- Deleted `src/server.js`.
- Deleted `src/server.test.js`.
- Modified `package.json`.
- Modified `package-lock.json`.

## Self-Review

No unresolved in-scope code findings remain. The implementation validates file-valued workspace paths, rejects empty option values, rejects trailing global arguments, and rewrites legacy daemon hints at the CLI boundary.

## Concerns

- `TASKFERRY_CHILD=1` still requires the child-environment change in protected `src/tasks.js`, which this task explicitly forbids modifying. Task 7 owns that change.
- Legacy MCP smoke scripts and historical documentation remain outside this task's allowed file list. The package test integration command no longer invokes those scripts. Later cleanup must remove or migrate them.
- `watch --summaries` and `summary --style activity` are accepted by the Task 4 CLI contract, but their full activity-summary behavior belongs to the Task 5 event and activity work. The current daemon protocol cannot accept a summaries subscription parameter.
- The `src/opencode-plugin.js` package export intentionally points to the forward-reference path required by the brief. Task 7 creates that file.
