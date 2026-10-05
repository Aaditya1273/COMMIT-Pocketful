#!/usr/bin/env bash
# R3-13 gate step: start the accepted stage-1 and stage-2 services from this revision's
# frozen folders, then export from each and import into the stage-3 candidate at $1.
set -u
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(cd "$here/../.." && pwd)"
p1=$(( 20000 + RANDOM % 10000 )); p2=$(( 30000 + RANDOM % 10000 ))
( cd "$repo/stage-1" && PORT=$p1 exec node src/server.js ) >/dev/null 2>&1 & a=$!
( cd "$repo/stage-2" && PORT=$p2 exec node src/server.js ) >/dev/null 2>&1 & b=$!
trap 'kill $a $b 2>/dev/null' EXIT
for i in $(seq 1 100); do curl -sf "http://127.0.0.1:$p1/health" >/dev/null && curl -sf "http://127.0.0.1:$p2/health" >/dev/null && break; sleep 0.1; done
p3=$(( 40000 + RANDOM % 10000 ))
( cd "$repo/stage-3" && PORT=$p3 exec node src/server.js ) >/dev/null 2>&1 & c3=$!
trap 'kill $a $b $c3 2>/dev/null' EXIT
for i in $(seq 1 100); do curl -sf "http://127.0.0.1:$p3/health" >/dev/null && break; sleep 0.1; done
node "$here/upgrade3.mjs" "http://127.0.0.1:$p1" "http://127.0.0.1:$p2" "$1" && node "$here/upgrade4.mjs" "http://127.0.0.1:$p3" "$1"
