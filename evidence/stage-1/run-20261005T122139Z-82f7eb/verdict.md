```text
ACCEPT

Run:
    20261005T122139Z-82f7eb (factory 1.0.0-rc.3)
Revision:
    29baf0520a2f1b51ebdfc04c006ff473cec73fb0 on HEAD
    candidate digest b517e87477236bde24ffbc7f2dba59c0fdb9834642400634c867dd1037fc4731

Why:
    every blocking step ran and passed

Checks independently executed:
    clean-build: PASSED
    container: PASSED
    official-isolated: PASSED
    shipped-host: PASSED
    contract: PASSED
    contract-fuzz-seed2: PASSED
    extra: PASSED
    import-semantic: PASSED
    survivor-checks: PASSED
    reference-481927: PASSED
    reference-7: PASSED
    reference-90210: PASSED
    adversarial: PASSED
    mutation: PASSED

Production modification by verifier:
    NONE

Accepted revision is frozen: any change is a new revision and needs a new verification.
```

| Step | Kind | Blocking | Status | Duration | Requirements |
|---|---|---|---|---|---|
| clean-build | build | yes | PASSED | 3.0 s | R-01 |
| container | offline | yes | PASSED | 16.5 s | R-01 R-02 R-03 R-33 |
| official-isolated | supplied-checks | yes | PASSED | 39.7 s | R-01..R-37 |
| shipped-host | supplied-checks | yes | PASSED | 19.4 s | R-01..R-37 |
| contract | contract | yes | PASSED | 7.0 s | R-02..R-37 |
| contract-fuzz-seed2 | contract | yes | PASSED | 6.9 s | R-33 |
| extra | contract | yes | PASSED | 0.3 s | R-13 R-14 R-25 R-34 R-35 R-04 |
| import-semantic | contract | yes | PASSED | 0.3 s | R-33 |
| survivor-checks | contract | yes | PASSED | 3.2 s | R-04 R-07 R-10 R-12 R-19 R-28 R-31 R-33 R-35 |
| reference-481927 | reference | yes | PASSED | 8.3 s | R-12 R-17..R-31 R-35..R-37 |
| reference-7 | reference | yes | PASSED | 8.3 s | R-12 R-17..R-31 R-35..R-37 |
| reference-90210 | reference | yes | PASSED | 8.3 s | R-12 R-17..R-31 R-35..R-37 |
| adversarial | adversarial | yes | PASSED | 9.9 s | R-12 R-20 R-25 R-36 R-13 R-32 R-33 |
| mutation | mutation | yes | PASSED | 1935.2 s | suite strength |

Evidence manifest: `evidence.json`, sha256 `796ef5f041bd373e5cf587dbaa2769742296fa29fb00a429ea6449bed610a85f`
