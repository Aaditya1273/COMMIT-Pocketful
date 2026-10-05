```text
ACCEPT

Run:
    20261005T164036Z-9d2396 (factory 1.0.0-rc.3)
Revision:
    cc1d710726857c36ef4cc0de22bb97a7046f5fe2 on HEAD
    candidate digest 176a2d44c47dc0de34ee50ebb96762ee082ef169f939096ea31f966a63d37694

Why:
    every blocking step ran and passed

Checks independently executed:
    clean-build: PASSED
    container: PASSED
    official-isolated: PASSED
    shipped-stage-1-host: PASSED
    contract: PASSED
    auth-contract: PASSED
    refund-contract: PASSED
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
| clean-build | build | yes | PASSED | 8.6 s | R-01 R2-28 |
| container | offline | yes | PASSED | 57.0 s | R-01 R-02 R-03 R2-03..R2-28 |
| official-isolated | supplied-checks | yes | PASSED | 50.9 s | R-01..R-37 R2-01..R2-28 R3-01..R3-15 R4-01..R4-09 |
| shipped-stage-1-host | supplied-checks | yes | PASSED | 19.5 s | R2-01 |
| contract | contract | yes | PASSED | 7.4 s | R2-01 R-02..R-37 |
| auth-contract | contract | yes | PASSED | 3.9 s | R2-03..R2-16 |
| refund-contract | contract | yes | PASSED | 0.8 s | R4-01..R4-08 |
| ledger-contract | contract | yes | PASSED | 4.9 s | R3-01..R3-15 |
| upgrade | contract | yes | PASSED | 1.3 s | R4-09 R4-08 R3-13 R2-02 |
| extra | contract | yes | PASSED | 0.3 s | R-04 R-13 R-14 R-25 R-34 R-35 |
| survivor-checks | contract | yes | PASSED | 3.2 s | R-04 R-07 R-10 R-12 R-19 R-28 R-31 R-33 R-35 |
| import-semantic | contract | yes | PASSED | 0.3 s | R-33 |
| ui | contract | yes | PASSED | 31.3 s | R2-17..R2-28 |
| reference-ledger-481927 | reference | yes | PASSED | 4.9 s | R3-03 R3-04 R3-06 R3-07 R3-09 |
| reference-ledger-7 | reference | yes | PASSED | 4.8 s | R3-03 R3-04 R3-06 R3-07 R3-09 |
| reference-ledger-90210 | reference | yes | PASSED | 4.8 s | R3-03 R3-04 R3-06 R3-07 R3-09 |
| reference-holds-481927 | reference | yes | PASSED | 5.8 s | R2-04..R2-15 |
| reference-holds-7 | reference | yes | PASSED | 5.9 s | R2-04..R2-15 |
| reference-holds-90210 | reference | yes | PASSED | 5.8 s | R2-04..R2-15 |
| reference-stage1-481927 | reference | yes | PASSED | 8.6 s | R2-01 R-12 R-17..R-31 |
| reference-stage1-7 | reference | yes | PASSED | 8.2 s | R2-01 R-12 R-17..R-31 |
| adversarial-ledger | adversarial | yes | PASSED | 2.3 s | R3-10 R3-11 R3-07 |
| adversarial-holds | adversarial | yes | PASSED | 12.8 s | R2-04 R2-08 R2-10 R2-14 R2-15 |
| adversarial | adversarial | yes | PASSED | 9.5 s | R2-01 R-12 R-20 R-25 R-36 |
| mutation-sample | mutation | yes | PASSED | 1287.4 s | suite strength (100-mutant seeded sample, --max 100 --seed 1, per the owner's time constraint) |

Evidence manifest: `evidence.json`, sha256 `bec2f362a7569a72c622f51213d3017f769735a9f907ee66bfcec448999204f7`
