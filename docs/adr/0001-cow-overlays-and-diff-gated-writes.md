# ADR 0001: Ferries run on copy-on-write overlays; advisor writes never land, dispatch writes land only on accept

**Status:** Accepted and implemented (PR #251, 2026-07-31).

**Date:** 2026-07-29

## Context

Two documented incident classes forced this decision:

1. **2026-07-29, hearth checkout destroyed by an advisor.** A `minimax/MiniMax-M3` advisor review, instructed read-only in its prompt, ran an uncontained `rm` chain during empirical verification and deleted the live `/workspace/hearth` working tree, `.git` included (task `oc_ms6oy1e6_4f37e34d`). Recovery was cheap only because `main` happened to be even with `origin/main`.
2. **Earlier, worker ignored `--directory`.** A dispatched worker's tool calls passed their own workdir and committed onto the main checkout instead of the assigned worktree.

Taskferry already sandboxes every executor spawn with bwrap (`src/sandbox.js`, called from `src/tasks.js` and `src/changeset.js`): read-only root, tmpfs `/tmp`, a deny-list tmpfs over the secret paths (`~/.ssh`, `~/.aws`, gcloud, gh, gnupg, `~/.claude`, the taskferry state dir), `--unshare-all --share-net --die-with-parent`. It bind-mounts the target directory read-write: `--bind directory directory`.

So the v1 sandbox protects host secrets from the worker, but not the repo from the worker. Both incidents happened inside the sandbox. And the sandbox has no concept of role: an advisor persists nothing by design, yet gets the identical writable mount an implementer needs. Isolation policy lives in prompt prose, which is not enforcement.

## Decision

**1. Every ferry gets a copy-on-write overlay on its target directory.** In `buildBwrapArgs()`, the `--bind directory directory` line becomes, on overlay-capable hosts, `--overlay-src <directory> --overlay <upper> <work> <directory>` (bwrap ≥ 0.8; argument order is RWSRC WORKDIR DEST; syntax and semantics verified on the target host, see Evidence). The worker sees the real path. All writes and deletes land in `<upper>`; the underlying tree is read-only by construction. `<upper>` and `<work>` are per-task unique (`<overlayTmpRoot>/taskferry-cow-<task-id>/{upper,work}`), never shared between concurrent ferries: a shared overlayfs workdir corrupts the mount, and a shared upper would blend two workers' change-sets into one undecidable diff. `overlayTmpRoot` defaults to `<runtimeDir>/overlay`, not `/tmp` (moved off `os.tmpdir()` so two daemons on the same host don't collide in a shared namespace), overridable via `TASKFERRY_OVERLAY_TMP_DIR`; both `<upper>` and `<work>` are destroyed on reject or after apply.

**2. Advisor role: overlay only, diff-gated.** Advisors keep the full toolset, bash included. Read-only is a property of the checkout, not of the toolset, so empirical verification (running experiments, scratch files, cleanup chains) stays possible and becomes safe by default. The advisor namespace additionally gets its `runtimeDir` bound read-only instead of read-write, so the daemon's Unix socket living there is unreachable; network stays shared with every other role — `--unshare-net` was tried for advisor and reverted when it blocked the worker CLI's own outbound access to its model provider. On exit, taskferry computes the changeset from `<upper>` by running `git diff` inside one short-lived bwrap that re-mounts the same overlay read-only (this resolves deletions and overlayfs whiteouts without custom parsing), presents it for accept/reject, and discards `<upper>` on reject. An advisor has no path to persist a write.

**3. Worktree-or-checkout is a skill-layer decision, not a taskferry default.** Taskferry overlays whatever directory it is given. The overlay makes writes to the main checkout mechanically safe (nothing lands until accept), so git worktrees stop being an isolation requirement and taskferry core does not create them. The choice moves to the skill layer: `using-taskferry` (and the SDD lifecycle it serves) asks the user at the start of feature work whether to run in a worktree or directly on the main checkout. Worktrees keep two values unrelated to safety, and the skill's prompt says so when asking: branch isolation (parallel sessions on different branches without switch races), and lower-layer stability. The overlay's lower is the live directory. A branch switch or external edit on the main checkout while a ferry is in flight mutates that lower in place, so concurrent sessions sharing a checkout need worktrees for this reason. The write path is the same in every configuration: taskferry computes the diff from the upper on exit, the user accepts or rejects it, and an accepted diff is applied onto the given directory (worktree, main checkout, or bare non-git target) outside the sandbox; unaccepted diffs vanish with the upper. For targets outside any git repo, the worktree question simply does not arise; the overlay mounts over the target directory directly.

**4. There is exactly one bwrap layer, and it stays taskferry's.** Verified 2026-07-29: opencode's live configuration carries no sandbox settings (no `sandbox` key in `~/.config/opencode/opencode.json` or `.jsonc`, no sandbox flag on the CLI), and the bwrap layer observed around executor processes is taskferry's own (`src/sandbox.js`). There is no inner opencode sandbox to disable and no nesting to prototype. If a future executor ships its own sandbox, taskferry's layer must remain the outermost one.

## Consequences

Gains:

- Both incident classes become structurally impossible. The live checkout is never writable from inside a ferry, and "worker wandered to the main checkout" has nowhere to wander: the main checkout is either the read-only lower (advisor) or not mounted at all (worktree dispatch).
- The accept/reject gate makes "what did the ferry change" reviewable by construction. The upper is the diff; no trust in worker self-reports required.
- Empirical advisor verification stops being a forbidden activity guarded by prose and starts being a safe default.
- Integration surface is one mount line in one function that already carries an extra-binds taxonomy.

Costs and hazards:

