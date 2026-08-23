# Worktree dependencies

Dispatches run in a **copy-on-write overlay** over the directory you name (`--directory`), not in the live checkout. The overlay starts empty — worker writes are gated by `accept`/`reject`.

Dependencies are **not** part of that overlay. A fresh worktree (or overlay) has no `node_modules`, no `uv` venv, no `target/`, until something installs them.

## Current scaffolding

The golden scaffolding (`scaffolding-repos/resources/node.md` from `jeremysball/taskferry@4.3.0` for Node; `resources/python.md` for Python) uses `mise` but **taskferry itself does not create worktrees or install deps** — that stays at the repo/scaffolding layer.

### Node / TypeScript / JavaScript

```toml
# .mise.toml
[tasks.setup]
run = "bash scripts/mise-setup-deps.sh"
[hooks]
enter = "mise run setup"
```

`scripts/mise-setup-deps.sh` symlinks `node_modules` from the main checkout when `package-lock.json` is identical, otherwise runs `npm ci`. Idempotent via `node_modules/.mise-setup-stamp`. `[hooks] enter` needs `mise activate` — it fires on interactive `cd` in an activated shell, not inside taskferry's `bwrap`.

The supported flow is **host-side, before dispatch**:

```bash
cd <worktree> && mise run setup          # symlink or npm ci, ms in common case
taskferry dispatch --directory <worktree> --prompt "..." --model ...
# or: alias tfd='mise run setup && taskferry dispatch'
```

Yes — we **are** using mise for worktree dep management today, via that explicit step. The overlay's `lowerdir` is the worktree you populated; the worker sees `node_modules` without re-running setup inside the sandbox. `mise run setup` is a direct `mise run` invocation and works without shell activation; only the `enter` hook needs it.

### Python

Python has no global `node_modules` to symlink — each worktree needs its own venv/deps. Scaffolding uses `uv`:

```bash
uv sync --locked                         # Python
mise run setup && uv sync --locked        # polyglot Node + Python
```

Cache the lockfile in CI (`~/.cache/uv` keyed on `uv.lock`), same shape as Node's `~/.npm` cache.

## If a worktree has no deps

A worktree that has never had its deps installed will fail with `Cannot find module` / `ModuleNotFoundError` before useful work. Fix is host-side:

```bash
git -C <worktree> status --short   # confirm which worktree
mise run setup                     # Node
uv sync --locked                   # Python
taskferry dispatch --directory <worktree> --prompt "..." --model ...
```

## Does git have a hook that fires on worktree creation?

No dedicated `post-worktree` hook. `git worktree add` **does** trigger `post-checkout` in the new worktree (it checks out the branch), so a repo *could* wire:

```bash
# .githooks/post-checkout  (chmod +x, via core.hooksPath = .githooks)
#!/bin/sh
# $1 = previous HEAD, $2 = new HEAD, $3 = 1 if branch checkout
if [ "$3" = "1" ]; then
  # symlink or install — keep it fast, idempotent, and scoped
  if [ -f package-lock.json ]; then mise run setup 2>/dev/null || npm ci; fi
  if [ -f uv.lock ]; then uv sync --locked 2>/dev/null || true; fi
fi
```

**But scaffolding deliberately does not ship this.** `post-checkout` fires on *every* `git checkout` / `git switch`, not just `worktree add`, so it would run `npm ci`/`uv sync` on every branch switch. Keep the cost explicit: run `mise run setup` / `uv sync` before first dispatch (or via alias `tfd`), not on every checkout. If you do want auto-install, gate it on `cmp -s` lockfiles and stamp files exactly like `mise-setup-deps.sh` already does — don't run a full install on every checkout.

## Related docs

- `scaffolding-repos/resources/node.md` — golden Node scaffolding (`.mise.toml` + `mise-setup-deps.sh` + `pre-commit` + `check.yml`)
- `scaffolding-repos/resources/python.md` — Python port (`uv sync`)
- `docs/config.md#taskferrytoml` — current `.taskferry.toml` keys (`check`, `check_timeout_seconds`, `read_only_paths`/`roBind`)
- `docs/troubleshooting.md` — `Cannot find module` / `No module named` → re-run `mise run setup` (or `uv sync`) in that worktree and re-dispatch
