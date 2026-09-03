# Taskferry Evolution

This document is a map of how taskferry became the system it is today, and a
reference for copying its useful patterns into another project. It is based on
the complete 313-commit history on `main` from 2026-07-13 through 2026-08-20.
The final section preserves one line for every commit in chronological order.

This is a history and architecture guide, not an API reference. Confirm current
flags and behavior in [the CLI reference](cli-reference.md), [configuration
documentation](config.md), [the daemon guide](daemon.md), and
[the security guide](security.md) before copying an implementation.

## The Shape It Became

Taskferry started as an OpenCode background-run wrapper. It is now a daemon-backed
execution fabric with four boundaries:

1. **Client boundary.** Any shell-capable agent or script can dispatch work and
   receive a task ID immediately. Claude Code, OpenCode, and Codex have native
   integrations, but none is required.
2. **Process boundary.** A private daemon owns worker processes, Unix-socket
   RPC, lifecycle state, cancellation, watchdogs, and recovery after the client
   session disappears.
3. **Filesystem boundary.** Linux dispatches run in a bubblewrap sandbox and,
   by default, a copy-on-write overlay. Worker writes become an inspectable
   changeset rather than an immediate mutation of the target tree.
4. **Judgment boundary.** The result is not the same thing as an accepted
   change. The normal loop is `dispatch`, `wait`, `result --diff`, inspect,
   then `accept` or `reject`.

The original motivation was context isolation. The durable product is broader:
it separates long-running work from the lifetime of the client, provider
selection from task orchestration, worker execution from filesystem mutation,
and model output from human acceptance.

## What Is Worth Copying

### 1. Start with a daemon, not a terminal wrapper

The early commits deliberately moved away from MCP and terminal-pane control.
The daemon owns the child process and observes its real exit event. That gives
the system durable state, cross-terminal retrieval, process-group cancellation,
and a place to put queueing and recovery. A tmux pane can display work; it is a
poor ownership model for work.

### 2. Make the risky boundary explicit

The most important later addition was not another model adapter. It was the
overlay and changeset boundary. A worker can be useful without being trusted.
Copy-on-write execution, explicit binds, a sandbox deny-list, HEAD-drift
handling, and an accept gate make those two questions separate:

- Did the worker produce a useful result?
- Should that result be allowed to land here?

That separation is the main reusable pattern for agent systems that modify code.

### 3. Treat failure as a product surface

Taskferry accumulated named failure reasons, failure details, output-seen
watchdog states, provider-exhaustion detection, resume hints, actionable
changeset errors, and honest terminal status. A crashed worker is not just an
exit code. The operator needs to know whether it never spawned, stopped before
output, stopped after meaningful output, exhausted a provider, lost the target
HEAD, or produced a changeset that could not be applied.

### 4. Add observability before adding more automation

Lifecycle events, `tail`, `watch --task-id`, `wait --summarize`, activity
summaries, `doctor --stats`, telemetry classes, final-marker parsing, and
latency profiling turned a background queue into something operable. The
system can now be watched, queried, summarized, and audited without reading raw
logs as a completion protocol.

### 5. Put configuration on all useful surfaces

The project converged on flag > environment > config > default precedence for
tunable behavior. It also added `TASKFERRY_ENV_FILE` for unattended callers,
live reload for that file, caller-environment forwarding for provider
credentials, an environment deny-list, per-provider concurrency/rate limits,
and project-local `.taskferry.toml` verification gates.

### 6. Keep the lifecycle above the worker backend

The `WorkerExecutor` abstraction made `pi` and OpenCode implementation details
of the same task lifecycle. That allowed the default executor to change without
rewriting queueing, persistence, sandboxing, result extraction, or the CLI.
Future projects should establish this boundary before adding a second worker
backend.

## Easy-to-Miss Features

These are implemented capabilities that are easy to miss if you only read the
top-level quickstart:

- `TASKFERRY_ENV_FILE` supplies secrets to non-interactive callers and can be
  reloaded without restarting the daemon.
- Caller environment forwarding means a new provider key exported before a
  `dispatch`, `advisor`, or `summary` call is visible on that call. Taskferry
  does not rotate multiple keys; rotation belongs in a caller-side wrapper.
- `TASKFERRY_ENV_DENYLIST` strips named variables from every spawned child,
  including variables forwarded by a caller.
- `.taskferry.toml` can run a settle-time project check before a changeset is
  accepted.
- `--class` and final-marker parsing turn free-form dispatches into telemetry
  cohorts with a machine-checkable completion contract.
- `--parent-task` links a retry or fix-forward task to the task that failed.
- `--rw-bind` and `--ro-bind` make extra filesystem access explicit. The old
  `--allowed-dirs` name remains a deprecated alias for read-write binds.
- `--no-overlay` and `--no-sandbox` are deliberate escape hatches with
  different safety consequences, not interchangeable speed flags.
- `taskferry output` provides a durable per-task scratch directory for files a
  worker needs to return without pretending they are part of the Git diff.
- `--session-id` resumes the worker conversation that did the prior work,
  rather than paying to reconstruct its context in a new session.
- `advisor --summarize-context` can attach caller context to a consultation.
- `watch --task-id` scopes live activity to one task, while fleet watch scopes
  activity by workspace and can flush summaries on an interval.
- `context` emits compact hook-oriented state for session-start integrations.
- `doctor --stats` and optional request-latency profiling make the daemon itself
  observable.
