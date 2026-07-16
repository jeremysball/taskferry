# Task 6 Report: Add Claude Code Integration

## What I Implemented

- Added the `taskferry` Claude Code plugin manifest and marketplace entry.
- Added the exact task activity monitor command from the brief.
- Added a `SessionStart` hook scoped to startup, clear, and compact events.
- Made the hook request current-workspace TOON context from the AXI CLI and wrap it in Claude's JSON `hookSpecificOutput.additionalContext` shape.
- Added one actionable JSON error when `taskferry` is missing from `PATH`.
- Bundled a complete AXI CLI worker-dispatch skill with the required `subagent-driven-development` contract.
- Added integration tests for manifests, hook payloads, workspace scoping, monitor sanitization, missing-binary guidance, and skill contents.

## TDD Evidence

- RED: `node --test src/integrations.test.js` initially failed 3 tests with missing-file `ENOENT` errors for the plugin manifest, hook, and skill.
- RED: after adding the hook JSON-output regression test, it failed with `SyntaxError: Unexpected token 'd'` because the hook emitted raw TOON context instead of JSON.
- GREEN: `node --test src/integrations.test.js` passed all 7 tests after the plugin files and JSON wrapper were implemented.

## Final Verification

- `node --test src/integrations.test.js`: 7 passed.
- `claude plugin validate ./integrations/claude --strict`: passed.
- `claude plugin validate ./.claude-plugin/marketplace.json --strict`: passed.
- `npm test`: 154 passed.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `git diff --check`: clean.

The existing `npm test` script enumerates the prior unit-test files and does not include the new integration test. The integration test was run explicitly as required by the brief.

## Files Changed

- `.claude-plugin/marketplace.json`
- `integrations/claude/.claude-plugin/plugin.json`
- `integrations/claude/hooks/hooks.json`
- `integrations/claude/monitors/monitors.json`
- `integrations/claude/skills/taskferry/SKILL.md`
- `src/integrations.test.js`
- `.superpowers/sdd/task-6-report.md`

## Self-Review

- The monitor command matches the brief exactly.
- The plugin registers no commands, agents, MCP servers, or channels.
- The hook emits valid Claude JSON and keeps the CLI's TOON output inside `additionalContext`.
- The hook passes `CLAUDE_PROJECT_DIR` to the CLI and does not expose other workspace state.
- Monitor activity remains one line after newline sanitization.
- The skill uses AXI CLI commands, contains no MCP instructions, and does not present Taskferry as an alternative to `subagent-driven-development`.
- No files under `src/` other than `src/integrations.test.js` were modified.

## Concerns

- The canonical `skills/taskferry/SKILL.md` and `scripts/generate-skill.js` are intentionally absent. Task 6 writes the Claude copy directly; Task 8 owns the canonical source and generator.
- Claude's `claude plugin validate` command was available and passed with `--strict`. No validator concerns remain.

## Controller Addendum (post-review fixes)

Two review passes found and fixed real bugs in the SessionStart hook, not present in the numbers above:

- Review pass 1 found the `&&` short-circuit dropped all hook output when an installed `taskferry` exited nonzero. Fixed in commit `59f0f14`, adding one regression test.
- Review pass 2 found the directory argument's quoting decoded to a literal backslash-quote instead of a real shell quote, so `taskferry` received literal quote characters and paths with spaces still split into multiple arguments. Fixed in commit `41f9698`, adding one regression test and hardening the missing-binary test to actually execute that branch.
- The integration suite now has 9 tests (not 7 as reported above), all passing: `node --test src/integrations.test.js`.
