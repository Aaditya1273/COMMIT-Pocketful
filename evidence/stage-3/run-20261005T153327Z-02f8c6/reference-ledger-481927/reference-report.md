# Reference-model campaign: pocketful-stage-3-ledger-reference

| | |
|---|---|
| Result | **AGREE** (0 divergences -- agreement is not proof of correctness) |
| Run | 20261005T153623Z-30f679 (factory 1.0.0-rc.3) |
| Seed | 481927 |
| Campaign module sha256 | `8c79e80e80de540d612be1a37e599ac22d7cbf9efc4c896683eb6b80d3d932c3` |
| Operations executed / requested | 1000 / 1000 |
| Whole-state comparisons | 200 |
| Invariant checks | 1200 |
| Expected outcomes | 201: 394, 200: 195, 409 historical_overdraft: 166, 409 insufficient_funds: 70, 200 replay: 60, 404 not_found: 58, 409 idempotency_key_reuse: 25, 403 forbidden: 19, 409 stale_revision: 13 |
| Duration | 4.3 s |

Reproduce: `node commit/campaign.ts --module verification/stage-3/reference-ledger.mjs --base-url <url> --seed 481927 --operations 1000`

The full operation sequence is in `reference-report.json`.
