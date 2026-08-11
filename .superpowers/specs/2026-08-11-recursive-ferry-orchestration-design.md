# Recursive Ferry Orchestration and Task-Scoped Identity — Design

Date: 2026-08-11. Status: proposed architecture; protocol details pending implementation plan.

## Background

Task Ferry today is deliberately a generic execution substrate. A thin CLI validates input, talks JSON-RPC to a private daemon over a Unix-domain socket, and the daemon owns queued/running worker processes, settlement, changesets, and durable task state. `dispatch` returns immediately; `wait`, `status`, `result`, `watch`, `accept`, and `reject` operate on the resulting task.

The current README also draws an important boundary around methodology: the bundled `using-taskferry` skill makes Task Ferry the worker execution layer for a subagent-driven-development-style lifecycle, while that lifecycle owns briefs, worktrees, decomposition, and review. Task Ferry is explicitly not the lifecycle itself.

The next architecture should preserve that boundary while making the substrate recursively usable by the workers it launches.

The motivating workflow is hierarchical:

- A top-level orchestrator ("captain") owns the global objective.
- It decomposes the objective into larger coherent workstreams and dispatches ferries to own them. In conversation these were called "first mates."
- A first-mate ferry runs the same kind of loop the top-level orchestrator previously ran: understand its objective, decide what can be delegated, dispatch child ferries, inspect their results, request review, integrate accepted work, and continue until its objective is complete.
- Leaf ferries perform concrete implementation, investigation, review, or other bounded tasks.
- "Captain", "first mate", "implementer", and "reviewer" are roles expressed by prompt/skill policy, not distinct daemon task types. There is one task/ferry protocol.

The goal is therefore not to add a second class of worker. The goal is to let any dispatched ferry safely become a parent.

## Design principles

### 1. One ferry type

Task Ferry should not encode separate first-mate, implementation, or review task classes.

Every ferry has the same substrate capabilities, subject to the same sandbox and daemon rules:

- inspect its own Task Ferry task state;
- dispatch child ferries;
- wait for and inspect child results;
- ask a question through the daemon;
- receive an answer to a question it asked;
- use the existing changeset lifecycle for child work;
- finish and return a result to its parent.

The methodology layer decides how those capabilities are used.

This keeps role policy out of the daemon and allows recursive decomposition without introducing a parallel orchestration system for each level.

### 2. The daemon is the source of truth for identity

A ferry must not tell Task Ferry "I am task X."

When the daemon launches a sandboxed ferry, it injects task-scoped identity material into that sandbox read-only. Self-scoped commands resolve the caller's identity from that injected material.

This prevents the common failure mode where a nested ferry inherits its parent's task identifier and accidentally acts on the parent's behalf.

It also means self-scoped CLI commands do not require a model to copy, remember, or interpolate its own task ID.

### 3. Parentage is assigned, not claimed

When an external client dispatches a task, the task has no Task Ferry parent unless the caller explicitly belongs to an existing ferry context.

When a ferry dispatches another ferry:

1. the CLI authenticates the caller's injected task identity;
2. the daemon derives the parent from that identity;
3. the new task record receives `parentTaskId = callerTaskId`;
4. the child receives its own fresh identity material at launch.

The child cannot choose an arbitrary parent ID.

### 4. Bidirectional interaction is a substrate primitive

Today the common Task Ferry flow is effectively one-way: dispatch work, let it run, retrieve the result later.

Recursive orchestration needs an explicit way for a ferry to stop when it lacks required information and ask upstream rather than guessing for an hour.

A question/answer primitive makes "I need input" a normal control-flow operation rather than a failure mode.

### 5. Decomposition and review policy stay in skills

Task Ferry should expose the mechanics needed for hierarchy but should not decide:

- how a broad problem is decomposed;
- how large a child task should be;
- whether three reviewers or one reviewer are required;
- whether a reviewer is adversarial, specification-focused, or code-quality-focused;
- what "done" means for a particular software-development methodology;
- when a parent should ask a child to retry;
- how a captain chooses first-mate boundaries.

Those decisions belong in the SDD/superpowers skill layer.

This is the same boundary the repository already states for the existing `using-taskferry` integration: Task Ferry supplies execution; the lifecycle supplies method.

## Proposed task identity mechanism

### Identity file/capability

