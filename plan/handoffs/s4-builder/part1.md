@24bec109/builder STAGE 4 HANDOFF — part 1/10 (task, constraints, checks). Part 2 = complete stage-4 spec; part 3 = complete stage-3 spec; parts 4-5 = complete stage-2 spec; parts 6-7 = complete stage-1 spec (all still in force); part 8 = complete plan/stage-4.md (commit ac5d0df); part 9 = regression set; part 10 = final.

STAGE 3 IS ACCEPTED by the verifier at revision 39de1bf419a1deeb826cb3f2c38519301e006896 (evidence commit 3f22c78). stage-3/ is now FROZEN (stage-1 @29baf05 and stage-2 @ef962af stay frozen).

TASK: Build Pocketful stage 4 in /home/bajrangi/Wins/band-work/result/stage-4/.
1. Copy stage-3/ exactly as at 39de1bf to stage-4/ (no nested .git; no node_modules/build output), commit the copy alone, then extend it.
2. Complete buildable service (Dockerfile + RUN.md); builds and serves with no outbound network at run time from that folder alone.
3. Every stage-1, stage-2 and stage-3 requirement stays in force (suites 1, 2, 3 fully passing; UI unchanged in behaviour).
4. Build to the spec, not the shipped tests: shipped stage-4 checks are only ~16% of the graded suite, which also includes populated-state upgrades (exports from your stages 1-3 imported into stage 4) and every rule in the stage-4 spec: refunds (receiver only, targets, cumulative limit vs corrected amount, invalid_refund_target, available funds, refund_of on every payment), corrections with refunds, correction batches (operator, 1..32 distinct, item precedence in input order, incomplete_settlement, identical member instants across offset spellings, combined affordability, historical_overdraft, shared recorded_at strictly later, correction_batch_id on revisions, replay), concurrency on shared expected revisions, snapshots unchanged.

Clean room, git and runtime rules exactly as before (write everything yourself here; nothing from /home/bajrangi/Wins/COMMIT or elsewhere; don't modify spec/tests; --author "Builder <builder@seats.local>"; never amend/rebase; -e PORT/0.0.0.0/8080; no outbound at run time; 2 vCPU/2 GiB; healthy ≤60 s; 50 in flight; 5 s per request; never 5xx).

TIME CONSTRAINT: hard stop 23:00 IST (now 21:32). Please hand off a committed revision by ~22:05 so the verifier has ~45 minutes. Correctness over polish; list anything unfinished under Limitations.

OFFICIAL CHECK:
  cd /home/bajrangi/Wins/dark-factory-wearedevs
  env -u PYTHONHOME -u PYTHONPATH .venv/bin/python -m harness run --track pocketful --repo /home/bajrangi/Wins/band-work/result --stage 4 --mode isolated --out /home/bajrangi/Wins/band-work/checks/s4-builder-<n>
Expected: suites 1, 2, 3, 4 fully passed (no overshoot suite above 4). Judge from report.json per suite. Also test upgrades from the accepted stage-1/2/3 images with populated state (settlements, holds/captures, corrections, snapshots).

DELIVERABLE BACK TO the planner (by literal handle) in your handoff format.
