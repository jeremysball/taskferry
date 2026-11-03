#!/usr/bin/env bash
# Rotate the TaskFerry daemon's stdout/stderr log with bounded retention.
#
# The unit opens the log with O_APPEND (`StandardOutput=append:`), so rotation
# is copy-truncate: the old contents are copied aside and the live file is
# truncated in place. Renaming the live file instead would leave the daemon
# writing to the renamed inode and the new file empty forever.
#
# Usage:
#   scripts/rotate-daemon-logs.sh [--log-dir DIR] [--max-bytes N] [--keep N]
#
# Environment (flags win):
#   TASKFERRY_LOG_DIR        default: $XDG_STATE_HOME/taskferry/logs
#   TASKFERRY_LOG_NAME       default: daemon.log
#   TASKFERRY_LOG_MAX_BYTES  default: 10485760 (10 MiB)
#   TASKFERRY_LOG_KEEP       default: 5
set -euo pipefail

log_dir="${TASKFERRY_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/taskferry/logs}"
log_name="${TASKFERRY_LOG_NAME:-daemon.log}"
max_bytes="${TASKFERRY_LOG_MAX_BYTES:-10485760}"
keep="${TASKFERRY_LOG_KEEP:-5}"

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --log-dir) log_dir="${2:?--log-dir needs a value}"; shift 2 ;;
    --max-bytes) max_bytes="${2:?--max-bytes needs a value}"; shift 2 ;;
    --keep) keep="${2:?--keep needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$log_name" in
  */*|"") echo "error: TASKFERRY_LOG_NAME must be a bare file name" >&2; exit 2 ;;
esac
case "$max_bytes" in
  ''|*[!0-9]*) echo "error: --max-bytes must be a positive integer" >&2; exit 2 ;;
esac
case "$keep" in
  ''|*[!0-9]*) echo "error: --keep must be a positive integer" >&2; exit 2 ;;
esac
[ "$max_bytes" -gt 0 ] || { echo "error: --max-bytes must be greater than 0" >&2; exit 2; }
[ "$keep" -gt 0 ] || { echo "error: --keep must be greater than 0" >&2; exit 2; }

log_file="$log_dir/$log_name"
[ -f "$log_file" ] || exit 0

size="$(wc -c < "$log_file" | tr -d '[:space:]')"
[ "$size" -ge "$max_bytes" ] || exit 0

rm -f -- "$log_file.$keep"

index="$keep"
while [ "$index" -gt 1 ]; do
  previous=$((index - 1))
  if [ -f "$log_file.$previous" ]; then
    mv -f -- "$log_file.$previous" "$log_file.$index"
  fi
  index="$previous"
done

cp -- "$log_file" "$log_file.1"
: > "$log_file"
echo "rotated $log_file ($size bytes -> $log_file.1, keeping $keep)"
