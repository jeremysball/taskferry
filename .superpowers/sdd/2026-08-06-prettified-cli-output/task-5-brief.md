### Task 5: Full verification pass

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the full check script**

Run: `npm run check`
Expected: PASS (syntax check on every tracked `.js` file, `eslint .`, `tsc --noEmit`). Fix any lint/type error surfaced here before proceeding — do not skip or silence.

- [ ] **Step 2: Run the full unit test suite one more time**

Run: `npm run test:unit`
Expected: PASS, 0 failures.

- [ ] **Step 3: Manually verify real TTY output for at least `doctor` and `list`**

These run against the live daemon this session already has running, so use a workspace/task set that actually exists rather than inventing one. From a real interactive terminal (not through a piped agent tool call, which is non-TTY and would just show the unchanged plain path):

```bash
node src/cli.js doctor
node src/cli.js list
node src/cli.js doctor --stats
node src/cli.js dispatch --help
```

Expected: `doctor` shows bold section labels and green/red glyphs; `list` shows grouped, colored status headers with aligned columns underneath; `doctor --stats` shows a trend line and an aligned by-model table; `--help` output still reads correctly under the fallback renderer (bold labels, comma-joined `commands`/`options`/`examples` lines).

If this session has no real TTY available to it, ask the user to run these four commands themselves and confirm the output looks right — do not claim this step is done without either running it in a real terminal or getting that confirmation.

- [ ] **Step 4: Confirm non-TTY output is unaffected by piping the same commands**

```bash
node src/cli.js doctor | cat
node src/cli.js list | cat
```

Expected: plain TOON text, no ANSI escapes, identical in shape to what these commands printed before this plan's changes.

- [ ] **Step 5: Report results**

Summarize: lint/typecheck status, unit test count and pass/fail, and what the manual TTY check showed (or who confirmed it, if delegated to the user).
