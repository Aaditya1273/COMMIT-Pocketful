# Reference-model campaign: pocketful-stage-1-reference

| | |
|---|---|
| Result | **AGREE** (0 divergences -- agreement is not proof of correctness) |
| Run | 20261005T164418Z-0293c7 (factory 1.0.0-rc.3) |
| Seed | 481927 |
| Campaign module sha256 | `82cef72ef02d4719aa57a1826f8bcc0a78c6beee76cd4248b395643e8d98187b` |
| Operations executed / requested | 1000 / 1000 |
| Whole-state comparisons | 250 |
| Invariant checks | 8000 |
| Expected outcomes | 201: 477, 409 idempotency_key_reuse: 110, 200: 97, 409 request_not_pending: 80, 409 insufficient_funds: 65, 200 replay: 64, 422 validation_failed: 44, 403 forbidden: 33, 404 not_found: 18, 422 self_payment: 7, 422 self_request: 5 |
| Duration | 8.5 s |

Reproduce: `node commit/campaign.ts --module verification/stage-4/reference.mjs --base-url <url> --seed 481927 --operations 1000`

The full operation sequence is in `reference-report.json`.
