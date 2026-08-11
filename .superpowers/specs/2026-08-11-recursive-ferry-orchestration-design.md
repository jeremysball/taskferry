# Recursive Ferry Orchestration and Task-Scoped Identity — Design

Date: 2026-08-11. Status: proposed architecture, revised against verified
substrate behavior. Ready for an implementation plan, subject to the
prerequisite defects listed near the end.

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

## What the substrate already does, verified

Everything in this section was run against the real implementation on
bubblewrap 0.11.2 rather than inferred from reading the code. It changes
several of the assumptions the rest of this document was originally
written on.

**Nested dispatch already works, unsupervised.** `buildBwrapArgs` binds the
whole runtime directory read-write into every dispatch sandbox
(`src/sandbox.js`), and the daemon socket lives there. The `taskferry`
binary is visible too, because the root filesystem is bound read-only. A
ferry can therefore already call `taskferry dispatch` today. The result is
an orphan task with no parent link and no accounting. This design is not
opening a door; it is putting a frame around one that is already open.

**Sibling ferries are not isolated from each other.** `resolveOverlayTmpRoot()`
places the overlay tree under the runtime directory, so it sits inside that
same read-write bind. From inside one sandbox, another task's pending
changeset upper directory was listed, read, and overwritten, and the write
was confirmed on the host afterward. Each ferry is handed its own overlay
subdirectory by naming convention, and nothing enforces the boundary.

**Adding the overlay tree to the sandbox deny list does not fix that.**
Deny-list `--tmpfs` entries are emitted before the runtime directory bind,
and bubblewrap applies mounts in argument order, so binding the parent
afterward un-masks everything nested under it. Both orderings were run: mask
then bind still exposed the file; bind then mask produced an empty
directory. A future change that adds the overlay root to `sandboxDenylist`
will silently do nothing, with no error.

**A read-only bind does not block a Unix socket connection.** The advisor
role passes `runtimeDirWritable: false` specifically so that, per its own
documentation, "connect() fails on a read-only mount". It does not. Through
a `--ro-bind`, a client connected to a live listening socket and received
its reply, while `touch` in the same directory failed with `Read-only file
system`. The kernel checks the socket inode's permission bits on
`connect()`, not the mount's read-only flag. Advisors can reach the daemon
today despite the code intending the opposite.

**Overlay lower layers stack, and deletions compose.** Multiple
`--overlay-src` flags stack as lower layers, with the last one topmost.
Mounting a parent's upper directory over a base checkout, with a child's own
upper on top, gave the child the parent's uncommitted edit; the child's
writes landed only in the child's upper; the parent's upper and the base
checkout were both untouched. A child deleting a base-layer file produced a
whiteout character device in the child's upper, leaving the base intact.

Three of these are defects that exist independently of recursive
orchestration: the sibling overlay exposure, the deny-list ordering no-op,
and the ineffective read-only socket guard. They should be filed and fixed
on their own schedule, not folded into this work.

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

### Threat model

The protocol is built for ferries that are fallible rather than hostile. A
worker is assumed to be capable of confusing itself about which task it is,
and not assumed to be actively trying to impersonate a sibling. Two
structural choices keep the stronger model reachable later without a
protocol break: identity material never lives anywhere the sandbox can
enumerate, and self-scoped calls go through their own daemon method that can
later be made to require a capability.

Under that model no opaque capability token is needed for the first version.
The mount itself is the capability. A ferry that has no socket bound cannot
dispatch, cannot ask a question, and cannot impersonate anyone, and there is
no token to validate and nothing to get wrong.

### Identity file and mounts

The whole-runtime-directory bind is replaced by three narrow mounts, because
as established above it cannot be made safe by flipping it to read-only:

```text
--bind    <runtimeDir>/tasks/<taskId>     <runtimeDir>/self
--ro-bind <runtimeDir>/tasks/<taskId>/id  <runtimeDir>/self/id
--bind    <runtimeDir>/daemon.sock        <runtimeDir>/self/sock
```

The source path is per-task; the destination path is fixed. Because every
sandbox has its own mount namespace, the fixed destination resolves to a
different host file for every ferry, and a child's mount replaces its
parent's with no masking logic to write or to get wrong.

The socket bind is the one that is conditional; see the recursion gate
below.

Sibling overlays become unreachable as a side effect, because nothing binds
their parent directory any more.

The important properties are:

