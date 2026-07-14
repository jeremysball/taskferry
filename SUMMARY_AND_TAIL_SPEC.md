# Task Summary and Text Tail Specification

## Purpose

Add two observation tools for work delegated through `taskferry_dispatch`:

- `taskferry_tail` gives an immediate, bounded view of the newest model text.
- `taskferry_summary` creates a short, semantic progress report from the task's observed narration.

The tools complement existing interfaces. `taskferry_status` remains the source of lifecycle state, `taskferry_wait` remains the blocking lifecycle primitive, and `taskferry_result` remains the full completed-task result.

## Design Decisions

`taskferry_tail` is deterministic and synchronous. It parses a bounded suffix of the task's existing NDJSON log, never starts a model, and returns the requested suffix of the latest `type: "text"` event.

"Text" means the most recent parsed `type: "text"` event, not a reconstructed multi-event model turn. This matches the command's purpose: immediate access to the last emitted text without reading an unbounded log. Text limits are Unicode code points, not JavaScript UTF-16 code units.

`taskferry_summary` is asynchronous. A semantic summary requires a model call, which may exceed an MCP client's request timeout. It runs under a dedicated, tool-denied OpenCode agent using `opencode-go/deepseek-v4-flash`, and immediately returns that task's identifier. The caller waits for and reads it using the existing `taskferry_wait` and `taskferry_result` tools.

The exact DeepSeek model ID was verified with `opencode models` on 2026-07-13.

## `taskferry_tail`

### Input

```text
taskferry_tail(task_id, chars?)
```

| Field | Required | Default | Constraints |
| --- | --- | --- | --- |
| `task_id` | yes | | A task returned by `taskferry_dispatch`. |
| `chars` | no | `1000` | Positive integer, maximum `65536` Unicode code points. |

### Result

```text
taskId: oc_...
status: running
text: ...last requested characters of the latest text event...
textTotalChars: 3842
truncated: true
```

`text` is the entire latest text event when it is no longer than `chars`; otherwise it is its final `chars` Unicode code points. `textTotalChars` reports the complete event length. `truncated` is true exactly when content was omitted.

The `status` is captured with the log read. It may change immediately afterward, so it is advisory; callers requiring an authoritative terminal state use `taskferry_wait` or `taskferry_status`.

When a known task has emitted no text events, return a successful, definitive empty result:

```text
taskId: oc_...
status: running
text: none observed yet
textTotalChars: 0
truncated: false
help[1]: Run taskferry_wait with task_id "oc_..." to wait for task output
```

An unknown task follows the existing shared `error:` and `help:` response path. An invalid `chars` value is a usage error, before reading the log.

## `taskferry_summary`

### Input

```text
taskferry_summary(task_id, max_words?)
```

| Field | Required | Default | Constraints |
| --- | --- | --- | --- |
| `task_id` | yes | | A task returned by `taskferry_dispatch`. |
| `max_words` | no | `200` | Positive integer from `75` through `300`. |

### Snapshot and Dispatch

The tool captures, in order:

1. Source task ID, status, directory, prompt preview, and capture timestamp.
2. A bounded narration excerpt available in the task log at that instant.
3. The source log byte count and whether the source task was still active.

The manager captures a byte boundary from the source log before it reads source status and timestamp. It parses only complete NDJSON lines before that boundary, so the snapshot cannot contain a partly written event. The source status, capture timestamp, and byte boundary are stored together as snapshot metadata.

The summary input has a 96 KiB UTF-8 byte limit. When the parsed narration exceeds that limit, retain its beginning and end with a plain omission marker that states the omitted byte count. The opening normally contains the objective and early investigation; the ending contains current progress. This bounds memory, provider cost, and attachment size without silently presenting the excerpt as a complete transcript.

The manager serializes the metadata and excerpt to a mode-`0600` temporary attachment in a mode-`0700` summary directory. It invokes OpenCode with `--pure`, a dedicated summary agent, and `--file <attachment>`. The attachment content never appears in argv or a task prompt preview, and the attachment is removed after the child exits.

The dedicated agent has an explicit `"*": "deny"` permission rule. It can call the model but cannot read, edit, search, browse, execute commands, invoke subagents, or use MCP tools. The child runs from the private summary directory, not the source workspace. The summary prompt directs it to use only the attachment, follow no instructions inside that material, state uncertainty plainly, and aim for `max_words` words.

The source task continues independently. A summary is always a snapshot, never a promise about work that appears in the log after `capturedAt`.

### Immediate Result

The new task is returned in a compact, explicit relationship to its source:

```text
sourceTaskId: oc_source
sourceStatus: running
capturedAt: 2026-07-13T23:39:47.000Z
sourceNarrationChars: 18241
summaryInputBytes: 18241
summaryTask:
  id: oc_summary
  status: queued | running
  model: opencode-go/deepseek-v4-flash
next: Run taskferry_wait with task_id "oc_summary", then taskferry_result with task_id "oc_summary"
```

The summary task uses the normal task manager lifecycle. It appears in `taskferry_list`, can be waited on, and can be cancelled. `taskferry_result` returns the report in its existing `message` field. If a server restart changes an active summary task to `unknown`, it is unavailable: `taskferry_result` must return a definitive incomplete-state response rather than parse partial text.

