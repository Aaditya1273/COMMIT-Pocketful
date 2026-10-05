@24bec109/builder STAGE 1 HANDOFF — part 1/6 (task, constraints, checks). Parts 2-3 = complete stage-1 specification text; parts 4-5 = complete plan; part 6 = final. Plan revision: 71188bfb9d75f6e3c5948fdf00956ed4c713cf36

TASK (from the human dispatch, verbatim essentials): Build Pocketful, stage 1 now. Stage N goes in /home/bajrangi/Wins/band-work/result/stage-N/ : a complete, buildable service with a Dockerfile and a RUN.md, as the specification's delivery section requires. It must build, and serve with no outbound network at run time, from that folder alone. Stage 1 is built from the specification. A stage-N folder must solve stage N, not a later stage (do NOT add stage-2 features: no browser UI, no authorizations/holds/captures). Build to the specification, not to the shipped sample tests; they are a fraction of what is graded.

Result repository (absolute): /home/bajrangi/Wins/band-work/result
Your folder: /home/bajrangi/Wins/band-work/result/stage-1/  (source, Dockerfile, RUN.md, your own tests). Touch nothing outside it.

Clean room: write every line of stage code yourself in this room. Do not copy code from /home/bajrangi/Wins/COMMIT (including its calibration/ directory), from any other repository, or any other team's submission. Do not modify the specification or the official tests (/home/bajrangi/Wins/dark-factory-wearedevs/pocketful/test/ — you may read the sample tests to see wiring, but the spec is the contract).

Git: commit in the result repository on main; never amend or rebase a reported revision; attribute every commit: git commit --author "Builder <builder@seats.local>". Do not commit node_modules, build output, or check output.

Runtime constraints (spec §2): image runs on its own with -e PORT=<port> and a port mapping; listen 0.0.0.0:$PORT default 8080; no outbound network at run time (build may fetch); 2 vCPU, 2 GiB; first healthy response within 60 s; up to 50 requests in flight; per-request timeout 5 s (10 s for POST /_test/reset); state is ephemeral; no 5xx ever.

OFFICIAL CHECK (use this interpreter exactly; --out must be a NEW directory each run):
  cd /home/bajrangi/Wins/dark-factory-wearedevs
  .venv/bin/python -m harness run --track pocketful --repo /home/bajrangi/Wins/band-work/result --stage 1 --mode isolated --out /home/bajrangi/Wins/band-work/checks/s1-builder-<n>
Judge from <out>/report.json, each suite's collected/passed/failed/errors — never from the exit code. The harness also runs suite 2 as an overshoot probe; a correct stage-1 folder FAILS suite 2. A missing, crashed, skipped or empty suite is not a pass. Docker is running. The shipped stage-1 checks are ~79% of the graded suite: also test the spec behaviours the samples do not ask (concurrency, idempotency races, export/import round trips with replay, settlements, validation precedence).

DELIVERABLE BACK TO @planner (one message, your mandate's handoff format): Work completed (R-ids), full revision hash, folder, files changed, exact commands executed, verbatim outputs (report.json suite counts), checks passed/failed as numbers, limitations, reproduction from a clean checkout.
