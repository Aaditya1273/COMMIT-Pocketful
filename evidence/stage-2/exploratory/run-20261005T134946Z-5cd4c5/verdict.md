```text
ACCEPT

Run:
    20261005T134946Z-5cd4c5 (factory 1.0.0-rc.3)
Revision:
    ef962af95a5b8507cf97395525468c1510c1b51c on HEAD
    candidate digest 030a6bc1aa805257326cf77f3beddb5a7e9dfb38dc867e8116e645e8ef11490e

Why:
    every blocking step ran and passed

Checks independently executed:
    clean-build: PASSED
    container: PASSED
    official-isolated: PASSED
    shipped-stage-1-host: PASSED
    contract: PASSED
    auth-contract: PASSED
    upgrade: PASSED
    extra: PASSED
    survivor-checks: PASSED
    import-semantic: PASSED
    ui: PASSED
    reference-holds-481927: PASSED
    reference-holds-7: PASSED
    reference-holds-90210: PASSED
    reference-stage1-481927: PASSED
    reference-stage1-7: PASSED
    adversarial-holds: PASSED
    adversarial: PASSED
    mutation-sample: PASSED

Production modification by verifier:
    NONE

Accepted revision is frozen: any change is a new revision and needs a new verification.
```

| Step | Kind | Blocking | Status | Duration | Requirements |
|---|---|---|---|---|---|
| clean-build | build | yes | PASSED | 1.6 s | R-01 R2-28 |
| container | offline | yes | PASSED | 44.9 s | R-01 R-02 R-03 R2-03..R2-28 |
| official-isolated | supplied-checks | yes | PASSED | 42.6 s | R-01..R-37 R2-01..R2-28 |
| shipped-stage-1-host | supplied-checks | yes | PASSED | 18.8 s | R2-01 |
| contract | contract | yes | PASSED | 7.0 s | R2-01 R-02..R-37 |
| auth-contract | contract | yes | PASSED | 3.8 s | R2-03..R2-16 |
| upgrade | contract | yes | PASSED | 0.3 s | R2-02 |
| extra | contract | yes | PASSED | 0.3 s | R-04 R-13 R-14 R-25 R-34 R-35 |
| survivor-checks | contract | yes | PASSED | 3.1 s | R-04 R-07 R-10 R-12 R-19 R-28 R-31 R-33 R-35 |
| import-semantic | contract | yes | PASSED | 0.3 s | R-33 |
| ui | contract | yes | PASSED | 24.7 s | R2-17..R2-28 |
| reference-holds-481927 | reference | yes | PASSED | 5.4 s | R2-04..R2-15 |
| reference-holds-7 | reference | yes | PASSED | 5.4 s | R2-04..R2-15 |
| reference-holds-90210 | reference | yes | PASSED | 5.5 s | R2-04..R2-15 |
| reference-stage1-481927 | reference | yes | PASSED | 7.8 s | R2-01 R-12 R-17..R-31 |
| reference-stage1-7 | reference | yes | PASSED | 7.3 s | R2-01 R-12 R-17..R-31 |
| adversarial-holds | adversarial | yes | PASSED | 12.6 s | R2-04 R2-08 R2-10 R2-14 R2-15 |
| adversarial | adversarial | yes | PASSED | 8.9 s | R2-01 R-12 R-20 R-25 R-36 |
| mutation-sample | mutation | yes | PASSED | 1226.7 s | suite strength (100-mutant seeded sample, --max 100 --seed 1, per the owner's time constraint) |

Evidence manifest: `evidence.json`, sha256 `bc7fc3854d0244ea147a0cb8fc7181eb0eed844a3ef857392e427ca7f8fd8bf3`