At task launch, the daemon creates identity material associated with the new task and mounts it read-only at a fixed private path inside the sandbox.

Conceptually:

```text
/run/taskferry/self
```

The exact host/runtime path is implementation detail. The important properties are:

- created by the daemon;
- unique to the spawned task;
- mounted read-only;
- not supplied by the model;
- not derived solely from mutable environment variables;
- replaced with fresh child identity when a nested task is launched.

The initial discussion considered placing the task ID in a file whose filename also contains the task's spawn/start time converted to Unix epoch, allowing a nested worker to distinguish its own record from an inherited parent record.

That remains a viable identification scheme, but the cleaner invariant is stronger: a child sandbox should receive exactly one authoritative self identity at one fixed path. If the sandbox construction can mask/replace any inherited parent identity at that path, no timestamp search is required.

For accidental misuse protection, a read-only task ID at the fixed path may be sufficient. If the daemon socket is directly reachable from arbitrary code inside the sandbox and the protocol needs to prevent deliberate impersonation, the file should additionally contain a daemon-issued opaque capability/nonce bound to that task. Self-scoped RPCs then require both the task identity and valid capability.

This security choice should be made explicitly during implementation planning rather than accidentally relying on task IDs being hard to guess.

### Nested sandbox invariant

A child ferry must never see its parent's injected identity as its own.

At child spawn, sandbox setup must either:

- mask the parent identity path and mount the child's identity file over it; or
- place identity outside all directories inherited from the parent's filesystem view.

The correct invariant is:

> Inside any running ferry sandbox, the Task Ferry self-identity lookup resolves to exactly one task: that sandbox's task.

Tests should assert this directly for at least two nesting levels.

## Self-scoped CLI operations

A ferry should not need to learn or carry its own task ID.

### Task-scoped status/context

The desired operation is semantically simple: existing `status` behavior with the caller's task ID injected automatically.

The public `main` branch currently already uses `taskferry context` for a different operation: compact current-workspace state used by session-start hooks. Therefore the new self-scoped operation cannot silently reuse that command name without changing an existing CLI contract.

The final spelling is an implementation decision. Possible shapes include:

```text
taskferry self
taskferry self status
taskferry status --self
taskferry task-context
```

Whatever name is chosen, its semantics should remain thin:

```text
resolve self identity
→ call the existing task-status path for that task ID
→ render the same result shape
```

It should not become a second status implementation or a new "rich context" data model.

### Nested dispatch

A ferry invokes the normal dispatch surface:

```text
taskferry dispatch --prompt ... --directory ...
```

If no valid self identity is present, dispatch behaves as it does for an external client.

If valid self identity is present, the daemon records that task as the new task's parent. Parentage should be additive metadata on the normal task object, not a separate nested-task store.

The CLI should not expose a normal `--parent-task-id` override to ferries. Parentage is derived by the daemon.

## Question / answer protocol

### Asking

Inside a ferry:

```text
taskferry question --prompt "..."
```

The caller does not provide a task ID.

The CLI resolves the injected self identity and sends a question request to the daemon. The daemon records at minimum:

```text
questionId
taskId
prompt
createdAt
status: pending | answered | cancelled
answer
answeredAt
```

The command blocks until the question is answered, cancelled, the task is cancelled, or a defined operational failure occurs.

The worker can therefore write ordinary control flow around it:

```text
answer = taskferry question ...
continue work using answer
```

The question is always attributed to the actual calling ferry by the daemon; a ferry cannot ask a question "as" one of its siblings or children through the self-scoped command.

### Surfacing questions

Questions need to become visible without requiring a human or captain to poll every task individually.

The existing `watch` stream is the natural transport for this. A pending question should emit a task/question event containing enough information to identify:

- the asking task;
- its parent, when present;
- the question ID;
- the question text;
- the task/workspace needed for orientation.

Human-facing workspace output may also surface a concise pending-question indicator.

### Answering

An external caller or supervising agent answers a specific question:

```text
taskferry answer <question-id> --text "..."
```

The answer is persisted by the daemon and wakes the blocked `question` call.

Whether answers are permitted from any local Task Ferry client or restricted to the direct parent is an authorization/policy decision still to be made. The protocol should not conflate that question with identity attribution: the daemon must always know who asked, even if multiple actors are allowed to answer.

### Question state and daemon restart

Questions introduce durable in-flight state that the current fire-and-return flow does not have.

