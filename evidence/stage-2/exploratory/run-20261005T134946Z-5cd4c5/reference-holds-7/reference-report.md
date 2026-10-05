# Reference-model campaign: pocketful-stage-2-holds-reference

| | |
|---|---|
| Result | **AGREE** (0 divergences -- agreement is not proof of correctness) |
| Run | 20261005T135219Z-d84074 (factory 1.0.0-rc.3) |
| Seed | 7 |
| Campaign module sha256 | `3eb406af53f5f54ae08c271ca6976ebf46e89f78c498bd8d914a9723f522e5c6` |
| Operations executed / requested | 1000 / 1000 |
| Whole-state comparisons | 250 |
| Invariant checks | 3000 |
| Expected outcomes | 409 insufficient_funds: 314, 409 authorization_not_open: 237, 201: 228, 200: 82, 200 replay: 55, 403 forbidden: 35, 409 idempotency_key_reuse: 26, 422 validation_failed: 10, 422 self_payment: 7, 422 capture_exceeds_authorization: 6 |
| Duration | 5.3 s |

Reproduce: `node commit/campaign.ts --module verification/stage-2/reference-holds.mjs --base-url <url> --seed 7 --operations 1000`

The full operation sequence is in `reference-report.json`.
