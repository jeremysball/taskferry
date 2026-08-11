#!/usr/bin/env bash
# taskferry data source for the Claude Code statusline.
#
# Reads the same JSON Claude Code feeds a statusline command (via stdin) and
# emits raw, uncolored task data on stdout, or nothing if no taskferry task
# is running / taskferry isn't installed. Callers pipe their statusline
# input straight through: `printf '%s' "$input" | tf-sl`.
#
# tf-sl does no width/mode rendering of its own -- that decision belongs to
# the caller, which already computes its own width tier for its other
# segments and is in the best position to keep this one consistent with
# them. Output, when a task is active, is exactly three lines:
#   1. id|status|running|queued
#   2. summarizedActivity text (may be blank)
#   3. "1" if that summary text is still within its 60s freshness window
#      (first-seen per task id + summary hash), else "0"
# The freshness window is tracked here, not by the caller, because it is a
# property of the underlying data's staleness (how long has this exact
# summary been true), not of terminal width.
cleanup_refresh() {
  rm -f "$refresh_tmp" "$refresh_lock_pid" 2>/dev/null
  rmdir "$refresh_lock_dir" 2>/dev/null || true
}

refresh_snapshot() {
  refresh_cwd=$1
  refresh_snapshot_dir=$2
  refresh_snapshot_file=$3
  refresh_lock_dir="${refresh_snapshot_file}.lock"
  refresh_lock_pid="$refresh_lock_dir/pid"
  refresh_tmp="${refresh_snapshot_file}.$$"

  umask 077
  mkdir -p "$refresh_snapshot_dir" 2>/dev/null || return
  if ! mkdir "$refresh_lock_dir" 2>/dev/null; then
    refresh_owner=""
    [ -r "$refresh_lock_pid" ] && refresh_owner=$(cat "$refresh_lock_pid")
    case "$refresh_owner" in
      ''|*[!0-9]*) return ;;
    esac
    if kill -0 "$refresh_owner" 2>/dev/null; then
      return
    fi
    rm -f "$refresh_lock_pid" 2>/dev/null
    rmdir "$refresh_lock_dir" 2>/dev/null || return
    mkdir "$refresh_lock_dir" 2>/dev/null || return
  fi
  trap cleanup_refresh EXIT
  trap 'cleanup_refresh; exit 1' INT TERM
  printf '%s\n' "$$" > "$refresh_lock_pid" || return

  # A second foreground poll can decide a refresh is due before the first
  # helper publishes, then reach this lock only after that helper is done.
  # Recheck under the lock so delayed contenders do not immediately repeat
  # the same list/status pair.
  refresh_existing_epoch=""
  [ -r "$refresh_snapshot_file" ] && refresh_existing_epoch=$(sed -n '1p' "$refresh_snapshot_file")
  case "$refresh_existing_epoch" in
    ''|*[!0-9]*) ;;
    *)
      refresh_existing_age=$(($(date +%s) - refresh_existing_epoch))
      [ "$refresh_existing_age" -ge 0 ] && [ "$refresh_existing_age" -lt 2 ] && return
      ;;
  esac

  # Preserve the existing hard cap around CLI requests. This helper is also
  # detached from the statusline's file descriptors, so even a slow request
  # can never hold up Claude's foreground render.
  if ! refresh_out=$(TASKFERRY_AUTO_START=0 timeout 1 taskferry list --directory "$refresh_cwd" --limit 5 2>/dev/null); then
    return
  fi

  refresh_running=$(printf '%s\n' "$refresh_out" | awk -F': ' '/^  running:/{print $2; exit}')
  refresh_queued=$(printf '%s\n' "$refresh_out" | awk -F': ' '/^  queued:/{print $2; exit}')
  refresh_row=$(printf '%s\n' "$refresh_out" | awk -F, '$1 ~ /^  oc_/ && $2=="running"{print;exit}')
  refresh_id=$(printf '%s\n' "$refresh_row" | cut -d, -f1 | sed 's/^  //')
  refresh_status=$(printf '%s\n' "$refresh_row" | cut -d, -f2)
  refresh_segment=""
  refresh_summary=""
  if [ -n "$refresh_id" ]; then
    refresh_segment="$refresh_id|$refresh_status|${refresh_running:-0}|${refresh_queued:-0}"
    if refresh_status_out=$(TASKFERRY_AUTO_START=0 timeout 1 taskferry status "$refresh_id" 2>/dev/null); then
      refresh_summary_raw=$(printf '%s\n' "$refresh_status_out" | sed -n 's/^summarizedActivity: "\(.*\)"$/\1/p')
      [ -n "$refresh_summary_raw" ] && refresh_summary=$(printf '%s' "$refresh_summary_raw" | sed 's/\\"/"/g')
    fi
  fi

  printf '%s\n%s\n%s\n' "$(date +%s)" "$refresh_segment" "$refresh_summary" > "$refresh_tmp" || return
  mv "$refresh_tmp" "$refresh_snapshot_file"
}

