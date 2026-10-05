#!/bin/sh
# Re-run this verification (run 20261005T164036Z-9d2396) against the same revision.
set -eu
git checkout cc1d710726857c36ef4cc0de22bb97a7046f5fe2
node commit/verify.ts --plan 'verification/stage-4/plan.json' --out "${1:-evidence/rerun-$(date -u +%Y%m%dT%H%M%SZ)}"
