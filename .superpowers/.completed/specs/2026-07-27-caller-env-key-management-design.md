# Caller-Env Key Management Design

**Supersedes** the now-deleted `.superpowers/specs/2026-07-27-env-denylist-design.md`
(removed in this spec's own initial commit). That spec's `envDenylist`/
`TASKFERRY_ENV_DENYLIST` config surface and its `src/executor.js:151`
`.pi` → `.pi/agent` fallback fix both fold into this spec (denylist
repositioned in the pipeline, see §4; the executor.js fix is unchanged and
still in scope, §6).

**Revision note:** an independent `opencode-go/kimi-k3` (max effort) review
of the first version of this spec found five real defects, verified against
source before folding in here: §3/§5 never mentioned `src/daemon.js`, whose
`invoke()` would have silently dropped the `env` param for `task.summary`
and `task.advisor`; the `OPENCODE_CONFIG*` stripping in today's
`summaryEnvironment()` was unaccounted for; `task.summary --mode activity`
and the background `scheduleActivity()` refresh path share one fixed-
signature closure with no room to carry a live caller's env, making the
original §5 promise undeliverable as written; dispatch's env resolution is
deferred past a queuing gap (`pendingLaunches` → `startTask()`) the original
spec didn't thread `env` through; and `skills/using-taskferry/SKILL.md` was
misidentified as generated when it is actually the canonical source. All
five are fixed below.

**Goal:** Rip out taskferry's entire key-slot management system
(`TASKFERRY_KEY_SLOTS`, `TASKFERRY_PROVIDER_KEY_ENV`,
`TASKFERRY_SUMMARY_KEY_SLOT`, `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV`, and
everything they touch) and replace it with a simpler model: the process
issuing a live CLI command (`dispatch`, `summary --mode report`, `advisor`)
forwards its own environment to the daemon, which unions it on top of its
own ambient environment — caller wins — before spawning a worker or
report-mode summary child. No more slot registries, no more "restart the
daemon after exporting a new key."

## 1. Why

The key-slot system exists because the daemon is long-running and only ever
sees the environment it started with — a key exported in a later shell
session is invisible to it without a restart (`docs/security.md`). Working
around that required a whole parallel config surface (named slots, a
provider-key target variable, explicit `--key-slot` selection per dispatch)
that duplicates what a normal shell environment already does. Since the
daemon and every caller run as the same local user over a `0600` socket
(`docs/security.md:9-16`'s existing trust model: "run a separate daemon per
user ... instead of relying on socket-level access control"), there's no
trust boundary being crossed by having a live caller hand its own env to
the daemon it's talking to — a caller can already read the daemon's own
ambient env via `/proc` and run arbitrary code via dispatch prompts, so
handing over its own env adds no new capability the trust model didn't
already grant.

## 2. Full rip-out

Removed entirely, no deprecation period:

- Env vars: `TASKFERRY_KEY_SLOTS`, `TASKFERRY_PROVIDER_KEY_ENV`,
  `TASKFERRY_SUMMARY_KEY_SLOT`, `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV`.
- `config.json` fields: `keySlots`, `providerKeyEnv`, `summaryKeySlot`,
  `summaryProviderKeyEnv` (`src/config.js:19-22`'s `CONFIG_FIELD_TYPES` and
  its `parseKeySlots(parsed.keySlots)` validation call at `src/config.js:79`).
- CLI: `--key-slot` flag (`src/args.js:335`, plus its default in the no-op
  dispatch options at `src/args.js:231`).
- RPC: the `keySlot` param on `task.dispatch` (`src/protocol.js:84,90`) and
  `"keySlot"` from `RESULT_FIELDS` (`src/protocol.js:33`).
- `src/commands.js:83`: the `keySlot` spread in the `dispatch` case's RPC
  params.
- `src/tasks.js`: `parseKeySlots()`, `resolveKeySlot()`,
  `providerKeyEnvNameFor()`, the `keySlots` Map, `keySlotsSpec` /
  `providerKeyEnvName` / `summaryKeySlot` / `summaryProviderKeyEnvName`
  `createTaskManager` options and their JSDoc entries, the `keyEnvValue`
  field on `DispatchLaunch`/`SummaryLaunch` (JSDoc at `src/tasks.js:102,116`,
  used at `src/tasks.js:574-578,1024,1060`, replaced per §3.4 below), and
  the `keySlot` output field on `summarize()` (`src/tasks.js:859`) and
  `result()` (`src/tasks.js:2647`) — `summarizeRow()` (`src/tasks.js:884-887`)
  has no `keySlot` field and needs no change.
- The preflight "no credentials available for `<provider>`" check at
  `src/tasks.js:1023-1028`. This check only ever fired for the single
  provider `TASKFERRY_PROVIDER_KEY_ENV` named — generalizing it to check
  every dispatched provider's conventional `<PROVIDER>_API_KEY` name would
  false-positive on providers authenticated via OpenCode's own `auth.json`
  (OAuth-based, no env var at all), so no replacement preflight is added.
  A missing-credential dispatch now fails from inside the spawned child
  instead, still classified by the existing `PROVIDER_FAILURE_BUCKETS`
  parser (`src/tasks.js:210-229`, e.g. the `pi_authentication_failed`
  bucket already observed in this project's own task history) rather than
  surfacing as a truly opaque crash.
- All tests exercising any of the above (`src/tasks.test.js`,
  `src/args.test.js`, `src/config.test.js`).
- Docs: the "Provider key slots" section of `docs/security.md` (replaced,
  not just deleted — see §7); the `keySlots`/`providerKeyEnv`/
  `summaryKeySlot`/`summaryProviderKeyEnv` rows and example in
  `docs/config.md`; the `TASKFERRY_KEY_SLOTS` / `TASKFERRY_PROVIDER_KEY_ENV`
  / `TASKFERRY_SUMMARY_KEY_SLOT` / `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV` rows
  in `docs/sourcemap.md`'s env var table, and the phrase "key-slot env
  stripping" in `docs/sourcemap.md:48`'s `tasks.js` responsibility summary;
  `--key-slot` and the `keySlot` result field in `docs/cli-reference.md`
  (the flag itself, plus the separate result-field mentions around lines
  169 and 222); the three `--key-slot` retry-advice mentions inside
  `docs/troubleshooting.md:108-114`'s provider-failure-bucket entries
  (distinct from the named error entry around lines 144-150, also removed);
  the `key_slot` → `--key-slot` migration row in
  `docs/migrating-from-mcp.md:41`.
- `skills/using-taskferry/SKILL.md` is the **canonical source** for the
  taskferry-integration skill (confirmed via `scripts/generate-skill.js:10-13`:
  it reads this exact path and writes the generated copies to
  `integrations/claude/skills/using-taskferry/SKILL.md` and
  `integrations/codex/skills/using-taskferry/SKILL.md`). Edit the canonical
  file directly, then run `npm run skill:generate` (checked at dispatch
  time by `checkSkills()` in `src/commands.js`) to refresh the generated
  copies — do not hand-edit either generated copy.

## 3. New mechanism: caller-env union

### 3.1 Wire and CLI

`src/commands.js`'s `runCommand()` already receives the caller's
environment as its `env` parameter (default `process.env`). Three RPC calls
gain a new `env: env` param, sending that environment across the socket
as-is (no client-side filtering — filtering happens once, daemon-side):

- `dispatch` case (`src/commands.js:77`, `task.dispatch`)
- `advisor` case (`src/commands.js:130`, `task.advisor`)
- `summary` case (`src/commands.js:163`, `task.summary`)

`src/protocol.js`'s param validators for these three methods gain an
optional `env` field, added to each method's `hasOnly([...])` allow-list
and validated with
`optional(params.env, (value) => isObject(value) && Object.values(value).every((entry) => typeof entry === "string"))`
— `isObject` is already imported from `./numbers.js` for other params.
Plain `typeof === "string"` (not a non-empty-string check) on purpose:
`process.env` can legitimately hold an empty-string value (`export FOO=`),
and rejecting the whole `env` payload over one empty-string entry would be
a spurious failure on a real, if unusual, caller environment. An
empty-object `env` (`{}`) is also valid.

### 3.2 Daemon-side dispatch (`src/daemon.js`)

`invoke()`'s three affected branches (`src/daemon.js:176-223`):

- `task.dispatch` (`src/daemon.js:182`, `return manager.dispatch(params)`)
  already forwards the whole `params` object, including the new `env`
  field, with no change needed here — this is the one branch the original
  version of this spec correctly covered by implication.
- `task.summary` (`src/daemon.js:201-205`) currently rebuilds an explicit
  `{ maxWords, mode }` options object and would silently drop `params.env`
  if left as-is. Add `...(params.env === undefined ? {} : { env: params.env })`
  to that object.
- `task.advisor` (`src/daemon.js:206-215`) currently rebuilds an explicit
  field list and would likewise silently drop `params.env`. Add the same
  `env` passthrough to the object passed to `manager.advisor`.

Manager-side parameter naming stays `env` throughout (`dispatch`,
`advisor`, `summarizeTask`, `sanitizedEnvironment`, etc.) — no `env` →
`callerEnv` rename anywhere in the call chain. The original version of
this spec introduced that rename only for `tasks.js`'s internal functions,
which is exactly the kind of naming drift that let the `daemon.js` gap go
unnoticed: keeping one name end-to-end removes an entire class of
"forwarded under the wrong key" bug.

### 3.3 The merge pipeline

`src/tasks.js`'s `environmentWithoutKeySlotSources()` is renamed to
`sanitizedEnvironment(env)` (taking the caller's env as an argument,
`env = {}` default) and rewritten to build the final base environment in
this fixed order:

1. `base = {...process.env}` — the daemon's own ambient environment, read
   fresh at the moment this function runs (spawn time for dispatch, per
   §3.4 — not stale at whatever moment the request was queued).
2. `overlay = {...env}` with a fixed excluded set deleted: `PATH`, `HOME`,
   `TASKFERRY_STATE_DIR`, `TASKFERRY_RUNTIME_DIR`, `TASKFERRY_CACHE_DIR`,
   `TASKFERRY_SOCKET_PATH`. All six are daemon-controlled plumbing resolved
   once at the daemon's own startup (state/runtime/cache directory layout,
   binary resolution, home-relative sandbox bind targets, and — the one the
   original version of this spec missed — the daemon's own socket path,
   resolved at `src/daemon.js:40` and documented at `docs/sourcemap.md:100`).
   A caller with `TASKFERRY_SOCKET_PATH` exported (common when running a
   second, test daemon in another shell) must not have that value forwarded
   into every worker it dispatches — a nested `taskferry` call inside that
   worker would otherwise dial the caller's socket instead of the daemon's
   real one (the one the sandbox deliberately binds read-write for nested
   dispatch, `docs/security.md`'s bubblewrap section), breaking or
   misrouting the nested call. A different value from whichever shell
   happened to invoke the CLI must not desync the daemon from its own
   already-fixed layout for any of these six.
3. `merged = {...base, ...overlay}` — caller wins on every key it sets that
   isn't in the excluded set.
4. `for (const name of envDenylist) delete merged[name];` — applied
   **last** among the general-purpose steps, after the union, stripping the
   name regardless of whether the value came from the daemon's ambient
   environment or the caller. See §4.

`sanitizedEnvironment(env)` returns `merged` after step 4. The two callers
then each add their own final, non-overridable step:

- `dispatchEnvironment(env)` returns `{ ...sanitizedEnvironment(env),
  TASKFERRY_CHILD: "1" }`.
- `summaryEnvironment(env)` returns `{ ...sanitizedEnvironment(env),
  TASKFERRY_CHILD: "1" }` **minus** `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`,
  and `OPENCODE_CONFIG_CONTENT` — i.e. delete those three names from the
  result after `sanitizedEnvironment()` returns, same as `summaryEnvironment()`
  does today (`src/tasks.js:596-598`), but now positioned *after* the
  caller-env union rather than only after copying `process.env`. This is
  necessary, not cosmetic: those three names aren't in step 2's excluded
  set, so without this deletion a caller could reintroduce arbitrary
  OpenCode config into a summary child via its own `env` — an undocumented,
  security-relevant change from today's guarantee that summary children
  always run under stock config. `TASKFERRY_CHILD` is forced after this
  deletion (unaffected by it either way, since the name doesn't overlap).

In both cases, `TASKFERRY_CHILD` is set absolute-last, unconditionally,
after every deletion — unchanged from today: a denylist entry naming
`TASKFERRY_CHILD` would be pointless self-sabotage the code doesn't need to
guard against, since this assignment always wins regardless.

### 3.4 Threading `env` through to spawn time

Two different storage shapes exist today, and they need two different
fixes:

- **Summary launches already store a precomputed environment.**
  `summarizeTask()` computes `const env = summaryEnvironment();` once,
  synchronously, during the live RPC call (`src/tasks.js:1392`, and
  identically at `src/tasks.js:1095` for the preflight), then stores it
  directly on the `SummaryLaunch` object: `pendingLaunches.set(id, { kind:
  "summary", ..., env, ... })` (`src/tasks.js:1445-1452`). `startTask()`
  later reads it back verbatim: `summaryLaunch.env`
  (`src/tasks.js:1541`). Threading the caller's `env` through here is a
  straightforward parameter change — `summarizeTask(taskId, { ..., env })`
  → `summaryEnvironment(env)` — with no queuing-gap concern, since the
  environment is already frozen at request time by design.
- **Dispatch launches are different: only a single resolved key value is
  stored, and the real environment build is deferred to spawn time.**
  `dispatch()` resolves `resolvedKeySlot.keyEnvValue` and stores just that
  scalar on `DispatchLaunch`: `pendingLaunches.set(id, { ...,
  keyEnvValue: resolvedKeySlot.keyEnvValue, ... })` (`src/tasks.js:1060`).
  `startTask()` doesn't call `dispatchEnvironment()` until the task
  actually launches — which can be arbitrarily later than the dispatch
  request, once the rate-limit window and concurrency cap allow it
  (`launchQueuedTasks()`, `src/tasks.js:1466-1487`) — via
  `dispatchEnvironment(dispatchLaunch.keyEnvValue)`
  (`src/tasks.js:1541`). §2 removes `keyEnvValue`; replace it with an `env`
  field on `DispatchLaunch`, stored the same way `SummaryLaunch` already
  stores its `env` — captured once at `dispatch()` time from the request's
  `env` param, not recomputed or re-read at spawn time. `startTask()`
  becomes `dispatchEnvironment(dispatchLaunch.env)`. This preserves the
  existing, correct behavior of reading the *daemon's* ambient portion
  fresh at actual spawn time (`sanitizedEnvironment()`'s step 1 runs inside
  `dispatchEnvironment()`, called from `startTask()`) while freezing the
  *caller's* portion at the moment the caller actually made the request —
  which is what "the caller's environment" should mean regardless of how
  long a dispatch sits queued.

## 4. Denylist: unchanged config surface, repositioned pipeline slot

`envDenylist` (config field) / `TASKFERRY_ENV_DENYLIST` (env var) /
`parseEnvDenylist()` are implemented exactly as specified in the superseded
spec — same comma-separated flat-string grammar as `allowedDirs`, same
precedence (env var over config file), same `createTaskManager` option
wiring, same `src/config.js` `CONFIG_FIELD_TYPES` entry. The only change
from that spec is *where* stripping happens in the pipeline: §3.3 step 4,
after the caller-env union, not merely after copying `process.env`. This
makes the denylist strictly more powerful than originally specified — it
now also blocks a caller from ever re-introducing a name the daemon
operator has decided is permanently unsafe, not just from inheriting it
ambiently.

The now-moot "denylist vs. provider-key restore precedence" section from
the superseded spec is dropped — there is no provider-key restore step
anymore for the denylist to defer to.

## 5. Forwarding scope: live calls only, and one deliberate carve-out

- `task.dispatch`, `task.advisor`, and `task.summary` **in report mode**
  (the default — no `--mode` flag, or `--mode report`) carry the caller's
  `env`. `task.advisor` gets this via `dispatch()` internally, since
  `advisor()` calls `dispatch()` directly (`src/tasks.js:2257`).
- `task.summary --mode activity` does **not** carry the caller's `env`,
  even though it's a live RPC call, and this is a deliberate scope
  narrowing, not an oversight. `summarizeRequest()` routes `--mode
  activity` to `activitySummary()` (`src/tasks.js:1211-1213`), which calls
  `activityCache.refresh(source, {...})` (`src/tasks.js:1200`) — the exact
  same `activityCache` instance, and the exact same fixed-signature
  `summarize` closure (`({ task, maxWords, previousActivity }) =>
  summarizeActivity(task.id, maxWords, previousActivity)`,
  `src/tasks.js:695`), that the *background* `scheduleActivity()` refresh
  path also calls (`src/tasks.js:702,728-729`, invoked from
  `src/tasks.js:1732,1825,1835,1874,2074`). There is no per-call hook in
  that closure's signature to carry a live caller's `env` through to
  `summarizeActivity()` → `summarizeTask()` without either restructuring
  `src/activity.js`'s cache/callback contract (out of scope here — it's a
  shared-cache design serving both live and background callers by
  construction, and reworking it is a separate piece of work) or stashing
  `env` in manager-scope state, which would leak a live caller's
  environment into a later, unrelated background refresh for the same
  task — a real bug, not a hypothetical one, since both paths share the
  identical downstream call chain. Given that, `--mode activity` keeps
  today's ambient-only behavior, same as every background refresh, and
  `task.summary`'s default report mode is the path actually worth fixing —
  it's the one a user or an implementer's `taskferry summary` invocation
  reaches directly.

## 6. `executor.js:151` fallback fix (unchanged from superseded spec)

`realAgentDir = spawnEnv.PI_CODING_AGENT_DIR || path.join(homeDir, ".pi")`
→ `path.join(homeDir, ".pi", "agent")`, matching pi's own `getAgentDir()`.
`src/executor.test.js:62` (`"sandboxAuthFile falls back to ~/.pi"`) updates
its expected path to include the `/agent` segment. This fix is independent
of everything else in this spec but was folded into the superseded spec
because the denylist was the mechanism that made the fix observably correct
(see that spec's now-superseded "Denylisting `PI_CODING_AGENT_DIR` alone is
not sufficient" section) — still true here, since `envDenylist` still
exists and is still the mechanism an operator uses to strip a stale
`PI_CODING_AGENT_DIR` from the daemon's own ambient environment. What
changes in practice: a caller can now *also* just export the correct
`PI_CODING_AGENT_DIR` in their own shell before dispatching, and it wins
over the daemon's stale ambient value without needing `envDenylist`
configured at all. The same caller-controlled steering applies to
`XDG_DATA_HOME` for OpenCode dispatches (`src/tasks.js:1559`,
`src/executor.js:208`) — both determine which host `auth.json` gets
ro-bound into the sandbox; there's no privilege escalation under the
same-user trust model (§1), but a caller now has more influence over which
credential file gets bound than it did before, worth knowing even though
it isn't a new boundary crossing.

## 7. Docs to add (not just remove)

The superseded spec's own "Docs to update" section specified real
additions that this spec's §2 rip-out list doesn't restate on its own —
listed explicitly here so an implementer working only from this file
doesn't miss them:

- `docs/config.md`: new `envDenylist` row (same shape as the existing
  `allowedDirs` row).
- `docs/sourcemap.md`: new `TASKFERRY_ENV_DENYLIST` row in the env var
  table.
- `docs/security.md`: replace the deleted "Provider key slots" section
  with new prose describing the caller-env union model (§1, §3.3) and the
  denylist's repositioned role as a backstop (§4). This isn't optional
  cleanup — `docs/security.md:36` ("a dispatched task inherits the
  daemon's own process environment, so it authenticates the same way the
  daemon does") becomes actively false once a live caller's env can win
  over the daemon's ambient values, and this repo's `CLAUDE.md` treats
  `docs/security.md` as the project's stated trust model, not just a nice-
  to-have doc.
- `docs/cli-reference.md` and `skills/using-taskferry/SKILL.md` (canonical
  copy, then regenerate per §2): a short note that `dispatch`/`advisor`/
  `summary` (report mode) now forward the caller's own environment to the
  daemon by default, with no per-call opt-out (§8).

## 8. Known limitation: `modelsCache` is not env-scoped

`summaryModelAvailable()` (`src/tasks.js:1077-1088`) memoizes
`listModelsFn(env)`'s output in a single module-scope `modelsCache`
variable for 5 minutes, keyed only by expiry time, not by which `env`
produced it (`src/tasks.js:682`). With per-caller `env` now possible, a
model-availability check populated by caller A's environment (a different
`OPENCODE_CONFIG` or provider key, and therefore a different available-model
list) can be served to caller B's or a later background refresh's check
within that same 5-minute window. This is accepted as a known limitation
rather than fixed here — the blast radius is a stale-but-plausible
model-availability answer for at most 5 minutes, not a credential leak, and
scoping the cache by environment fingerprint is real added complexity for a
narrow benefit. Revisit if it causes a real incident.

## 9. Testing

- `src/tasks.test.js`: rewrite the key-slot spawn-capture tests
  (`environmentWithoutKeySlotSources`/`dispatchEnvironment`/
  `summaryEnvironment` behavior) as `sanitizedEnvironment` tests covering
  the full pipeline order in §3.3: caller env overlays daemon ambient env;
  the fixed excluded set (`PATH`, `HOME`,
  `TASKFERRY_STATE_DIR`/`RUNTIME_DIR`/`CACHE_DIR`/`SOCKET_PATH`) is never
  overridden by `env` even when present there; a denylisted name is
  stripped even when `env` explicitly sets it; `TASKFERRY_CHILD` survives
  even when denylisted; `env === undefined` (the `--mode activity` and
  background-refresh paths) behaves as ambient-only; `summaryEnvironment`
  strips `OPENCODE_CONFIG`/`OPENCODE_CONFIG_DIR`/`OPENCODE_CONFIG_CONTENT`
  even when `env` explicitly sets one of them. Also cover the queuing case
  from §3.4: a `DispatchLaunch`'s stored `env` is the one captured at
  `dispatch()` time, not re-read from a different `env` if one were somehow
  available later (there isn't one in practice, but the field should be
  read from the stored launch, not from an ambient/global source, to guard
  against a future regression). Delete the key-slot-specific tests
  (`resolveKeySlot`/`parseKeySlots`/the "no credentials available" preflight
  tests) outright rather than adapting them.
- `src/config.test.js`: delete `keySlots`/`providerKeyEnv`/
  `summaryKeySlot`/`summaryProviderKeyEnv` field tests; `envDenylist`
  string-type acceptance/rejection tests carry over unchanged from the
  superseded spec.
- `src/args.test.js`: delete `--key-slot` flag tests.
- `src/commands.js` tests (wherever `runCommand("dispatch"/"advisor"/
  "summary", ...)` is exercised): assert the RPC request now includes
  `env` sourced from the injected `env` option, for all three commands.
- `src/protocol.js` tests: `env` accepted as an optional object param on
  the three affected methods; `keySlot` no longer accepted.
- `src/daemon.js` tests: `invoke()`'s `task.summary` and `task.advisor`
  branches actually forward `params.env` into the call to
  `manager.summarize`/`manager.advisor` — this is the specific gap the
  independent review caught, so it needs its own explicit test, not just
  coverage-by-implication from the `task.dispatch` case.

## 10. Non-goals

- No opt-out flag (e.g. `--no-env-forward`) to suppress caller-env
  forwarding on a single call — the denylist is the only override
  mechanism. YAGNI unless a real need surfaces.
- No change to `allowedDirs` or the bubblewrap sandboxing design.
- Not fixing the stale `PI_CODING_AGENT_DIR` at its source (container
  image / launch environment) — same non-goal as the superseded spec.
- Not restructuring `src/activity.js`'s shared cache/callback contract to
  let `--mode activity` carry a live caller's `env` — see §5's carve-out.
- Not scoping `modelsCache` by environment fingerprint — see §8.
