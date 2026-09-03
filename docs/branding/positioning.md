# Taskferry Positioning

## Package scope

This package positions taskferry as a local execution boundary for background
agent work. It covers the README, feature packaging, claim ledger, and palette.
It does not define a hosted service, pricing, a website, or a logo system.

## Recommendation

**Taskferry is the change boundary for background agent work.** It lets a
primary coding session dispatch work to a daemon-owned worker, then inspect the
result before the result reaches the target tree.

**Audience:** solo operators and small engineering teams running Claude Code,
OpenCode, Codex, or shell-driven coding agents who want background execution
without giving up review control.

**Package:** a local CLI, a private daemon, worker executors, Linux sandboxing,
copy-on-write overlays, task observation, and explicit changeset acceptance.

**It is not:** an autonomous coding product, a model provider, a hosted agent
fleet, or an MCP-only server.

**Deliberate sacrifice:** taskferry keeps an explicit inspect-and-accept step
instead of collapsing worker execution and repository mutation into one smooth
button. It also keeps the product Unix-shaped rather than promising Windows
support it does not ship.

**Hook:** Background agent work with a changeset at the door.

Evidence: `src/tasks.js:6710-6745`, `src/sandbox.js:285-318`,
`src/tasks.js:5572-5595`, and `src/tasks.js:6142-6157`.

## Candidate framings considered

### The courier

Move worker tasks out of the primary session without losing the handoff. This
fits the existing otter artwork and the daemon's task-ID workflow, but it makes
the queue metaphor more important than the product's strongest distinction:
worker writes do not land automatically.

### The local execution fabric

Operate concurrent agent work from a private daemon across terminals and
frontends. This is accurate for the architecture, but it leads with an
implementation category and fits a generic job queue too easily.

### The change boundary

Dispatch work independently, keep the result inspectable, and choose whether
the changeset lands. This framing owns the relationship between execution and
acceptance, which is the behavior taskferry deliberately protects.

## Brand Core

**Opposed:** terminal-attached agent wrappers and direct, opaque writes from
background workers. **Refusal:** a worker's clean exit is never treated as
permission to land its changes. **Own:** `dispatch`, `daemon`, `changeset`,
`inspect`, `accept`. **Avoid:** `autonomous`, `magic`, `copilot`, `seamless`,
`AI engineer`, and absolute claims of security or correctness. **Tone:**
operator-direct, technical, and candid about platform, provider, and worker
limits.

## Competitive-fit test

The identity does not paste cleanly onto a tmux wrapper because the wrapper
does not own the daemon, task lifecycle, or changeset boundary described here.
It does not paste cleanly onto an MCP-only runner because taskferry's public
interface is a shell CLI and its state outlives a client session. It does not
paste cleanly onto a generic hosted queue because the defining behavior is a
local copy-on-write view plus an explicit decision about landing the diff.

Evidence for the alternatives and exclusions: `README.md:38-72`,
`docs/security.md:275-452`, and `docs/daemon.md:3-6`.

## Copy constraints

- Lead with dispatch, inspection, and acceptance, not model cleverness.
- Say "worker" or "agent work" when the execution is model-backed; do not
  imply that taskferry authored or verified the code.
- State Linux and macOS differences when describing sandboxing.
- Keep `accept` and `reject` visible in the primary workflow.
- Describe the otter as a visual signal for movement and custody, not as a
  claim about autonomy or personality.