- Worktree-aware directory matching means a repository's main checkout and its
  linked worktrees share task visibility, while unrelated repositories do not.
- The published package includes the skill generator and native integration
  setup, so a fresh project can install the operational layer rather than
  copying an undocumented collection of scripts.

## What Is Not Shipped

Two architectural ideas appear in the history as design documents, not as
implemented product features:

- **Recursive ferry dispatch**: a worker dispatching its own workers. The
  proposal exists, but the history does not contain the corresponding shipped
  implementation.
- **Model/provider tags and routing**: a design for routing work by provider or
  model tags. The specification exists, but it is not evidence that automatic
  routing is available in the current CLI.

Keeping these separate matters. A future reader should not treat a spec, plan,
or archived SDD artifact as a supported command.

## Reusable Build Sequence

The history suggests this order for a future project:

1. Scaffold a normal CLI and a daemon with durable task IDs.
2. Add real process ownership, cancellation, persistence, and settlement.
3. Add structured output and dependency-injected tests before broad integrations.
4. Add lifecycle events, activity retrieval, and failure classification.
5. Add native integrations only after the shell interface is useful by itself.
6. Add executor abstraction before adding a second worker backend.
7. Add configuration precedence and non-interactive secret loading.
8. Add sandboxing, overlays, bind controls, changeset extraction, and acceptance
   gates before treating worker writes as trusted.
9. Add provider-specific concurrency, telemetry, and project verification.
10. Add documentation audits, release automation, and copyable skills after the
    operational loop is stable.

The order is not a law, but it reflects the actual risk curve. Taskferry became
trustworthy when filesystem mutation and failure handling received the same
design attention as model dispatch.

## Complete Commit Ledger

One line per commit, oldest first. Merge and documentation commits remain in the
ledger because they explain when a behavior was integrated, documented, or
deliberately retired.

