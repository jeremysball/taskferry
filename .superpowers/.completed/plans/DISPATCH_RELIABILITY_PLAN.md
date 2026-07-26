# Dispatch Reliability and Key Slots Plan

## Goal

Make delegated OpenCode tasks fail clearly when provider usage is exhausted or
the CLI stops producing output, cap active child processes at four, and let a
caller select a preconfigured provider key from the MCP server environment
without exposing secret values.

## Current Evidence

- The task manager changes a task from `running` only when the `opencode`
  child exits or emits a spawn error.
- An exhausted OpenCode Go review task remained alive and emitted no stdout or
  stderr. Its task log was empty until cancellation, so there was no error
  string for the MCP server to match.
- The existing dispatch-window design limits launches in a time window. It
  does not limit the number of running child processes.
- Sol found two prerequisite defects: `cancel-smoke-test.js` uses `decode`
  without importing it, and concurrent MCP server processes can overwrite the
  shared `tasks.json` state file.

## Design

### Provider Failure Detection

1. Reproduce a depleted OpenCode Go request with one bounded `opencode run`.
   Capture its exit code, stderr, and JSON events to identify the stable
   provider exhaustion signal.
2. Parse the confirmed structured event or diagnostic while the child runs.
   On a match, stop the child process group and mark the task `crashed` with
   `failureReason: "provider_usage_exhausted"`.
3. Add a configurable startup/no-output watchdog. A child that emits no event
   before its deadline is stopped and marked `crashed` with
   `failureReason: "no_output_timeout"`. This is distinct from a confirmed
   provider usage failure.
4. Return actionable, compact task detail. Provider exhaustion tells callers
   to select another configured key or model; a no-output timeout tells them
   to inspect the private log or retry. Raw provider diagnostics remain in the
   private task log.

### Active-Task Concurrency

1. Add `TASKFERRY_MAX_CONCURRENT_TASKS`, defaulting to `4`.
2. Treat this as a real active-child limit: start at most four `running`
   OpenCode children; retain later tasks as `queued`.
3. Drain queued tasks FIFO whenever a child succeeds, crashes, is cancelled,
   fails to spawn, or reaches a watchdog timeout.
4. Remove the current launch-window setting, or retain it only as an
   independent optional burst-rate control. It must not be documented as a
   concurrency limit.

### Key Slots

1. Configure named slots at MCP server startup, for example:

   ```text
   TASKFERRY_KEY_SLOTS=primary:OPENCODE_GO_API_KEY,backup:OPENCODE_GO_API_KEY_BACKUP
   TASKFERRY_PROVIDER_KEY_ENV=OPENCODE_GO_API_KEY
   ```

2. Add an optional `key_slot` to `taskferry_dispatch`. Validate it against the
   configured slot names before creating or launching a task.
3. At child spawn, read the selected source environment variable and pass its
   value only as the configured provider key environment variable in the
   child `env`. Do not put the key in task metadata, persisted state, prompt
   previews, tool output, command arguments, or logs.
4. Persist the selected slot name for diagnostics, never the selected key or
   its source value. A missing slot or unset source variable fails before
   spawning with a structured, actionable error.
5. Give summaries their own configured key slot because they use the separate
   DeepSeek summary model. A source task's slot does not implicitly transfer
   secrets to its summary task.
6. The MCP server sees environment values from its own process. Restart it
   after changing environment values; callers can select among slots that
   were present when the server started.

### Durable Shared State

1. Replace bare whole-file writes with coordinated, atomic state updates:
   lock, read current state, merge the local task change, write a private
   temporary file, then rename it into place.
2. Report malformed state as a structured server error rather than throwing
   during startup.
3. Preserve the task-summary specification's private file permissions and
   active-task-to-`unknown` restart semantics.

### Tests and Verification

1. Fix the missing `decode` import in `cancel-smoke-test.js`.
2. Add unit tests for four active tasks, a fifth queued task, FIFO draining,
   cancellation, spawn failure, watchdog timeout, and provider exhaustion.
3. Add tests that a selected key slot reaches only the child environment and
   that no secret appears in state, logs, or tool responses.
4. Add two-manager persistence tests that prove concurrent updates retain
   both task records and malformed state returns a structured error.
5. After OpenCode Go usage is available, run a bounded live integration test
   to confirm the observed provider failure classification and normal key-slot
   execution.

## Non-Goals

- Storing secrets in repository files, task state, prompts, or tool output.
- Inferring provider exhaustion from an arbitrary timeout.
- Treating a launch-rate window as an active-task concurrency cap.
