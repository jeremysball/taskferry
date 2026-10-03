# Draft: replacement for CLAUDE_md addendum "Awaiting ferries" section

This is the text that should replace the current
`## Awaiting ferries without a Monitor tool` section in
`/home/jeremy/.claude/CLAUDE_md-addendum-for-non-claude-model.md`
once `taskferry wait-all` ships.

---

## Awaiting ferries without a Monitor tool

Claude Code's `Monitor` tool doesn't exist here — opencode, kilo code, and
every other non-Claude-Code harness this file covers have no native way to
hand off a running ferry (or a group of them) and be woken when it settles.

Use `taskferry wait-all` — the consolidated group-wait command:

```bash
# Common case: wait for everything running/queued in this workspace
taskferry wait-all --summarize

# Explicit ids: wait for exactly these
taskferry wait-all <id1> <id2> <id3> --summarize

# Scoped to another workspace
taskferry wait-all --directory /path/to/other/workspace --summarize
```

- Waits concurrently (not sequentially) — wall-clock is bounded by the
  slowest ferry, not the sum.
- Silent while blocking by default; on return prints one line per id plus
  an `N/M settled` tally. Exit code 0 only if every id settled successfully.
- `--summarize` redraws a compact table every `--interval` (default 15s):
  `3/10 settled... working` header plus per-task `last write Xs ago` /
  `+N bytes since last poll` from the same activity snapshot machinery
  `wait --summarize` already uses.
- Passing ids and `--directory` together is rejected — same mutual-exclusion
  rule `list`/`watch` already enforce for `--all` vs `--directory`.
- `0/0 settled` (nothing running/queued in scope) succeeds immediately.

For a single ferry, `taskferry wait <id> --summarize` is still the right
call. For the whole workspace, `taskferry watch --all --summaries` streams
events but doesn't exit on its own — pair it with `wait-all` when you need
a blocking group wait.

Once the group has settled, pull each outcome with
`taskferry result <id> --fields message,tokens` (or `taskferry output <id>`
for scratch artifacts). Don't treat `wait`/`wait-all` returning as success —
check status/failure per id.