- Hard dependency on bwrap ≥ 0.8 and unprivileged user namespaces. v1 already required both; this raises the bwrap floor from "any" to 0.8.
- Overlayfs whiteouts: deletions surface in `<upper>` as character-device whiteout entries. Diff extraction must go through the merged view, never a raw upper listing.
- ~~Namespace-owned leftovers: overlayfs `<work>` dirs are owned by the unmapped namespace uid and survive sandbox exit. Cleanup needs a privileged rm or a small purpose-built namespace.~~ **Corrected 2026-07-29, during implementation planning:** this claim was asserted "(verified empirically)" with no corresponding entry in this ADR's own Evidence section, and direct testing against the exact `buildBwrapArgs()` flag set disproved it (see Evidence). `<upper>`/`<work>` come back owned by the *invoking* uid, not an unmapped one — bwrap's default `--unshare-user` identity-maps the outer uid, and neither this design nor v1 passes `--uid`/`--gid`. A plain `rm -rf` from the daemon's own uid removes the whole tree **when `<work>/work` is still empty** (an optimistic `rmdir()` fast path that only needs the parent directory's permissions). Once anything has ever been deleted inside the overlay, that scratch subdir (mode `000`) holds an internal whiteout entry and is no longer empty, so `rm` has to `opendir()` it — which the mode blocks, aborting partway through after `<upper>` is already gone (taskferry#273). `cleanupOverlay()` therefore runs a same-uid `chmod -R u+rwX` before `rm -rf`, still no privileged step, but a non-trivial one.
- Git semantics shift for dispatch workers: commits made inside the sandbox land in `<upper>` and are invisible until the apply step. Worker-facing docs must say taskferry applies accepted changes, not that the worker's commit is durable.
- Debug opacity: a change a worker "made" that did not land is an unaccepted, discarded upper, not a lost write. Troubleshooting docs must name this failure mode.
- Per-dispatch setup grows slightly: two directories to create and clean up per ferry.
- Lower-layer volatility on the main checkout: with a ferry in flight, a concurrent session switching branches or editing the main checkout mutates the overlay's lower in place (overlayfs does not snapshot the lower). The skill-layer worktree prompt (decision 3) is the mitigation; solo sessions on the main checkout are unaffected.

## Alternatives considered

- **Extend the v1 deny-list (block `rm` and friends).** Rejected: command-level deny-lists are escapable (`find -delete`, a python one-liner, the next tool that writes), and maintaining one is whack-a-mole. Read-only must be a filesystem-layer property, not a command-layer one.
- **Read-only as tool removal (no bash, or no tools, for advisors).** Rejected as the default: it kills the empirical verification that makes advisor reviews worth more than opinion. Remains a legitimate niche for pure-judgment passes where all context is inlined in the prompt.
- **"Read-only bash" command allow-list.** Rejected: the same escapability as the deny-list plus false confidence.
- **Throwaway clone / scratch directory per ferry.** Rejected: its isolation is agreement, not mechanism. Every session must remember to clone instead of using the live tree, the copy drifts from the real thing, and a worker pointed at the wrong path is back to incident one. Strictly weaker than a mount-level guarantee once one exists. (Recorded as an interim mitigation in `choosing-a-model/working-report.md` after the 2026-07-29 incident; superseded by this decision.)
- **Worktrees alone.** Rejected as sufficient: they isolate branches but provide no accept gate for advisor work and nothing for non-git targets. Adopted instead as an optional skill-layer substrate (decision 3).
- **Worktree-by-default inside taskferry core (`--no-new-worktree` to opt out).** Rejected after the CoW decision made it redundant: an isolation tool has no business owning a git-workflow preference once writes are mechanically gated, and baking it in would impose worktree lifecycle (creation, auditing, cleanup) on every dispatch, including advisory and non-git ones. The choice belongs in the skill layer, where the user is present to make it.

## Revisit this decision if

- A target host cannot run unprivileged user namespaces or bwrap ≥ 0.8. Fallback: worktree plus read-only binds, accept-gate via diff against the worktree.
- bubblewrap changes `--overlay` / `--overlay-src` semantics upstream.
- An executor with its own sandbox becomes the default, forcing a renegotiation of which layer is outermost.

## Evidence (verified 2026-07-29, target host)

- bwrap 0.11.2; `kernel.unprivileged_userns_clone = 1`; `/tmp` is an 8G tmpfs.
- Working invocation, minimal illustration (not the exact flag set `buildBwrapArgs()` emits — see the cleanup re-verification below for that): `bwrap --unshare-user --ro-bind / / --dev /dev --proc /proc --overlay-src <repo> --overlay <upper> <work> <repo> <cmd>`.
- Adversarial test: inside the sandbox, creating a file and deleting `package.json` at the real repo path both succeeded; on the host neither change was ever visible; git history read intact from both views; `<upper>` afterwards contained exactly the new file and a whiteout entry for the deletion.
- Incident artifacts: task `oc_ms6oy1e6_4f37e34d`, log at `~/.local/state/taskferry/logs/oc_ms6oy1e6_4f37e34d.ndjson`. Note: the pi executor log records command outputs but not inputs, an audit gap worth its own issue.
- Cleanup ownership re-verified 2026-07-29 during implementation planning, against the exact flag set `buildBwrapArgs()` emits (`--ro-bind / / --proc /proc --dev /dev --tmpfs /tmp --overlay-src <lower> --overlay <upper> <work> <lower> --unshare-all --share-net --die-with-parent`): `stat` on every file under `<upper>` and `<work>` (including `<work>/work`, overlayfs's internal scratch subdir, mode `000`) showed the invoking uid, not an unmapped one. `rm -rf` on the whole tree from that same uid, no bwrap wrapper, exited 0. This contradicts the "Namespace-owned leftovers" bullet above as originally written; see its correction.