- created by the daemon;
- unique to the spawned task;
- mounted read-only;
- not supplied by the model;
- not derived solely from mutable environment variables;
- replaced with fresh child identity when a nested task is launched.

The initial discussion considered placing the task ID in a file whose filename also contains the task's spawn/start time converted to Unix epoch, allowing a nested worker to distinguish its own record from an inherited parent record.

That scheme is no longer needed. Per-task source with fixed destination
gives a child exactly one authoritative self identity at one fixed path by
construction, so there is nothing to search and no ambiguity to resolve.

The file holds the task ID and nothing else in the first version. Adding a
daemon-issued capability later means adding a field to a file the daemon
already writes and a check to a method that already exists, which is why the
decision can be deferred without being designed around.

### Nested sandbox invariant

A child ferry must never see its parent's injected identity as its own.

The mount arrangement above satisfies this without additional logic: the
child's own per-task source is mounted at the same fixed destination, so it
covers whatever the parent had there.

The correct invariant is:

> Inside any running ferry sandbox, the Task Ferry self-identity lookup resolves to exactly one task: that sandbox's task.

Tests should assert this directly for at least two nesting levels.

## Self-scoped CLI operations

A ferry should not need to learn or carry its own task ID.

### Task-scoped status/context

The desired operation is semantically simple: existing `status` behavior with the caller's task ID injected automatically.

The public `main` branch currently already uses `taskferry context` for a different operation: compact current-workspace state used by session-start hooks. Therefore the new self-scoped operation cannot silently reuse that command name without changing an existing CLI contract.

The chosen spelling is `taskferry self`, which leaves `taskferry context`
untouched:

```text
taskferry self
```

Its semantics remain thin:

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

### Recursion gate

Every ferry gets the socket bind, up to a depth limit. The daemon stamps
`depth` on each task record, derives a child's depth as `parent.depth + 1`,
and omits the socket bind entirely once the limit is reached.

This matters because it is structural rather than advisory. A ferry at the
limit is not told not to dispatch; it has no socket, so `taskferry dispatch`
fails with a connection error it cannot reason its way around. A prompt that
instructs a worker to dispatch itself cannot produce a runaway subtree.

The default limit is 3, which covers captain to first mate to leaf with one
level spare, and is configurable.

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

The command blocks until the question is answered, cancelled, the task is cancelled, or a defined operational failure occurs. The task is parked while it blocks, per the scheduling section above.

The exchange is two phases on the wire rather than one. **Register** returns
a durable `questionId` immediately; **await** then blocks on that ID. The
split is what makes daemon restart survivable, because a reconnecting CLI
re-awaits an ID it already holds instead of asking a second question.

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

Any local Task Ferry client may answer in the first version. The daemon
always records who asked, so narrowing who may answer is policy that can be
tightened later without touching the protocol. Restricting answers to the
direct parent now would be actively wrong: the parent may itself be blocked,
and the human is the answerer of last resort.

The protocol must not conflate authorization with identity attribution. The daemon always knows who asked, even where several actors are allowed to answer.

### Question state and daemon restart

Questions introduce durable in-flight state that the current fire-and-return flow does not have.

Implementation planning must specify what happens if the daemon restarts while:

- a ferry is blocked in `taskferry question`;
- an answer is already persisted but the caller has not received it;
- a pending question has not yet been answered.

The two-phase register-then-await split above resolves all three cases. The
`questionId` is durable and is returned before the CLI blocks, so on
reconnect the CLI re-awaits an ID the daemon can look up: still pending,
already answered, or cancelled. No case produces a duplicate question, and
silent loss of a pending question is not reachable.

## Parent/child task model

Add lineage metadata to the existing task record:

```text
parentTaskId: string | null
depth: number
```

`depth` is 0 for an externally dispatched root and `parent.depth + 1`
otherwise. It is stored rather than derived because the launch path needs it
to decide whether to bind the socket, and walking ancestors on every launch
to recompute it would be work the record can just carry.

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

## Nested changesets

Recursive dispatch cannot be correct until nested filesystem semantics are explicit.

Today a dispatched task runs in a sandboxed filesystem view and its changes can settle as a pending changeset. `taskferry accept <id>` applies that pending changeset to the task's target directory.

For a child spawned by a sandboxed parent, "the target directory" must normally be the parent's working view, not the real host checkout behind the parent.

Otherwise a child could bypass its parent and mutate state the parent has not accepted, breaking both isolation and the review/accept model.

