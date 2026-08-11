# Skill evals

Behavioural tests for the `using-taskferry` skill. They check what a model
actually *does* after reading the skill, which is the thing a text-presence
assertion cannot check.

## Why these exist

The skill was split from one 764-line file into a core plus four resources. A
routing panel confirmed models pick the right resource file, but routing to a
file is not the same as acting correctly on what is in it. Each fixture here
pins one behaviour a review flagged as plausibly broken, and records the finding
that motivated it in its own `sourceFinding` field.

| Fixture | Defends against |
|---|---|
| `crash-overlay-recovery` | Reading a clean `git status` after a crash as proof no work exists, then re-dispatching from scratch and losing the overlay's partial work |
| `reviewer-visibility` | Dispatching a reviewer at a worktree that does not contain the pending changeset, so it reviews a clean tree and approves a defect |

## What is tested where

Model runs cost money and are not deterministic, so they are **not** part of
`npm test`. The split:

- `src/evals.test.js` runs in CI. It covers the harness: the shim answers a
  fixture identically every time, fails loudly on an unmatched command, and the
  scorer turns a given command log into a given verdict. A broken harness fails
  CI rather than silently scoring every eval PASS.
- `evals/run.js` is run by hand against a real model.

## Running one

```sh
node evals/run.js --fixture crash-overlay-recovery --model <provider/model> --variant max
```

It builds a temp sandbox containing the skill and a fake `taskferry`, dispatches
a real ferry into it, then scores the commands the model chose to run. Exit code
0 means every check passed. The report names each failing criterion and why, so
a failure says which behaviour broke rather than just `FAIL`.

## How the shim works

`evals/shim/taskferry.js` stands in for the real CLI. It answers from the
fixture's `responses` list, picking the last entry whose `match` tokens all
appear in argv, so a fixture can state a general case and then override it for a
more specific one. Every invocation is appended to a JSONL log before the
response is written, so a crashed run still leaves a trace.

An unmatched command exits 1 with a message on stderr rather than returning
something plausible. A fixture that does not anticipate a command the model
tries should fail visibly, not quietly score that command as a miss.

## Adding a fixture

1. Write `evals/fixtures/<name>.json` with `name` (matching the filename),
   `sourceFinding`, `task`, `responses`, and `checks`.
2. Add a case to `src/evals.test.js` proving the scorer *fails* the specific
   mistake the fixture exists to catch. A check that cannot fail is not a check.
3. Available check kinds: `ranCommand`, `neverRanCommand`, `ranInOrder`,
   `ranExactly`. The fixture-shape test rejects any other kind.
