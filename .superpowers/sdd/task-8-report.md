# Task 8 implementation report

## Scope

Implemented CLI/RPC plumbing for `--executor <opencode|pi>` on `dispatch` and `advisor` in only:

- `src/args.js`
- `src/commands.js`
- `src/protocol.js`
- `src/daemon.js`
- Direct tests: `src/args.test.js`, `src/commands.test.js`, `src/protocol.test.js`, `src/daemon.test.js`

Preserved all pre-existing concurrent working-tree changes and did not modify `tasks.js`, `executor.js`, `package-lock.json`, reports other than this required report, or unrelated tests.

## RED evidence

Command:

```bash
node --test src/args.test.js src/commands.test.js src/protocol.test.js src/daemon.test.js
```

Result before production changes:

- 103 tests
- 92 passed
- 11 failed
- Failures were the expected missing-feature failures:
  - `--executor` rejected as unknown by dispatch/advisor parsing
  - command payloads omitted `executor`
  - protocol rejected otherwise-valid dispatch/advisor requests containing `executor`
  - daemon requests containing `executor` failed protocol validation before manager forwarding/error propagation

## GREEN evidence

Focused module tests:

```bash
node --test src/args.test.js src/commands.test.js src/protocol.test.js src/daemon.test.js
```

Result: 103 passed, 0 failed.

Syntax checks:

```bash
node --check src/args.js src/args.test.js src/commands.js src/commands.test.js src/daemon.js src/daemon.test.js src/protocol.js src/protocol.test.js
```

Result: PASS, no output.

Lint:

```bash
npm run lint
```

Result: PASS with 0 errors and 35 pre-existing warnings. A clean-tree comparison also produced the same 35-warning baseline.

Typecheck:

```bash
npm run typecheck
```

Result: PASS, no output.

Full unit suite, run once as requested:

```bash
npm test
```

Result: 480 tests; 478 passed, 2 failed. Both failures are in pre-existing/concurrent `src/tasks.test.js` sandbox/auth behavior outside Task 8 scope:

- `ro-binds the real opencode auth.json into the sandboxed XDG_DATA_HOME when it exists...`
- `leaves XDG_DATA_HOME untouched when sandboxing is disabled`

Task 8's focused modules remained green after that run.

## Implemented behavior

- Added documented `--executor <opencode|pi>` options for dispatch and advisor.
- Added `executor: undefined` defaults to both commands.
- Added parsing, per-command allowlisting, and enum validation with the requested usage/help text.
- Forwarded defined executor values from both CLI command handlers into RPC params while preserving omission when undefined.
- Added executor to dispatch/advisor protocol allowlists and restricted values to `opencode` or `pi`.
- Forwarded advisor executor values from daemon RPC handling into `manager.advisor()`.
- Verified dispatch daemon handling already forwards the entire validated params object.
- Added advisor manager-error forwarding coverage through the actual socket/RPC layer.

## Staged hunks

Intended staged files/hunks:

- `src/args.js`: option specs, defaults, value map, validation, command allowlists
- `src/args.test.js`: dispatch/advisor accept/reject parsing tests and updated default shape
- `src/commands.js`: dispatch/advisor executor payload forwarding
- `src/commands.test.js`: dispatch/advisor forwarding tests
- `src/protocol.js`: dispatch/advisor executor allowlists and enum validation
- `src/protocol.test.js`: accepted and invalid executor tests for dispatch/advisor
- `src/daemon.js`: advisor executor forwarding
- `src/daemon.test.js`: dispatch/advisor manager forwarding and advisor error propagation tests

No unrelated working-tree files are intended to be staged.

## Self-review

- Compared the scoped diff against every Task 8 brief step.
- Confirmed undefined executor values are omitted from command and daemon payloads.
- Confirmed validation exists at both CLI and protocol boundaries.
- Confirmed protocol rejects unknown values before manager invocation.
- Confirmed daemon advisor forwarding preserves all existing optional params.
- Confirmed dispatch remains the intended direct `manager.dispatch(params)` pass-through.
- Confirmed scoped diff has no whitespace errors and syntax checks pass.
- Confirmed no hardcoded project-specific absolute paths were added.

## Concerns

The full unit suite is not completely green due to two failures in concurrent/out-of-scope Task 7 sandbox/auth tests. Focused Task 8 tests, syntax checks, lint, and typecheck all pass. No Task 8 correctness concerns remain.