if [ "${1:-}" = "--refresh-statusline-snapshot" ]; then
  refresh_snapshot "$2" "$3" "$4"
  exit
fi

input=$(cat)
cwd=$(echo "$input" | jq -r '.cwd // empty')

tf_seg=""
if command -v taskferry >/dev/null 2>&1 && [ -n "$cwd" ]; then
  # A statusline snapshot is a few bytes, rewritten every couple of seconds,
  # and has no reason to survive a reboot -- that's the runtime dir's job
  # (transient sockets/locks, see resolveRuntimeDir() in src/paths.js), not
  # the cache dir's (larger regenerable data, see resolveCacheDir() there --
  # that one exists because worker caches filled the small runtime tmpfs).
  # Mirror resolveRuntimeDir()'s own fallback chain rather than inventing a
  # separate one here.
  runtime_root="$TASKFERRY_RUNTIME_DIR"
  if [ -z "$runtime_root" ] && [ -n "$XDG_RUNTIME_DIR" ]; then
    runtime_root="$XDG_RUNTIME_DIR/taskferry"
  fi
  if [ -z "$runtime_root" ]; then
    run_candidate="/run/user/$(id -u 2>/dev/null)"
    if [ -d "$run_candidate" ]; then
      runtime_root="$run_candidate/taskferry"
    else
      runtime_root="${XDG_STATE_HOME:-$HOME/.local/state}/taskferry/run"
    fi
  fi
  snapshot_dir="$runtime_root/statusline"
  workspace_key=$(printf '%s' "$cwd" | cksum | awk '{print $1 "-" $2}')
  snapshot_file="$snapshot_dir/${workspace_key}.snapshot"
  snapshot_epoch=""
  snapshot_segment=""
  snapshot_summary=""
  if [ -r "$snapshot_file" ]; then
    {
      IFS= read -r snapshot_epoch || snapshot_epoch=""
      IFS= read -r snapshot_segment || snapshot_segment=""
      IFS= read -r snapshot_summary || snapshot_summary=""
    } < "$snapshot_file"
  fi

  now_epoch=$(date +%s)
  refresh_due=1
  case "$snapshot_epoch" in
    ''|*[!0-9]*) snapshot_age=-1 ;;
    *) snapshot_age=$((now_epoch - snapshot_epoch)) ;;
  esac
  if [ "$snapshot_age" -ge 0 ]; then
    # A two-second refresh window collapses normal one-second Claude polls;
    # ten seconds is the fail-closed display limit if refreshes stop working.
    [ "$snapshot_age" -lt 2 ] && refresh_due=0
    if [ "$snapshot_age" -le 10 ]; then
      tf_seg="$snapshot_segment"
      tf_summary="$snapshot_summary"
    fi
  fi
  if [ "$refresh_due" = 1 ]; then
    /bin/bash "$0" --refresh-statusline-snapshot "$cwd" "$snapshot_dir" "$snapshot_file" </dev/null >/dev/null 2>&1 &
  fi
fi

[ -z "$tf_seg" ] && exit 0

tf_id="${tf_seg%%|*}"

# The 60s freshness window on the summary text is tracked per (task id,
# summary text) first-seen state, since the normalized snapshot carries no
# timestamp of its own for when the summary was captured.
fresh=0
if [ -n "$tf_summary" ]; then
  state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/claude-statusline"
  state_file="$state_dir/tf-summary-seen"
  mkdir -p "$state_dir" 2>/dev/null
  summary_hash=$(printf '%s' "$tf_summary" | cksum | awk '{print $1}')
  now_epoch=$(date +%s)
  prev_line=""
  [ -f "$state_file" ] && prev_line=$(cat "$state_file")
  prev_id="${prev_line%%	*}"
  rest="${prev_line#*	}"
  prev_hash="${rest%%	*}"
  prev_seen="${rest#*	}"
  if [ "$prev_id" = "$tf_id" ] && [ "$prev_hash" = "$summary_hash" ] && [ -n "$prev_seen" ]; then
    first_seen="$prev_seen"
  else
    first_seen="$now_epoch"
    printf '%s\t%s\t%s\n' "$tf_id" "$summary_hash" "$first_seen" > "$state_file"
  fi
  age=$((now_epoch - first_seen))
  [ "$age" -lt 60 ] && fresh=1
fi

printf '%s\n%s\n%s\n' "$tf_seg" "$tf_summary" "$fresh"