Implementation planning must specify what happens if the daemon restarts while:

- a ferry is blocked in `taskferry question`;
- an answer is already persisted but the caller has not received it;
- a pending question has not yet been answered.

The minimum reliable design is for questions and answers to have stable IDs and durable daemon state, so a reconnecting CLI can determine whether its request is still pending or already answered instead of creating a duplicate question.

Exact restart/reconnect mechanics can be a follow-up if recursive orchestration ships behind a deliberately narrower first version, but silent loss of pending questions is not an acceptable final state.

## Parent/child task model

Add lineage metadata to the existing task record:

```text
parentTaskId: string | null
```

Derived views may expose children without storing a second authoritative list:

```text
children = tasks where parentTaskId == task.id
```

A task may have zero or more children.

The root orchestrator/captain does not need to be represented as a special daemon task. A normal external harness can dispatch root tasks with `parentTaskId: null`.

"First mate" therefore means: a ferry whose assigned objective is broad enough that its skill/prompt chooses to dispatch children.

## Recursive control loop

The daemon should not implement this loop, but the SDD skill layer can standardize it.

A first-mate ferry roughly repeats:

1. orient on its objective and current state;
2. decide whether the next piece should be done locally, delegated, reviewed, or clarified;
3. dispatch child ferries for independently ownable work;
4. wait/watch as appropriate;
5. inspect child results and pending changesets;
6. request review through additional ordinary ferries when policy requires it;
7. accept, reject, retry, or revise;
8. ask upstream when required information is missing;
9. integrate results and repeat;
10. return a bounded result to its parent.

This is recursive: a child given a sufficiently broad objective may itself run the same loop.

The daemon only needs to make the operations safe and observable.

## Review remains a role, not a type

The discussion considered multiple reviewers per implementation task, including a rough three-reviewers-to-one-implementer shape.

That can be valuable SDD policy, but it should not become a Task Ferry primitive.

A reviewer is an ordinary ferry given a review objective. A parent may dispatch:

- one implementation ferry;
- three review ferries;
- two competing solution ferries;
- a specification reviewer followed by a code-quality reviewer;
- no reviewer at all.

Task Ferry records lineage and results. The skill decides the review topology and how disagreement is resolved.

If reviewer disagreement needs a formal resolution loop, that belongs in the skill/lifecycle spec unless a missing daemon primitive is discovered while implementing it.

## Critical filesystem problem: nested changesets

Recursive dispatch cannot be correct until nested filesystem semantics are explicit.

Today a dispatched task runs in a sandboxed filesystem view and its changes can settle as a pending changeset. `taskferry accept <id>` applies that pending changeset to the task's target directory.

For a child spawned by a sandboxed parent, "the target directory" must normally be the parent's working view, not the real host checkout behind the parent.

Otherwise a child could bypass its parent and mutate state the parent has not accepted, breaking both isolation and the review/accept model.

### Required invariant

For a nested task:

> Accepting a child's changeset applies it into the parent ferry's visible working state exactly as if the parent had made that edit itself; it does not escape directly to the root host checkout unless the parent itself is rooted there by design.

This creates a path-resolution problem because the path passed by the parent is a path inside the parent's sandbox namespace, while the daemon manages mounts and changesets from the host namespace.

Implementation planning must trace the current bwrap/overlay construction and define a canonical mapping from:

```text
parent-visible path
→ parent task's host-side merged/overlay backing path
→ child sandbox target
```

This should be solved in the daemon/sandbox layer, not by teaching model prompts to reason about host overlay paths.

### Child accept authority

The first version also needs a decision about who performs `accept` for child changes:

- the parent ferry explicitly runs `taskferry accept <child-id>`;
- the child auto-accepts into the parent view after successful completion;
- skill policy chooses between explicit and automatic acceptance.

Given Task Ferry's existing safety model, explicit parent acceptance is the conservative default because it preserves review-before-integration.

## Making Task Ferry available inside ferries

Recursive orchestration requires a launched ferry to have access to the Task Ferry CLI and daemon transport.

Sandbox construction therefore needs to expose, read-only:

- the Task Ferry executable/entrypoint needed by the worker;
- the daemon Unix socket;
- the task's self-identity material.

