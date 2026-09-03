# Reorientation brief

Context handoff for two independent threads investigated in the same session.
Verified against `jeremysball/taskferry` @ `6661b55` and `gastownhall/beads` @
`40b3232`.

## Thread 1 -- orchestration

The decision lives in `docs/adr/0004-work-of-record-vs-run-state.md`. Read that
first; this section only holds reference material that did not belong in an ADR.

**One-line version:** GitHub and SDD are the durable work of record and are
already fine. What is missing is *run state* -- what is in flight, which ferry has
it, what is ready next -- plus something to do the assigning. Build a derived,
disposable, single-writer run ledger and an orchestrator skill on top of it.
Beads is a work-of-record system and would duplicate GitHub, so it is out.

**Beads operational detail**, retained in case the dependency-complexity trigger
in the ADR ever fires:

- Deployment for multiple writers is one shared `dolt sql-server` (Unix socket
  preferred over TCP). Embedded mode is single-writer via file lock. Federation
  (peer-to-peer sync of separate DBs) has node-local leases that are
  unenforceable across replicas, degrading claim safety to eventual.
- Dolt has no row-level locking and no `SELECT FOR UPDATE`; it merges concurrent
  transactions cell-by-cell and is REPEATABLE READ, not SERIALIZABLE. Beads
  compensates by rewriting a random `row_lock` cell on every ownership-mutating
  path, forcing a real conflict that is retried with backoff (25 ms initial, 15 s
  budget). **Consequence: nothing may write that database except through `bd`.**
- `bd ready --claim` computes the *entire* ready set inside a transaction and
  walks it (`Limit=0, MaxRows=0`, deliberate -- bounding it would make claim
  spuriously report "nothing ready"). Cost scales with backlog. Narrow filters,
  no idle hot-polling.
- `--claim` cannot combine with `--mol`, `--gated`, or `--explain`. Scoped
  claiming is `bd ready --mol X` then `bd update <id> --claim`.
- `bd update --if-assignee` / `--if-status` are general CAS guards. **Exit 13**
  means a guard lost the race (skip gracefully); 1 means real failure.
- Leases: 5 min default TTL, kept alive by `bd heartbeat`, expired ones reverted
  by `bd reclaim`.
- Server mode defaults auto-commit **off** (committing per write under load
  causes "database is read only"), so history needs a periodic `bd vc commit`.
  Uncommitted is not unsaved -- the working set is durable -- but push and
  `bd history` need commits.
- Never commit the Dolt directory to git; `bd doctor --fix` maintains the
  gitignore. The git-visible artifact is `.beads/issues.jsonl`, an export
  refreshed by a pre-commit hook when `export.auto=true`.
- `bd create --skills` is not a real field -- it appends `## Required Skills` to
  the description. `bd create --validate` only lints that a markdown heading
  exists, never that criteria are good or met. Neither is a verification
  mechanism; Beads has none.

## Thread 2 -- daemon exclusivity

**The bug class:** using *time* as a proxy for *liveness*. `staleMs`, lock-file
mtime, and health-check timeouts are all guesses about whether another process is
alive. Once liveness must be inferred you need a reclaim path; a reclaim path is
check-then-act; check-then-act has a window. Fix the inference and the chain
collapses.

**What is already correct -- do not "fix" these:**

- `socketHealth`'s error handler concludes `listening: false` only for ENOENT /
  ECONNREFUSED / ENOTSOCK, and rejects on anything ambiguous. EAGAIN from a full
  backlog does not get a live socket unlinked.
- A CPU-starved daemon is handled safely. AF_UNIX `connect()` completes in the
  kernel as soon as the request lands in the listen backlog -- the daemon need not
  be scheduled at all -- so a starved daemon yields `{listening: true, healthy:
  false}` and the booting process refuses to start. Misleading message, safe
  outcome.
- Per-call-site `staleMs` sizing in `ensureDaemonStarted` (`startupTimeoutMs +
  1000`) is deliberate, and the default `timeoutMs` (5 s) being shorter than the
  default `staleMs` (10 s) means reclaim is mostly reachable only for genuinely
  orphaned lock files.

**Why the lock exists at all:** `state-lock.js` landed in PR #6 (2026-07-14) to
make `tasks.json` writes safe when every CLI invocation wrote state directly.
`daemon.js` landed the next day and made that world obsolete. The lock survived,
repurposed for daemon lifecycle -- a job it was not designed for. When a primitive
is reused, its assumptions do not travel with it, and nothing flags the mismatch.
Worth a standing review question: for any shared primitive, do its current
callers still match the assumptions in the commit that introduced it?

**What is wrong:** see `docs/issues/daemon-exclusivity.md`.

## Concepts

- **CAS (compare-and-swap):** one atomic op that writes only if the current value
  still matches what you read, folding the check into the write and eliminating
  check-then-act races. `O_CREAT|O_EXCL` (Node's `flag: "wx"`) is the
  filesystem's only native CAS: absent → mine.
- **Fence token:** a token carried by the right to act, which the *protected
  resource* validates at write time. A lock answers "may I start?"; a fence
  answers "am I still allowed, right now?" Beads' `row_lock` is a fence -- they do
  not perfect the claim, they make the write conditional.
- **Acquire-as-test:** with a kernel resource whose lifetime is bound to the
  process, you never check liveness -- you attempt to acquire, and success *means*
  the previous holder is dead. Test and exclusion are one atomic operation, so
  there is no window between deciding and acting.
- **Pid reuse:** pids are recycled, so a recorded pid can be answered by an
  unrelated process and `kill(pid, 0)` alone is not a liveness check. Pid +
  kernel start time (`/proc/<pid>/stat` field 22, monotonic, never reused) is.
