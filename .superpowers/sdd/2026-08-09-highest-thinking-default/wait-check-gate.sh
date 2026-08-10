#!/bin/sh
set -e
TASK_ID="$1"
while true; do
  s=$(taskferry status "$TASK_ID" --full 2>&1 | rg 'checkStatus:' | awk '{print $2}')
  if [ "$s" != "running" ]; then
    echo "gate settled: $s"
    taskferry status "$TASK_ID" --full 2>&1 | rg -i "checkstatus|checkexitcode"
    break
  fi
  sleep 5
done
