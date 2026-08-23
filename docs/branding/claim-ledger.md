# Taskferry Claim Ledger

This ledger is the evidence layer for the branding package. The README uses
the claims below without publishing source paths in every sentence.

## Maturity

**State: limited.** The repository has a runnable CLI and a passing unit-test
surface, but this branding run does not claim a live provider-backed coding
dispatch or a runtime screenshot. Provider availability and worker output are
external variables. The README therefore describes the core workflow and
states the platform/provider limits instead of claiming a verified demo.

| Surface | Exercise | Result | README effect |
|---|---|---|---|
| CLI identity | `mise exec -- node src/cli.js --version` | Pass: `name: taskferry`, `version: 4.1.0`, `protocolVersion: 1` | Keep setup instructions; do not claim a fresh-host bootstrap was exercised here |
| Core CLI | `mise exec -- node src/cli.js --help` | Pass: 17 commands listed | Include command surface |
| Core worker lifecycle | Real provider-backed dispatch | Not run in this package pass | Describe as implemented; do not include a live-output screenshot |
| Static boundary | `mise exec -- npm test`, `npm run lint`, `npm run typecheck` | Pass: 1323 tests, 0 failures; lint and typecheck pass | Keep source-backed claims; label maturity `limited` |

## Claims

| Claim | Source citation | Confidence | Relation | Maturity effect | Disposition |
|---|---|---|---|---|---|
| Dispatch queues a task and returns a next-step hint | `src/tasks.js:6710-6746` | source-supported | support | core | included |
| The daemon outlives the client call | `src/client.js:592-632`, `src/daemon.js:732-818` | source-supported | support | core | included |
| Linux uses sandbox and copy-on-write mounts by default when enabled | `src/sandbox.js:285-318`, `docs/security.md:275-452` | source-supported | support | core | qualified by platform and host capability |
| Changes are held as a pending changeset | `src/tasks.js:5572-5595` | source-supported | support | core | included |
| `accept` and `reject` decide the pending changeset outcome | `src/tasks.js:6142-6192` | source-supported | support | core | included |
| Project checks gate acceptance | `src/tasks.js:5727-5819`, `src/init.js:35-110` | source-supported | support | core | qualified by overlay/platform conditions |
| Scratch output survives terminal task states | `src/tasks.js:6195-6227`, `src/output-dir.js:417-491` | source-supported | support | demo | included |
| OpenCode gets toasts and prompt context from the native plugin | `src/opencode-plugin.js:245-318` | source-supported | support | demo | included |
| Recursive ferry dispatch is available | `docs/evolution.md:128-141` | contradicted | conflict | core | omitted |
| Automatic model/provider routing is available | `docs/evolution.md:128-141` | contradicted | conflict | core | omitted |
| Existing PNG assets are successful runtime screenshots | asset paths only | unverified | unrelated | demo | omitted |

## Evidence hierarchy

This package treats real execution as stronger than a focused passing test,
which is stronger than a reachable call chain, which is stronger than docs or
comments. An approved positioning chooses which true claims to lead with, but
it cannot make an unexercised provider call or screenshot factual.
