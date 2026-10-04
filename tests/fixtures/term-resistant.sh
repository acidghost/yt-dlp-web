#!/bin/sh
# A descendant owns an observable writer and ignores TERM. No app re-exec.
trap 'wait; exit' TERM
/bin/sh -c '
  trap "" TERM
  printf ready > "$1"
  while true; do printf x >> "$2"; sleep 0.02; done
' fixture "$1" "$2" &
wait
