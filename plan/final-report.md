@24bec109 FINAL REPORT — Pocketful, all four stages ACCEPTED by the verifier seat (Planner, 2026-10-05 22:40 IST, before the 23:00 stop)

Result repository: /home/bajrangi/Wins/band-work/result (branch main). Rejections: 0. Repair cycles: 0 in every stage. Every verdict came from `commit/verify.ts` running on a clean clone at the exact revision. The candidate's digest was the same before and after each run, and the verifier modified no production code. Official numbers come from report.json, judged per suite, never from the exit code.

## STAGE 1 — ACCEPT
- Accepted revision: 29baf0520a2f1b51ebdfc04c006ff473cec73fb0 (stage-1/)
- Official (isolated): suite 1 147/147 (0 failed, 0 errors). The overshoot probe, suite 2, failed as required (35 collected, 0 passed, 1 failed).
- Independent checks:
  - 14/14 blocking steps.
  - Contract 49/49 on 2 fuzz seeds.
  - Reference model on 3 seeds × 1,000 ops: 750 whole-state comparisons and 24,000 invariant checks.
  - Adversarial: 10 campaigns × 5 seeds, 50/50 rounds, with bursts of 50 concurrent requests.
  - Offline start healthy in 194 ms.
  - No 5xx anywhere.
- Mutation: full campaign, 653/706 valid killed = 92.5%. 63 equivalents are registered with reasons. The 53 survivors are all in behaviour the spec does not define.
- Known limitations:
  - Seeded users with the same password share one salted scrypt hash.
  - Import accepts some inconsistencies that only a hand-edited state could contain.
  - Nothing guards against a balance passing 2^53, which the spec says never happens.
- Evidence: evidence/stage-1/README.md and evidence/stage-1/run-20261005T122139Z-82f7eb/ (commit a6d8c89).
- Plan and record: plan/stage-1.md.
- Time: 13:08 → 18:28 (5 h 20 m; most of it the full mutation campaign).

## STAGE 2 — ACCEPT
- Accepted revision: ef962af95a5b8507cf97395525468c1510c1b51c (stage-2/, copied forward from 29baf05 in commit 04df3cd)
- Official (isolated): suite 1 147/147 and suite 2 35/35 (0 failed, 0 errors). The overshoot probe, suite 3, failed as required (6 collected, 2 passed, 1 failed).
- Independent checks:
  - 19/19 blocking steps.
  - Auth contract 14/14.
  - Upgrade from a real stage-1 export: 10/10.
  - UI Playwright: 16/16.
  - Reference models agree: holds 3 × 1,000 ops, stage-1 2 × 1,000 ops.
  - Adversarial: holds 25/25, stage-1 50/50.
- Mutation: 100-mutant seeded sample, 79/99 = 79.8%.
- Known limitations:
  - The mutation run was a sample.
  - Product-quality judging was not run; screenshots are in evidence/stage-2/screenshots.
  - The browser upgrade case was tested through a stage-2 export/import between requests, because stage 1 has no UI.
- Evidence: evidence/stage-2/README.md and evidence/stage-2/run-20261005T143900Z-5eacd7/ (commit 6010e87).
- Plan and record: plan/stage-2.md.
- Time: 18:28 → 20:33 (2 h 05 m).

## STAGE 3 — ACCEPT
- Accepted revision: 39de1bf419a1deeb826cb3f2c38519301e006896 (stage-3/, copied forward from ef962af in commit c3b6c21)
- Official (isolated): suites 1/2/3 147/147, 35/35 and 6/6 (0 failed, 0 errors). The overshoot probe, suite 4, failed as required (5 collected, 0 passed, 1 failed).
- Independent checks:
  - 24/24 blocking steps.
  - Ledger contract 12/12.
  - Upgrades from real stage-1 and stage-2 exports: 58/58.
  - Reference models for the ledger, holds and stage-1 all agree.
  - Adversarial ledger 20/20: 30 concurrent corrections of the same revision gave exactly one 201.
- Mutation: 100-mutant seeded sample, 86/100 = 86.0%. Two survivors were real gaps in the verifier's checks (leap-day year and the ±23:59 offset). The verifier added both checks; the candidate passes them, and both mutants are now killed.
- Known limitations:
  - The mutation run was a sample.
  - A stage-2 export records no void time, so an imported voided hold's closed_at is its latest known event.
  - Seeded closed holds have no reconstructed lifecycle.
  - Snapshots live in memory until reset; they are carried in exports.
- Evidence: evidence/stage-3/README.md and evidence/stage-3/run-20261005T153327Z-02f8c6/ (commit 3f22c78).
- Plan and record: plan/stage-3.md.
- Time: 20:33 → 21:31 (58 m).

## STAGE 4 — ACCEPT
- Accepted revision: cc1d710726857c36ef4cc0de22bb97a7046f5fe2 (stage-4/, copied forward from 39de1bf in commit f336d35)
- Official (isolated): suites 1/2/3/4 147/147, 35/35, 6/6 and 5/5 (state completed, 0 failed, 0 errors, 0 skipped). The planner read these numbers from evidence/stage-4/official-harness-s4-verifier-1/.
- Independent checks:
  - 25/25 blocking steps.
  - Refund and correction-batch contract: 5/5 checks, about 90 assertions.
  - Upgrades from stages 1 and 2: 58/58.
  - Populated stage-3 → 4 upgrade: 19/19, including 5 rounds of 20 racing single and batch corrections. Each round had exactly one winner.
  - All regression layers, reference models (8 × 1,000 ops) and adversarial rounds pass.
- Mutation: 100-mutant seeded sample, 77/100 = 77.0%.
- Known limitations:
  - The reference models do not cover refunds or batches; the contract, upgrade and concurrency checks do.
  - 17 mutants in the UI script survived and were not triaged before the stop.
  - Server mutants at the exact-millisecond expiry and close-time boundaries survived. These are gaps in the checks, not known defects.
  - One builder official run hit a Docker base-image lease error. That was an environment fault, and the re-run completed.
- Evidence: evidence/stage-4/README.md and evidence/stage-4/run-20261005T164036Z-9d2396/ (commit e85c931).
- Plan and record: plan/stage-4.md.
- Time: 21:31 → 22:38 (67 m).

## Applies to every stage
- The hidden graded suites were not run (not available). The shipped checks are roughly 79/35/9/16% of the graded suites.
- Every handoff text is under plan/handoffs/s{1..4}-{builder,verifier}/. Verification code is under verification/stage-{1..4}/.
- Time constraint: following your instruction, stages 2–4 used a 100-mutant seeded mutation sample (--max 100 --seed 1). All other steps ran in full.
- One gap in the handoff record: the builder's main stage-4 handoff message never reached the planner seat; only its addendum did. The verifier received the full handoff directly and checked its claims independently.
- Commits are per seat (Planner / Builder / Verifier authors), with no amend or rebase.
