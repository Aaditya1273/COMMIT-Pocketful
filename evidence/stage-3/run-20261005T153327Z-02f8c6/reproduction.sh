#!/bin/sh
# Re-run this verification (run 20261005T153327Z-02f8c6) against the same revision.
set -eu
git checkout 39de1bf419a1deeb826cb3f2c38519301e006896
node commit/verify.ts --plan 'verification/stage-3/plan.json' --out "${1:-evidence/rerun-$(date -u +%Y%m%dT%H%M%SZ)}"