- `a336b88` | 2026-07-13 | chore: scaffold opencode-cc-tool package
- `333d255` | 2026-07-13 | feat(tasks): add background dispatch, status, and result tracking for opencode runs
- `1d37875` | 2026-07-13 | feat(server): expose opencode_dispatch/status/result/list as MCP tools
- `4e4cb34` | 2026-07-13 | test: add stdio smoke-test client for the MCP server
- `f7eb609` | 2026-07-13 | docs: add README covering rationale, tools, design notes, and setup
- `305e486` | 2026-07-13 | fix(tasks): stop concatenating every step's narration into opencode_result
- `bbde278` | 2026-07-13 | docs: writing-clearly pass on README
- `b3d2535` | 2026-07-13 | feat: add opencode_cancel and opencode_wait tools
- `1ed3bd3` | 2026-07-13 | docs: document opencode_cancel, opencode_wait, and push-notification findings
- `a5a3933` | 2026-07-13 | feat(tasks): switch tool output to TOON and add dependency-injected test coverage
- `e359067` | 2026-07-13 | fix(tasks): show promptTotalChars when promptPreview is truncated
- `1344947` | 2026-07-13 | feat(wait): include output tail on timeout
- `58c5293` | 2026-07-13 | Add safe task summaries and selective results (#2)
- `bd5c159` | 2026-07-14 | refactor: rename package and MCP tools from opencode-cc-tool to taskferry (#3)
- `7503c6d` | 2026-07-14 | feat(status): report log write activity to spot stuck tasks (#4)
- `0d944df` | 2026-07-14 | feat(taskferry): add taskferry_advisor, rename taskferry_wait to taskferry_poll (#5)
- `95416d5` | 2026-07-14 | feat: lean tool output + CI/lint/typecheck quality gates (#7)
- `cbf670a` | 2026-07-14 | feat(taskferry): dispatch reliability - locking, concurrency cap, watchdog, key slots (#6)
- `8a3b3d6` | 2026-07-15 | fix(taskferry): address remaining GLM-5.2 review findings from PR #6 (#8)
- `3e8c9ed` | 2026-07-15 | merge: integrate origin/main (PR #8 watchdog fixes) (#9)
- `94fd319` | 2026-07-15 | docs: define taskferry AXI architecture
- `fa10e04` | 2026-07-15 | docs: address task 1 review findings
- `c8742df` | 2026-07-15 | feat(core): emit task lifecycle events
- `067b67d` | 2026-07-15 | fix(core): surface swallowed onEvent observer failures
- `187e781` | 2026-07-15 | fix(core): guard onEvent failure diagnostic against its own errors
- `5428d6f` | 2026-07-15 | feat(daemon): add persistent local task service
- `67b0c06` | 2026-07-15 | docs: require strict per-worktree task isolation, no repo/branch grouping
- `455758e` | 2026-07-15 | fix(daemon): stop destroying sockets on backpressure
- `e831281` | 2026-07-15 | fix(tasks): don't let a gracefully-exiting SIGTERM'd child mask provider exhaustion
- `6afba07` | 2026-07-15 | fix(tasks): surface provider exhaustion status reliably (#10)
- `839526f` | 2026-07-15 | feat(cli): replace MCP server with AXI commands
- `354e43e` | 2026-07-15 | fix(cli): migrate stale MCP hints in active result output
- `a6b621a` | 2026-07-15 | feat(events): add summarized task activity streams
- `7ab86d3` | 2026-07-15 | feat(claude): add task activity monitor plugin
- `59f0f14` | 2026-07-15 | fix(claude): report a structured error when taskferry context fails
- `41f9698` | 2026-07-15 | fix(claude): quote CLAUDE_PROJECT_DIR correctly in the SessionStart hook
- `75066f4` | 2026-07-15 | test(claude): execute the missing-taskferry hook branch and fix report count
- `19d7185` | 2026-07-15 | feat(opencode): add native task activity plugin
- `f1f5674` | 2026-07-16 | feat(codex): add lifecycle context plugin
- `91a4e57` | 2026-07-16 | test: exercise CLI and daemon integration
- `80e9695` | 2026-07-16 | docs: document AXI CLI and agent integrations
- `f1e5b99` | 2026-07-16 | fix(taskferry): close activity, summary-wait, and terminal-task edge cases
- `d3ab380` | 2026-07-16 | Merge remote-tracking branch 'origin/main' into worktree-taskferry-axi-cli
- `899c37f` | 2026-07-16 | fix(daemon): close inode-reuse race in stale-socket identity check
- `cde4e6a` | 2026-07-16 | Merge pull request #20 from jeremysball/worktree-taskferry-axi-cli
- `dbfcc6c` | 2026-07-16 | docs(setup): define PATH installer
- `411b230` | 2026-07-16 | docs(setup): define dependency bootstrap
- `e742ad1` | 2026-07-16 | docs(setup): automate native integrations
- `8cd5201` | 2026-07-17 | fix(tasks): make wait hang until settlement, keep --timeout-ms as an override
- `bd011cb` | 2026-07-17 | test(tasks): cover uncapped poll timeouts
- `2fa223a` | 2026-07-17 | chore(lint): update stale MCP-server comment in eslint config
- `414ef2b` | 2026-07-17 | test(tasks): pair mock.timers enable with reset inside try/finally
- `a371a13` | 2026-07-17 | feat(tasks): plumb post-output no-output timeout option
- `b36158d` | 2026-07-17 | feat(tasks): escalate no-output watchdog after first log event
- `b208bc2` | 2026-07-17 | fix(cli): resolve symlinked entrypoint before the direct-execution guard
- `1d46a60` | 2026-07-17 | feat(setup): install local integrations
- `7c8b0e7` | 2026-07-17 | docs(sdd): add task 1 report for setup service and symlink guard fix
- `d189238` | 2026-07-17 | chore(config): drop deleted src/server.js from tsconfig include
- `0d19c7d` | 2026-07-17 | chore(sdd): keep SDD process artifacts out of version control
- `df72c2e` | 2026-07-17 | feat(cli): bootstrap local setup
- `23bde46` | 2026-07-17 | test(cli): cover setup failure and arg-parsing edge cases
- `93abab5` | 2026-07-17 | docs(setup): document local installation
- `ff0a3f6` | 2026-07-17 | docs(setup): remove stale "taskferry setup doesn't exist" claim
- `db5309c` | 2026-07-17 | fix(tasks): wait hangs until settlement; escalate no-output watchdog (#21)
- `3afed6e` | 2026-07-17 | feat(setup): bootstrap local CLI, symlinks, and native integrations (#22)
- `a48b202` | 2026-07-17 | docs(plans): consolidate completed and unready plans
- `680e8fa` | 2026-07-17 | docs(skill,todo): update skill guidance and create master todo tracker
- `35287ee` | 2026-07-17 | fix(tasks): remove silent 45s clamp on wait/poll timeout
- `59e91ef` | 2026-07-17 | Merge worktree-wait-hang-and-plan-fixes
- `6206e3f` | 2026-07-17 | Merge feat/taskferry-setup
- `ca115b1` | 2026-07-17 | docs(todo): mark Tier 0 items shipped after worktree reconciliation
- `cb00233` | 2026-07-17 | docs(specs): design task-scoped live summary streaming
- `4128151` | 2026-07-17 | docs: add sourcemap for newcomers and agents
- `03bd093` | 2026-07-17 | docs(specs): simplify summarizer task-scoping to client-side filter
- `4970bdd` | 2026-07-17 | docs(plans): add implementation plan for watch --task-id and wait --summarize
- `39fbfda` | 2026-07-17 | docs(specs): remove unused onEvent callback from streaming helper spec
- `3172ed8` | 2026-07-17 | refactor(commands): extract streamTaskEvents from watchCommand
- `3c548d6` | 2026-07-17 | fix(commands): use tmpdir instead of hardcoded path in commands.test.js
- `d93b356` | 2026-07-17 | feat(commands): filter streamTaskEvents to one task and auto-resolve on its terminal event
- `caaa8a5` | 2026-07-17 | fix(commands): print terminal event before resolving in streamTaskEvents
- `4646d4d` | 2026-07-17 | feat(cli): add watch --task-id to scope live streaming to one task
- `91b2469` | 2026-07-17 | feat(cli): add wait --summarize for live periodic progress summaries
- `ce13f2d` | 2026-07-17 | docs: document watch --task-id and wait --summarize
- `e7fc063` | 2026-07-17 | fix(commands): address final review findings on wait --summarize
- `6c837fe` | 2026-07-17 | fix(test): wire commands.test.js into the test:unit script
- `94709bf` | 2026-07-17 | docs(sdd): correct task-4 and task-5 reports to match shipped work
- `44b12c7` | 2026-07-17 | fix(commands): resolve wait --summarize and watch --task-id hangs on settled tasks
- `cfc45cc` | 2026-07-17 | Merge pull request #23 from jeremysball/worktree-taskferry-summarizer
- `403fbf5` | 2026-07-17 | fix(tasks,commands): restore ambient summary key on collision, skip aborted trailing status RPC
- `2a2fc44` | 2026-07-17 | Merge pull request #24 from jeremysball/fix/summarize-followups
- `db4c322` | 2026-07-17 | fix(tasks): error classification, failureDetail, resume hints (#25)
- `88063bd` | 2026-07-17 | fix(tasks): raise post-output no-output watchdog to 10 minutes (#27)
- `2f75358` | 2026-07-17 | fix(tasks): switch default summary model off the unresponsive deepseek-v4-flash (#29)
- `3b58e6f` | 2026-07-17 | fix(commands): warn in doctor when the Claude plugin isn't installed (#26)
- `3613218` | 2026-07-17 | fix(tasks,output): make streamed activity summaries diff-aware and compact (#28)
- `4163130` | 2026-07-18 | feat(config): add JSON config file with env > config > default precedence (#41)
- `17b66ae` | 2026-07-19 | Scope claude-monitor watch to originating Claude Code session (#42)
- `156965b` | 2026-07-19 | fix(cleanup): consolidate duplicated dir/error/narration/number helpers (#43)
- `3b95587` | 2026-07-17 | feat(skills): rename taskferry skill to using-taskferry
- `914d486` | 2026-07-18 | feat(daemon): add idle-deferred self-restart on source change
- `a51e000` | 2026-07-18 | feat(activity): include truncated tool calls in narration summaries
- `4e816da` | 2026-07-18 | refactor(activity): rename activity-summary throttle to summarizer timeout
- `bc6d1e5` | 2026-07-19 | docs(skill): sync canon using-taskferry with model-tiering and Monitor-pattern sections
- `ecac037` | 2026-07-19 | chore: ignore .claude/ and scratch redteam-findings plan
- `2605b76` | 2026-07-19 | Merge pull request #44 from jeremysball/chore/converge-main-with-origin
- `6b1f143` | 2026-07-20 | fix(setup): use git-hash comparison to detect stale Claude plugin installs (#64)
- `345e063` | 2026-07-20 | docs(plans): record 2026-07-19 efficiency red-team pass findings
- `be375c6` | 2026-07-20 | fix(activity): reduce default activity-summary call rate
- `677ba46` | 2026-07-20 | chore(docs): migrate superpowers plans/specs to .superpowers/
- `8a472a1` | 2026-07-20 | feat(output): colorize status text when writing to a TTY
- `38304ee` | 2026-07-20 | Merge pull request #66 from jeremysball/chore/superpowers-migration-and-tty-color
- `448bbe2` | 2026-07-21 | docs(skill): move generic dispatch rules into using-taskferry canon (#69)
- `2ec78a7` | 2026-07-21 | fix(tasks): classify unrecognized structured error events (#68)
- `fab05e1` | 2026-07-21 | feat: rename summary --style to --mode; fail fast on summarizer failure (#72)
- `e4a55f6` | 2026-07-21 | feat(setup): canonize taskferry statusline segment as tf-sl (#74)
- `7748347` | 2026-07-22 | docs: refresh README and daemon-restart spec (#80)
- `5c83d0a` | 2026-07-22 | feat(doctor): add Playwright MCP isolation checks and repairs (#76)
- `1a4f646` | 2026-07-22 | fix(dispatch): resolve prompt-size, credential, and trailing-error failures (#83)
- `2ee3d17` | 2026-07-22 | perf(doctor): run health checks concurrently instead of sequentially
- `8755968` | 2026-07-22 | fix(wait): apply a default timeout instead of blocking forever
- `9726d5a` | 2026-07-22 | fix(activity): route each subscriber its own requested summary variant
- `c076b91` | 2026-07-22 | Merge pull request #88 from jeremysball/chore/doctor-parallel-checks
- `02c4f15` | 2026-07-22 | Merge branch 'main' into fix/wait-default-timeout
- `421d0e3` | 2026-07-22 | Merge pull request #89 from jeremysball/fix/wait-default-timeout
- `d115c5d` | 2026-07-22 | Merge branch 'main' into fix/per-subscription-activity-summaries
- `191b066` | 2026-07-22 | Merge pull request #90 from jeremysball/fix/per-subscription-activity-summaries
- `7333b64` | 2026-07-22 | fix(watch): remove claude-monitor live-activity notification feature
- `37cf2e0` | 2026-07-22 | fix(watch): drop unreachable originSessionId subscription plumbing
- `07d0910` | 2026-07-22 | test(commands): cover the pre-dispatch skill:check gate
- `6f942c1` | 2026-07-22 | docs(skill): document verifying a worker's claimed commit
- `3f194ed` | 2026-07-22 | Merge pull request #92 from jeremysball/finish-issue-87
- `0846614` | 2026-07-23 | fix(daemon): remove unreachable setActivitySummarySubscriptions fallback (#105)
- `b6392c5` | 2026-07-23 | refactor: extract shared defaultRunCommand helper (#106)
- `0968c1c` | 2026-07-23 | refactor: extract shared isObject helper into numbers.js (#107)
- `748d362` | 2026-07-23 | refactor: remove dead export getActivitySubscriptionsForDir (#108)
- `0954394` | 2026-07-23 | refactor: extract shared normalizeDirectory helper to paths.js (#109)
- `4913a2b` | 2026-07-23 | fix(tasks): scan readSessionIdFromLog incrementally instead of buffering the whole log (#110)
- `bdab274` | 2026-07-23 | fix(sandbox): bind a git worktree's real gitdir read-write, add allowedDirs (#111)
- `1777b4e` | 2026-07-23 | Cleanup day: batch fix for 12 straightforward issues (#112)
- `f929719` | 2026-07-24 | feat(executor): add WorkerExecutor abstraction foundation (#119)
- `c23aeb7` | 2026-07-24 | fix(tasks): remove taskferry-summary opencode agent isolation mechanism (#120)
- `bd5dfcb` | 2026-07-24 | feat(cli): wire WorkerExecutor through startTask and CLI (#121)
- `1726e1d` | 2026-07-24 | feat(config): promote wait timeout, cancel grace, and default executor to config (#122)
- `4607954` | 2026-07-24 | docs(specs): add sonarjs lint ratchet design
- `6d3fefe` | 2026-07-24 | docs(plans): add sonarjs lint ratchet implementation plan
- `7c3c9dd` | 2026-07-24 | fix(advisor): report actual queued/running status instead of hardcoding running
- `07236fc` | 2026-07-24 | fix(plan): address advisor review findings on sonarjs lint ratchet plan
- `d4f9b79` | 2026-07-24 | fix(executor): set OPENCODE_DB in sandbox env so opencode uses isolated DB
- `d45428b` | 2026-07-24 | Merge pull request #123 from jeremysball/fix/sandbox-opencode-db-path
- `8e32f7e` | 2026-07-24 | fix(daemon): detached-boot auto-start, drop redundant OPENCODE_DB override (#129)
- `85de281` | 2026-07-25 | docs/fix: heredoc stdin for prompts, sandboxed worker cache fix, config plumbing (#140)
- `4b93b70` | 2026-07-26 | docs: fix accumulated drift from rounds 2-8 of taskferry audits (#141)
- `eb53402` | 2026-07-26 | fix(sandbox): bind pi's real extensions dir read-only into the sandbox (#142)
- `37acdee` | 2026-07-26 | fix: issue triage batch 1 (crash-safety, memory leak, stdin hang, shell injection) (#194)
- `a647913` | 2026-07-27 | fix(tasks): sum tokens/cost across every step_finish, not just the last (#202)
- `c52da51` | 2026-07-28 | fix(setup): normalize defaultRunCommandAsync's exit-code shape to match spawnSync (#215)
- `bc43a8c` | 2026-07-28 | chore: fix version drift, add release-please for automated version bumps (#216)
- `8570627` | 2026-07-28 | chore(main): release taskferry 2.1.0
- `993736c` | 2026-07-28 | ci: retrigger required status checks
- `0a98a52` | 2026-07-28 | Merge pull request #217 from jeremysball/release-please--branches--main--components--taskferry
- `2173554` | 2026-07-28 | ci(release): use a scoped PAT so release-please PRs trigger required checks (#218)
- `2949f04` | 2026-07-28 | fix(setup): tighten managed-symlink guard to the exact checkout in use (#213)
- `c29a427` | 2026-07-28 | docs: add npm-package spec, reorganize completed .superpowers docs (#220)
- `97a5497` | 2026-07-28 | feat(executor): make pi the default executor instead of opencode (#198)
- `22067f3` | 2026-07-28 | feat(args): duration-string flags (#223)
- `fbb5694` | 2026-07-28 | feat(fleet-monitor): git-workspace-scoped directory defaults + watch --flush-interval (#225)
- `26309e4` | 2026-07-28 | fix(sandbox): scope a worktree dispatch's git-common-dir bind to shared data only (#227)
- `d9040f7` | 2026-07-28 | docs: refresh sourcemap and require keeping it in sync (#228)
- `f48ef2f` | 2026-07-29 | fix(release): sync plugin manifests to 2.1.0, wire into release-please (#240)
- `656d9da` | 2026-07-29 | feat: replace key-slot system with caller-env forwarding (#241)
- `6c2c6cf` | 2026-07-29 | docs(skill): drop per-ferry Monitor in favor of fleet-wide watch (#247)
- `4109293` | 2026-07-31 | refactor: deduplicate bwrap availability checks (#199)
- `032ac5b` | 2026-07-31 | feat(sandbox): copy-on-write overlays and diff-gated writes (#251)
- `6eb60ad` | 2026-07-31 | chore: archive completed CoW plans/specs; note tmpRoot cleanup limitation (#254)
- `f9f279f` | 2026-07-31 | fix(tasks): surface boot-crash stderr as failureReason instead of silent null (#255)
- `9433ae3` | 2026-07-31 | chore: sync three local-only docs and plan commits to main (#256)
- `e017001` | 2026-07-31 | fix(sandbox): stop unsharing network on advisor spawns (#257)
- `04d5e48` | 2026-07-31 | fix(tasks): stop overlay tests from scanning and acting on real host /tmp (#258)
- `498952c` | 2026-07-31 | fix(sandbox): bind writable git-common-dir files as scratch copies, not sub-overlays (#259)
- `9da0167` | 2026-07-31 | fix(sandbox): deny ~/.claude by default, make the deny-list configurable (#264)
- `1303b9a` | 2026-07-31 | fix(skill): disambiguate the fleet-watch log path per workspace (#268)
- `f0d27ff` | 2026-07-31 | docs(advisor): add spec for auto-context-dump advisor design (#260)
- `c054dfa` | 2026-07-31 | fix(changeset): refuse to extract a diff when the directory's HEAD has moved since dispatch (#262)
- `7c6e69e` | 2026-07-31 | feat(advisor): auto-attach caller context, --summarize-context (advisor-context-dump plan) (#266)
- `5bbe015` | 2026-07-31 | chore: archive completed advisor-context-dump plan/spec (#270)
- `653fea6` | 2026-07-31 | fix(advisor): prompt caller's --prompt ahead of canned pushback framing (#271)
- `881107e` | 2026-08-01 | feat(doctor): add taskferry doctor --stats (#272)
- `1886fdf` | 2026-08-01 | fix(statusline): never let tf-sl trigger daemon autostart (#279)
- `08be50a` | 2026-08-01 | fix(daemon): treat XDG_RUNTIME_DIR as canonical even when unexported (#280)
- `3fec57d` | 2026-08-01 | feat(config): add TASKFERRY_ENV_FILE for non-interactive callers with missing secrets (#284)
- `e5be588` | 2026-08-01 | fix(tasks): scope overlayTmpRoot under runtimeDir to stop cross-daemon sweep collisions (#288)
- `1f06572` | 2026-08-01 | fix(changeset): overlay cleanup can't strand upper/ on kernel whiteout (#278)
- `88a9387` | 2026-08-01 | feat(config): live-reload TASKFERRY_ENV_FILE/envFile instead of requiring a restart (#291)
- `0256d75` | 2026-08-01 | refactor(paths): extract resolveInvokedPath into shared paths.js (#274)
- `edd2111` | 2026-08-01 | perf(tasks): build filtered env in one pass instead of spread+delete (#275)
- `52eaac9` | 2026-08-01 | perf(config): cache parsed config instead of re-reading on every call (#276)
- `ed0020b` | 2026-08-01 | refactor(args): collapse flag-parsing structures into one declarative spec (#277)
- `4d6c4cf` | 2026-08-01 | fix(daemon): stop task.list/context from scanning every historical task (#294)
- `b5789cd` | 2026-08-01 | fix(daemon): back off between prepareSocket retries to stop a busy-spin under boot contention (#285)
- `ddf63fd` | 2026-08-01 | fix(advisor): correct misleading transcript-error hint about --prompt
- `f3b1d9d` | 2026-08-01 | fix(advisor): extract only user/assistant text from the Claude transcript (#295)
- `7da0f91` | 2026-08-01 | fix(daemon): forward whole params to task.wait/task.result instead of rebuilding field lists (#296)
- `dc6177d` | 2026-08-01 | fix: cap unbounded task-list payloads and settle advisor changesets correctly (#297)
- `2d75153` | 2026-08-01 | fix(daemon): debounce persistTask() writes instead of full rewrite per transition (#298)
- `6232710` | 2026-08-01 | feat(daemon): opt-in request-latency profiling with log rotation (#301)
- `b232985` | 2026-08-03 | perf(activity): hoist sanitizeActivityText's regexes to module scope (#307)
- `64c43bd` | 2026-08-03 | refactor(args): compose parseNumber() from numbers.js's integer helper (#308)
- `fd26b57` | 2026-08-03 | refactor(output): collapse errorValue()'s three passes into one (#309)
- `de786e0` | 2026-08-03 | fix(mcp-isolation): stop stripJsonComments's string match from crossing lines (#310)
- `579b1f0` | 2026-08-03 | docs(sourcemap): sync line counts for files touched by #164/#169/#171/#174 (#311)
- `e0851bc` | 2026-08-03 | docs(skills): tighten using-taskferry per skill-optimizer pass (#319)
- `9a0a390` | 2026-08-03 | fix(lint)!: promote sonarjs and maintainability rules to hard errors (#303)
- `66062f0` | 2026-08-03 | docs: codify filter-then-process ordering in CLAUDE.md (#317)
- `955b948` | 2026-08-03 | docs(skill): forbid reading raw ndjson logs instead of taskferry tail (#313)
- `d219b09` | 2026-08-03 | chore(skills): bump fleet-watch flush-interval default to 15m (#312)
- `640059b` | 2026-08-03 | docs: isolate own taskferry dev/test dispatches from the shared daemon (#290)
- `3bc845f` | 2026-08-03 | docs(plan): track the max-effort whole-codebase review (#305)
- `64cae69` | 2026-08-03 | docs(skills): fix fleet-watch guidance to scope by exact dispatch directory (#314)
- `2db1081` | 2026-08-03 | fix(commands): report real package version in doctor --full output (#306)
- `285c7a3` | 2026-08-04 | fix(tasks): stagger launches globally and surface overlay_mount_busy (#318) (#321)
- `55de14e` | 2026-08-04 | docs(skill): forbid shell-backgrounding taskferry wait (nohup, &, disown) (#322)
- `88a38d1` | 2026-08-04 | docs(sandbox): document /tmp invisibility inside the sandbox (#323)
- `bf46637` | 2026-08-04 | chore(plans): track the axi-audit-fixes plan as completed (#324)
- `1521f5d` | 2026-08-04 | feat(config): live-reload TASKFERRY_ENV_FILE/envFile instead of requiring a restart (#320)
- `7e3232d` | 2026-08-04 | chore(main): release taskferry 3.0.0 (#219)
- `b806ae4` | 2026-08-04 | fix(output): trim overlayDirs internals out of `status --full` (#330)
- `9c94513` | 2026-08-04 | fix(changeset): retry extraction bwrap on the overlay-mount-busy race (#326) (#327)
- `af62f76` | 2026-08-04 | fix(changeset): re-check HEAD after retry and inject a fast test sleepFn (#333)
- `2d5c286` | 2026-08-04 | fix(daemon): make watch/list/context directory filtering worktree-aware, add watch --all (#334)
- `5b3f837` | 2026-08-05 | feat(dispatch): tranche 2 telemetry instrumentation (--class tag + finalStatus parsing) (#340)
- `eb685c6` | 2026-08-05 | docs(cli): specify prompt stdin help (#341)
- `2860818` | 2026-08-05 | fix(tasks): split no_output_timeout by output-seen, recover crashed-but-completed tasks (#345)
- `b8b3bf9` | 2026-08-05 | chore(plans): archive shipped plans/specs, commit outstanding SDD scratch state (#347)
- `49d896a` | 2026-08-05 | fix(tasks): match --require-final-marker across a multi-paragraph message (#339)
- `89988a3` | 2026-08-06 | fix(daemon): doctor --stats connection-closed bug + doctor output formatting (#332)
- `ee6ce40` | 2026-08-06 | feat: stale-base 3-way apply and honest terminal status (#353)
- `003d9bf` | 2026-08-06 | docs(sdd): archive completed stale-base 3-way apply plan (#355)
- `44e657e` | 2026-08-06 | fix(changeset): set an explicit maxBuffer on defaultRunCommand's spawnSync (#361)
- `0080dea` | 2026-08-06 | fix(ci): collapse check workflow into a single job to fix runner contention
- `566a331` | 2026-08-06 | feat(cli): prettified TTY output via a shape-based renderer (#367)
- `a24b548` | 2026-08-06 | docs(sdd): archive completed prettified-cli-output plan and spec
- `f0b09ba` | 2026-08-06 | feat: .taskferry.toml project config with settle-time verification gate (#352)
- `98cf743` | 2026-08-06 | docs(sdd): archive completed check-gate-project-config plan and spec (#371)
- `cc5cecc` | 2026-08-06 | fix(tests): close the test-suite's own /tmp temp-dir leak (#368)
- `e0056ed` | 2026-08-06 | fix(test): route integration smoke tests through OpenRouter, not direct minimax (#364)
- `062563c` | 2026-08-06 | fix(tasks): close remaining gaps in the any-growth watchdog activity signal (#360)
- `f49d787` | 2026-08-07 | fix(sandbox): give opencode a writable config home inside the sandbox (#390)
- `c1e8e1c` | 2026-08-07 | docs: task-first README rewrite and MIT license (#389)
- `30eefc8` | 2026-08-07 | fix(npm): ship scripts/generate-skill.js in the published package (#393)
- `6d20aab` | 2026-08-07 | chore(main): release taskferry 3.1.0
- `530420a` | 2026-08-07 | ci(check): use mise to install Node, matching the repo's .mise.toml pin (#394)
- `ae67ad9` | 2026-08-07 | chore: merge main into release-please branch to satisfy branch protection
- `f18766f` | 2026-08-07 | Merge pull request #331 from jeremysball/release-please--branches--main--components--taskferry
- `9b82527` | 2026-08-07 | docs: fix drift found in a full doc-accuracy audit against v3.1.0 (#396)
- `af58c0a` | 2026-08-08 | docs: provider-concurrency design spec, plan, and two cleanups (#402)
- `94e5229` | 2026-08-08 | docs(skills): three corrections to the using-taskferry skill (#411)
- `f2ce2c4` | 2026-08-09 | feat(tasks): per-provider concurrency and dispatch-rate limits (#413)
- `8d4e1ee` | 2026-08-09 | docs: retire the sourcemap, keeping its gotchas section in daemon.md (#419)
- `6bf3e06` | 2026-08-09 | docs(superpowers): un-archive the prompt-stdin spec and track the orphan-resumption plan (#422)
- `bb77329` | 2026-08-09 | chore(main): release taskferry 3.2.0 (#421)
- `bdbd8c8` | 2026-08-09 | feat(sandbox): add --ro-bind, rename --allowed-dirs to --rw-bind (#401)
- `ee0184f` | 2026-08-10 | fix(tasks): tighten parseNumstatLine to reject non-integer/non-finite numstat tokens (#417)
- `ab50d93` | 2026-08-11 | perf(statusline): cache Taskferry refreshes (#441)
- `975f3fc` | 2026-08-10 | docs(superpowers): add highest-thinking-default plan and design spec (#444)
- `99f3576` | 2026-08-10 | refactor(statusline): tf-sl emits raw fields, drops width/mode rendering (#445)
- `fbc1b4e` | 2026-08-11 | ci: add workflow_dispatch trigger to check.yml (#448)
- `230fc77` | 2026-08-11 | docs(skills): split using-taskferry into SKILL.md plus resources (#446)
- `085ef7c` | 2026-08-11 | fix(skills): correct four defects in using-taskferry and add executable tests
- `fd1b2f5` | 2026-08-11 | feat(tasks)!: require --model on dispatch, default omitted --variant to highest-thinking (#435)
- `6ed2128` | 2026-08-11 | chore(superpowers): archive the shipped highest-thinking-default plan and spec (#450)
- `b56fb3f` | 2026-08-11 | feat(types): typecheck the whole of src/, not just tasks.js (#400)
- `29ae066` | 2026-08-12 | docs(skills): flag that bare --timeout values are milliseconds (#407)
- `070f32c` | 2026-08-12 | fix(sandbox): narrow the runtime-dir bind to the daemon socket only (#457)
- `02d637d` | 2026-08-12 | fix(tests): remove the undefined/ gitignore bandaid at its root (#463)
- `83eef89` | 2026-08-12 | chore(main): release taskferry 4.0.0
- `082ca12` | 2026-08-12 | ci: disable opencode's title agent in the integration leg (#451)
- `1e4f61a` | 2026-08-12 | docs(skill): document accept's clean-tree requirement and failure mode (#462)
- `f780205` | 2026-08-12 | docs: add CONTRIBUTING.md, restoring conventions orphaned by the sourcemap retirement (#436)
- `343b5c9` | 2026-08-12 | docs(superpowers): track the recursive ferry orchestration design spec (#456)
- `3733dca` | 2026-08-12 | Merge remote-tracking branch 'main' into release-please--branches--main--components--taskferry
- `62e0d8a` | 2026-08-12 | docs(changelog): surface skill and statusline changes in the 4.0.0 notes
- `d303e7b` | 2026-08-12 | Merge pull request #428 from jeremysball/release-please--branches--main--components--taskferry
- `81a4f29` | 2026-08-12 | docs(claude): commit skill changes as fix/feat, not docs
- `cec5e51` | 2026-08-12 | Merge pull request #464 from jeremysball/docs/skill-commit-convention
- `ac1d1aa` | 2026-08-13 | docs: welcome agentic PRs and expand contribution guidance (#469)
- `4f28cce` | 2026-08-13 | fix(daemon): extract shared emptyStatusCounts helper (#466)
- `89b5fc7` | 2026-08-13 | fix(daemon): reuse errorValue() in responseError() (#467)
- `84b4706` | 2026-08-13 | fix(sandbox): dedupe bwrap availability check logic (#468)
- `b5505cc` | 2026-08-13 | test(tasks): dedupe fakeExecutor literals via shared helper (#470)
- `5a31a7c` | 2026-08-14 | fix(sandbox): skip symlinked opencode config entries when ro-binding (#475)
- `df2ccb6` | 2026-08-14 | fix(sandbox): snapshot a worktree's private gitDir instead of live-overlaying it (#476)
- `8d56d61` | 2026-08-14 | fix(sandbox): persist overlay record before spawning the child (#477)
- `dd3e382` | 2026-08-14 | fix(daemon): resolve workspace root before scheduleActivityFor's subscription lookup (#479)
- `fdc2f94` | 2026-08-14 | fix(cli): accept exits nonzero on failed apply; result --diff size errors are actionable (#472)
- `434c075` | 2026-08-14 | feat(daemon): add per-task writable scratch dir for durable deliverables (#474)
- `2628f7d` | 2026-08-14 | fix(daemon): cap list --all rows server-side so all-time history can't kill the connection (#473)
- `d693d42` | 2026-08-16 | chore: add lint/typecheck/test/check mise tasks (#486)
- `51988a7` | 2026-08-16 | docs: expand CONTRIBUTING.md (#485)
- `3a8230a` | 2026-08-16 | fix(skills): resume the prior ferry's session for follow-up work (#465)
- `3656e7b` | 2026-08-16 | chore(main): release taskferry 4.1.0
- `cf7a10e` | 2026-08-16 | docs(adr): propose recursive ferry dispatch spec (MVP + first-class design) (#480)
- `516baff` | 2026-08-17 | Merge branch 'main' into release-please--branches--main--components--taskferry
- `7449b02` | 2026-08-17 | Merge pull request #471 from jeremysball/release-please--branches--main--components--taskferry
- `bd4284a` | 2026-08-18 | fix(executor): resolve symlinked opencode config entries instead of dropping them (#492)
- `9026971` | 2026-08-18 | docs(adr): reject native tool-spec exposure for opencode/kilo plugins
- `f9aaf1f` | 2026-08-18 | docs(adr): correct kilo.md's actual location (PR #489 branch, not main)
- `94b1362` | 2026-08-18 | docs(adr): reject native tool-spec exposure for opencode/kilo plugins (#496)
- `1d4c68c` | 2026-08-19 | docs: add spec for model/provider tags and routing (#498)
- `4a0a367` | 2026-08-20 | fix(output-dir): close symlink escape and traversal issues in task.output (#482)
- `077d979` | 2026-08-20 | fix(tests): stop the tasks.failure watchdog test from racing a fixed sleep (#516)
- `b55a8e4` | 2026-08-20 | fix(output-dir): make sandbox claim conditional on noSandbox flag (#517)
- `55b21fe` | 2026-08-20 | perf(tasks): filter the boot-time output-dir sweep before running lstat/rm per entry (#518)
- `0b7b0ac` | 2026-08-20 | fix(tasks): surface outputDir in taskferry status and result (#519)
