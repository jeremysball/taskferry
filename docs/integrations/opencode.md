# OpenCode worker backend

Taskferry's native OpenCode presentation plugin is deprecated and removed.
`taskferry setup` no longer installs it and removes the old plugin symlink
when it points to this checkout. Unrelated files and links are left alone.

OpenCode remains supported as a worker executor:

```bash
taskferry dispatch --executor opencode --model provider/model --prompt "Your task"
```

Taskferry detects the installed CLI major version. OpenCode 2 workers use
`run --standalone --auto --format json`, preserving sandbox isolation rather
than connecting to the shared OpenCode background service. Model variants
use `provider/model#variant`; resumed sessions use `--session`.

Use `taskferry list`, `taskferry watch`, and `taskferry result` to monitor work.
The removed plugin's toasts and automatic model-context injection are no
longer provided. Kilo, Claude Code, and Codex integrations are unchanged.
