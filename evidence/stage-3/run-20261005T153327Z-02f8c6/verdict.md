```text
ACCEPT

Run:
    20261005T153327Z-02f8c6 (factory 1.0.0-rc.3)
Revision:
    39de1bf419a1deeb826cb3f2c38519301e006896 on HEAD
    candidate digest a3d9a95790d885a144ed118706af71f67a9170cd63fd46cb2abd612c8ae38241

Why:
    every blocking step ran and passed

Checks independently executed:
    clean-build: PASSED
    container: PASSED
    official-isolated: PASSED
    shipped-stage-1-host: PASSED
    contract: PASSED
    auth-contract: PASSED
    ledger-contract: PASSED
    upgrade: PASSED
    extra: PASSED
    survivor-checks: PASSED
    import-semantic: PASSED
    ui: PASSED
    reference-ledger-481927: PASSED
    reference-ledger-7: PASSED
    reference-ledger-90210: PASSED
    reference-holds-481927: PASSED
    reference-holds-7: PASSED
    reference-holds-90210: PASSED
    reference-stage1-481927: PASSED
    reference-stage1-7: PASSED
    adversarial-ledger: PASSED
    adversarial-holds: PASSED
    adversarial: PASSED
    mutation-sample: PASSED

Production modification by verifier:
    NONE

Accepted revision is frozen: any change is a new revision and needs a new verification.
```

| Step | Kind | Blocking | Status | Duration | Requirements |
|---|---|---|---|---|---|
| clean-build | build | yes | PASSED | 4.7 s | R-01 R2-28 |
| container | offline | yes | PASSED | 56.2 s | R-01 R-02 R-03 R2-03..R2-28 |
| official-isolated | supplied-checks | yes | PASSED | 45.7 s | R-01..R-37 R2-01..R2-28 R3-01..R3-15 |
| shipped-stage-1-host | supplied-checks | yes | PASSED | 19.0 s | R2-01 |
| contract | contract | yes | PASSED | 7.0 s | R2-01 R-02..R-37 |
| auth-contract | contract | yes | PASSED | 3.8 s | R2-03..R2-16 |
| ledger-contract | contract | yes | PASSED | 4.8 s | R3-01..R3-15 |
| upgrade | contract | yes | PASSED | 0.5 s | R3-13 R2-02 |
| extra | contract | yes | PASSED | 0.3 s | R-04 R-13 R-14 R-25 R-34 R-35 |
| survivor-checks | contract | yes | PASSED | 3.2 s | R-04 R-07 R-10 R-12 R-19 R-28 R-31 R-33 R-35 |
| import-semantic | contract | yes | PASSED | 0.3 s | R-33 |
| ui | contract | yes | PASSED | 30.7 s | R2-17..R2-28 |
| reference-ledger-481927 | reference | yes | PASSED | 4.4 s | R3-03 R3-04 R3-06 R3-07 R3-09 |
| reference-ledger-7 | reference | yes | PASSED | 4.4 s | R3-03 R3-04 R3-06 R3-07 R3-09 |
| reference-ledger-90210 | reference | yes | PASSED | 4.4 s | R3-03 R3-04 R3-06 R3-07 R3-09 |
| reference-holds-481927 | reference | yes | PASSED | 5.4 s | R2-04..R2-15 |
| reference-holds-7 | reference | yes | PASSED | 5.4 s | R2-04..R2-15 |
| reference-holds-90210 | reference | yes | PASSED | 5.4 s | R2-04..R2-15 |
| reference-stage1-481927 | reference | yes | PASSED | 7.7 s | R2-01 R-12 R-17..R-31 |
| reference-stage1-7 | reference | yes | PASSED | 7.6 s | R2-01 R-12 R-17..R-31 |
| adversarial-ledger | adversarial | yes | PASSED | 2.2 s | R3-10 R3-11 R3-07 |
| adversarial-holds | adversarial | yes | PASSED | 12.7 s | R2-04 R2-08 R2-10 R2-14 R2-15 |
| adversarial | adversarial | yes | PASSED | 9.0 s | R2-01 R-12 R-20 R-25 R-36 |
| mutation-sample | mutation | yes | PASSED | 1045.7 s | suite strength (100-mutant seeded sample, --max 100 --seed 1, per the owner's time constraint) |

Evidence manifest: `evidence.json`, sha256 `c8f5acf4ade3031972fb7a99fda42c5bb36b03cbb8c4d39d6c1dd94658e0af29`
