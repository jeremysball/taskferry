## Task 8: Documentation sweep

**Files:**
- Modify: `docs/cli-reference.md:57-58`, `:135`, `:137`
- Modify: `docs/config.md:57-61`
- Modify: `docs/daemon.md:375` (append two entries after the existing list)
- Modify: `src/command-specs.js` (dispatch's `--model`/`--variant` option text)
- Modify: `skills/using-taskferry/SKILL.md` (canonical only, then regenerate)
- Modify: `README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `docs/cli-reference.md`**

Replace line 57:

```
| `--model <id>` | `provider/model`, e.g. `opencode-go/minimax-m3`. Run `opencode models` to list installed models. Required unless resuming via `--session-id` with a matching prior task, in which case the model is inherited from that task |
```

Replace line 58:

```
| `--variant <name>` | Reasoning-effort override. Precedence when omitted: the resumed session's own variant (on a `--session-id` resume) wins, otherwise the configured `defaultVariant` (default `highest`) applies -- see `docs/config.md`. `highest` resolves to `--thinking max` on pi (pi clamps to the model's real ceiling itself) or the model's highest cached opencode variant, sending no flag at all if the model has none. Accepted concrete values: pi takes `off`, `minimal`, `low`, `medium`, `high`, `xhigh`; opencode's depend on the model and are never validated by taskferry -- an unrecognized value is silently ignored by opencode itself |
```

Replace line 135 (`advisor`'s `--model <id>` row) — no change needed; `advisor` already requires `--model`, but drop any stale cross-reference to a default if present. Verify by reading the current line before editing; if it already reads "Required, no default; the caller picks the advisor," leave it as-is.

Replace line 137:

```
| `--variant <name>` | Optional reasoning-effort override. Same omitted-flag resolution chain as `dispatch`'s `--variant` above (resumed session, then `defaultVariant`, default `highest`) |
```

- [ ] **Step 2: Update `docs/config.md`**

Add a row after the `defaultExecutor` row (line 57):

```
| `defaultVariant` | `TASKFERRY_DEFAULT_VARIANT` | string (`highest`, or one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) | `highest` |
```

- [ ] **Step 3: Update `docs/daemon.md`'s "Things that look like bugs but aren't"**

Append two entries after the existing last bullet in that section (find it with `rg -n "## Things that look like bugs but aren't" -A 200 docs/daemon.md` to locate the true end of the list before editing, since the list has grown since this plan was written):

```markdown
- A pi dispatch's task record shows `variant: "max"` but the actual provider
  ran at, say, `high`. Expected: pi's own `clampThinkingLevel()` clamps a
  requested level to the model's real ceiling at runtime, including on
  extension providers (`ollama/*`, custom pi providers) taskferry cannot see
  the registry for. taskferry records what was requested, not what pi
  clamped it to, because it has no way to observe the clamp.
- A model dispatches with no `--variant` flag even though `defaultVariant`
  is `highest`, until up to 24h after that model first became available
  through opencode. Expected: the opencode variants cache
  (`<cacheDir>/opencode-variants.json`) refreshes once at daemon startup and
  once every 24h afterward, never synchronously on the dispatch path (a
  fresh `opencode models --verbose` shell-out costs ~3-4s, which would
  otherwise block the daemon's single thread on every affected dispatch).
  A model absent from the cache resolves to no variant flag, not an error.
```

- [ ] **Step 4: Update `src/command-specs.js`**

In the `dispatch` entry's `options` object, change:

```js
"--model <id>": "required unless resuming via --session-id with a matching prior task",
"--variant <name>": "optional; defaults to the model's highest supported thinking level (see defaultVariant in docs/config.md)",
```

- [ ] **Step 5: Regenerate the skill and sweep the README**

Edit `skills/using-taskferry/SKILL.md` (canonical copy) to state `--model` is required for a fresh dispatch and that an omitted `--variant` now means "this model's hardest thinking level," then run `npm run skill:generate` and commit the regenerated integration copies alongside it. Run `rg -n "taskferry dispatch" README.md` and add `--model <provider/model>` to any example invocation that currently omits it.

- [ ] **Step 6: Commit**

```bash
git add docs/cli-reference.md docs/config.md docs/daemon.md src/command-specs.js skills/using-taskferry/SKILL.md README.md
git commit -m "docs: document required --model and the highest-thinking default variant"
```

---

