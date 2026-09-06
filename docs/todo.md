# taskferry todo

Prioritized work list. Snapshot of 2026-09-06; the live truth is the issue
tracker (`gh-axi issue list --state open`). Update this file when an entry
closes or the order changes.

## Roadmap (#588, in order)

1. **Fleet commands** — `fleet dispatch/status/wait` on the persist-before-spawn + auto-resume foundation. Specs: #577, #576. Decides #95/#336.
2. **Provider tag support** — model tags + query types configured once in config, dispatch by tag (#499, design #498).
3. **Agent-first onboarding + demo** — agent-run install, `npm install -g taskferry` in the README quickstart, 90-second terminal-loop demo embedded in the README.

## Correctness queue

Settle-time and changeset bugs, newest first:

* #592 — model task state as a sum type so impossible states stop being representable.
* #591 — `--no-diff-gate` to settle without a pending changeset.
* #590 — accepting a non-git changeset silently overwrites edits made after dispatch.
* #589 — dispatch into a git subdirectory can never produce an acceptable changeset.
* #583 — refuse the COW overlay for a non-git dispatch directory, bind instead.
