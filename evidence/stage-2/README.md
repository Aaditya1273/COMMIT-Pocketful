# Stage 2 verification evidence (Verifier)

**Verdict: ACCEPT, bound to revision `ef962af95a5b8507cf97395525468c1510c1b51c`**
(git tree of `stage-2/` `b53bb299a303a6a014657a50ce1c4fd639734ede`; candidate content digest
`030a6bc1aa805257326cf77f3beddb5a7e9dfb38dc867e8116e645e8ef11490e`, the same before and after the run).
`stage-1/` is unchanged since the accepted 29baf05 (identical tree `10a55dea…`).

**Mutation was a 100-mutant seeded sample** (`mutate --max 100 --seed 1`), as the human owner's
time constraint of 2026-10-05 directs. It was not a full campaign. Every other gate step ran in full.

| Path | What it is |
|---|---|
| `run-20261005T143900Z-5eacd7/` | the release-gate run (`commit/verify.ts`, evidence schema v2). Manifest sha256 `577d2c681320dd5c66a97aea2c610c09d8dc77764ae34cdb8dfc1cd0b832fed1`. `node commit/cli.ts audit` passes. |
| `official-harness-s2-verifier-1/` | standalone official isolated run on a clean clone at ef962af |
| `exploratory/run-…134946Z-5cd4c5/` | first gate run. Sample: 56 killed, 37 **timeouts**, 6 survived = 56.6% kill rate (93.9% if timeouts are counted as detected). The timeouts came from my UI layer: broken-UI mutants made every locator wait out under 8 parallel browsers. That is a verification weakness. Fixed with fail-fast UI checks, 4 jobs and a 300 s mutant budget. |
| `exploratory/run-…141826Z-aa1198/` | second gate run: 75/99 = 75.8%. Its survivors showed the UI suite lacked JPY/BHD *input* parsing, HTTP 500 as an uncertain outcome, and redirect-to-login checks. All three were added. |
| `screenshots/` | `/`, `/requests`, `/authorizations`, `/split` at 1280 px and 375 px |
| `../../verification/stage-2/` | all stage-2 verification code and the plan |

## Results of the release-gate run (each step is in `run-…/logs/<step>.log`)

| Step | Result |
|---|---|
| clean-build | `docker build --no-cache stage-2`: PASSED |
| container | Offline (`--network none --cpus 2 --memory 2g`): healthy after 192 ms; outbound request fails; `PORT` empty → 8080. Against capped containers: contract 49/49 (including import into a second process), auth contract 14/14, UI checks. §2 limits: 200 distinct-password users reset in 4.0 s; 50 logins, slowest 1.0 s. |
| official-isolated | judged from `report.json`. Suite 1 **147/147**; suite 2 **35/35** (test_sample 10/10, test_ui 25/25); overshoot suite 3 6 collected / 2 passed / **1 failed** (no `as_of`), as required. |
| shipped-stage-1-host | 147 passed |
| contract | stage-1 regression 49/49. Only changes from stage 1: `/me` now carries `total`/`available`/`held`, and payments carry `authorization_id`, both as stage 2 specifies. |
| auth-contract | 14/14 holds checks: `/me` fields; seeded holds (open, expired by clock at reset, voided, captured); reset errors (holds > balance, ttl 0/-1/1.5/"600", bad status, bad/duplicate auth ids); authorize 201 shape, `expires_at = created_at + ttl`, errors, replay/reuse/claimed-key precedence; final and partial captures, remainder rules, `payment_ids`; capture errors and precedence, `final` non-boolean → 400, `{}` vs `{"amount":N}` → 409; void rules; **expiry by clock with no traffic at the deadline**; list filters, paging and grammar; `available` governs payments, request pay, settlements and authorizations; captures may spend reserved money; content negotiation; export/import of holds, ttl and replays. |
| upgrade | 10/10: a real stage-1 service built from this revision's `stage-1/` exports; stage 2 imports. Old token works; `/me` gains `total`/`available`/`held`; a lost-response payment replays 200 identical; a pending request is payable; operator kept; default ttl 600. |
| ui | **16/16** Playwright checks, independent of the shipped tests: login/signup and `auth-error`; `current-user`/`current-handle` on every route; logout; formatting (`100.00 EUR`, `2500 JPY`, `0.500 BHD`); `available` is the headline (larger type than total); `wallet-held` absent at 0; decimal rules (9 bad inputs → `pay-error` with no POST; `15.5`→1550, `15`/`15.00`→1500; JPY `1200`→1200; BHD `12.345`→12345); unchanged resubmission moves no money; refusal keeps inputs; another client spent the funds → `pay-error` + refreshed balance; lost response after commit → `pay-uncertain`, then the same-key retry moves money once; 500 and 503 → uncertain; latest refresh wins against a delayed earlier `/me` (interception verified to fire); feed testids, `data-visibility`, exact amounts and notes (HTML as text); requests screen button rules and the stale-button case; split preview equals server shares before posting; authorizations screen (status, amounts, `expires_at` text, pre-filled capture amount, capture/void rules, `authorization-error`, `empty-authorizations`); authorize form refresh; import between browser requests keeps the session and retry identity; unauthenticated routes → login; 375 px without horizontal scroll on 6 routes; every input labelled; **no request leaves the origin**. |
| reference-holds ×3 | seeds 481927 · 7 · 90210: **agree**, 3 × 1,000 operations (authorize / capture final + partial / void / pay / settle / replays) against a model of totals and holds; whole-state comparison of `/me` and every user's authorizations every 4 operations |
| reference-stage1 ×2 | seeds 481927 · 7: agree, 2 × 1,000 operations |
| adversarial-holds | **25/25** rounds (5 campaigns × 5 seeds, bursts of 50): payments, authorizations, settlements and request pays competing for `available` with live `/me` watchers; concurrent captures over a remainder (never over-captures; records match money); same-key bursts on both new paths; capture vs void (exactly one wins, money consistent); captures racing expiry |
| adversarial | stage-1 campaigns 50/50 |
| mutation-sample | **100-mutant seeded sample**: 79 killed / 99 valid = **79.8%**, 0 timeouts, 1 invalid, 20 survivors. server.js 55/62 (88.7%); public/app.js 24/37 (64.9%). |

