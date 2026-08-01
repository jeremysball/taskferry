#!/usr/bin/env bash
# Installs (or shares) node_modules for the current checkout. Run via
# `mise run setup`. Deliberately has no hardcoded absolute paths -- every
# location is derived from git so this works from the main checkout, any
# `.claude/worktrees/<name>` worktree, or a throwaway clone.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
common_dir="$(git rev-parse --git-common-dir)"
main_root="$(dirname "$(realpath "$common_dir")")"

cd "$repo_root"

if [ "$main_root" = "$repo_root" ]; then
  echo "mise-setup-deps: main checkout ($repo_root) -- running npm ci"
  npm ci
  exit 0
fi

# A worktree: fast-path a symlink to the main checkout's node_modules when
# its lockfile is byte-identical to ours (the common case -- a feature
# branch that hasn't touched package.json/package-lock.json). Falls back to
# a real, isolated npm ci whenever the lockfiles differ, so a worktree that
# genuinely needs different dependencies never silently shares the wrong
# tree.
main_lock="$main_root/package-lock.json"
worktree_lock="$repo_root/package-lock.json"

if [ -d "$main_root/node_modules" ] \
  && [ -f "$main_lock" ] && [ -f "$worktree_lock" ] \
  && cmp -s "$main_lock" "$worktree_lock"; then
  echo "mise-setup-deps: worktree lockfile matches main checkout ($main_root) -- symlinking node_modules"
  rm -rf node_modules
  ln -s "$main_root/node_modules" node_modules
else
  echo "mise-setup-deps: worktree lockfile differs from (or main checkout lacks) node_modules -- running npm ci in $repo_root"
  npm ci
fi
