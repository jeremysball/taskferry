# Contributing

This covers the conventions a PR against this repo is expected to follow. For
setup, commands, and architecture, see the [README](README.md) and the docs
it links to under "Further reading" — this file doesn't repeat those.

## Before opening a PR

Run `npm run check`. It runs, in order: a syntax check on every tracked
`.js` file, `eslint .`, `tsc --noEmit`, `npm run skill:check`, and the full
unit suite. The same checks (minus the full suite) also run as a pre-commit
hook once you've run `npm install` (`.githooks/pre-commit`, wired via the
`prepare` script) — bypass it in a pinch with `git commit --no-verify`, but
`npm run check` still has to pass before review.

### Adding a new test file

`npm run test:unit` lists every unit test file explicitly in `package.json`
rather than globbing `src/**/*.test.js`. A new test file is silently skipped
by CI until you add it to that list by hand — there's no error, no warning,
the file just never runs. If you add `src/foo.test.js`, add it to the
`test:unit` script in the same commit.

### Changed the CLI surface?

If a PR changes a command, flag, default, or output shape, regenerate the
agent-facing skill: `npm run skill:generate`. `npm run skill:check` (part of
`npm run check`) fails if the generated file and the CLI have drifted apart.
The canonical skill source is `skills/using-taskferry/SKILL.md`.

## Test file conventions

These aren't enforced by lint — `eslint.config.mjs` explicitly excludes
`*.test.js` from the `complexity`/`max-lines`/`max-lines-per-function`
rules that apply to the rest of `src/`, since it's normal for a test file to
be long. They're conventions this codebase follows by hand, so violating
them won't fail `npm run check`, but a PR that ignores them will likely get
asked to restructure.

- **Keep a `describe` callback under 200 lines.** When one grows past that,
  split it into multiple sibling `describe` blocks by topic before it grows
  further, not after. Several existing files split a single large behavior
  area into topic-based sub-`describe`s for exactly this reason (see
  `src/tasks.sandbox.test.js` or `src/tasks.watchdog.test.js` for examples).
- **Split a large test file by topic, not by line count alone.** When a test
  file is doing too much (mixing unrelated behavior areas under one file),
  split it into separate files named for the area under test, e.g.
  `tasks.dispatch.test.js`, `tasks.watchdog.test.js`, `tasks.lifecycle.test.js`
  rather than one undifferentiated `tasks.test.js`. Remember to add the new
  file to `test:unit` in `package.json` (see above).
- **A file split off from a larger one is self-contained.** It keeps its own
  copy of whatever fixtures/helpers it needs rather than reaching back into
  the file it was split from. `src/commands-stream.test.js` is the
  reference example: split out of `commands.test.js`, it keeps its own
  `tmp-dir`/`fakeClient`/`fakeIo`/`setupWatch` helpers and only imports the
  function under test.
- **Shared scaffolding used by several split files goes in a `*.test-helpers.js`
  file, not a `*.test.js` file.** `src/tasks.test-helpers.js` is the
  pattern: it holds fixtures and builders several `tasks.*.test.js` files
  share (`makeManager()`, `baseTask()`, temp-dir tracking with automatic
  teardown). Because it isn't named `*.test.js`, `node --test` skips it as a
  suite on its own, but it's still ordinary `src/` code subject to the
  normal (non-test) ESLint rules, unlike the test files that import it.

  Adoption is partial, so treat this as the target rather than a description
  of the whole suite. Eighteen test files import the shared helpers, but
  `commands.test.js`, `advisor-context.test.js`, `changeset.test.js`,
  `changeset.integration.test.js`, and `env-file.test.js` still keep local
  copies of every helper instead of importing them, and `opencode-plugin.test.js`
  imports only a couple of the shared helpers while still keeping local
  copies of the rest. Issues #372, #374, and #375 track the remaining work.
  Import the shared helper in new code; copying a neighbor's local version
  deepens the duplication those issues describe.

## Documentation conventions

- **Don't add a file-by-file index of the codebase** (line counts, per-file
  responsibility summaries). This repo had one (`docs/sourcemap.md`) and
  retired it: it went stale on nearly every commit that touched `src/`, and
  `rg`/`wc -l` answer the same questions on demand without needing upkeep.
  See `CLAUDE.md`'s "Record behavior that looks like a bug but isn't"
  section for the full reasoning.
- **Deliberate non-obvious behavior goes in `docs/daemon.md`'s "Things that
  look like bugs but aren't" section, in the same PR that introduces it.**
  If your change adds behavior a future reader could reasonably mistake for
  a bug (a delayed effect, a race the design tolerates on purpose, a default
  that looks backwards until you know why), add an entry there rather than
  leaving it to get re-diagnosed from scratch later.
- **Behavior changes need their docs updated in the same PR.** If you change
  a flag, default, env var, or output shape, grep the repo for the old name
  and update every doc hit (`docs/cli-reference.md`, `docs/config.md`, the
  relevant `docs/integrations/*.md`, `skills/using-taskferry/SKILL.md`) as
  part of the same change, not a follow-up.

## Picking up work

- Check the [`good first issue`](https://github.com/jeremysball/taskferry/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
  label for small, self-contained, well-scoped issues if you're looking for
  a place to start.
- Before starting a non-trivial fix, check whether an open PR already
  addresses the same issue. Two independent PRs landing the same fix is
  wasted effort on one side; only one gets merged; if you see this has
  already happened for something you were about to pick up, comment on the
  existing PR instead of opening a duplicate.
- First-time contributors: GitHub holds Actions workflow runs on a fork PR
  for maintainer approval before CI executes. If your PR shows no checks
  yet, that's why — a maintainer needs to approve the run, not something
  wrong with your PR.

## Agentic PRs are welcome

PRs authored or driven by an AI coding agent (Claude Code, Codex, Devin,
Cursor, OpenHands, or your own script) are evaluated the same as any other
PR: does the diff fix the linked issue, does `npm run check` pass, does it
follow the conventions above. No disclosure requirement, no separate
review lane, no penalty for the PR having an agent in the loop.

That said, this repo's `good first issue` label is written with an
agent-friendly shape on purpose — every issue names exact files, line
numbers, and the current behavior versus the expected one, specifically so
scope isn't something you have to go dig for. That shape is also what
makes a PR fast to review and merge, agent-authored or not:

- **Match the issue's stated scope exactly.** An issue naming one function
  in one file is a request to fix that function, not to refactor the
  surrounding module. Scope creep is the single fastest way to turn a
  same-day merge into a multi-round review.
- **Run `npm run check` yourself before opening the PR**, and paste its
  real output (or a summary of it) in the PR description. A claim that
  tests pass is worth nothing without the command actually having been
  run, whether the PR was opened by a person or an agent.
- **Don't claim verification you didn't do.** If you patched the bug but
  didn't confirm the original failure mode is actually gone (ran the
  reproduction, hit the changed code path), say so in the PR instead of
  asserting it's fixed. A wrong-but-confident claim costs more review time
  than an honest "I didn't verify X."
- **One issue, one PR.** Bundling several unrelated `good first issue`
  fixes into a single PR makes it harder to review and to credit
  correctly; open one PR per issue.

## Credit

External contributions are credited by name/handle in the merge commit and
changelog entry, not absorbed into a generic release-please rollup.
