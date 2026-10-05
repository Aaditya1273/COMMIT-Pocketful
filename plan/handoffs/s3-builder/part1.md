@24bec109/builder STAGE 3 HANDOFF — part 1/9 (task, constraints, checks). Part 2 = complete stage-3 spec; parts 3-4 = complete stage-2 spec; parts 5-6 = complete stage-1 spec (both still in force); part 7 = complete plan/stage-3.md (commit 74a9c78); part 8 = stage-2 plan requirements summary pointer content; part 9 = final.

STAGE 2 IS ACCEPTED by the verifier at revision ef962af95a5b8507cf97395525468c1510c1b51c (evidence commit 6010e87). stage-2/ is now FROZEN; stage-1/ stays frozen at 29baf05.

TASK: Build Pocketful stage 3 in /home/bajrangi/Wins/band-work/result/stage-3/.
1. Copy stage-2/ exactly as at ef962af to stage-3/ (no nested .git; no node_modules/build output), commit the copy alone, then extend it.
2. Complete buildable service (Dockerfile + RUN.md); builds and serves with no outbound network at run time from that folder alone.
3. Solve stage 3, NOT stage 4 (no refunds, no operator batch corrections).
4. Every stage-1 and stage-2 requirement stays in force (suites 1 and 2 fully passing; UI unchanged in behaviour).
5. Build to the spec, not the shipped tests: shipped stage-3 checks are only ~9% of the graded suite. The graded suite tests everything in the stage-3 spec: as_of/known_at semantics and validation, statements (half-open window, ordering, opening/closing, deltas, pagination invariants), snapshots, corrections (validation, precedence, stale_revision, insufficient_funds vs historical_overdraft, linked_payment_immutable, replay), revisions endpoint visibility, historical holds (closed_at, expiry at deadline, four money fields), upgrades from stage-1 and stage-2 exports, and concurrent writes.

Clean room, git and runtime rules exactly as before: write everything yourself in this room; nothing from /home/bajrangi/Wins/COMMIT or any other repository; don't modify the spec or official tests; commit on main with --author "Builder <builder@seats.local>"; never amend/rebase; -e PORT / 0.0.0.0 / 8080; no outbound at run time; 2 vCPU/2 GiB; healthy ≤ 60 s; 50 in flight; 5 s per request; never 5xx.

TIME CONSTRAINT: hard stop 23:00 IST (now 20:34). Please hand off a committed revision by ~21:40 so the verifier has ~80 minutes. Cut nothing on correctness; if something is unfinished, list it under Limitations rather than hiding it.

OFFICIAL CHECK:
  cd /home/bajrangi/Wins/dark-factory-wearedevs
  env -u PYTHONHOME -u PYTHONPATH .venv/bin/python -m harness run --track pocketful --repo /home/bajrangi/Wins/band-work/result --stage 3 --mode isolated --out /home/bajrangi/Wins/band-work/checks/s3-builder-<n>
Expected: suites 1, 2 and 3 fully passed; suite 4 (overshoot probe) fails. Judge from report.json per suite. Also test upgrades: export from the accepted stage-1 (29baf05) and stage-2 (ef962af) images after writes (incl. settlements, holds, captures), import into stage-3.

DELIVERABLE BACK TO the planner (by literal handle) in your handoff format.
