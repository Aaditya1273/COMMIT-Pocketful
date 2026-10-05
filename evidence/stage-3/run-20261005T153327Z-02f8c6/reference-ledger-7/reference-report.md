# Reference-model campaign: pocketful-stage-3-ledger-reference

| | |
|---|---|
| Result | **AGREE** (0 divergences -- agreement is not proof of correctness) |
| Run | 20261005T153627Z-5a1075 (factory 1.0.0-rc.3) |
| Seed | 7 |
| Campaign module sha256 | `8c79e80e80de540d612be1a37e599ac22d7cbf9efc4c896683eb6b80d3d932c3` |
| Operations executed / requested | 1000 / 1000 |
| Whole-state comparisons | 200 |
| Invariant checks | 1200 |
| Expected outcomes | 201: 350, 200: 197, 409 historical_overdraft: 167, 409 insufficient_funds: 130, 200 replay: 66, 404 not_found: 38, 403 forbidden: 25, 409 idempotency_key_reuse: 18, 409 stale_revision: 9 |
| Duration | 4.3 s |

Reproduce: `node commit/campaign.ts --module verification/stage-3/reference-ledger.mjs --base-url <url> --seed 7 --operations 1000`

The full operation sequence is in `reference-report.json`.