### Required invariant

For a nested task:

> Accepting a child's changeset applies it into the parent ferry's visible working state exactly as if the parent had made that edit itself; it does not escape directly to the root host checkout unless the parent itself is rooted there by design.

### Mount strategy: stacked lower layers

The original draft anticipated a path-resolution problem here, on the
assumption that a parent-visible path and its host-side backing path would
differ and need a canonical mapping between them. Stacked lower layers make
that mapping unnecessary.

A child launches with one `--overlay-src` per ancestor, ordered bottom-first
from the real checkout up to its immediate parent, with its own upper on
top, mounted at the same absolute path the parent sees:

```text
--overlay-src <base checkout>
--overlay-src <grandparent upper>
--overlay-src <parent upper>
--overlay <child upper> <child work> <directory>
```

Because the child's `directory` is literally the same string as the
parent's, the daemon translates nothing. It resolves the caller's task,
walks that task's ancestor chain, and prepends one flag per ancestor.

This arrangement was tested directly: the child saw the parent's uncommitted
edit, the child's writes and deletions landed only in its own upper, and
both the parent's upper and the base checkout were unmodified afterward.

### Promotion on accept

Accepting a child moves its work up exactly one level, by changing only
where the existing apply step writes.

For a non-git target, `applyChangeset` today mounts the finished task's
overlay as a merged view at a synthetic mount point, read-write binds
`directory`, and rsyncs one into the other. For a nested task the source is
unchanged; the destination bind on `directory` becomes an overlay mount
whose lower stack is the parent's ancestry and whose upper is the parent's
upper. Every byte rsync writes then lands in the parent's upper rather than
on the host checkout. It is one additional parameter on
`buildMergedViewBwrapArgs`.

Reject is unchanged: delete the child's upper.

The git target path is the larger piece of work. It currently never enters a
sandbox at all, shelling out to `git apply --3way` directly against the host
directory. To nest, that call has to move inside a bwrap whose `directory`
is the parent's writable merged view. This is the path this repository uses
for nearly every dispatch, so it should be planned as real work rather than
as a variation on the non-git case.

Promotion deliberately reuses the diff pipeline rather than merging upper
directories directly. Deletions then arrive as ordinary diff hunks, so no
whiteout device has to be recreated, and accept behaves identically at every
level.

### Overlay lifetime constraint

A parent's overlay cannot be torn down while any descendant still mounts it
as a lower layer. `cleanupOverlay` and the daemon's orphan-overlay sweep
both need to consult lineage before removing anything, which neither does
today.

### Child accept authority

The parent ferry explicitly runs `taskferry accept <child-id>`. This is the
conservative choice and it preserves review before integration, which is the
property the whole changeset model exists to provide.

Auto-acceptance on successful completion, and letting skill policy choose
between the two, are both deferred. Neither should be added until a real
lifecycle demonstrates that explicit acceptance is the bottleneck.

## Making Task Ferry available inside ferries

Recursive orchestration requires a launched ferry to have access to the Task Ferry CLI and daemon transport.

Sandbox construction needs to expose three things, at three different
access levels:

- the Task Ferry executable, read-only. This already happens, since the root filesystem is bound read-only.
- the task's self-identity material, read-only, from a per-task source at a fixed destination.
- the daemon socket, read-write, and only below the depth limit.

The socket bind must be read-write. A read-only bind does not prevent
connecting to a Unix socket, so it is neither a working restriction nor a
meaningful signal of intent; the only real gate is whether the socket is
bound at all.

Nothing else from the runtime directory is exposed. That is what keeps the
sandbox from being an unscoped daemon client with visibility into every
other task's pending work.

No writable copy of Task Ferry itself is required inside the worker.

## Cancellation and lineage

Lineage introduces a cancellation question that does not exist for unrelated tasks.

Possible semantics:

1. cancel parent only; children continue independently;
2. cancel parent cascades to all descendants;
3. default parent-only plus an explicit cascade option.

Option 3. Cancelling a parent does not implicitly cancel its descendants,
and an explicit cascade is available for callers that want a subtree gone.
Descendants are discoverable either way, so the skill layer can walk and
cancel a subtree deterministically without the daemon inventing a policy.

The overlay lifetime constraint above interacts with this: cancelling a
parent while a child still runs must not release the parent's overlay, since
the child has it mounted as a lower layer.

## Scheduling and concurrency

