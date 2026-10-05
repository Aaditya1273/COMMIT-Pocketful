# Stage 1 verification evidence (Verifier)

**Verdict: ACCEPT, bound to revision `29baf0520a2f1b51ebdfc04c006ff473cec73fb0`**
(git tree of `stage-1/` `10a55deab7538cbdd0dfb8444565c742309991b0`; candidate content digest
`b517e87477236bde24ffbc7f2dba59c0fdb9834642400634c867dd1037fc4731`, the same before and after the run).
Any later change to `stage-1/` needs a new verdict.

| Path | What it is |
|---|---|
| `run-20261005T122139Z-82f7eb/` | the release-gate run (`commit/verify.ts`, evidence schema v2). Manifest sha256 `796ef5f041bd373e5cf587dbaa2769742296fa29fb00a429ea6449bed610a85f`. `node commit/cli.ts audit` passes on it. |
| `official-harness-s1-verifier-2/` | an extra standalone official isolated-mode run on a clean clone at 29baf05 (`report.json`: revision 29baf05, suite 1 147/147, suite 2 0/35 with 1 failed). |
| `exploratory/mutation-campaign-1/` | the first mutation campaign, run with the suite **before** it was strengthened: 530 killed / 769 valid = **68.9%**. |
| `exploratory/survivor-replay-1/`, `survivor-replay-2/` | the campaign-1 survivors replayed after new checks: 91/239 killed, then 26/148 killed. |
| `../../verification/stage-1/` | all verification code: the plan, contract checks, reference model, adversarial campaigns, survivor checks, the kill check and the equivalent-mutant register |

## How the run was made

The run used a clean clone at 29baf05 with `verification/` copied in untracked. `stage-1/` was
clean throughout.

```sh
git clone /home/bajrangi/Wins/band-work/result /tmp/vf-s1 && cd /tmp/vf-s1 && git checkout 29baf0520a2f1b51ebdfc04c006ff473cec73fb0
cp -r <result>/verification ./verification
node commit/cli.ts verify --plan verification/stage-1/plan.json --out <new dir> --revision 29baf0520a2f1b51ebdfc04c006ff473cec73fb0
```

Wall time: 2067 s on the 12-core host. The mutation step took 1935 s of that.

## Results (each step is in `run-…/logs/<step>.log`)

| Step | Result |
|---|---|
| clean-build | `docker build --no-cache` of `stage-1/` alone: PASSED |
| container | `--network none --cpus 2 --memory 2g`: healthy after 194 ms. Outbound request from inside fails. `PORT` empty → serves 8080. Contract 49/49 against capped containers, including import into a **second container process**. §2 limits: reset of 200 users with **distinct** passwords + 500 payments + 300 requests in 4.1 s; 50 concurrent logins, slowest 1.1 s; 50 concurrent mixed requests, slowest 0.2 s; 5 MiB body handled (201). |
| official-isolated | official harness, isolated mode, judged from `report.json`: suite 1 **147/147** (0 failed, 0 errors). Overshoot suite 2: 35 collected, 0 passed, 1 failed, as required. |
| shipped-host | shipped stage-1 tests against the host instance: 147 passed |
| contract (2 fuzz seeds) | 49/49 checks each (1,928 and 1,940 requests). Covers every §-rule plus the plan's ambiguity decisions. Includes a 120-mutation import-corruption fuzz per seed. |
| extra | 36/36 spot probes |
| import-semantic | 28 targeted invalid-state imports, 0 blocking failures (see *Observations*) |
| survivor-checks | 186/186 checks written for observable survivors of campaign 1 |
| reference ×3 | seeds 481927 · 7 · 90210: **agree**, 3 × 1,000 operations, 750 whole-state comparisons, 24,000 invariant checks |
| adversarial | **50/50** rounds (10 campaigns × 5 seeds), bursts of 50 in flight, 380 state checks, 5,740 requests. Covers: same-key bursts on all 5 write paths, overdraw with concurrent `/me` watchers (no transient negative balance), pay/decline/cancel races, competing settlements, ring chaos, lost-response retries, same-key conflicting bodies, signup races, export under load, splits paid in full. |
| mutation | 782 mutants discovered and executed. 63 equivalent (register below), 13 invalid. **653 killed / 706 valid = 92.5%**, 0 timeouts, 53 survivors. |

