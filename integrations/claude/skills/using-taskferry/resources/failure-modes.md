# Failure modes

Ways a dispatch goes wrong that are not what they look like. Each entry
below is a real incident, not a hypothetical — the symptom is listed first
because that is what you will actually see.

## `no_output_timeout` crashes

**Symptom:** `status: crashed`, `failureReason: no_output_timeout_dead_spawn`
(no parseable log event ever emitted) or `no_output_timeout_stalled` (some
parseable event emitted, then no progress past the post-output budget).

The worker may have been genuinely still working, not actually stuck:
high-reasoning-effort models can go silent for minutes mid-turn (long
internal reasoning, or a slow tool call such as a full test suite), and some
models (e.g. `glm-5.2`) stream long stretches of empty `</think>`
thinking-tail events that don't reset the watchdog. Taskferry's own watchdog
kills the process regardless of whether real work is happening underneath.

Treat every `no_output_timeout_*` crash as a possible false-positive kill,
not proof the task failed:

- Check `taskferry status <id> --full` for `sessionId`. If it is non-null, real
  work happened before the kill — resume that exact session rather than
  re-dispatching fresh and re-paying for research already done:
  `taskferry dispatch --prompt - --model <same model> --directory "<worktree>"
  --session-id <sessionId> <<'PROMPT_EOF'` followed by `Continue exactly where
  you left off and finish the task.` and a `PROMPT_EOF` terminator.
- If `sessionId` is null, nothing was salvageable (the process never got far
  enough to start a session) — dispatching fresh is the only option.
- Check what actually landed before deciding whether to resume or restart. **On
  an ordinary (overlayed) dispatch, `git status` in the worktree is the wrong
  place to look**: the crash killed the worker, but its writes went to the
  overlay, so the real worktree is clean whether the task did everything or
  nothing. Use `taskferry result <id> --diff` (and `--fields diffStat`), which
  reads the overlay, and treat a clean `git status` as no evidence either way.
  Only on a `--no-overlay` dispatch do the worker's writes land in the
  directory itself, and only then does `git status` / `git diff --stat` answer
  the question.
- Two or more consecutive `no_output_timeout_*` crashes on the same
  prompt+model+variant combination, especially with `sessionId: null` every
  time, is a signal to change something rather than retry unchanged: drop to a
  less exhaustive `--variant`, switch model/provider, or shorten the prompt so
  the worker produces its first tool call sooner.

## A worker's tool calls don't honor `--directory`

**Symptom:** the worker reports a commit hash that doesn't exist in the
assigned worktree, and `taskferry status --full` shows `incomplete: true`.

Even with `--directory <worktree>` set correctly on the dispatch, a
worker's individual tool calls can pass their own `workdir` that overrides
it — confirmed once with `opencode/deepseek-v4-flash-free`: it made the
correct code changes but every `bash`/`edit`/`write` tool call explicitly
passed `workdir: <main-checkout-root>` instead of the assigned worktree, so
the commit landed on local `main` in the main checkout, not the worktree
branch. The `incomplete: true` flag was, in hindsight, the earlier warning
sign worth checking alongside the final message text.

**Diagnosing it is the one sanctioned reason to read a raw log directly.**
The `workdir` field on `type=="tool_use"` events is not surfaced by any CLI
command, so `jq 'select(.type=="tool_use")'` over the ndjson log is the only
way to confirm this specific failure. That exception is scoped to this
failure mode — it is not a general license to grep logs whenever a CLI
command feels slower.

**Recovery, once you confirm it happened** (the commit is missing from the
assigned worktree): check other likely locations (the main checkout is the
common one) before assuming the work vanished. If found there, `git
cherry-pick` the commit onto the correct worktree branch, then `git revert`
it in the wrong location to remove it — never a hard reset there, since that
could disturb unrelated pre-existing dirty state in that checkout.

## `/tmp` paths are invisible inside the sandbox by default

**Symptom:** a worker reports reading a `/tmp` file you gave it, but echoes
back content that doesn't match what you saved there — with no error and
`exitCode: 0`.