The socket must be usable for the allowed nested operations without turning the sandbox into an unscoped daemon client. If capability validation is added, the daemon can authorize self-scoped operations from the injected identity while still allowing ordinary non-self operations according to the intended threat model.

No writable copy of Task Ferry itself is required inside the worker.

## Cancellation and lineage

Lineage introduces a cancellation question that does not exist for unrelated tasks.

Possible semantics:

1. cancel parent only; children continue independently;
2. cancel parent cascades to all descendants;
3. default parent-only plus an explicit cascade option.

The safest substrate default is probably not to invent implicit cascade until the lifecycle semantics are proven. However, the daemon should make descendants discoverable so the skill/orchestrator can cancel a subtree deterministically.

This remains an explicit design decision.

## Scheduling and concurrency

The existing global Task Ferry queue and concurrency cap should continue to apply to nested tasks.

Recursive orchestration must not create a second scheduler.

A child dispatch is an ordinary dispatch with lineage metadata and therefore enters the same queue.

Per-parent concurrency, subtree budgets, token budgets, or model budgets may become useful later, but they are not required to establish the recursive protocol.

## Observability

Existing task views should gain enough lineage information to debug a hierarchy without introducing a completely separate UI.

Candidate additions:

- `parentTaskId` on full status/result output;
- child count on full task status;
- optional tree-oriented list/watch rendering;
- question-pending metadata/events;
- root-task or ancestor identifiers if repeated traversal becomes expensive.

The stored source of truth should remain the task records plus parent links. Any tree is a view.

## Decomposition: intentionally not solved in the daemon

Problem decomposition is probably the most important behavioral problem in the overall architecture, but it is not a daemon algorithm.

The substrate must make good decomposition possible by giving a ferry:

- a bounded objective;
- its own task state;
- the ability to launch children;
- the ability to inspect child progress/results;
- the ability to ask upstream;
- the ability to integrate or reject child changes.

The SDD skills then define how the model chooses a boundary.

A useful skill-level rule can be framed around ownership rather than size: delegate a unit when it can be given a coherent objective, clear constraints, a bounded working area, and an independently verifiable completion condition.

The exact decomposition heuristics should be developed and tested in the skill layer independently of the daemon protocol.

## Interaction with addenda / methodology skills

The surrounding development environment already treats skills as runtime behavioral policy, including local addenda that modify or extend upstream plugin skills without editing the plugin-owned source directly.

That is a strong fit for the boundary above:

- Task Ferry remains the generic recursive execution API.
- The SDD/superpowers/addenda layer teaches the captain and ferries how to use it.
- Changing review ratios, decomposition heuristics, escalation rules, or role prompts does not require changing the daemon.
- Task Ferry can still be used for non-coding hierarchical work by a different skill layer.

The API is generic; the client behavior is specialized.

## Protocol sketch

External root dispatch:

```text
captain
  -> taskferry dispatch
  -> daemon creates task A
       parentTaskId = null
       selfCapability = cap_A
  -> launch A with cap_A mounted read-only
```

Nested dispatch:

```text
ferry A
  -> taskferry dispatch
  -> CLI presents cap_A
  -> daemon resolves caller = A
  -> daemon creates task B
       parentTaskId = A
       selfCapability = cap_B
  -> launch B with cap_B mounted read-only
```

Question:

```text
ferry B
  -> taskferry question "Need decision X"
  -> CLI presents cap_B
  -> daemon records Q1 { taskId: B, parentTaskId: A, status: pending }
  -> watch emits Q1
  -> caller answers Q1
  -> daemon persists answer and wakes B
  -> B continues
```

Self status:

```text
ferry B
  -> taskferry <self-status-command>
  -> CLI presents cap_B
  -> daemon resolves B
  -> existing status path for B
```

## Error handling summary

| Situation | Behavior |
| --- | --- |
| self-scoped command outside a ferry | fail fast with a usage/operational error explaining no task identity is available |
| self identity file missing inside a launched ferry | task/environment bug; fail loudly, never guess from environment or cwd |
| malformed/unknown capability | reject the self-scoped RPC |
| nested dispatch | daemon derives `parentTaskId` from authenticated caller identity |
| child receives parent identity | invariant violation; integration test must catch this |
| ferry asks a question | daemon attributes question to authenticated caller and blocks until answer/cancel/failure |
| ferry attempts to claim another task in a self-scoped call | impossible through supported CLI; daemon ignores caller-supplied identity |
| parent exits while child runs | child remains a normal durable task unless cancellation policy explicitly says otherwise |
| child changeset accepted | must apply into the correct parent-visible working state, not silently escape to root checkout |
| daemon restarts with pending question | final implementation must preserve or deterministically recover question state |