Recursive orchestration must not create a second scheduler, and a child
dispatch is an ordinary dispatch with lineage metadata that enters the same
queue.

Left at that, it deadlocks.

The global launch gate refuses to start anything once `runningCount` reaches
the concurrency ceiling. A first mate blocked in `taskferry wait` is still
`running`, so it still holds a slot. Fill every slot with first mates
waiting on children, and no child can launch, so no parent can finish. This
is a permanent stall rather than a slowdown, and it needs only as many
simultaneous first mates as the concurrency limit to trigger. Below that
threshold every blocked parent still consumes capacity for work it is not
performing.

The fix stays inside the existing scheduler. A ferry blocked in a
daemon-mediated `wait` or `question` is **parked**, and a parked ferry does
not count toward `runningCount`. This is defensible on the ceiling's own
terms: the cap exists to bound provider load, and a parked ferry issues no
inference. Per-provider queues are unaffected.

Parking has a second consumer. The inactivity watchdog fails a running task
that produces no parseable log events for long enough, which is precisely
what a ferry waiting on an answer looks like. Parking must suspend the
watchdog as well as the concurrency accounting, or every blocked ferry is
eventually killed as stalled.

A parked ferry takes a distinct, visible status rather than an indefinite
silent block. It should read as waiting on someone in `list` output and in
session-start orientation, instead of appearing alive. An explicit
`--timeout` remains available for callers that want one, but there is no
default timeout, because a legitimate overnight question may wait hours and
killing that work is worse than surfacing it.

Per-parent concurrency, subtree budgets, token budgets, or model budgets may become useful later, but they are not required to establish the recursive protocol.

## Observability

Existing task views should gain enough lineage information to debug a hierarchy without introducing a completely separate UI.

The minimum set:

- `parentTaskId` and `depth` on full status/result output;
- child count on full task status;
- a pending-question flag, so a parked ferry reads as waiting on someone;
- question events on `watch`.

Deferred until a real hierarchy exists to justify them: tree-oriented
list/watch rendering, and cached root/ancestor identifiers if repeated
traversal turns out to be expensive.

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
       depth = 0
  -> daemon writes <runtimeDir>/tasks/A/id
  -> launch A with
       <runtimeDir>/tasks/A/id -> <runtimeDir>/self/id   (read-only)
       daemon.sock             -> <runtimeDir>/self/sock (read-write)
```

Nested dispatch:

```text
ferry A
  -> taskferry dispatch
  -> CLI reads <runtimeDir>/self/id, connects on <runtimeDir>/self/sock
  -> daemon resolves caller = A
  -> daemon creates task B
       parentTaskId = A
       depth = 1
  -> launch B with B's own id mounted at the same fixed path,
     socket bound only if depth < limit,
     and A's overlay upper stacked as a lower layer under B's own
```

Question:

```text
ferry B
  -> taskferry question "Need decision X"
  -> CLI reads self id, registers Q1, receives questionId, then awaits it
  -> daemon records Q1 { taskId: B, parentTaskId: A, status: pending }
  -> daemon parks B: slot released, watchdog suspended
  -> watch emits Q1
  -> any local client answers Q1
  -> daemon persists answer, unparks B, wakes the await
  -> B continues
```

Self status:

```text
ferry B
  -> taskferry self
  -> CLI reads <runtimeDir>/self/id
  -> daemon resolves B
  -> existing status path for B
