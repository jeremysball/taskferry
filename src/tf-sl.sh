#!/usr/bin/env bash
# taskferry segment for the Claude Code statusline.
#
# Reads the same JSON Claude Code feeds a statusline command (via stdin) and
# emits just the ANSI-colored "tf: ..." segment, or nothing if no taskferry
# task is running / taskferry isn't installed. Callers pipe their statusline
# input straight through: `printf '%s' "$input" | tf-sl`.
input=$(cat)
width=${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}
case "$width" in ''|*[!0-9]*) width=80 ;; esac
if [ "$width" -ge 110 ]; then mode="full"
elif [ "$width" -ge 80 ]; then mode="normal"
elif [ "$width" -ge 55 ]; then mode="compact"
else mode="minimal"
fi

cwd=$(echo "$input" | jq -r '.cwd // empty')

RED='\033[38;5;167m'
YELLOW='\033[38;5;179m'
GREEN='\033[38;5;108m'
GRAY='\033[38;5;59m'
WHITE='\033[38;5;231m'
RESET='\033[0m'

tf_seg=""
tf_summary_fresh=""
if command -v taskferry >/dev/null 2>&1 && [ -n "$cwd" ]; then
  # TASKFERRY_AUTO_START=0 on every call in this script: if a statusline poll
  # were ever the first command to trigger a daemon autostart, the daemon
  # inherits that poll's env for its entire lifetime (see docs/daemon.md) --
  # a statusline segment must never be the thing that boots the daemon.
  # --limit 5, not 1: only a running task should surface, and the newest
  # dispatch (row 1) isn't necessarily the one still running.
  tf_out=$(TASKFERRY_AUTO_START=0 timeout 1 taskferry list --directory "$cwd" --limit 5 2>/dev/null)
  if [ -n "$tf_out" ]; then
    tf_running=$(echo "$tf_out" | awk -F': ' '/^  running:/{print $2; exit}')
    tf_queued=$(echo "$tf_out" | awk -F': ' '/^  queued:/{print $2; exit}')
    tf_row=$(echo "$tf_out" | grep '^  oc_' | awk -F, '$2=="running"{print;exit}')
    tf_id=$(echo "$tf_row" | cut -d, -f1)
    tf_status=$(echo "$tf_row" | cut -d, -f2)
    if [ -n "$tf_id" ]; then
      tf_seg="$tf_id|$tf_status|${tf_running:-0}|${tf_queued:-0}"
    fi
  fi

  # Smallform (minimal mode) swaps the bare status word for the task's
  # summarizedActivity text, but only for 60s after that text first shows up
  # -- past that window (or before a summary exists at all) it falls back to
  # the status word. First-seen time is tracked per (task id, summary text)
  # in a one-line state file since taskferry's status response carries no
  # timestamp of its own for when the summary was captured.
  if [ -n "$tf_id" ]; then
    tf_status_out=$(TASKFERRY_AUTO_START=0 timeout 1 taskferry status "$tf_id" 2>/dev/null)
    tf_summary_raw=$(echo "$tf_status_out" | sed -n 's/^summarizedActivity: "\(.*\)"$/\1/p')
    if [ -n "$tf_summary_raw" ]; then
      tf_summary=$(printf '%s' "$tf_summary_raw" | sed 's/\\"/"/g')
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
      [ "$age" -lt 60 ] && tf_summary_fresh="$tf_summary"
    fi
  fi
fi

[ -z "$tf_seg" ] && exit 0

tf_id="${tf_seg%%|*}"
tf_rest="${tf_seg#*|}"
tf_status="${tf_rest%%|*}"
tf_rest="${tf_rest#*|}"
tf_running="${tf_rest%%|*}"
tf_queued="${tf_rest#*|}"
case "$tf_status" in
  done) tf_status_color="$GREEN" ;;
  crashed|cancelled) tf_status_color="$RED" ;;
  running|queued) tf_status_color="$YELLOW" ;;
  *) tf_status_color="$WHITE" ;;
esac
if [ "$mode" = "minimal" ]; then
  if [ -n "$tf_summary_fresh" ]; then
    trimmed=$(printf '%s' "$tf_summary_fresh" | tr '\n' ' ' | cut -c1-30)
    [ "${#tf_summary_fresh}" -gt 30 ] && trimmed="${trimmed}…"
    seg="$(printf "${GRAY}tf:${RESET}${WHITE}%s${RESET}" "$trimmed")"
  else
    seg="$(printf "${GRAY}tf:${RESET}${tf_status_color}%s${RESET}" "$tf_status")"
  fi
else
  tf_active=""
  if [ "$mode" != "compact" ] && { [ "$tf_running" != "0" ] || [ "$tf_queued" != "0" ]; }; then
    tf_active=$(printf " ${GRAY}(%sr/%sq)${RESET}" "$tf_running" "$tf_queued")
  fi
  tf_id_shown="${tf_id: -8}"
  [ "$mode" = "compact" ] && tf_id_shown="${tf_id: -4}"
  seg="$(printf "${GRAY}tf:${RESET}%s %s" "$tf_id_shown" "$(printf "${tf_status_color}%s${RESET}" "$tf_status")")$tf_active"
fi

printf "%b" "$seg"