## Testing

### Identity and lineage

- Dispatch a root ferry from an external shell; assert `parentTaskId` is null.
- From that ferry, dispatch a child; assert the daemon assigns the parent automatically.
- From the child, dispatch a grandchild; assert lineage A -> B -> C.
- Inside each level, run the self-status command and prove it returns that level's task, never the ancestor's.
- Attempt to mutate/replace the self-identity material from inside the sandbox; prove it is read-only.
- If opaque capabilities are adopted, try a fabricated task ID/capability pair and prove the daemon rejects it.

### Question/answer

- Ferry asks a question and blocks.
- `watch` surfaces the pending question.
- Answer the question externally; prove the original CLI call wakes and returns the answer.
- Two ferries ask questions concurrently; answering one must never wake the other.
- Attempt to ask on behalf of another task through the supported self-scoped command; prove no task-id override exists.
- Exercise cancellation while blocked in a question.
- Exercise daemon restart according to the final reconnect/persistence design.

### Nested changesets

This requires real system tests; mocks are not proof of namespace/overlay behavior.

- Root task A changes file `x`.
- A dispatches child B against A's visible workspace.
- B changes `x` again.
- Before B is accepted, A must not see B's pending edit.
- After A accepts B, A sees B's edit.
- The real root checkout outside A must still not see A/B changes until A itself is accepted by its parent/root caller.
- Repeat at three nesting levels.
- Reject B and prove its changes disappear without affecting A's preexisting modifications.

### Generic substrate boundary

- A non-SDD caller can use nested dispatch and questions without loading SDD skills.
- Review ratios/decomposition rules are absent from daemon configuration and task schema.
- Changing an SDD skill's review policy requires no daemon change.

## Non-goals

- Encoding "captain", "first mate", "implementer", or "reviewer" as distinct daemon task types.
- Hard-coding a three-reviewers-per-implementation rule.
- Solving optimal problem decomposition in Task Ferry core.
- Making the daemon decide whether a task is semantically complete beyond existing generic completion/marker mechanisms.
- Building a second scheduler for child tasks.
- Replacing the existing changeset accept/reject model with direct shared-write workers.
- Treating `taskferry context`'s current session-start-hook meaning as though it does not exist.
- Requiring models to manually track or interpolate their own Task Ferry task IDs.
- Using mutable environment variables as the sole authority for ferry identity.

## Open decisions before implementation planning

1. **Self-status command spelling.** Current `taskferry context` is already occupied; choose a non-conflicting thin wrapper around status.
2. **Identity strength.** Fixed read-only task ID only, or task ID plus daemon-issued opaque capability.
3. **Nested filesystem mapping.** Precisely map a parent-visible directory to a host-side child sandbox target and prove accept/reject composes recursively.
4. **Question authorization.** Can any local caller answer, only the direct parent, or a defined set of supervisors?
5. **Question restart behavior.** Define durable reconnect semantics across daemon replacement.
6. **Cancellation.** Decide whether descendant cancellation is explicit, automatic, or policy-driven.
7. **Child acceptance.** Parent-explicit accept is the conservative default; decide whether the skill may opt into auto-accept.
8. **Lineage presentation.** Minimum CLI fields/events needed to debug trees without bloating normal output.

## Recommended implementation sequence

1. Add task lineage (`parentTaskId`) without recursive dispatch behavior.
2. Add daemon-issued self identity and a self-status CLI wrapper; integration-test nested identity masking.
3. Make the Task Ferry CLI/socket safely available inside sandboxes.
4. Enable nested `dispatch` with daemon-derived parentage.
5. Solve nested overlay/changeset mapping and prove two- and three-level accept/reject behavior with real integration tests.
6. Add durable `question` / `answer` plus watch events.
7. Add minimal lineage observability.
8. Only then update SDD skills to introduce captain/first-mate recursive decomposition and review loops.
9. Iterate on decomposition/review policy in skills independently of the substrate.

The substrate is complete when an ordinary ferry can safely behave like an orchestrator without Task Ferry needing to know that it is a "first mate."
