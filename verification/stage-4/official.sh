#!/usr/bin/env bash
# Official isolated-mode harness for stage N, judged from report.json (never the exit code).
# usage: official.sh <out-dir> <repo> <stage>
set -u
out="$(mkdir -p "$1" && cd "$1" && pwd)"; repo="$(cd "$2" && pwd)"; stage="$3"
kickoff="${COMMIT_KICKOFF:-/home/bajrangi/Wins/dark-factory-wearedevs}"
here="$(cd "$(dirname "$0")" && pwd)"
rmdir "$out" 2>/dev/null
( cd "$kickoff" && env -u PYTHONHOME -u PYTHONPATH .venv/bin/python -m harness run --track pocketful --repo "$repo" --stage "$stage" --mode isolated --out "$out" )
echo "harness exit code: $? (not used for the judgement)"
node "$here/judge-official.mjs" "$out" "$stage"
