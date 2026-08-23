# Worktree dependencies

Dispatches run in a **copy-on-write overlay** over the directory you name (`--directory`), not in the live checkout. The overlay starts empty — worker writes are gated by `accept`/`reject`.

Dependencies are **not** part of that overlay. A fresh worktree (or overlay) has no `node_modules`, no `uv` venv, no `target/`, until something installs them.

## Current scaffolding (Node)

The golden scaffolding (`scaffolding-repos/resources/node.md`, from `jeremysball/taskferry@4.3.0`) uses:

```toml
# .mise.toml
[tasks.setup]
run = "bash scripts/mise-setup-deps.sh"
[hooks]
enter = "mise run setup"
```

`scripts/mise-setup-deps.sh` symlinks `node_modules` from the main checkout when `package-lock.json` is identical, otherwise runs `npm ci`. It is idempotent via `node_modules/.mise-setup-stamp` (skips when the lock hash hasn't changed).

**Limitations:**

- **Node/npm-only.** Does not handle pnpm/yarn, Python (`uv sync`), Go (`go mod download`), Rust (`cargo fetch`), or any other ecosystem.
- **`[hooks] enter` needs `mise activate`.** The automatic hook fires only in a shell with `mise activate` in its rc. A daemon-spawned dispatch that has never `cd`'d through mise won't get it — and taskferry's bwrap sandbox doesn't source your rc.
- **But dispatches are not broken.** `mise run setup` is a direct `mise run` invocation, not a hook — it works without shell activation. The supported flow is to run it **on the host, before dispatch**, so the worker sees `node_modules` via the overlay's lowerdir:

  ```bash
  cd <worktree> && mise run setup          # symlink or npm ci, ms in common case
  taskferry dispatch --directory <worktree> --prompt "..." --model ...
  # or: alias tfd='mise run setup && taskferry dispatch'
  ```

  Yes — we **are** using mise for worktree dep management today, via that explicit host-side step. The overlay's lowerdir is the worktree directory you populated; the worker doesn't need to re-run the setup inside the sandbox.

Taskferry itself does not auto-run `npm ci`/`uv sync` on worktree creation or inside the overlay.

## Recommendations

1. **Always `mise run setup` before first dispatch into a new worktree.** In practice, `cd <worktree> && mise run setup` populates the tree via symlink or `npm ci` in milliseconds for the common lockfile-identical case.

2. **Add a per-repo dispatch alias** so the install is not forgotten:

   ```bash
   alias tfd='mise run setup && taskferry dispatch'
   # usage: tfd --directory <worktree> --prompt "..." --model ...
   ```

3. **Python / polyglot repos — use the ecosystem's own install** before dispatch:

   ```bash
   uv sync --locked                         # Python
   mise run setup && uv sync --locked        # polyglot Node + Python
   ```

4. **If a dispatch fails with missing modules**, re-run the install in that worktree and re-dispatch:

   ```bash
   git -C <worktree> status --short   # confirm which worktree
   mise run setup                     # or uv sync --locked
   taskferry dispatch --directory <worktree> --prompt "..." --model ...
   ```

## Tracking a first-class hook

A repo-owned hook that taskferry would run automatically after materializing the worktree/overlay (before worker spawn) is tracked in [#551](https://github.com/jeremysball/taskferry/issues/551) as `postWorktreeCreationHook` (aliases `post_worktree_creation_hook` / `postWorktreeHook` for compat). Until that lands, the manual `mise run setup` / `uv sync` steps above are the supported path.

## Related docs

- `scaffolding-repos/resources/node.md` — golden Node scaffolding (`.mise.toml` + `mise-setup-deps.sh` + `pre-commit` + `check.yml`)
- `scaffolding-repos/resources/python.md` — Python port (`uv sync`)
- `docs/config.md#taskferrytoml` — current `.taskferry.toml` keys (`check`, `check_timeout_seconds`, `read_only_paths`/`roBind`); `postWorktreeCreationHook` will be documented there when implemented
- `docs/troubleshooting.md` — `Cannot find module` / `No module named` → re-run `mise run setup` (or `uv sync`) in that worktree and re-dispatch
