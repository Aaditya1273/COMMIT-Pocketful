#!/usr/bin/env bash
# Official isolated-mode harness (internal network, no outbound access, 2 vCPU, 2 GiB),
# judged from report.json per suite -- never from the harness exit code.
# usage: official.sh <out-dir> [repo]
set -u
out="$(mkdir -p "$1" && cd "$1" && pwd)"
repo="$(cd "${2:-.}" && pwd)"
kickoff="${COMMIT_KICKOFF:-/home/bajrangi/Wins/dark-factory-wearedevs}"
here="$(cd "$(dirname "$0")" && pwd)"
rmdir "$out" 2>/dev/null
( cd "$kickoff" && env -u PYTHONHOME -u PYTHONPATH .venv/bin/python -m harness run --track pocketful --repo "$repo" --stage 1 --mode isolated --out "$out" )
echo "harness exit code: $? (not used for the judgement)"
node "$here/judge-official.mjs" "$out"
