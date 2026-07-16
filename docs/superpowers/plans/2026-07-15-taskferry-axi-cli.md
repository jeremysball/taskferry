# Taskferry AXI CLI Implementation Plan

> **For agentic workers:** Use `subagent-driven-development` for the task-by-task review loop. Its workers run through the `taskferry` skill. Use `executing-plans` only for inline implementation.

**Goal:** Replace taskferry's MCP server with a persistent AXI CLI and native, non-MCP integrations for Claude Code, OpenCode, and Codex.

**Architecture:** A private daemon owns task processes and exposes versioned JSON RPC over a protected Unix socket. The public CLI validates input, calls the daemon, and emits TOON. Native integrations subscribe to workspace-scoped task events without creating another public API. The `taskferry` skill becomes the single external-worker execution contract.

**Tech Stack:** Node.js ESM, `node:test`, Unix sockets, `@toon-format/toon`, Claude Code plugins, OpenCode plugins, Codex plugins and hooks.

## Global Constraints

- Remove MCP completely, including dependencies, tool schemas, server registration, tests, documentation, and MCP configuration.
- Do not provide `taskferry setup`.
- Install integrations through each agent's native plugin or skill mechanism.
- Emit structured data, errors, and help on stdout as TOON.
- Reserve stderr for diagnostics.
- Use exit code `0` for success and idempotent no-ops, `1` for operational errors, and `2` for usage errors.
- Reject unknown commands, arguments, and flags before contacting the daemon.
- Default workspace-scoped commands to the current working directory.
- Normalize workspace paths with `fs.realpathSync`.
- Scope every workspace-filtered command strictly by the realpath of the working directory, never by git repository identity (common-dir, origin URL, or branch name). Two git worktrees of the same repository are distinct workspaces: a task dispatched from one is invisible to `list`/`status`/`watch`/`context` run from another, even though they share history. Do not add a repo-level or branch-level grouping concept anywhere (CLI, daemon, or integrations) — worktree isolation falls directly out of existing directory scoping and must stay that way, with no added surface for the model to reason about.
- Store state under `TASKFERRY_STATE_DIR`, then `XDG_STATE_HOME`, then `~/.local/state/taskferry`.
- Store sockets under `TASKFERRY_RUNTIME_DIR`, then `XDG_RUNTIME_DIR/taskferry`, then the taskferry state directory's `run/` subdirectory.
- Create state and runtime directories with mode `0700`; create files and the socket with mode `0600`.
- Support Linux and macOS in this release. Defer Windows until named-pipe support exists.
- Set `TASKFERRY_CHILD=1` on every dispatched OpenCode child.
- Keep automatic activity summaries bounded and cached. Document them as secondary model-provider calls.
- Do not use Claude Code's Agent tool unless the user explicitly requests a Claude subagent.
- `subagent-driven-development` owns the implementation and review lifecycle. `taskferry` owns all external worker execution.

## Public Commands

| Command | Purpose |
|---|---|
| `taskferry` | Show live workspace tasks and contextual next actions |
| `taskferry dispatch` | Queue a background OpenCode run |
| `taskferry list` | List workspace tasks with counts |
| `taskferry status <id>` | Return task status and activity |
| `taskferry wait <id>` | Wait for settlement or a timeout |
| `taskferry result <id>` | Return the final model result |
| `taskferry tail <id>` | Return recent model text |
| `taskferry summary <id>` | Produce report or activity summaries |
| `taskferry advisor` | Dispatch and wait for a model consultation |
| `taskferry cancel <id>` | Cancel queued or running work |
| `taskferry watch` | Stream workspace task events |
| `taskferry context` | Produce compact session context |
| `taskferry doctor` | Inspect installation and daemon health |
| `taskferry --version` | Print package and protocol versions |

`poll` becomes `wait` because it describes behavior rather than transport. The migration guide must call out this rename.

## File Map

