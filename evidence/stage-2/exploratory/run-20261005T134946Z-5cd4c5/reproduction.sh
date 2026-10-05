#!/bin/sh
# Re-run this verification (run 20261005T134946Z-5cd4c5) against the same revision.
set -eu
git checkout ef962af95a5b8507cf97395525468c1510c1b51c
node commit/verify.ts --plan 'verification/stage-2/plan.json' --out "${1:-evidence/rerun-$(date -u +%Y%m%dT%H%M%SZ)}"
