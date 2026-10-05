#!/usr/bin/env bash
# R2-02 gate step: start the accepted stage-1 service from this revision's stage-1/ folder
# and the stage-2 candidate at $1, then export from stage 1 and import into stage 2.
set -u
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(cd "$here/../.." && pwd)"
port=$(( 20000 + RANDOM % 20000 ))
( cd "$repo/stage-1" && PORT=$port exec node src/server.js ) > /dev/null 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null' EXIT
for i in $(seq 1 100); do curl -sf "http://127.0.0.1:$port/health" >/dev/null && break; sleep 0.1; done
node "$here/upgrade.mjs" "http://127.0.0.1:$port" "$1"
