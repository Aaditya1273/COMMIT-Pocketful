# Reference-model campaign: pocketful-stage-3-ledger-reference

| | |
|---|---|
| Result | **AGREE** (0 divergences -- agreement is not proof of correctness) |
| Run | 20261005T164355Z-f29542 (factory 1.0.0-rc.3) |
| Seed | 90210 |
| Campaign module sha256 | `8c79e80e80de540d612be1a37e599ac22d7cbf9efc4c896683eb6b80d3d932c3` |
| Operations executed / requested | 1000 / 1000 |
| Whole-state comparisons | 200 |
| Invariant checks | 1200 |
| Expected outcomes | 201: 387, 200: 199, 409 historical_overdraft: 138, 409 insufficient_funds: 100, 200 replay: 53, 404 not_found: 50, 409 idempotency_key_reuse: 28, 403 forbidden: 27, 409 stale_revision: 18 |
| Duration | 4.7 s |

Reproduce: `node commit/campaign.ts --module verification/stage-4/reference-ledger.mjs --base-url <url> --seed 90210 --operations 1000`

The full operation sequence is in `reference-report.json`.