Every sandboxed dispatch mounts a fresh, empty `--tmpfs /tmp`. If you point a
dispatch at a scratch file you saved under `/tmp` (a diff, a prompt, any
input the worker's supposed to read) without also passing `--rw-bind`
for that path, the file doesn't exist from the worker's point of view —
even though it's right there on the host. Pass the containing directory via
`--rw-bind /tmp/your-scratch-dir` any time a dispatch needs to read
something under `/tmp` that isn't already the dispatch's `--directory`.
(`--allowed-dirs` is the deprecated alias for `--rw-bind`; it still works
but warns.)

This bit once with a batch of code-review dispatches pointed at diff files
saved under `/tmp/pr-reviews/pr-<N>.diff`: none of the finders could read
them, and instead of reporting the read failure, each one silently
reconstructed the diff itself with `git diff main...HEAD` in its own
worktree. For PRs stacked on another open PR's branch, that reconstruction
pulled in the whole underlying stack and produced findings that didn't
belong to the PR under review — with no error, no `incomplete: true`, just
a `done`/`exitCode: 0` task that quietly answered a different question than
the one asked (taskferry#211). If a worker's report describes reading a
specific `/tmp` path you gave it, and the content it echoes back doesn't
match what you saved there, suspect this before suspecting the model.

## A model can't actually hear audio or see images

**Symptom:** a worker "reviews" an audio or image file and describes it
plausibly, having only ever received its path as a string.

OpenCode passes file paths through as text, so a worker never perceives the
bytes. When a model must genuinely perceive them, bypass the worker and POST
directly to the provider's chat-completions endpoint with a real content
part:

```jsonc
{"type": "input_audio", "input_audio": {"data": "<base64>", "format": "mp3"}}
// or {"type": "image_url", "image_url": {"url": "data:image/png;base64,<...>"}}
```

Keep the one-shot script in a temp directory; this is a side channel around
Taskferry, not a Taskferry feature.

## Diagnosing the daemon rather than the task

Before assuming a task-level problem, check whether the daemon itself is
healthy:

- `taskferry doctor --full` — dead socket, stale process, failing health check.
- `taskferry doctor --stats` — aggregate report over task history (status mix,
  per-model crash rates, failure-reason histogram, unknown backlog, crash-rate
  trend), instead of hand-computing it from `taskferry list --all`.
- `taskferry list` / `taskferry context --format toon` — workspace-scoped state.

Use `taskferry cancel <id>` for work that should stop; it sends SIGTERM and
escalates to SIGKILL after a grace period (default 5000ms, override with
`--grace-ms <number>` for a worker that needs longer to unwind, e.g. mid
long-running command).

## What does and doesn't need a daemon restart

**The daemon picks up code changes automatically (deferred-until-idle
restart), and provider credentials no longer require a daemon restart.**
`dispatch`, `advisor`, and `summary` (report mode) forward the calling
shell's own environment to the daemon on every call — so exporting a fresh
API key into your shell immediately takes effect on the next taskferry
command. Daemon-level configuration variables
(`TASKFERRY_MAX_CONCURRENT_TASKS`, `TASKFERRY_ENV_DENYLIST`, and the
`config.json` fields they override) still require a daemon restart because
they are read once at startup.

**`TASKFERRY_ENV_FILE` (or the `envFile` config field) solves a different
problem than caller-env forwarding: a non-interactive caller — cron,
systemd, a scheduled job — that never had the secret in its own environment
to forward in the first place**, because secrets exported in an interactive
shell's rc file (`.bashrc`/`.zshrc`/`config.fish`) are invisible to a
process cron spawns. Point it at a `.env`-style file (`NAME=VALUE` per
line) and the daemon loads it once at startup as the lowest-priority layer
of every spawned child's environment — below its own ambient env, below the
caller's forwarded env, so a live caller's or the daemon's own value still
wins on a shared key. It's read once at daemon startup like the other
daemon-level vars above, not per-dispatch — a daemon restart is required to
pick up a changed file or a newly set/changed `TASKFERRY_ENV_FILE`. See
`docs/security.md#caller-env-forwarding` and `docs/config.md`.
