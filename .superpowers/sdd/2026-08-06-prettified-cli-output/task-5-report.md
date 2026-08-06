### Task 5: Full verification pass

**Status:** DONE

**Step 1 — `npm run check`:** PASS. Syntax check on every tracked `.js`
file, `eslint .`, `tsc --noEmit` — all silent/clean, no output.

**Step 2 — `npm run test:unit`:** PASS, 1041/1041 tests, 0 failures, 0
cancelled, 0 skipped (165 suites, 16.2s).

**Step 3 — manual real-TTY verification:** No interactive terminal was
available directly, so a real PTY was manufactured with `script -qec
"<cmd>" /tmp/...` (confirmed first with `process.stdout.isTTY` — `script`
reports `true`, unlike a plain piped Bash capture which reports
`undefined`). Ran all four commands under that real PTY:

- `node src/cli.js doctor`: bold section labels (`Daemon`, `Claude
  integration`, `MCP isolation`) and green `✓` glyphs. Matches expected.
- `node src/cli.js list`: grouped, colored status headers (yellow
  `running`, green `done`, red `crashed`/`cancelled`, plain `unknown`)
  with aligned columns underneath. Matches expected.
- `node src/cli.js doctor --stats`: red "worsening" trend line plus an
  aligned by-model table with dimmed column headers. Matches expected.
- `node src/cli.js dispatch --help`: bold labels (`command`, `usage`,
  `description`, `options`, `examples`) under the fallback renderer,
  comma-joined `examples` line reads correctly. Matches expected.

**Step 4 — non-TTY (piped) confirmation:**

- `node src/cli.js doctor | cat`: plain `key: value` TOON text, zero
  ANSI escapes.
- `node src/cli.js list | cat`: plain TOON (`counts:` block, `tasks[N]:`
  list), zero ANSI escapes.

Both byte-identical in shape to the pre-plan TOON output (verified against
`docs/sourcemap.md`'s documented non-TTY guarantee and the Global
Constraint requiring `writeToon()`'s non-TTY branch to stay a plain
`encode()` call).

**Concerns:** None. All five steps pass; no code changes were needed —
this was a verification-only task.