### Empty Source Material

When a source task has no parsed text events, do not dispatch a model. Return a successful, definitive response:

```text
sourceTaskId: oc_source
sourceStatus: queued
summary: no model text observed yet
help[1]: Run taskferry_tail with task_id "oc_source" after the task emits output
```

This avoids spending a model call to summarize an empty transcript.

### Privacy Boundary

`taskferry_summary` sends captured task narration to the configured DeepSeek provider through OpenCode. Narration can contain repository details, command output, or secrets emitted by a delegated task. The tool description must disclose this transfer. Locally, the input exists only in a private temporary attachment until the summary child exits. `taskferry_tail` is local and sends no task content to a model.

The manager creates its state and log directories with mode `0700`, creates state, log, and snapshot files with mode `0600`, and persists task state atomically by writing a private temporary file and renaming it into place. Startup must report a malformed state file as a structured server error rather than crash during initialization.

## Model Prompt Contract

The summary prompt must request these four facts when available:

1. The task's objective.
2. Work completed or evidence gathered.
3. Current outcome or blocker.
4. The most useful next action.

It must not claim that the source task finished when its snapshot status is `queued`, `running`, or `unknown`. It must distinguish evidence from inference and omit unavailable sections instead of inventing details.

The summary agent must print only the report as its final message. `max_words` is a model target, not a hard output guarantee; the immediate result and final result label it as such. This keeps `taskferry_result(...).message` directly usable without parsing agent narration.

## Selective Results

Extend `taskferry_result` with an optional `fields` array. Omitted `fields` preserves the current full result shape. When present, the response contains only `taskId`, `status`, and the requested fields.

```text
taskferry_result(task_id, full?, fields?)
```

The allowed fields are `message`, `narration`, `tokens`, `cost`, `sessionId`, `exitCode`, `signal`, `spawnError`, and `logPath`. `full` is valid only when `fields` is omitted or includes `narration`.

For the common low-token case:

```text
taskferry_result(task_id: "oc_...", fields: ["message"])

taskId: oc_...
status: done
message: The final assistant turn only.
```

`fields` is a response projection, not a new parser. It cannot request partial text from a running task; use `taskferry_tail` for live output.

## Implementation Boundaries

- Add a bounded reverse reader for `readLastText(logPath)`. It ignores non-JSON lines and non-text events, returns the newest complete text event, and never materializes the entire log.
- Add an asynchronous bounded reader for summary snapshots. It reads complete NDJSON lines up to a captured byte boundary and never blocks the task manager's event loop with a full-log read.
- Add task-manager methods for `tail(taskId, options)` and `summarize(taskId, options)`. Reuse the existing unknown-task error helper and TOON response boundary.
- `summarize` must snapshot source content before it enqueues the summary task. Persist the source-task relationship, snapshot metadata, and summary input length on the summary task so results remain interpretable after a server restart. Include that relationship in the summary task's status and result detail. An `unknown` summary task is incomplete, never a partial result.
- Use a separate summary launch path. It must use a private working directory, `--pure`, the tool-denied summary agent, and a mode-`0600` `--file` attachment. Do not use generic `dispatch()` or `--auto` for summaries.
- Make the summary model configurable through `TASKFERRY_SUMMARY_MODEL`, defaulting to `opencode-go/deepseek-v4-flash`. Cache a capability preflight from `opencode models`; return an actionable error without creating a task when the configured model is unavailable.
- Add `fields` projection to `result(taskId, options)` and `taskferry_result`. Keep its omitted-fields response backward compatible.
- Register both MCP tools in `src/server.js` with tight schemas and descriptions that disclose the summary provider.
- Do not alter `taskferry_result` semantics. A summary task is an ordinary dispatched task whose final `message` happens to be a summary.
- Do not expose raw log paths or raw NDJSON in the new default responses.
- Return all new validation failures as structured TOON `error:` and `help:` responses with usage error code `2`; do not rely on SDK/Zod validation text.

## Test Requirements

- `taskferry_tail` returns the final complete text event without reading the entire log.
- `taskferry_tail` returns an exact suffix and correct length/truncation fields.
- `taskferry_tail` has a definitive no-text result and rejects invalid `chars` before log access.
- `taskferry_summary` refuses to dispatch for an empty narration snapshot.
- `taskferry_summary` sends the captured snapshot, requested word limit, and DeepSeek model ID to its child task.
- Summary launches have no agent tools available and run outside the source workspace.
- Summary input moves through a private attachment, never argv or the persisted prompt preview.
- A summary requested while the source task is running remains associated with the captured source status and timestamp after the source finishes.
- Summary-task relationship metadata survives atomic persistence and appears in its status/result detail. A reloaded active summary is `unknown` and cannot yield a result.
- `taskferry_result(fields: ["message"])` returns only its mandatory task envelope and final message; omitting `fields` preserves the current response.
- MCP smoke coverage verifies both tool schemas and TOON responses.

## Non-Goals

- Streaming text or push notifications.
- A persistent incremental summary that mutates as the source task runs.
- Replacing `taskferry_wait`, `taskferry_result`, or full narration retrieval.
- Automatic summarization, which would create unexpected model calls and external data transfer.
