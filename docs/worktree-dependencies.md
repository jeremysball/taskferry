# Worktree dependencies and `postWorktreeHook`

## The problem

Taskferry dispatches run in a **copy-on-write overlay** over the directory you name (`--directory`), not in the live checkout. The overlay starts empty — worker writes are gated by `accept`/`reject`.

Dependencies are **not** part of that overlay. A fresh worktree (or overlay) has no `node_modules`, no `uv` venv, no `target/`, until something installs them.

Two things fill that gap today, and both are limited:

1. **`scripts/mise-setup-deps.sh` + `.mise.toml` `[hooks] enter`** (the golden scaffolding in `scaffolding-repos/resources/node.md`).

   ```toml
   # .mise.toml
   [tasks.setup]
   run = "bash scripts/mise-setup-deps.sh"
   [hooks]
   enter = "mise run setup"
   ```

   The script symlinks `node_modules` from the main checkout when `package-lock.json` is identical, otherwise runs `npm ci`. It is **Node/npm-only**, requires `mise activate` in the shell rc (without it `[hooks] enter` is inert), and is idempotent via `node_modules/.mise-setup-stamp` (skips when the lock hash hasn't changed).

   It does **not** handle pnpm/yarn, Python (`uv sync`), Go (`go mod download`), Rust (`cargo fetch`), or any non-npm tool. It also only runs on interactive `cd` into a mise-activated shell — a daemon-spawned dispatch that has never `cd`'d through mise won't get it.

2. **Nothing else.** Taskferry itself does not run `npm ci`/`uv sync`/etc. on worktree creation. If you dispatch into a worktree that has never been entered through mise, the worker sees `Cannot find module` / `ModuleNotFoundError` before it does anything useful.

## Recommended fix: `postWorktreeHook` in `.taskferry.toml`

Add an explicit, repo-owned hook that taskferry runs **once per dispatch**, right after it materializes the worktree/overlay and before it spawns the worker. The repo declares what it actually needs; taskferry just runs it.

### Proposal (to be implemented in `src/project-config.js` + `src/tasks.js`)

```toml
# .taskferry.toml
check = "npm run check"

# Run after the worktree/overlay is ready, before the worker spawns.
# Preferred: a mise task that already encodes the per-ecosystem logic.
postWorktreeHook = "mise run setup"

# Or inline:
# postWorktreeHook = "npm ci"
# postWorkTreeHook = "uv sync --locked"
# postWorkTreeHook = "mise run setup && uv sync --locked"  # polyglot
```

Keys `postWorktreeHook` and `post_worktree_hook` are aliases (duration-style casing tolerance, same as `check_timeout_seconds` → `checkTimeoutSeconds`). Missing/empty → no hook. Unrecognized keys remain a hard error at dispatch (surfaces as `projectConfigWarning`).

Lifecycle:

1. taskferry resolves the dispatch directory (worktree or plain dir).
2. If `postWorktreeHook` is set, it runs the command **in that directory**, with the same env the worker will get, under the same timeout/error handling as the `check` gate (captures tail, times out after `check_timeout_seconds`, records `postWorktreeHookStatus`/`postWorktreeHookOutputTail` on the task).
3. On failure/timeout the task settles `failed` with the hook output in `result` — same as a failed `check` gate — so `dispatch` never silently spawns a worker into a broken tree.
4. On success the worker spawns normally, now with dependencies present.

### Why this instead of more mise magic

- **Explicit over implicit.** `mise` hooks depend on interactive shell activation; a daemon-spawned dispatch has no guarantee of that. A `postWorktreeHook` runs inside taskferry's own spawn, so it works whether or not the user's shell is mise-activated.
- **One knob per repo, not per language.** Node repos use `mise run setup` or `npm ci`; Python repos use `uv sync`; polyglot repos use `mise run setup && uv sync`. The repo picks — taskferry doesn't guess.
- **Symlink optimization stays.** Keep `scripts/mise-setup-deps.sh` as the hook body for Node — it already fast-paths `node_modules` via symlink when the lockfile matches, so the hook is milliseconds in the common case and a real `npm ci` only when the lockfile diverged.
- **No global daemon config.** The hook lives in `.taskferry.toml` (project-owned, reviewed) not in the daemon's global `config.json`. Different repos need different install commands.

### How to adopt today (before the hook lands)

Until `postWorktreeHook` is implemented, wire the same command through mise's own hook, but be explicit about the limitation:

```bash
# In the repo you're about to dispatch from:
mise run setup          # one-time, populates node_modules via symlink or npm ci
# Then dispatch:
taskferry dispatch --directory <worktree> --prompt "..." --model ...
```

Or add a per-repo alias so the dispatch always pre-installs:

```bash
alias tfd='mise run setup && taskferry dispatch'
```

Once `postWorktreeHook` is available, move that command into `.taskferry.toml` and drop the alias — the docs for each scaffolded repo's `resources/node.md` and `resources/python.md` will be updated to recommend:

```toml
postWorktreeHook = "mise run setup"      # Node
postWorktreeHook = "uv sync --locked"   # Python
```

### Related docs

- `scaffolding-repos/resources/node.md` — golden Node scaffolding (`.mise.toml` + `mise-setup-deps.sh` + `pre-commit` + `check.yml`)
- `scaffolding-repos/resources/python.md` — Python port (`uv sync`)
- `docs/config.md#taskferrytoml` — current `.taskferry.toml` keys (`check`, `check_timeout_seconds`, `read_only_paths`/`roBind`); `postWorktreeHook` will be documented there when implemented
- `docs/troubleshooting.md` — if a dispatch fails with `Cannot find module` / `No module named`, re-run `mise run setup` (or the hook's command) in that worktree and re-dispatch
