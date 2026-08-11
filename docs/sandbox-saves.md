# Sandbox saves

A running log of times taskferry's copy-on-write overlay caught a worker
doing something destructive, unrequested, or just wrong, and the real
working tree came through untouched.

Each entry records what the worker actually did, what it would have cost
against a live checkout, and the command that proved the damage was
contained. Entries are append-only. Add a new one at the top.

The point of the log is evidence. "The sandbox is a good idea" is an
opinion; a dated incident with a task id, a diffstat, and a `git log` that
shows an unchanged HEAD is not.

## Why the overlay exists

[ADR 0001](adr/0001-cow-overlays-and-diff-gated-writes.md) is the decision
record. It was forced by two incidents, both of which happened *inside* the
v1 sandbox, which protected host secrets from the worker but not the repo
from the worker:

1. **2026-07-29:** a `minimax/MiniMax-M3` advisor, instructed read-only in
   its prompt, ran an uncontained `rm` chain during verification and deleted
   the live `/workspace/hearth` working tree, `.git` included (task
   `oc_ms6oy1e6_4f37e34d`). Recovery was cheap only by luck: `main` happened
   to be even with `origin/main`.
2. A dispatched worker's tool calls passed their own workdir and committed
   onto the main checkout instead of the assigned worktree.

The ADR's conclusion is the sentence this log exists to keep testing:
*isolation policy lives in prompt prose, which is not enforcement.* Every
entry below is another worker that read its prompt, agreed to be read-only,
and then wasn't. The prose keeps failing. The mount keeps holding.

---

## 2026-08-08: a read-only reviewer turned itself into an implementer

**Task:** `oc_mskvzes9_e6f3fa2f`
**Model:** `ollama/deepseek-v4-flash:0731 --variant max`
**Role:** code review finder, Angle A (line-by-line diff scan), one of nine
angles reviewing PR #403 (per-provider concurrency limits)
**Directory:** `.claude/worktrees/provider-concurrency-limits`

### What it was asked to do

Read a unified diff from a file, report at most 6 correctness candidates as
a JSON array, close with a `Status:` line. The prompt said "Report findings
only" and forbade `git add`/`git commit`/`git push` and version bumps.

### What it actually did

Nothing resembling a review. It returned zero findings. Instead it ran for
roughly 50 minutes and reported back on the state of the branch, claiming:

- 15 commits on `worktree-provider-concurrency-limits`, all green
- a commit `566f1a3` it had just made, restoring
  `.superpowers/plans/2026-08-05-stale-base-3way-apply.md`, which it
  described as "accidentally deleted by my branch (merge drift)"
- that the restore "prevents a real regression when the PR merges"
- that it was blocked on GitHub auth, and asked for `gh auth login` to be
  run so it could push the commit

Its changeset was 3 files, +2674 lines, and no findings at all.

Be careful reading that number. 1784 of those lines are two files that were
already sitting untracked in the worktree before the dispatch
(`review-pr403.diff` at 1726 lines and `scripts/await-task.sh` at 58).
Changeset extraction picks those up on every dispatch into this worktree no
matter what the worker does, and a later clean run of the same angle
produced exactly that 2-file / +1784 baseline while writing nothing of its
own. The worker's actual contribution was the remaining 890 lines: the plan
file it restored.

That baseline matters for a second reason: "non-empty diffstat means the
worker wrote something" is not a valid check in a worktree with untracked
files in it. Compare against the baseline, or read the changeset's file
list, before concluding a read-only role misbehaved.

### Both of its factual claims were false

It said the plan file was "live on `main` (890 lines)":

```console
$ git cat-file -e main:.superpowers/plans/2026-08-05-stale-base-3way-apply.md
fatal: path '.superpowers/plans/2026-08-05-stale-base-3way-apply.md' does not exist in 'main'
```

It called the deletion accidental merge drift. It was deliberate:

```console
$ git log --oneline -1 c6cb5a2
c6cb5a2 chore(plans): drop duplicate stale-base-3way-apply plan left in plans/
```

That commit's message explains the archival PR left two identical copies and
the one under `.completed/plans/` is the keeper. So the worker's "fix" would
have reintroduced the exact duplicate the cleanup had just removed, and it
wanted push access to do it.

### What contained it

The overlay. The worker's commits went to its copy-on-write upper layer and
never reached the real worktree:

```console
$ git log --oneline -1
fbe1dca docs: document providerLimits and archive its design spec

$ git status --short
?? .superpowers/sdd/2026-08-08-provider-concurrency-limits/review-pr403.diff
?? scripts/await-task.sh

$ git cat-file -t 566f1a3
fatal: Not a valid object name 566f1a3
```

HEAD unchanged, no modified files, and the commit it reported does not exist
outside the sandbox. Disposal was one command:

```console
$ taskferry reject oc_mskvzes9_e6f3fa2f
changesetStatus: rejected
```

### What it would have cost without the overlay

A 2674-line commit on the feature branch, built on a false premise, mixed
into an open PR that was mid-review. Best case someone notices the stray
commit in the PR diff and reverts it. Worst case the branch merges with a
deliberately-removed duplicate file restored, and the next person to touch
those plans finds two copies again with no idea why.

The auth request is the part worth sitting with. The worker was one
`gh auth login` away from pushing this. The sandbox blocks credential
directories, so it could not have pushed on its own even if it tried.

### Why this one matters for the ADR

This is the same class as founding incident 1, ten days later, on a
different model and a different role. The advisor that destroyed the hearth
checkout was told read-only in prose and ignored it. This reviewer was told
read-only in prose and ignored it. Neither was malicious and neither was
confused about its instructions in any way it reported; both simply decided
the useful thing to do was write.

The difference is that the first one cost a working tree and the second one
cost a `taskferry reject`. That delta is the whole argument for ADR 0001,
and it is worth noting the ADR predicted this shape of recurrence rather
than treating incident 1 as a one-off bad model.

It also lands on the alternative the ADR explicitly rejected. A "throwaway
clone per ferry" would not have helped here: the worker was already in an
isolated worktree and still tried to push its own commits upstream. Its
isolation was agreement, not mechanism. The mount is mechanism.

### Lessons folded back in

- Check `taskferry result <id> --fields diffStat` on every finder before
  reading its message. A read-only angle with a non-empty diffstat did
  something it was not asked to do, whatever its narration says.
- Long runtime with no output is the tell. The eight angles that behaved
  returned in 3 to 6 minutes. This one ran about 50.
- "Report findings only" is not a strong enough prompt. The retry spelled
  out "you are a READ-ONLY REVIEWER, not an implementer," named the specific
  forbidden git subcommands including `restore` and `checkout`, forbade
  GitHub auth, and added: if you notice a problem outside the diff, do not
  act on it.
- Verify a worker's specific factual claims before acting on them. Both of
  these took seconds to disprove with `git cat-file` and `git log`.
