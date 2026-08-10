# Task 8 Report: Documentation sweep

## Summary

Brought the docs in line with the landed Tasks 1-7 behavior: `--model`
required on a fresh dispatch, and an omitted `--variant` resolving to the
model's highest supported thinking level via `defaultVariant` (default
`highest`).

## Files touched

- **`docs/cli-reference.md`** — Replaced `dispatch`'s `--model <id>` row
  (line 57) with the required-unless-resuming text and `dispatch`'s
  `--variant <name>` row (line 58) with the full resolution-chain text
  (`--session-id` resume wins, then `defaultVariant`, default `highest`;
  pi `highest` = `--thinking max`, opencode = highest cached variant or no
  flag). Replaced `advisor`'s `--variant` row (line 137) with the
  shortened same-chain text. `advisor`'s `--model` row (line 135) already
  read "Required, no default; the caller picks the advisor" — left as-is
  per the brief's instruction.
- **`docs/config.md`** — Added the `defaultVariant` config-table row after
  `defaultExecutor` (line 57): `TASKFERRY_DEFAULT_VARIANT`, values
  `highest | off | minimal | low | medium | high | xhigh | max`, default
  `highest`. Verified against `KNOWN_VARIANT_LEVELS` in `src/config.js:56`.
- **`docs/daemon.md`** — Appended the two "Things that look like bugs but
  aren't" entries (pi `variant: "max"` record vs provider clamp; the
  24h-refresh opencode variants cache and missing-from-cache = no flag)
  verbatim from the brief, after the real last bullet (the
  `withFileLockAsync` contention entry ending at line 445, EOF). The
  brief's line reference (375) was just the section header; the list had
  grown by seven bullets since the plan was written. Both entries verified
  against the code: `src/variants.js` (pi `highest` → `max`), pi's
  `clampThinkingLevel` behavior, `src/variants-cache.js` (24h TTL,
  `<cacheDir>/opencode-variants.json`, `null` on any read failure → no
  flag, refresh never on the dispatch path), and
  `src/tasks.js:4598` (24h refresh cadence).
- **`src/command-specs.js`** — `dispatch` entry's `--model <id>` option
  text changed to "required unless resuming via --session-id with a
  matching prior task" and `--variant <name>` to "optional; defaults to the
  model's highest supported thinking level (see defaultVariant in
  docs/config.md)" — exactly per the brief.
- **`skills/using-taskferry/SKILL.md`** (canonical) — Worker Contract
  bullet now states `--model` is required for a fresh dispatch (only a
  `--session-id` resume may inherit the prior task's model) and that an
  omitted `--variant` means "that model's hardest thinking level"; the
  Choosing a Model bullet no longer claims an omitted `--model` falls back
  to a default.
- **`integrations/claude/skills/using-taskferry/SKILL.md`** and
  **`integrations/codex/skills/using-taskferry/SKILL.md`** — Regenerated
  via `npm run skill:generate`; identical to the canonical edit.
- **`README.md`** — Added `--model opencode-go/minimax-m3` to both example
  `taskferry dispatch` invocations (intro block, line 16, and the "Then
  dispatch" bash block, line 104) that omitted it.
- **`.superpowers/sdd/2026-08-09-highest-thinking-default/task-8-brief.md`** —
  Included in the commit (repo convention: briefs/reports ride along with
  the task commit, per git history for tasks 5-7).

## Verification

`npm run check` — declared in `.taskferry.toml`.

- Initial run failed 6 tests, all **environment leakage from this session,
  not my edits**: this ferry session exports `TASKFERRY_TASK_ID`,
  `TASKFERRY_CHILD`, `TASKFERRY_SOCKET_PATH`, `TASKFERRY_STATE_DIR`,
  `TASKFERRY_RUNTIME_DIR`, `XDG_DATA_HOME`, and `XDG_CONFIG_HOME` (the
  last two pointing at taskferry's own opencode-data dirs), and the test
  suite assumes none of those are set. The failures (`TASKFERRY_TASK_ID is
  absent from summary spawns`, the three opencode auth/data-home sandbox
  tests, `leaves XDG_DATA_HOME untouched`, and the daemon-client symlink
  guard test whose subprocess connected to the session's live daemon) are
  ambient-env artifacts. Proof it's not my change: a stash-clean run on
  the same tree failed 5 of the same tests (all but the symlink one, whose
  outcome depends on whether the real daemon is up).
- Final run with a scrubbed env
  (`env -u TASKFERRY_SOCKET_PATH -u TASKFERRY_STATE_DIR -u
  TASKFERRY_RUNTIME_DIR -u TASKFERRY_TASK_ID -u TASKFERRY_CHILD -u
  TASKFERRY_CACHE_DIR -u XDG_DATA_HOME -u XDG_CONFIG_HOME npm run check`):
  **exit 0, 1205/1205 tests pass, 0 fail.** (This task touches no source
  logic, so nothing else could have changed the result.)

## Concerns

- Line-number drift: `docs/daemon.md`'s section start (375) was correct
  but the list's real end had grown to line 445 — found with the mandated
  `rg -n "## Things that look like bugs but aren't" -A 200` and appended
  after the true last bullet. `docs/cli-reference.md` line numbers 57/58
  and 135/137 were still accurate (re-checked with `rg` before editing).
- `docs/config.md` row placement: the brief said "after the `defaultExecutor`
  row (line 57)" and the actual `defaultExecutor` row was at line 57 —
  exact.
- Stash-side-effect note: while verifying the pre-existing failures I
  stashed and re-popped; the pop failed on a readonly git dir for the
  untracked `undefined/` test-artifact dir the check runs had created
  (from an unset env var in a test path). I verified the stash diff
  exactly matched the restored worktree, dropped the stash, and removed
  the junk dir. Final `git status` contains only the intended files.
