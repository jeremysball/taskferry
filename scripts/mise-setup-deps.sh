#!/usr/bin/env bash
# Installs (or shares) node_modules for the current checkout. Run via
# `mise run setup`, and automatically on `cd` once mise shell activation is
# wired up (see .mise.toml's [hooks].enter). Deliberately has no hardcoded
# absolute paths -- every location is derived from git so this works from
# the main checkout, any `.claude/worktrees/<name>` worktree, or a
# throwaway clone.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
common_dir="$(git rev-parse --git-common-dir)"
main_root="$(dirname "$(realpath "$common_dir")")"

cd "$repo_root"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

stamp_path="node_modules/.mise-setup-stamp"
current_hash="$(hash_file package-lock.json)"

# Idempotency: this runs on every `cd` into a mise-activated worktree (the
# [hooks].enter case), so a no-op fast path matters -- re-running npm ci or
# even re-symlinking on every single cd would be wasteful and slow. Skip
# entirely once node_modules is already set up for the current lockfile.
if [ -e node_modules ] && [ -f "$stamp_path" ] && [ "$(cat "$stamp_path")" = "$current_hash" ]; then
  exit 0
fi

if [ "$main_root" = "$repo_root" ]; then
  echo "mise-setup-deps: main checkout ($repo_root) -- running npm ci"
  npm ci
  echo "$current_hash" > "$stamp_path"
  exit 0
fi

# A worktree: fast-path a symlink to the main checkout's node_modules when
# its lockfile is byte-identical to ours (the common case -- a feature
# branch that hasn't touched package.json/package-lock.json). Falls back to
# a real, isolated npm ci whenever the lockfiles differ, so a worktree that
# genuinely needs different dependencies never silently shares the wrong
# tree.
main_lock="$main_root/package-lock.json"

if [ -d "$main_root/node_modules" ] && cmp -s "$main_lock" package-lock.json; then
  echo "mise-setup-deps: worktree lockfile matches main checkout ($main_root) -- symlinking node_modules"
  rm -rf node_modules
  ln -s "$main_root/node_modules" node_modules
  # The symlink target is the source of truth for its own stamp; write ours
  # alongside it via the real path so a later `cmp` against the worktree's
  # own lockfile still finds it through the symlink.
  echo "$current_hash" > "$stamp_path"
else
  echo "mise-setup-deps: worktree lockfile differs from (or main checkout lacks) node_modules -- running npm ci in $repo_root"
  npm ci
  echo "$current_hash" > "$stamp_path"
fi
