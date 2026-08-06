# Task 1 Report: raise the shared `task.tail`/`--tail-chars` ceiling to 131072

**Status:** DONE
**Commit (in worktree `.worktrees/advisor-context-dump`, branch `docs/advisor-context-dump-spec`):**
`ce2291f feat(tail): raise the chars ceiling from 65536 to 131072`

## Implementation

Raised the `chars` ceiling from 65536 to 131072 at all three enforcement points, per the brief:

- `src/args.js:84` — help text ("maximum 131072").
- `src/args.js:419` — `parseNumber(value, name, { min: 1, max: 131072 })` for `tailChars`/`chars`.
- `src/protocol.js:142` — `task.tail`'s `validParams` check (`value <= 131072`).
- `src/tasks.js:3098-3099` — `tail()`'s runtime guard and error message.

## Sanctioned deviation

The brief's own `args.test.js` case expects the out-of-range error message to
match `/from 1 through 131072/`, but the existing `parseNumber` helper's
`min === 1` branch only ever produced `"a positive integer"` (no range),
regardless of which bound was violated. Made one minimal edit at
`src/args.js:203` so that branch includes the range only when the value
exceeds `max`, leaving the `--chars 0` case's message unchanged:

```js
const qualifier = min === 1 ? (number > max ? `a positive integer from ${min} through ${max}` : "a positive integer") : `from ${min} through ${max}`;
```

Verified both cases hold: `--chars 0` still throws `"a positive integer"`,
`--chars 131073` throws `"a positive integer from 1 through 131072"`.

## Test evidence

Fresh, controlled re-run in the worktree (`.worktrees/advisor-context-dump`,
HEAD `ce2291f`), matching the orchestrator's own independent run:

```
$ node --test src/args.test.js src/protocol.test.js src/tasks.test.js
ℹ tests 393
ℹ pass 393
ℹ fail 0
```

All 3 new tests (`args.test.js`, `protocol.test.js`, `tasks.test.js`) pass,
plus the full existing suites in these three files.

Note: a task-reviewer dispatch (`oc_ms9jn4vh_e4e7ec2f`) initially reported
2/393 failures at `tasks.test.js:811`/`:850`. Both the orchestrator (direct
worktree run) and a controlled re-run with `XDG_DATA_HOME`/`XDG_CACHE_HOME`
unset reproduced 393/393 clean. The 2 failures only appear when
`XDG_DATA_HOME` is set to a dispatch-sandbox-specific path — an
environment artifact of that reviewer's own sandbox, not a regression
introduced by this task's diff. Confirmed pre-existing/unrelated: those two
tests assert on real `~/.local/share/opencode/auth.json` presence, nothing
this task's diff touches.

## Files changed

```
M  src/args.js
M  src/args.test.js
M  src/protocol.js
M  src/protocol.test.js
M  src/tasks.js
M  src/tasks.test.js
```

## Concerns

None outstanding. The report file itself was lost on the first two dispatch
attempts (sandbox path/mount issues, documented in the ledger) and was
reconstructed by the orchestrator from verified command output plus the
implementer's own settled task messages, rather than from a file the
implementer wrote directly — content is accurate to what actually landed
in the accepted commit.