| Path | Responsibility |
|---|---|
| `src/cli.js` | Executable entrypoint and exit-code handling |
| `src/args.js` | Strict per-command parsing and help |
| `src/commands.js` | Public command handlers and projections |
| `src/output.js` | TOON, hook, monitor, and stream formatting |
| `src/client.js` | Daemon connection and auto-start |
| `src/protocol.js` | Internal RPC envelopes and protocol version |
| `src/daemon.js` | Socket server, singleton lifecycle, RPC routing |
| `src/events.js` | Workspace subscriptions and event projection |
| `src/activity.js` | Bounded activity summaries and cache |
| `src/tasks.js` | Existing task lifecycle, queue, parsing, persistence |
| `src/opencode-plugin.js` | Native OpenCode toast and context integration |
| `integrations/claude/` | Claude Code plugin, monitor, hooks, and skill |
| `integrations/codex/` | Codex plugin, hooks, and skill |
| `.claude-plugin/marketplace.json` | Claude marketplace catalog |
| `.agents/plugins/marketplace.json` | Codex marketplace catalog |
| `skills/taskferry/SKILL.md` | Canonical taskferry Agent Skill |
| `scripts/generate-skill.js` | Generate distributed skills from the canonical skill |
| `README.md` | Product overview and quick start |
| `docs/cli-reference.md` | Complete command and output reference |
| `docs/daemon.md` | Process model, socket protocol, and recovery |
| `docs/integrations/claude-code.md` | Claude installation and UX |
| `docs/integrations/opencode.md` | OpenCode installation and UX |
| `docs/integrations/codex.md` | Codex installation and limitations |
| `docs/security.md` | Permissions, environment, logs, and summaries |
| `docs/migrating-from-mcp.md` | Removal and command mapping |
| `docs/troubleshooting.md` | Doctor output and common failures |

## Task 1: Record The Approved Design

**Files:**
- Create: `docs/superpowers/specs/2026-07-15-taskferry-axi-design.md`
- Modify: this plan

1. Record the decisions in this plan, including the absence of `setup` and MCP.
2. Document the daemon boundary, socket security, command surface, event model, summaries, and agent integrations.
3. Record the skill hierarchy: `subagent-driven-development` owns lifecycle; `taskferry` owns worker execution; `CLAUDE.md` selects taskferry as the default backend.
4. Document Claude's static task-panel label, OpenCode's dynamic toast titles, and Codex's lack of a persistent monitor.
5. Search the design and plan for placeholders before committing.
6. Commit: `docs: define taskferry AXI architecture`.

## Task 2: Add Task Events Without Changing Lifecycle Semantics

**Files:**
- Create: `src/events.js`
- Create: `src/events.test.js`
- Modify: `src/tasks.js`
- Modify: `src/tasks.test.js`

**Interfaces:**

```js
createTaskManager({ onEvent: (event) => void, ...existingOptions })

event = {
  sequence,
  type: "task.state" | "task.activity",
  taskId,
  directory,
  status,
  previousStatus,
  occurredAt,
  activity,
  outputWatermark
}
```

1. Write failing tests for `queued`, `running`, `done`, `crashed`, `cancelled`, and `unknown` transition events.
2. Test that repeated persistence cannot emit duplicate transitions.
3. Test that summary jobs are marked internal and excluded from user event streams.
4. Emit `queued` before launch, `running` after spawn, and terminal state after child settlement.
5. Give every event a daemon-lifetime monotonic sequence number.
6. Normalize task directories before persistence and event emission.
7. Preserve queue, watchdog, key-slot, result, and advisor tests.
8. Run `node --test src/tasks.test.js src/events.test.js`.
9. Commit: `feat(core): emit task lifecycle events`.

## Task 3: Implement The Private Daemon Protocol

**Files:**
- Create: `src/protocol.js`
- Create: `src/client.js`
- Create: `src/daemon.js`
- Create: `src/protocol.test.js`
- Create: `src/daemon.test.js`

**Protocol:**

```js
request = { version: 1, id: "request-id", method: "task.dispatch", params: {} }
response = { version: 1, id: "request-id", ok: true, result: {} }
errorResponse = {
  version: 1,
  id: "request-id",
  ok: false,
  error: { code: "UNKNOWN_TASK", message: "unknown task id: oc_123", help: "Run `taskferry list` to see valid task ids" }
}
```

**RPC Methods:**

```text
system.health
task.dispatch
task.cancel
task.status
task.wait
task.list
task.result
task.tail
task.summary
task.advisor
task.context
```

1. Test malformed JSON, unsupported protocol versions, unknown methods, and invalid parameters.
2. Test ordinary one-request connections and long-lived `event.subscribe` streams.
3. Test directory filtering, multiple clients, and disconnect cleanup.
4. Implement a protected Unix socket server.
5. Remove a stale socket only after a health check confirms no daemon accepts connections.
6. Implement auto-start with a lock, detached daemon, bounded retries, and actionable startup failures.
7. Preserve current restart semantics: persisted queued and running tasks become `unknown`.
8. Run `node --test src/protocol.test.js src/daemon.test.js`.
9. Commit: `feat(daemon): add persistent local task service`.

