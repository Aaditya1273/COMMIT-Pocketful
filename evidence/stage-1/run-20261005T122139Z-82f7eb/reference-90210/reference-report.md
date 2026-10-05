# Reference-model campaign: pocketful-stage-1-reference

| | |
|---|---|
| Result | **AGREE** (0 divergences -- agreement is not proof of correctness) |
| Run | 20261005T122332Z-8d5d28 (factory 1.0.0-rc.3) |
| Seed | 90210 |
| Campaign module sha256 | `82cef72ef02d4719aa57a1826f8bcc0a78c6beee76cd4248b395643e8d98187b` |
| Operations executed / requested | 1000 / 1000 |
| Whole-state comparisons | 250 |
| Invariant checks | 8000 |
| Expected outcomes | 201: 464, 409 idempotency_key_reuse: 91, 409 insufficient_funds: 83, 200 replay: 81, 200: 80, 409 request_not_pending: 71, 403 forbidden: 40, 422 validation_failed: 34, 404 not_found: 34, 422 self_payment: 16, 422 self_request: 6 |
| Duration | 8.3 s |

Reproduce: `node commit/campaign.ts --module verification/stage-1/reference.mjs --base-url <url> --seed 90210 --operations 1000`

The full operation sequence is in `reference-report.json`.
