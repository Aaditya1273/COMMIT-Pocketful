@24bec109/verifier STAGE 3 VERIFICATION HANDOFF — part 1/9 (task, revision, builder evidence, scope). Part 2 = complete stage-3 spec; parts 3-4 = complete stage-2 spec; parts 5-6 = complete stage-1 spec; part 7 = complete plan/stage-3.md; part 8 = regression set; part 9 = final.

Please issue an independent verdict (ACCEPT / REJECT / INCONCLUSIVE) on ONE revision:
  Revision: 39de1bf419a1deeb826cb3f2c38519301e006896   Folder: /home/bajrangi/Wins/band-work/result/stage-3/
  Copy-forward commit: c3b6c21 (stage-2 at ef962af copied unchanged). Planner checked: stage-1/ == 29baf05 and stage-2/ == ef962af at 39de1bf (git diff --quiet).

TASK: Pocketful stage 3 in stage-3/: complete buildable service (Dockerfile + RUN.md), builds and serves with no outbound network at run time from that folder alone; solves stage 3 and NOT stage 4; every stage-1 and stage-2 requirement stays in force (you verified them at 29baf05 and ef962af). Built to the spec, not to the shipped tests (shipped stage-3 checks are only ~9% of the graded suite). Clean-room and git rules as before; evidence under verification/ and evidence/ only, --author "Verifier <verifier@seats.local>".

SCOPE (human owner's constraint): hard stop 23:00 IST (now 20:54). Mutation = 100-mutant SEEDED SAMPLE (node commit/cli.ts mutate ... --max 100 --seed 1), recorded as such. All other gate steps complete: official harness isolated, contract, reference model, adversarial, clean build, offline. Please send the verdict by ~22:30 IST at the latest; if a REJECT is clear earlier, send it immediately so a repair can be routed.

OFFICIAL CHECK:
  cd /home/bajrangi/Wins/dark-factory-wearedevs
  env -u PYTHONHOME -u PYTHONPATH .venv/bin/python -m harness run --track pocketful --repo /home/bajrangi/Wins/band-work/result --stage 3 --mode isolated --out /home/bajrangi/Wins/band-work/checks/s3-verifier-<n>
Expected: suites 1, 2, 3 fully passed; suite 4 (overshoot) must fail. Judge from report.json.

BUILDER'S CLAIMS (reproduce, do not trust):
- s3-builder-2 on 39de1bf: suite 1 147/147, suite 2 35/35, suite 3 6/6 (0 failed/0 errors); suite 4 collected 5, passed 0, failed 1 ("KeyError: 'refund_of'").
- Own tests vs clean container (serial): 51/51 (stage-1/2 regression 37 + ledger 12 + upgrade 2); stage-2 browser regression 24/24 on the stage-3 container. Upgrade tests use real accepted images (stage-1 @29baf05, stage-2 @ef962af).
- Defect self-caught: a payment in the same millisecond as a statement read fell outside the default `to`; now default now = max(clock, last recorded time) and the default bound includes it.
- Clean container --network none healthy after 208 ms; assets offline.
- Stated limitations: (1) a stage-2 export has no void time → on import a voided hold's closed_at = its latest known event (creation or last capture); expired close at expires_at; captured at last capture. (2) Seeded captured/voided holds have no reconstructed lifecycle: never hold historically, closed_at = reset time. (3) Statement echoes `from` (null when omitted) and `to` (default instant). (4) Snapshots in memory until reset, travel in exports. (5) historical_overdraft evaluated only for the two wallets a correction touches. (6) No statement/correction UI (none specified). (7) Seeded equal passwords share one salted hash. (8) Hidden suite not run.
- Reproduction: git clone /home/bajrangi/Wins/band-work/result /tmp/r && cd /tmp/r && git checkout 39de1bf ; docker build -t pocketful-stage-3 stage-3 && docker run --rm --network none -e PORT=9000 pocketful-stage-3 ; (cd stage-3 && node --test test/*.test.js) ; upgrade: run s1 on :8081, s2 on :8082, s3 on :8080, then cd stage-3 && POCKETFUL_URL=http://127.0.0.1:8080 POCKETFUL_S1_URL=http://127.0.0.1:8081 POCKETFUL_S2_URL=http://127.0.0.1:8082 node --test --test-concurrency=1 test/*.test.js

WHAT I ASK: verify against parts 2-8 (R3-01..R3-15, edge cases 1-12, A3-01..A3-09) plus the stage-1/2 regression set. Probe what the 6 shipped checks don't: as_of inclusivity and before-history opening balance; known_at selection (not-yet-recorded payments contribute nothing); statement half-open windows, ordering ties by payment id, opening+deltas=closing on every page; snapshot freezing under concurrent payments/corrections and its 422/404 cases; correction validation and precedence (403/404/422/linked_payment_immutable/stale_revision/insufficient_funds before historical_overdraft incl. same-instant boundaries and available with holds); replay after newer revisions; concurrent same-expected-revision corrections; sum = seeded total in every historical view; historical holds (four fields, closed_at, expiry at deadline, future as_of); stage-1 and stage-2 export upgrades. Send your verdict to the planner and the builder by literal handle and commit evidence.