```

## Error handling summary

| Situation | Behavior |
| --- | --- |
| self-scoped command outside a ferry | fail fast with a usage/operational error explaining no task identity is available |
| self identity file missing inside a launched ferry | task/environment bug; fail loudly, never guess from environment or cwd |
| self identity file names an unknown/stale task ID | reject the self-scoped RPC |
| nested dispatch | daemon derives `parentTaskId` from authenticated caller identity |
| child receives parent identity | invariant violation; integration test must catch this |
| ferry asks a question | daemon attributes question to authenticated caller and blocks until answer/cancel/failure |
| ferry attempts to claim another task in a self-scoped call | impossible through supported CLI; daemon ignores caller-supplied identity |
| parent exits while child runs | child remains a normal durable task unless cancellation policy explicitly says otherwise |
| child changeset accepted | must apply into the correct parent-visible working state, not silently escape to root checkout |
| daemon restarts with pending question | CLI re-awaits its durable `questionId`; never asks a second time |
| ferry at the depth limit calls dispatch | no socket is bound, so the call fails to connect |
| parent cancelled while a child still runs | parent's overlay is retained, because the child mounts it as a lower layer |
| parked ferry exceeds the no-output timeout | watchdog does not fire; parking suspends it |

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

### Depth gate and sandbox narrowing

- Dispatch a ferry at the depth limit; prove it has no socket and that `taskferry dispatch` fails from inside it.
- From inside a sandbox, attempt to read another running task's overlay upper directory; prove it is not reachable.
- Attempt to read another task's identity file; prove it is not reachable.
- Prove the identity file cannot be modified from inside the sandbox.

### Scheduling

These need a real daemon with a real concurrency limit; the deadlock is a
scheduler property and cannot be observed against mocked launches.

- Set the concurrency limit to N. Start N first mates that each dispatch a child and wait. Prove every child eventually launches and every parent finishes.
- Prove a parked ferry does not count toward `runningCount`.
- Prove the inactivity watchdog does not kill a ferry parked on a question for longer than the no-output timeout.

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

## Decisions

1. **Self-status command spelling.** Resolved: `taskferry self`, leaving `taskferry context` untouched.
2. **Identity strength.** Resolved: read-only task ID for the first version, with the mount itself acting as the capability. Identity material lives outside anything the sandbox can enumerate, and self-scoped calls get their own daemon method, so an opaque capability can be added later without a protocol break.
3. **Nested filesystem mapping.** Resolved: stacked overlay lower layers mounted at the same absolute path, so no mapping is required. Accept promotes one level by retargeting the existing apply at the parent's writable merged view.
4. **Question authorization.** Resolved for the first version: any local caller may answer. The daemon always records who asked, so this can be narrowed later.
5. **Question restart behavior.** Resolved: two-phase register-then-await, so a reconnecting CLI re-awaits a durable ID rather than asking again.
6. **Cancellation.** Resolved: parent-only by default, explicit cascade available, descendants always discoverable.
7. **Child acceptance.** Resolved: parent-explicit accept, preserving review before integration. Whether a skill may opt into auto-accept is deferred until a real lifecycle asks for it.
8. **Lineage presentation.** Resolved to a minimum set; tree rendering deferred.

Still genuinely open, deferred because no evidence yet justifies a choice:

- The default depth limit of 3 is a guess. It should be revisited once real hierarchies exist and their actual depths are known.
- Whether the git-target accept path is worth restructuring generally, or only wrapped for the nested case.

## Prerequisite defects

These exist independently of recursive orchestration and should be filed and
fixed separately. Two of them block this design, because it cannot be built
correctly on top of them.

1. **Sibling overlay exposure.** Every running ferry can read and write every other running ferry's pending changeset. Blocks this design: identity material cannot be protected while the overlay tree's parent directory is bound read-write.
2. **Ineffective read-only socket guard.** The advisor role's read-only bind does not prevent connecting to the daemon socket. Blocks this design: the socket bind is the recursion capability, so it has to actually gate.
3. **Deny-list ordering no-op.** A deny-list entry nested under the runtime directory is silently un-masked by the later parent bind. Does not block, but will mislead whoever tries to fix the first defect the obvious way.

## Recommended implementation sequence

0. Fix the two blocking prerequisite defects above: narrow the runtime-directory bind, and stop relying on a read-only bind to gate the socket.
1. Add task lineage (`parentTaskId`, `depth`) without recursive dispatch behavior.
2. Add daemon-issued self identity and `taskferry self`; integration-test that nested identity resolves to exactly one task per level.
3. Bind the socket per task, gated on depth. Prove a ferry at the limit cannot dispatch.
4. Enable nested `dispatch` with daemon-derived parentage.
5. Add parking, so a ferry blocked in `wait` releases its concurrency slot and is exempt from the inactivity watchdog. This precedes any multi-level work, because without it a two-level hierarchy can deadlock the queue.
6. Stack overlay lower layers for nested launches; teach overlay cleanup and the orphan sweep to respect lineage.
7. Retarget accept at the parent's merged view, non-git path first, then the git path. Prove two- and three-level accept/reject with real integration tests.
8. Add durable `question` / `answer` plus watch events.
9. Add minimal lineage observability.
10. Only then update SDD skills to introduce captain/first-mate recursive decomposition and review loops.
11. Iterate on decomposition/review policy in skills independently of the substrate.

The substrate is complete when an ordinary ferry can safely behave like an orchestrator without Task Ferry needing to know that it is a "first mate."
