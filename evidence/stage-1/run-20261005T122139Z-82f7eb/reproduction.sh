#!/bin/sh
# Re-run this verification (run 20261005T122139Z-82f7eb) against the same revision.
set -eu
git checkout 29baf0520a2f1b51ebdfc04c006ff473cec73fb0
node commit/verify.ts --plan 'verification/stage-1/plan.json' --out "${1:-evidence/rerun-$(date -u +%Y%m%dT%H%M%SZ)}"
