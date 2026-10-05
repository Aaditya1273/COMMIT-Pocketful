@24bec109/builder STAGE 2 HANDOFF — part 1/8 (task, constraints, checks). Parts 2-3 = complete stage-2 specification; parts 4-5 = complete stage-1 specification (still in force, referenced as §n); parts 6-7 = complete plan/stage-2.md (commit 6f0b40c); part 8 = final.

STAGE 1 IS ACCEPTED by the verifier at revision 29baf0520a2f1b51ebdfc04c006ff473cec73fb0 (evidence commit a6d8c89). stage-1/ is now FROZEN — do not change it.

TASK: Build Pocketful stage 2 in /home/bajrangi/Wins/band-work/result/stage-2/.
1. First, copy the accepted folder forward: copy stage-1/ exactly as at 29baf05 to stage-2/ (no nested .git; exclude node_modules/build output), commit that copy on its own, then extend the copy.
2. stage-2/ must be a complete, buildable service with Dockerfile and RUN.md; it must build, and serve with no outbound network at run time, from that folder alone. All UI assets (scripts, styles, fonts) bundled in the image — no CDN.
3. It must solve stage 2, not stage 3 (no statements, corrections, as-of history, refunds, batch corrections).
4. Every stage-1 requirement stays in force (suite 1 must still pass fully; R-01..R-37 of plan/stage-1.md).
5. Build to the specification, not to the shipped sample tests: the shipped stage-2 checks are only ~35% of the graded suite, which includes Playwright UI tests on everything the spec states (testids, formatting, decimal input, stale state, lost responses, upgrade import of a stage-1 export, holds/captures/expiry) and product-quality judging (coherent, presentation-ready, responsive at 375 px, accessible, distinct states).

Result repository (absolute): /home/bajrangi/Wins/band-work/result. Your folder: stage-2/ only.
Clean room: write every line yourself in this room; no code from /home/bajrangi/Wins/COMMIT (incl. calibration/) or any other repository/team. Do not modify the spec or the official tests (you may read /home/bajrangi/Wins/dark-factory-wearedevs/pocketful/test/stage_2/ for wiring only).
Git: commit on main with --author "Builder <builder@seats.local>"; never amend/rebase a reported revision.
Runtime constraints (§2): -e PORT, 0.0.0.0, default 8080; no outbound network at run time; 2 vCPU / 2 GiB; healthy within 60 s; 50 in flight; 5 s per request (10 s reset/import/export); ephemeral state; never 5xx.

TIME CONSTRAINT (from the human owner): the whole run stops at 23:00 IST today. It is now ~18:30. Please aim to hand off a committed, verified-by-you revision by ~20:45 so the verifier has time. If you must cut, cut polish, never correctness; list anything unfinished under Limitations.

OFFICIAL CHECK (same interpreter; prefix env -u PYTHONHOME -u PYTHONPATH as you found necessary; new --out each time):
  cd /home/bajrangi/Wins/dark-factory-wearedevs
  env -u PYTHONHOME -u PYTHONPATH .venv/bin/python -m harness run --track pocketful --repo /home/bajrangi/Wins/band-work/result --stage 2 --mode isolated --out /home/bajrangi/Wins/band-work/checks/s2-builder-<n>
Judge from report.json per suite (collected/passed/failed/errors). Expected: suite 1 and suite 2 fully passed; suite 3 (overshoot probe) fails. Missing/crashed/skipped/empty suites are not passes. Also test an upgrade: export from the stage-1 image (29baf05) after some writes, import into the stage-2 image, check tokens, pending requests and a lost-response payment replay.

DELIVERABLE BACK TO the planner (by literal handle) in your mandate's handoff format: work completed (R2-ids), full revision hash, files changed, exact commands, verbatim report.json numbers, own-check numbers, limitations, reproduction.
