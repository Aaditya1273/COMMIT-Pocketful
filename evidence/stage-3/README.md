# Stage 3 verification evidence (Verifier)

**Verdict: ACCEPT, bound to revision `39de1bf419a1deeb826cb3f2c38519301e006896`**
(git tree of `stage-3/` `01c4a385109a05db6cdf79f4ae2e3f9c03142eb3`; candidate content digest
`a3d9a95790d885a144ed118706af71f67a9170cd63fd46cb2abd612c8ae38241`, the same before and after the run).
`stage-1/` and `stage-2/` are unchanged since the accepted 29baf05 and ef962af.

**Mutation was a 100-mutant seeded sample** (`mutate --max 100 --seed 1`), as the human owner's
time constraint directs. Every other gate step ran in full.

| Path | What it is |
|---|---|
| `run-20261005T153327Z-02f8c6/` | the release-gate run (`commit/verify.ts`, schema v2). Manifest sha256 `c8f5acf4ade3031972fb7a99fda42c5bb36b03cbb8c4d39d6c1dd94658e0af29`. Audit passes. |
| `official-harness-s3-verifier-1/` | standalone official isolated run on a clean clone at 39de1bf |
| `supplementary/survivor-replay/` | after the gate run, two RFC 3339 boundary checks were added (valid leap day, ±23:59 offsets). The two sample survivors they target were replayed: both killed. Not part of the gate run's numbers. |
| `../../verification/stage-3/` | stage-3 verification code and plan. `ledger-contract.mjs` there is the version with the two added checks. |

## Results (each step is in `run-…/logs/<step>.log`)

| Step | Result |
|---|---|
| clean-build | `docker build --no-cache stage-3`: PASSED |
| container | Offline (`--network none`, 2 vCPU / 2 GiB): healthy after 192 ms; outbound fails; 8080 default. Against capped containers: contract 49/49, auth 14/14, UI 16/16, ledger 12/12; §2 limits met. |
| official-isolated | judged from `report.json`: suite 1 **147/147**, suite 2 **35/35**, suite 3 **6/6**; overshoot suite 4 5 collected / 0 passed / **1 failed** (no `refund_of`), as required |
| ledger-contract | 12/12: seeded timestamps (future → 422, unchanged; omitted = reset time); `as_of` inclusive / before history / beyond latest, exact echo (Z, +05:30), invalid instants → 422; statement half-open window, oldest first, same-instant tie by payment id (settlement), opening/closing, deltas, paging invariance incl. last partial page and beyond end, default `to` = now, others' public payments excluded, from > to → 422; corrections (shape, money both ways, replay after newer revisions, reuse 409, stale 409, revision list, strictly increasing `recorded_at`, third party 404, no token 401, feed unchanged, zero amount = zero delta); validation and precedence (403/404/400/401/16 × 422, linked before stale, captures and settlement members immutable, request-paid correctable); `insufficient_funds` (now) before `historical_overdraft` (past), failures change nothing, same-instant boundaries combined; backdating moves a payment between windows; `known_at` selection (not yet recorded → contributes nothing), echo; snapshots frozen across payment, correction and hold, 422/404 cases; historical holds (four fields at creation, capture, deadline, void; `closed_at`; captures once in statements); held funds guard corrections |
| upgrade | 58/58: real stage-1 and stage-2 services from this revision's frozen folders export, stage 3 imports. Balances and holds kept; statements close at the balance; revision 1 at `created_at` (settlement members at `committed_at`); lost payment replays; member and capture corrections → 422 `linked_payment_immutable`; an imported payment is correctable and the opening balance is unchanged; historical `held` at the capture; open hold capturable; each capture appears once |
| reference-ledger ×3 | seeds 481927 · 7 · 90210: **agree**, 3 × 1,000 operations. Payments; corrections with stale revisions and backdated effective times; `insufficient_funds` vs `historical_overdraft` predicted by an independent boundary model; replays; `as_of`/`known_at` reads; revisions visibility. Whole-state comparison of balances and every user's full statement every 5 operations. |
| reference-holds ×3, reference-stage1 ×2 | agree |
| adversarial-ledger | 20/20 rounds (4 campaigns × 5 seeds): 30 concurrent corrections on one expected revision (exactly one 201, rest `stale_revision`); same-key correction bursts; snapshots read during concurrent payments and corrections (never change); conservation and running balances in `as_of`/`known_at` views after concurrent corrections |
| adversarial-holds, adversarial | 25/25, 50/50 |
| ui, contract, auth-contract, extra, survivors, import-semantic, shipped stage 1 | all passed (stage-1/2 regression) |
| mutation-sample | **100-mutant seeded sample: 86 killed / 100 valid = 86.0%**, 0 timeouts. server.js 66/76; app.js 20/24. |

## Sample survivors (14)

| Where | # | Disposition |
|---|---|---|
| server.js 870, 874 | 2 | RFC 3339 leap-day year and ±23:59 offset boundary: **missing checks, now written**. Both mutants killed in the supplementary replay; the candidate passes the new checks. |
| server.js 138 | 1 | initial sequence value, overwritten on reset (equivalent) |
| server.js 1553, 1581, 1584, 1587 | 4 | sub-record validation of a hand-crafted import state (implementation-defined format) |
| server.js 1722 | 1 | 204 special case (Node sends no body on 204; equivalent) |
| server.js 1759 | 1 | request-body size cap (unspecified) |
| server.js 1781 | 1 | GET/HEAD page-serving branch for other methods (no specified observable) |
| app.js 51, 112, 122, 155 | 4 | attribute rendering of `false`, relative-time wording, message wording |

## Verification failures (my checks were wrong; fixed and re-run; candidate untouched)

1. A ledger check expected a correction with `effective_at = now` to succeed. Moving the effective time also removes the original credit from the receiver's past, so `historical_overdraft` is correct.
2. A reference invariant required every `balance_after` to be non-negative. The spec defines boundaries as the combined effect of an instant, so mid-instant entries may dip. The candidate and the model agreed throughout.
3. The upgrade check expected an opening balance of 10000. The fixture's seeded p_1 makes it 10500.

## Limitations

- Mutation is a seeded sample. The hidden suite and product-quality judging were not run.
- Builder-stated behaviours accepted as allowed by the spec: void time is unknown for stage-2 imports (`closed_at` = latest known event); seeded closed holds have no reconstructed lifecycle; the statement echoes `from`/`to`; snapshots live until reset and travel in exports.
- Seeded equal passwords share one salted hash (as in stages 1–2).