## Sample survivors (20): disposition

| Where | # | Disposition |
|---|---|---|
| app.js 98, 153, 512, 803 | 4 | wording of human-readable messages (any wording allowed) |
| app.js 963 | 1 | ARIA role chosen for a message (`alert` vs `status`); the spec only requires the element to exist |
| app.js 101 | 1 | client-side 13-digit cap; any amount that large is refused by the server (max 10⁹) |
| app.js 111 | 1 | threshold for the "Just now" relative-time label (formatting choice) |
| app.js 272, 636 | 2 | list readiness/loading-state conditions that differ only when one of two parallel list reads fails |
| app.js 332 | 1 | stale-render guard on fast re-navigation; no specified observable |
| app.js 728 | 1 | cosmetic "n pending" counter |
| app.js 887, 889 | 2 | split-uncertain message slot; the spec requires an uncertain state for payments only |
| server.js 73 | 1 | sign test for ±Infinity in canonical bodies (equivalent, as in stage 1) |
| server.js 94 | 1 | scrypt parameter bounds of a hand-crafted imported hash (unspecified, as in stage 1) |
| server.js 1000 | 2 | bounds on a seeded `captured_amount` field, which is not part of the specified fixture |
| server.js 1194, 1227, 1240 | 3 | field validation of a hand-crafted import state (implementation-defined format) |

## Verification failures (my checks were wrong; fixed and re-run; candidate untouched)

1. Expected `held` before expiry: 3000 + remainder 600 = 3600 held, not 4200.
2. UI layer timing out under parallel mutants (see the exploratory run). Fail-fast was added.

## Observations (not defects)

- A request's pay button has a visibility select, and capture has a "Release the rest" checkbox (unchecked → `final:false`). Neither is in the spec. Both are extra controls and the required testids are unaffected.
- Product quality, judged from the screenshots: calm teal visual system; "Available to spend" is the headline, with total and held secondary; private/public badges; people-first parties ("@bob paid @ada", "You're holding for @bob"); considered empty states; usable at 375 px. Judging by the graders is subjective and was not run.
- Seeded users with equal passwords share one salted hash (as in stage 1).

## Limitations

- **Mutation is a 100-mutant seeded sample** of 1,000+ mutants, so the kill rate is a sample estimate.
- The hidden graded suite and product-quality judging were not run.
- The upgrade check exports from a stage-1 service started from this revision's `stage-1/` folder, which is byte-identical to the accepted 29baf05. The browser upgrade case uses a stage-2 export/import between browser requests: no stage-1 UI exists, so a token cannot be issued from a stage-1 browser.
- Concurrency interleavings are not replayable from seeds.
