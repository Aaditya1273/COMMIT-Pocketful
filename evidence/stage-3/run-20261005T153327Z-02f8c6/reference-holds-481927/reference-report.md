# Reference-model campaign: pocketful-stage-2-holds-reference

| | |
|---|---|
| Result | **AGREE** (0 divergences -- agreement is not proof of correctness) |
| Run | 20261005T153636Z-bee417 (factory 1.0.0-rc.3) |
| Seed | 481927 |
| Campaign module sha256 | `3eb406af53f5f54ae08c271ca6976ebf46e89f78c498bd8d914a9723f522e5c6` |
| Operations executed / requested | 1000 / 1000 |
| Whole-state comparisons | 250 |
| Invariant checks | 3000 |
| Expected outcomes | 409 insufficient_funds: 342, 201: 224, 409 authorization_not_open: 204, 200: 92, 200 replay: 59, 403 forbidden: 31, 409 idempotency_key_reuse: 27, 422 validation_failed: 9, 422 capture_exceeds_authorization: 8, 422 self_payment: 4 |
| Duration | 5.3 s |

Reproduce: `node commit/campaign.ts --module verification/stage-3/reference-holds.mjs --base-url <url> --seed 481927 --operations 1000`

The full operation sequence is in `reference-report.json`.