## Mutation survivors (53): disposition

Every survivor here was looked at. None hides a requirement the specification states.

| Lines | # | Disposition |
|---|---|---|
| 22, 1026–1037 | 15 | Request-body size cap (64 MiB). The specification sets no size limit, so the cap's value and existence are unspecified. A 5 MiB body is verified to be handled. |
| 90, 95, 102 | 14 | Bounds on scrypt parameters inside an **imported, hand-crafted** password hash (N=2, N=2²⁰, r=1/32, p=16, maxmem). The service's own exports always use N=16384, r=8, p=1. A wrong password against an extreme-cost hash and against an empty derived key **is** checked (401). |
| 883, 898, 907, 911, 912, 921–923, 934, 936, 942, 943 | 22 | Type/shape validation of sub-records of a **hand-crafted** import state (split, settlement and idempotency records; request/payment link and time fields). The state format is implementation-defined (§10). A consequence fuzz checks that every accepted wrong-typed field still leaves a conserving, well-formed service. |
| 1062 | 2 | Default port 8080 when `PORT` is unset. The per-mutant harness always sets `PORT`, so the kill check cannot see this. The `container` step verifies 8080 on the real image. |

The 63 registered equivalents and their reasons are in `verification/stage-1/equivalents.json`.
They are error-message wording, scrypt cost/salt of new hashes, initial pre-reset values,
millisecond shifts of seeded timestamps, tie-breaks between identical timestamps (§8 leaves these
unordered), server timeouts, logging and signal handling, and an unread split map.

Kill attribution is fail-fast: layers run cheapest first, so a kill is credited to the first layer
that caught it. Contract 495, survivors 115, semantic-import 25, extra 16, adversarial 2. The
reference model and shipped tests ran on every survivor and caught none of them.

## Verification failures (my own checks were wrong; fixed, re-run, candidate untouched)

1. Wrong expected arithmetic in a contract check: 2500 + 2·10⁹ + 1 was written as 2,002,500,001.
2. Wrong expected feed count: ada cannot see the private p_2 (bob→dan).
3. The response scanner checked timestamps inside the opaque export `state`. Now only the envelope is scanned.
4. The reference module reported invariants without the `VIOLATED` prefix that `commit/campaign.ts` keys on. Broken invariants would have been counted but never flagged. Found before any reported run.
5. Integer scan used `Number.isSafeInteger`, which rejects 2⁵³ itself, although §4 allows ±2⁵³.
6. A comparison of balance objects depended on key order.
7. Fixture-id checks mutated a user that other records reference, so the reset was rejected for the wrong reason. Moved to an unreferenced user (found by surviving mutants).

## Observations, not defects (no requirement violated)

- Seeded users with the **same** password share one salted scrypt hash, so large resets fit the 10 s budget. Every signup gets its own salt. §6 requires a password-hashing function and forbids plaintext; both hold. No plaintext password appears in any export (checked). The cost is that equal seeded passwords are recognisable in an export, which §10 already treats as a private test artifact.
- Import validates users, balances, duplicates, user references, tokens, operators, hash format and all field types. It accepts some cross-record inconsistencies that only a hand-edited state can contain: a payment pointing at a non-existent request or settlement, a paid request with a null `payment_id`, a request whose requester is also its payer, a self-payment. §1 invariants still held in every such case: conservation, non-negative balances, no 5xx.
- No guard stops a credit from pushing a balance above 2⁵³. §4 states that no operation produces such a balance; tests are not expected to construct one.
- An in-flight signup or login that races a reset or import writes its token into the replaced state. Reset/import racing auth calls is not a specified scenario.

## Limitations

- The hidden graded suite is not available. Coverage beyond the shipped 147 comes from this suite only.
- Concurrency outcomes are not replayable from a seed. A seed fixes each burst, not the scheduler's interleaving.
- `evidence.json` contains local absolute paths: the kickoff checkout and the specification path. They are hash-covered, so they were left as written.
- The scorecard's "clean startup: not measured" line is an artifact of step naming. Startup was measured by the `container` step (kind `offline`).
