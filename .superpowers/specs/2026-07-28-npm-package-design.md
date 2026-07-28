# npm package design

## Scope

Publish `taskferry` as a real, public, MIT-licensed npm package
(`npm install -g taskferry` / `npx taskferry`), as an *addition* to the
existing git-clone flow, not a replacement. Contributors and anyone wanting
`taskferry setup`'s native-plugin registration can still clone the repo
directly.

`taskferry setup` must behave identically after either install path:
`npm install -g taskferry && taskferry setup` and
`git clone ... && node src/cli.js setup` are both first-class, not one
canonical path with the other bolted on.

Non-goals for this pass, explicitly deferred:

- Bun bundling (`bun build`) of the published package
- Bun `--compile` standalone binaries
- Auto-running `setup` via an npm `postinstall` hook
- A scoped or private package

Package name `taskferry` is confirmed free on the npm registry (`npm view
taskferry` returns 404).

## `package.json` / metadata changes

- Add `"license": "MIT"` plus a `LICENSE` file (standard MIT text).
- Add `"repository"`, `"homepage"`, `"bugs"` pointing at
  `github.com/jeremysball/taskferry`.
- Add a `"files"` array (currently absent, so npm would otherwise pack
  everything not gitignored).
- Keep `"bin"`, `"main"`, `"exports"` exactly as they are today — already
  correct for both install paths.
- Keep the `"prepare"` script (`git config core.hooksPath .githooks ||
  true`) unchanged. Verified directly rather than assumed: packed the
  current tree into a real tarball and did a real `npm install -g` from it
  into a throwaway prefix. npm 12 blocks lifecycle scripts (including
  `prepare`) on global installs by default unless allowlisted via
  `--allow-scripts`, so it silently no-ops on modern npm; the existing
  `|| true` guard already covers older npm versions where it would
  actually attempt to run outside a git repo.

## What ships in the tarball (`files` field)

**In:** `src/*.js` (excluding `*.test.js`), `src/tf-sl.sh`,
`scripts/generate-skill.js` (verified this is a genuine runtime dependency:
`commands.js`'s `dispatch` command calls `checkSkills()` from it, not just
a dev tool), `integrations/`, `skills/`, `.claude-plugin/marketplace.json`.

**Out:** `*.test.js`, `src/*-smoke-test.js`, `scripts/e2e-setup.js`,
`docs/`, `.superpowers/`, the two brand PNGs (confirmed the README doesn't
reference them), CI/lint/tsconfig files. All excluded automatically once
`files` is scoped — no separate ignore-list needed.

`devDependencies` (`eslint`, `typescript`, `@types/node`, ...) are never
installed for a consumer regardless of the `files` field — that's normal
npm behavior for any dependency install, not something this design needs
to handle. They only become relevant again in the `setup` fix below,
because `package.json`'s manifest text (including the `devDependencies`
list) always ships with a package, independent of `files`.

## `taskferry setup` must work unmodified for both install styles

Directory resolution already works correctly for both install styles, and
needed **no code change** — verified directly, not assumed:

- `cli.js:40` computes `checkoutDirectory` from
  `fileURLToPath(import.meta.url)`, never from `process.argv[1]`.
- A real symlink test confirms Node's ESM loader resolves `import.meta.url`
  through a symlink to the file's real location, while `process.argv[1]`
  stays as whatever path was actually invoked:

  ```
  invoking via a symlink:
    import.meta.url -> /tmp/symtest/real/src/cli.js   (real path)
    process.argv[1] -> /tmp/symtest/binlink/taskferry  (the symlink)
  ```

- So `checkoutDirectory` always lands on the real install directory — a
  git checkout or npm's global package directory — regardless of whether
  npm's own bin symlink or a prior `taskferry setup`'s
  `~/.local/bin/taskferry` symlink was used to invoke it. Plugin-marketplace
  registration (`claude plugin marketplace add <checkoutDirectory>`), the
  `opencode` plugin symlink, and the managed `~/.local/bin/taskferry`
  symlink guard from PR #213 all already work unmodified for an npm
  install.

**One real gap, found by reading the code, not guessed:**
`runSetup()` (`src/setup.js:231`) calls `runNpmInstall(checkoutDirectory)`
unconditionally on every run, with no check for whether the runtime
dependency is already resolved. For an npm-installed copy this is a
genuine problem, not a hypothetical one:

1. Plain `npm install` (no flags) installs `devDependencies` too by
   default. Since `package.json`'s full manifest (including its
   `devDependencies` list) ships regardless of the `files` field, `setup`
   would try to pull the entire dev toolchain (`eslint`, `typescript`,
   `@types/node`, ...) into a production install for no reason — the only
   real runtime dependency (`@toon-format/toon`) is already present from
   the initial `npm install -g`.
2. A system-wide global install (e.g. `sudo npm install -g taskferry`)
   commonly lands in a root-owned directory. A regular user running
   `taskferry setup` afterward would hit `EACCES` trying to `npm install`
   into it at all.

**Fix required as part of this work:** gate the `runNpmInstall` call so it
only runs when actually needed (e.g. skip when the runtime dependency is
already resolvable from `checkoutDirectory`, rather than blindly
re-installing every time). Exact gating signal is an implementation detail
for the plan, not this spec — the requirement is: `setup` must not attempt
a real `npm install` against an already-provisioned npm-installed package
directory.

## CI: publish on release

A new job — either appended to `release-please.yml` or a separate workflow
triggered on `release: published` — that only runs when release-please's
own output says a release was actually created this run. It runs
`npm ci`, then `npm publish --provenance --access public`, authenticated
with an `NPM_TOKEN` secret (a granular/automation token scoped to just this
package, same pattern already used for `RELEASE_PLEASE_TOKEN`).
`--provenance` requires `id-token: write` permission on the job and npm
>=9.5, and gives the public package a verifiable "built from this exact
commit/workflow" attestation on npmjs.org — worth doing for a public
package, no added design complexity.

## Docs

README's `## Install` section gets an `npm install -g taskferry` path added
alongside the existing git-clone path. Both paths end the same way:
`taskferry setup`.

## Testing / verification

- `npm pack` + a real `npm install -g` from the tarball into a throwaway
  prefix (the same check already done to verify the `prepare`-script
  behavior) — confirms the tarball is self-contained and both
  `taskferry --version` and `taskferry setup` work from it, including the
  fixed `runNpmInstall` gating.
- Existing `npm run check` (lint/typecheck/unit) stays the gate for the
  code itself; nothing about it changes.
