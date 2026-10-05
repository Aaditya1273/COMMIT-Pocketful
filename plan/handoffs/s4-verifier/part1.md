@24bec109/verifier STAGE 4 VERIFICATION HANDOFF — part 1/10 (task, revision, builder evidence, scope). Part 2 = complete stage-4 spec; part 3 = stage-3 spec; parts 4-5 = stage-2 spec; parts 6-7 = stage-1 spec; part 8 = complete plan/stage-4.md; part 9 = regression set; part 10 = final.

Please issue an independent verdict (ACCEPT / REJECT / INCONCLUSIVE) on ONE revision:
  Revision: cc1d710726857c36ef4cc0de22bb97a7046f5fe2   Folder: /home/bajrangi/Wins/band-work/result/stage-4/
  Commits: f336d35 (stage-3 at 39de1bf copied forward unchanged) → 2894b58 (refunds, correction batches, refund_of, correction_batch_id, tests/refunds.test.js) → cc1d710 (test/upgrade4.test.js populated stage-3 → stage-4 upgrade; RUN.md). Planner checked: stage-1/, stage-2/, stage-3/ identical to 29baf05 / ef962af / 39de1bf at cc1d710.

TASK: Pocketful stage 4 in stage-4/: complete buildable service (Dockerfile + RUN.md), builds and serves with no outbound network at run time from that folder alone; every stage-1/2/3 requirement stays in force (you verified them at 29baf05, ef962af, 39de1bf). Built to the spec, not to the shipped tests (shipped stage-4 checks are ~16% of the graded suite; graded suite also runs populated-state upgrades from stages 1-3). Clean-room and git rules as before; evidence under verification/ and evidence/ only, --author "Verifier <verifier@seats.local>".

SCOPE (human owner): HARD STOP 23:00 IST (now 22:05). Mutation = 100-mutant SEEDED SAMPLE (--max 100 --seed 1), recorded as such. All other gate steps complete: official harness isolated, contract, reference model, adversarial, clean build, offline. Send the verdict by ~22:55 at the latest. If a step cannot finish by 23:00, stop after the current step and report the verdict the evidence supports (INCONCLUSIVE if blocking steps did not run), stating which steps did not run.

OFFICIAL CHECK:
  cd /home/bajrangi/Wins/dark-factory-wearedevs
  env -u PYTHONHOME -u PYTHONPATH .venv/bin/python -m harness run --track pocketful --repo /home/bajrangi/Wins/band-work/result --stage 4 --mode isolated --out /home/bajrangi/Wins/band-work/checks/s4-verifier-<n>
Expected: suites 1-4 fully passed (no overshoot suite above 4). Judge from report.json.
Known environment issue (builder): one run ended state "error" because the harness's build of the stage-1 upgrade source hit "node:22-alpine: failed to resolve source metadata ... unable to lease content: lease does not exist" (Docker registry/cache); an identical re-run completed. That is an environment failure, not a candidate failure.

BUILDER'S CLAIMS (from the builder's stage-4 messages addressed to you and me; reproduce, do not trust):
- s4-builder-3 on cc1d710: state "completed", suite 1 147/147, suite 2 35/35, suite 3 6/6, suite 4 5/5 (0 failed, 0 errors, 0 skipped).
- s4-builder-2: state "error" (lease error above) after suite 1 147/147.
- Own tests added: test/refunds.test.js (refunds + correction batches), test/upgrade4.test.js (populated stage-3 → stage-4 upgrade). For the rest of the builder's evidence and stated limitations, use the builder's own STAGE 4 BUILDER HANDOFF addressed to you, and check its claims yourself.

WHAT I ASK: verify against parts 2-9 (R4-01..R4-09, edge cases 1-9, A4-01..A4-05) plus the stage-1/2/3 regression set. Probe what 5 shipped checks don't: refund authority/targets/cumulative limit vs corrected amount/invalid_refund_target/insufficient_funds vs available; refund_of on every payment shape incl. old replays; corrections vs refunded amounts; captures/refunds immutable; correction batches (operator 401/403, 1..32 distinct, item errors in input order, incomplete_settlement, identical member instants across offset spellings, combined affordability, insufficient_funds before historical_overdraft, shared strictly-later recorded_at, correction_batch_id, replay 200, nothing changes on rejection); concurrent single/batch corrections sharing an expected revision; snapshots unchanged; populated upgrades from stages 1-3. Send your verdict to the planner and the builder by literal handle and commit evidence.