## Task 4: Replace MCP With The AXI CLI

**Files:**
- Create: `src/cli.js`
- Create: `src/args.js`
- Create: `src/commands.js`
- Create: `src/output.js`
- Create: `src/args.test.js`
- Create: `src/cli.test.js`
- Delete: `src/server.js`
- Delete: `src/server.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Argument Contract:**

```text
dispatch --prompt <text> [--directory <path>] [--model <id>] [--variant <name>] [--session-id <id>] [--key-slot <name>]
cancel <id> [--grace-ms <number>]
wait <id> [--timeout-ms <number>] [--tail-chars <number>] [--full]
advisor --prompt <text> --model <id> [--directory <path>] [--variant <name>] [--session-id <id>] [--timeout-ms <number>]
status <id> [--full]
tail <id> [--chars <number>]
summary <id> [--style report|activity] [--max-words <number>] [--wait]
result <id> [--full] [--fields <comma-list>]
list [--directory <path>] [--all] [--limit <number>]
watch [--directory <path>] [--format toon|claude-monitor|ndjson] [--summaries]
context [--directory <path>] [--format toon|claude-hook|codex-hook]
doctor [--full]
```

1. Test each command's required arguments, defaults, valid flags, and concise help.
2. Test unknown flags and extra positional arguments as exit code `2`.
3. Test old MCP names, including `taskferry_poll`, with precise migration hints.
4. Test operational errors as TOON on stdout with exit code `1`.
5. Test no-args output with executable path, description, workspace tasks, counts, and contextual next actions.
6. Test explicit empty workspace output and minimal four-field list rows.
7. Move `leanStatus` and `leanResult` behavior from `server.js` into CLI projections.
8. Point the package binary at `src/cli.js` and package export at `src/opencode-plugin.js`.
9. Remove `@modelcontextprotocol/sdk` and `zod`; retain `@toon-format/toon`.
10. Run `npm install` to update the lockfile.
11. Run `node --test src/args.test.js src/cli.test.js`.
12. Commit: `feat(cli): replace MCP server with AXI commands`.

## Task 5: Add Activity Summaries And Watch Streams

**Files:**
- Create: `src/activity.js`
- Create: `src/activity.test.js`
- Modify: `src/tasks.js`
- Modify: `src/commands.js`
- Modify: `src/output.js`
- Modify: `src/daemon.js`

**Cache Key:**

```text
taskId + status + outputWatermark + summaryModel + maxWords
```

1. Test bounded and Unicode-safe narration snapshots.
2. Test prompt fallback before model output exists.
3. Test one summary request shared by concurrent subscribers.
4. Test cache hits across multiple Claude and OpenCode clients.
5. Test summary jobs never emit visible task events.
6. Test summary failure falls back to sanitized local activity text.
7. Add `TASKFERRY_ACTIVITY_SUMMARIES=0` for fallback-only operation.
8. Add `TASKFERRY_ACTIVITY_MIN_INTERVAL_MS`, default `60000`.
9. Refresh running activity only after 4096 more log bytes or a terminal transition.
10. Emit state transitions immediately, then enriched `task.activity` events.
11. Format Claude monitor events as one line:

```text
Taskferry(running · oc_ab12): Verifying the server with new env vars via Playwright
```

12. Preserve TOON as the default watch output. Permit NDJSON and Claude monitor lines only through `--format`.
13. Run `node --test src/activity.test.js src/cli.test.js src/daemon.test.js`.
14. Commit: `feat(events): add summarized task activity streams`.

## Task 6: Add Claude Code Integration

**Files:**
- Create: `integrations/claude/.claude-plugin/plugin.json`
- Create: `integrations/claude/monitors/monitors.json`
- Create: `integrations/claude/hooks/hooks.json`
- Create: `integrations/claude/skills/taskferry/SKILL.md`
- Create: `.claude-plugin/marketplace.json`
- Create: `src/integrations.test.js`

**Monitor:**

```json
[
  {
    "name": "taskferry",
    "description": "Taskferry task activity",
    "command": "taskferry watch --directory \"${CLAUDE_PROJECT_DIR}\" --format claude-monitor --summaries"
  }
]
```

1. Test plugin manifest and monitor validity.
2. Test SessionStart output uses Claude's `additionalContext` shape.
3. Test startup context contains only the current project.
4. Test monitor lines remain single-line after model output sanitization.
5. Test missing taskferry produces one actionable plugin error.
6. Bundle the canonical taskferry skill. Do not add commands, agents, MCP servers, or channels.
7. Validate with `claude plugin validate ./integrations/claude --strict`.
8. Commit: `feat(claude): add task activity monitor plugin`.

## Task 7: Add Native OpenCode Integration

**Files:**
- Create: `src/opencode-plugin.js`
- Create: `src/opencode-plugin.test.js`
- Modify: `src/tasks.js`
- Modify: `package.json`

**Plugin Hooks:**

```js
{
  dispose,
  event,
  "experimental.chat.system.transform"
}
```

1. Test that `TASKFERRY_CHILD=1` returns an empty hook object.
2. Set `TASKFERRY_CHILD=1` in every dispatched and summary child environment.
3. Test daemon subscription opens once and closes through `dispose`.
4. Test dynamic toast titles such as `Taskferry(done · oc_ab12)`.
5. Map terminal and active state to the correct OpenCode toast variants.
6. Add active tasks and unseen terminal transitions through `experimental.chat.system.transform`.
7. Mark terminal transitions consumed only after they enter a model request.
8. Limit injected context to five rows and include a count when more exist.
9. Log connection failures through `client.app.log` without breaking OpenCode.
10. Run `node --test src/opencode-plugin.test.js`.
11. Commit: `feat(opencode): add native task activity plugin`.

## Task 8: Add Codex Integration And Canonical Skill Distribution

**Files:**
- Create: `skills/taskferry/SKILL.md`
- Create: `integrations/codex/.codex-plugin/plugin.json`
- Create: `integrations/codex/hooks/hooks.json`
- Create: `integrations/codex/skills/taskferry/SKILL.md`
- Create: `.agents/plugins/marketplace.json`
- Create: `scripts/generate-skill.js`
- Modify: `package.json`
- Modify: `src/integrations.test.js`

**Skill Contract:**
- `subagent-driven-development` chooses the worker lifecycle.
- Taskferry selects model, dispatches, waits, retrieves results, handles crashes, and validates deliverables.
- Taskferry starts fresh sessions for separate implementation tasks and reviewers.
- Taskferry resumes only the implementer session for a fix to that same task.
- The skill never presents taskferry as an alternative to Subagent-Driven Development.

**Codex Hooks:**
- `SessionStart` injects current workspace task context.
- `UserPromptSubmit` refreshes compact state before each user turn.
- Do not claim live monitor behavior. Codex has no equivalent persistent monitor surface.

1. Test SessionStart and UserPromptSubmit `additionalContext` payloads.
2. Test the skill contains AXI CLI guidance and no MCP instructions.
3. Generate distributed Claude and Codex skill copies from the canonical source.
4. Add `npm run skill:generate` and `npm run skill:check`.
5. Test stale generated skill detection.
6. Document Codex hook trust through `/hooks` and `[features] hooks = true` only when disabled by the user.
7. Test with an isolated temporary `CODEX_HOME`.
8. Commit: `feat(codex): add lifecycle context plugin`.

## Task 9: Migrate Global Worker Skills And Policy

**Files outside this repository:**
- Create: `~/.claude/skills/taskferry/SKILL.md` from canonical source
- Modify: `~/.config/opencode/skills/subagent-driven-development/SKILL.md`
- Modify: `~/.claude/CLAUDE.md`
- Modify: `~/.claude/skills/deciding-to-dispatch/SKILL.md`
- Modify: `~/.claude/skills/delegate-code-review/SKILL.md`
- Modify: `~/.claude/skills/opencode-research/SKILL.md`
- Modify: `~/.claude/skills/repo-review/SKILL.md`
- Modify: `~/.claude/skills/statistics-rigor/SKILL.md`
- Delete: `~/.claude/skills/using-opencode/`
- Delete: `~/.claude/skills/delegate-to-opencode-attended/`

1. Add a `CLAUDE.md` rule that all SDD implementers, fixers, task reviewers, and final reviewers run through taskferry.
2. Remove the “Delegate to OpenCode” plan-execution option. Keep taskferry-backed SDD and inline execution only.
3. Remove the unnormalized session-token audit claim from governing policy.
4. Replace every active `using-opencode` reference with `taskferry`.
5. Replace all MCP tool examples with `taskferry` CLI commands.
6. Remove all tmux fallback instructions and the retired `run.sh` helper.
7. Preserve SDD's task brief, review package, progress ledger, worktree, task review, and final review rules.
8. Give taskferry the external-worker contracts formerly in `using-opencode`: model selection, dispatch, status, results, sessions, cancellation, and independent deliverable validation.
9. Replace the attended-delegation skill's code-execution references with SDD through taskferry.
10. Update research and code-review skills to invoke taskferry for their worker roles.
11. Test five fresh-context scenarios with taskferry guidance: implementer, fixer, reviewer, researcher, and advisor.
12. Confirm each scenario selects taskferry rather than Claude Code Agent or a direct OpenCode invocation.
13. Delete the retired skill directories only after the scenarios pass.
14. Search governing skills and `CLAUDE.md` for active references to retired names.

## Task 10: Rewrite Integration Smoke Tests

**Files:**
- Rewrite: `src/smoke-test.js`
- Rewrite: `src/cancel-smoke-test.js`
- Rewrite: `src/poll-smoke-test.js`
- Modify: `package.json`

1. Replace MCP clients with CLI invocations.
2. Use isolated state and runtime directories.
3. Verify the daemon survives after the dispatch CLI exits.
4. Verify dispatch, wait, result, list, no-args output, and watch events.
5. Verify cancellation kills the complete process group.
6. Verify short waits return `running` and longer waits settle.
7. Ensure each smoke test shuts down only its isolated daemon.
8. Run `npm run test:integration`.
9. Commit: `test: exercise CLI and daemon integration`.

## Task 11: Remove MCP And Document Everything

**Files:**
- Rewrite: `README.md`
- Create: `docs/cli-reference.md`
- Create: `docs/daemon.md`
- Create: `docs/integrations/claude-code.md`
- Create: `docs/integrations/opencode.md`
- Create: `docs/integrations/codex.md`
- Create: `docs/security.md`
- Create: `docs/migrating-from-mcp.md`
- Create: `docs/troubleshooting.md`
- Modify: `package.json`

**Migration Table:**

| MCP Tool | CLI |
|---|---|
| `taskferry_dispatch` | `taskferry dispatch` |
| `taskferry_cancel` | `taskferry cancel` |
| `taskferry_poll` | `taskferry wait` |
| `taskferry_advisor` | `taskferry advisor` |
| `taskferry_status` | `taskferry status` |
| `taskferry_tail` | `taskferry tail` |
| `taskferry_summary` | `taskferry summary` |
| `taskferry_result` | `taskferry result` |
| `taskferry_list` | `taskferry list` |

1. Rewrite README around the CLI rather than its historical MCP implementation.
2. Document commands, defaults, TOON success examples, empty states, usage errors, and operational errors.
3. Document daemon auto-start, socket permissions, restart behavior, queueing, watchdogs, cancellation, and recovery.
4. Document activity-summary privacy, cost, cache behavior, configuration, and opt-out.
5. Document each native integration's installation, update, removal, and UI limitations.
6. Document taskferry as SDD's external-worker backend.
7. Explain old Claude MCP registration removal without automating configuration changes.
8. Preserve existing-state-directory compatibility guidance.
9. Search for stale MCP references. Retain them only in migration documentation.
10. Search portable files for `/home/`, `/workspace/`, `/Users/`, and `/root/`.
11. Commit: `docs: document AXI CLI and agent integrations`.

## Task 12: Final Verification

Run:

```bash
npm test
npm run check
npm run skill:check
npm run test:integration
claude plugin validate ./integrations/claude --strict
rg "McpServer|StdioServerTransport|@modelcontextprotocol/sdk" package.json package-lock.json src integrations
rg "using-opencode|delegate-to-opencode-attended|mcp__taskferry" "$HOME/.claude/CLAUDE.md" "$HOME/.claude/skills" "$HOME/.config/opencode/skills"
rg "/home/|/workspace/|/Users/|/root/" src integrations scripts README.md docs
git diff --check
```

Expected:

- Unit, lint, type, skill-generation, and integration tests pass.
- Claude plugin validation passes.
- Runtime code has no MCP references.
- Governing worker skills have no active references to retired names or MCP tools.
- Absolute-path search has no unjustified hits.
- `git diff --check` reports no whitespace errors.

## Execution Choice

1. **Subagent-Driven Development through taskferry:** Use the planned taskferry worker backend for each implementation and review task.
2. **Inline Execution:** Implement sequentially in this session with verification checkpoints.
