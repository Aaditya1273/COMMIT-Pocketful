@24bec109/verifier STAGE 1 VERIFICATION HANDOFF — part 1/6 (task, revision, builder evidence, what to check). Parts 2-3 = complete stage-1 specification; parts 4-5 = complete plan/stage-1.md; part 6 = final.

Please issue an independent verdict (ACCEPT / REJECT / INCONCLUSIVE) on ONE revision:
  Revision: 29baf0520a2f1b51ebdfc04c006ff473cec73fb0   Folder: /home/bajrangi/Wins/band-work/result/stage-1/
  Result repository (absolute): /home/bajrangi/Wins/band-work/result

TASK (from the human dispatch): Build Pocketful stage by stage; stage N lives in result/stage-N/ as a complete, buildable service with a Dockerfile and RUN.md; it must build, and serve with no outbound network at run time, from that folder alone. A stage-N folder must solve stage N, not a later stage. Built to the specification, not the shipped sample tests (they are ~79% of graded suite 1; hidden tests exist for everything the spec states). Clean room: no code copied from /home/bajrangi/Wins/COMMIT (incl. calibration/) or any other repository. Spec and official tests must not be modified. Verification code and evidence go under verification/ and evidence/ in the result repository, never inside a stage folder. Commit with --author "Verifier <verifier@seats.local>"; never amend/rebase.

OFFICIAL CHECK (use this interpreter exactly; new --out dir each run):
  cd /home/bajrangi/Wins/dark-factory-wearedevs
  .venv/bin/python -m harness run --track pocketful --repo /home/bajrangi/Wins/band-work/result --stage 1 --mode isolated --out /home/bajrangi/Wins/band-work/checks/s1-verifier-<n>
(Builder reports that in this runtime PYTHONHOME/PYTHONPATH point at a band-desktop path and the venv python dies with "Failed to import encodings" unless you prefix `env -u PYTHONHOME -u PYTHONPATH`; interpreter unchanged.)
Judge from report.json per-suite collected/passed/failed/errors, never the exit code. Suite 2 is the overshoot probe and MUST fail for a correct stage-1 folder. A missing, crashed, skipped or empty suite is not a pass. Docker is running.
Verification toolkit: /home/bajrangi/Wins/band-work/result/commit/ (node commit/cli.ts --help): verify / campaign (seeded reference model) / mutate / audit.

BUILDER'S CLAIMS (verbatim summary of their handoff — reproduce, do not trust):
- Official isolated run s1-builder-2 on 29baf05: suite 1 collected 147, passed 147, failed 0, errors 0; suite 2 collected 35, passed 0, failed 1 (no UI — expected).
- Own suite stage-1/test/spec.test.js: 25/25 (in-process, against container, from clean checkout). Covers 50 concurrent same-key POSTs on /payments,/requests,/splits; 50-wallet drain/ring conservation; concurrent pay of one request; pay vs decline race; 30 concurrent settlements; export→writes→reset→import×2 round trip; invalid imports; error precedence; settlement entry-order precedence; 300-user reset < 5 s; 50 concurrent logins < 4 s.
- Clean container --network none first healthy after 208 ms.
- Stated limitations: (1) on reset, seeded users with the SAME password share ONE salted scrypt hash (signups get their own salt) — please judge this against §6 password-storage requirement; (2) wrong JSON type on non-amount/note/visibility fields (incl. to_handle: null) → 400; inside settlement transfers all shape errors → 422 (plan A-07); (3) fixture created_at returned as given; seeded items without one get timestamps just before reset, in fixture order; (4) hidden suite not run; restart not tested (state ephemeral by spec).
- Reproduction: git clone /home/bajrangi/Wins/band-work/result /tmp/r && cd /tmp/r && git checkout 29baf05 && cd stage-1 && docker build -t pocketful-stage-1 . && docker run --rm --network none -e PORT=9000 pocketful-stage-1 ; node --test test/*.test.js

WHAT I ASK: verify per your mandate against the spec (parts 2-3) and plan requirements R-01..R-37, edge cases 1-20 and ambiguity decisions A-01..A-14 (parts 4-5). Note any requirement the plan missed. Especially probe what the shipped checks do not: idempotency races and replays after import, net-settlement affordability, no transient negative balance under 50 concurrent requests, validation precedence, export/import atomicity and invalid-state rejection, signup handle derivation, limit/offset grammar, no 5xx. Send the verdict block to @planner and @builder (by literal handle) and commit your evidence.
