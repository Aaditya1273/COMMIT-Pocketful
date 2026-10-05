# Reference-model campaign: pocketful-stage-1-reference

| | |
|---|---|
| Result | **AGREE** (0 divergences -- agreement is not proof of correctness) |
| Run | 20261005T122324Z-572fbd (factory 1.0.0-rc.3) |
| Seed | 7 |
| Campaign module sha256 | `82cef72ef02d4719aa57a1826f8bcc0a78c6beee76cd4248b395643e8d98187b` |
| Operations executed / requested | 1000 / 1000 |
| Whole-state comparisons | 250 |
| Invariant checks | 8000 |
| Expected outcomes | 201: 431, 409 request_not_pending: 92, 409 idempotency_key_reuse: 92, 409 insufficient_funds: 91, 200: 88, 200 replay: 65, 422 validation_failed: 47, 403 forbidden: 43, 404 not_found: 34, 422 self_payment: 14, 422 self_request: 3 |
| Duration | 8.2 s |

Reproduce: `node commit/campaign.ts --module verification/stage-1/reference.mjs --base-url <url> --seed 7 --operations 1000`

The full operation sequence is in `reference-report.json`.
