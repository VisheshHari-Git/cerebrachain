#!/usr/bin/env bash
# Stop anything left over from a demo that was not shut down cleanly.
PORTS="8787 8545 8000 9091 9092 9093 $(seq -s ' ' 9110 9125)"
for port in $PORTS; do
  if command -v lsof >/dev/null; then
    pids=$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  else
    pids=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
  fi
  [ -n "$pids" ] && kill $pids 2>/dev/null && echo "stopped listener on port $port"
done
true
