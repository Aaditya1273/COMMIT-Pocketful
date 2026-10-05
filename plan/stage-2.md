# Stage 2 plan — Pocketful: wallet screens and payment authorizations

Author: Planner. Source of truth: `/home/bajrangi/Wins/dark-factory-wearedevs/pocketful/spec/stage-2.md`
("S2") plus every stage-1 requirement (`plan/stage-1.md`, R-01..R-37, which stay in force).

- Result repository: `/home/bajrangi/Wins/band-work/result`
- Build folder: `/home/bajrangi/Wins/band-work/result/stage-2/` — created by copying the
  **accepted** `stage-1/` revision (no nested `.git`) and extending the copy. `stage-1/` is frozen.
- A `stage-2/` folder must solve stage 2 only: no stage-3 statements, corrections, `as_of`, etc.
- Regression set: R-01..R-37 from stage 1 (suite 1 must still pass in full).

## Requirements

### Compatibility
- **R2-01 Stage-1 behaviour unchanged.** S2 "The stage-1 requirements continue to apply". "With no open holds, `balance`, `total` and `available` agree and `held` is zero, and every earlier behaviour is unchanged." Accept: official suite 1 passes against `stage-2/`.
- **R2-02 Upgrade import.** S2 "A stage-2 service must accept an export produced by the same team's stage-1 service." Tokens, pending requests, idempotency records survive; a lost-response payment retried after import with the same key/body → 200 original payment. Accept: export from the accepted stage-1 image, import into stage-2 image → 204; old token works; `/me` gains `total/available/held`; replay works.
- **R2-03 Content negotiation.** S2 "The browser and the API share `/requests`. Return the UI for `Accept: text/html`; API requests without that header receive JSON." Same for `/authorizations`. Accept: `GET /requests` with `Accept: text/html` → 200 HTML (no auth needed for the page shell); without → JSON API (401 without token).

### Authorizations (API)
- **R2-04 Invariants.** S2 1–3: sum of `total` = seeded total; a hold moves no money; `available = total − held` never negative; held funds cannot fund payments, authorizations or settlement net debits; captures may spend money reserved for them; cumulative captures ≤ authorized amount; each idempotent capture moves money once; closed hold cannot be captured.
- **R2-05 `GET /me`** adds `total` (== `balance`), `available`, `held` (sum of open, unexpired holds).
- **R2-06 insufficient_funds against `available`** on `POST /payments`, `/requests/{id}/pay`, settlements (net debit vs available), and authorizations.
- **R2-07 Fixture.** `authorization_ttl_seconds` default 600, positive integer else reset 422; `authorizations` array optional (default []); seeded `status` ∈ open/captured/voided/expired; seeded `expires_at` absolute; `available` derived. "A sum of seeded unexpired open holds larger than that user's `balance` is a reset error: `422 validation_failed` … changing nothing."
- **R2-08 Expiry.** "An authorization whose `expires_at` is at or before now is `expired` and holds no funds. Reads and writes must reflect expiry even if no request occurred at the deadline." Accept: create with short TTL fixture (e.g. 1–2 s), wait, `/me.available` restored and `GET /authorizations` shows `expired` with `remaining_amount: 0`; `?status=open` excludes it, `?status=expired` includes it.
- **R2-09 `POST /authorizations`** (7th/6th idempotent path; key required; caller = payer) body `{to_handle, amount, note?, visibility?}` → 201 authorization object: `authorization_id, from_user_id, from_handle, to_user_id, to_handle, amount, captured_amount (0), remaining_amount, currency, note, visibility, status:"open", expires_at (= created_at + ttl), payment_id:null, payment_ids:[], created_at`. Errors: available < amount 409 `insufficient_funds`; amount 422; self 422 `self_payment`; note/visibility 422; unknown handle 404. Not a feed item.
- **R2-10 `POST /authorizations/{id}/capture`** key required; receiver only; body `{amount?, final?}`; amount defaults to remaining; `final` boolean default true. → 201 payment (POST /payments shape) with `authorization_id` set, `request_id: null`, `settlement_id: null`, note/visibility copied, amount = captured amount; appears in the feed by the ordinary rule. Final capture → status `captured`, releases remainder in the same step. `final:false` with remainder left → stays `open`; capturing the full remainder closes it even with `final:false`. `captured_amount` cumulative; `payment_id` = latest capture; `payment_ids` all captures in order; `remaining_amount` = still held, 0 when closed. Errors: not open 409 `authorization_not_open`; expired 409 `authorization_expired`; amount > remainder 422 `capture_exceeds_authorization`; amount < 1 / non-integer 422 `validation_failed`; not receiver (incl. third parties) 403; unknown 404. Replay = identical body; `{}` vs `{"amount":2000}` → 409 reuse.
- **R2-11 `POST /authorizations/{id}/void`** payer only, no key; 200 `voided`, hold released (remainder only; captures preserved); already voided → 200; captured or expired → 409 `authorization_not_open`; not payer (incl. third party) 403; unknown 404.
- **R2-12 `GET /authorizations`** only caller's (payer or receiver), newest first; `direction` outgoing/incoming; `status` one of four (clock-expired matches `expired`, never `open`); limit/offset/has_more as `GET /requests`; unknown values 422. Response `{authorizations:[…], has_more}`.
- **R2-13 Payment shape** gains `authorization_id` (null when not from a capture) everywhere payments appear (POST /payments, pay, settlements, activity, replays of new requests).
- **R2-14 Idempotency** applies to the two new paths exactly as §7 (scope, replay 200, reuse 409, failed-key reuse, concurrency exactly-once, claimed-key precedence).
- **R2-15 Concurrency.** "Concurrent requests must produce the same results as executing them one at a time in some order, and the requirements above hold at every read." Accept: concurrent capture/void/payment/authorize mixes never break R2-04 on any read.
- **R2-16 Export/import** carries authorizations, ttl, capture records; stage-2 export re-imports into stage-2 exactly.

### UI (browser, served from the same image; no external assets at run time)
- **R2-17 Routes.** `/` (balance, pay form, request form, feed), `/requests`, `/split`, `/signup`, `/login`, `/authorizations` reachable by URL; other screens via UI; consistent navigation across routes.
- **R2-18 Auth screens & identity.** testids `signup-email`, `signup-password`, `signup-display-name`, `signup-submit`, `login-email`, `login-password`, `login-submit`, `auth-error` (present only when there is an error), `current-user` (every signed-in screen; contains display name), `current-handle` (text exactly the handle, no `@`), `logout-button`. Signed-in state persists across navigation (and across an import that preserves the token).
- **R2-19 Balance & pay `/`.** testids `wallet-balance` (formatted total, `data-amount` minor units), `wallet-available` (headline; `data-amount`), `wallet-held` (`data-amount`; absent when held is 0), `pay-handle`, `pay-amount` (decimal string), `pay-note`, `pay-visibility` (select, option values `public`/`private`), `pay-submit`, `pay-error`, `pay-uncertain`, `request-handle`, `request-amount`, `request-note`, `request-submit`, `request-error`, `wallet-refresh`.
- **R2-20 Formatted amount.** exactly `minor_units` decimals, a single space, currency code: `100.00 EUR`, `1200 JPY`, `1.500 BHD`; no sign; no thousands separators.
- **R2-21 Decimal input.** `15.00`/`15` → 1500, `15.5` → 1550 (minor_units 2); nonnumeric or more than `minor_units` decimals (`15.005`) → the form's error element, **no request sent**. Applies to pay, request, split, authorize, capture-amount inputs.
- **R2-22 Pay form idempotency.** Keep values after success; resubmitting unchanged sends no second payment (same key → replay, or no send): balance falls once, feed has one payment, `pay-error` absent. Changing any field → new key. Refused payment: `pay-error`, refresh balance/feed, preserve inputs. Lost response (network error / no response, including after commit): `pay-uncertain` (non-empty), not `pay-error`; unchanged form retries with the **same key and body**; success removes both, refreshes, money moved once.
- **R2-23 Feed.** `activity-list` children newest first; `activity-item-{payment_id}` with `data-visibility`; `activity-parties-{id}` contains both handles; `activity-amount-{id}` exactly formatted; `activity-note-{id}` exactly the note, present even when empty; `empty-activity` instead of the list when nothing visible. Open authorizations never appear.
- **R2-24 Requests screen.** `incoming-list`, `outgoing-list`; `request-item-{id}` with `data-status`; `request-amount-{id}`; `request-pay-{id}`/`request-decline-{id}` only on pending incoming; `request-cancel-{id}` only on pending outgoing; `request-error` when refused; `empty-requests` when both lists empty. A request cancelled elsewhere: pay refused → `request-error` and list refresh removes the stale button.
- **R2-25 Split screen.** `split-amount`, `split-handles` (comma-separated, in order), `split-note`, `split-submit`, `split-preview` with one `split-share-{handle}` per participant (exactly formatted, computed by §9 before posting, identical to the server's), `split-error`.
- **R2-26 Authorizations screen & form.** On `/`: `authorize-handle`, `authorize-amount`, `authorize-note`, `authorize-visibility`, `authorize-submit`, `authorize-error`. On `/authorizations`: `authorization-list` (newest first), `authorization-item-{id}` with `data-status`, `authorization-amount-{id}`, `authorization-captured-{id}` (only when `captured`), `authorization-expires-{id}` (RFC 3339 `expires_at` text), `authorization-capture-amount-{id}` (pre-filled remaining; only incoming open), `authorization-capture-{id}` (only incoming open), `authorization-void-{id}` (only outgoing open), `authorization-error`, `empty-authorizations`.
- **R2-27 Refresh after own action; latest-refresh-wins.** After any successful action, balance/feed/request lists on the same page show new state without manual reload, only after the write succeeded. `wallet-refresh` refreshes balance+feed without clearing the pay form; a delayed earlier read never overwrites a later refresh (out-of-order responses).
- **R2-28 Product quality.** Coherent calm consumer-finance look; available funds the clearest number; distinct visual states (available, held, pending, loading, success, refused, uncertain); visible labels; visible keyboard focus; sufficient contrast; usable at 375 px and desktop without horizontal scroll; considered empty/loading/error states; people-first formatting of people, amounts, timestamps. All fonts/scripts/styles bundled in the image.

## Edge cases
1. Auth expiring between the read and the capture → 409 `authorization_expired`; no money moves.
2. Capture at exactly `expires_at` → expired (at or before now).
3. Partial non-final captures summing exactly to the amount → closes as `captured`, remaining 0.
4. Void after a partial capture → `voided`, captured_amount preserved, only remainder released.
5. Concurrent captures on the same auth with different keys whose sum exceeds the remainder → at most the remainder captured; others 422/409; never over-capture.
6. Concurrent payment + authorization from the same wallet competing for `available` → never negative available.
7. Seeded open hold with past `expires_at` → expired at reset; does not count toward the 422 hold-sum check.
8. `authorization_ttl_seconds` of `0`, `-1`, `1.5`, `"600"` → reset 422.
9. `final` non-boolean → 400 `malformed_request` (wrong JSON type, §5).
10. Stage-1 export without `authorizations`/ttl imports cleanly with defaults.
11. Pay form: `15.`, `.5`, `1e3`, `-5`, `1,000`, empty → client error, no request (A2-03).
12. JPY (0) and BHD (3) formatting and parsing (`1200 JPY`, `12.345 BHD`).
13. Note with emoji/HTML characters rendered as text (no HTML injection), exact text in `activity-note-*`.

## Ambiguity log
- **A2-01 Capture on an expired auth** (clock- or seeded-`expired`) → 409 `authorization_expired`; on `captured`/`voided` → 409 `authorization_not_open`. Void on expired → 409 `authorization_not_open` (spec states it).
- **A2-02 Capture check order:** auth 401 → body parse 400 → key 400/422 → claimed-key resolution → 404 unknown → 403 not receiver → field validation (400 type, 422 `validation_failed`) → 409 not open / expired → 422 `capture_exceeds_authorization`.
- **A2-03 Decimal input grammar:** after trimming whitespace, `^\d+(\.\d{1,m})?$` where m = minor_units (no decimal point allowed when m = 0); anything else is a client-side error with no request sent. Values that parse but the server refuses (e.g. 0) are shown as the server's refusal.
- **A2-04 Pay form resubmission after success:** reuse the same key and body (server replays 200, no money moves) — never mint a new key unless a field changed. After a confirmed 4xx refusal keep the same key too (a 4xx-failed key is reusable).
- **A2-05 Session storage:** bearer token kept in browser storage so a token preserved by import keeps the browser signed in; unauthenticated page loads redirect to `/login`.
- **A2-06 Export `format_version`** stays `1`; import accepts both the stage-1 and stage-2 state layouts.
- **A2-07 `remaining_amount` for expired/voided/captured** is 0; `payment_ids` is `[]` for no captures.
- **A2-08 HTML for non-API routes** (`/`, `/split`, `/signup`, `/login`) is served regardless of `Accept`; `/requests` and `/authorizations` negotiate on `Accept: text/html`.

## Checks
```sh
cd /home/bajrangi/Wins/dark-factory-wearedevs
.venv/bin/python -m harness run --track pocketful --repo /home/bajrangi/Wins/band-work/result --stage 2 --mode isolated --out /home/bajrangi/Wins/band-work/checks/<new-dir>
```
Expected: suites 1 and 2 all passed (collected > 0, failed 0, errors 0); suite 3 fails (overshoot probe).

## Status
Dispatched 2026-10-05 after stage 1 ACCEPT (29baf05). Start point for the copy: stage-1/ at 29baf05.

## Verification scope (human time constraint, 2026-10-05T17:57 +05:30)
Mutation step is a seeded sample: `node commit/cli.ts mutate ... --max 100 --seed 1`, recorded in evidence as a 100-mutant seeded sample. All other gate steps complete. Hard stop 23:00 IST.

## Resource accounting

| Event | Time (+05:30) |
|---|---|
| Stage 1 ACCEPT received → stage 2 dispatch | 2026-10-05T18:28 |
| Handoff to builder (8 parts, msgs 492d8f1c…6dfb2f34; texts in plan/handoffs/s2-builder/) | 2026-10-05T18:29:31 |

| Builder handoff received: revision ef962af (msg cf28aff0; suites 1 147/147, 2 35/35 claimed) | 2026-10-05T19:07 |
| Handoff to verifier (8 parts, msgs a4d5b2e6…ed3c5dbd; texts in plan/handoffs/s2-verifier/) | 2026-10-05T19:07:33 |

| Verifier verdict ACCEPT (msg f9505878; evidence commit 6010e87) | 2026-10-05T20:33 (received) |

Repair cycles: 0. Outcome: ACCEPTED (see below).

## Outcome — ACCEPTED

- **Accepted revision:** `ef962af95a5b8507cf97395525468c1510c1b51c` — `stage-2/` frozen at this revision. Copy-forward commit 04df3cd; stage-1/ identical to 29baf05.
- **Verdict:** ACCEPT. Official isolated: suite 1 147/147, suite 2 35/35 (0 failed, 0 errors); suite 3 overshoot 6 collected / 2 passed / 1 failed (required). Contract 49/49; auth contract 14/14; upgrade (real stage-1 export → stage-2 import) 10/10; UI Playwright 16/16; reference model holds 3 seeds × 1,000 ops + stage-1 2 seeds × 1,000 ops all agree; adversarial-holds 25/25; adversarial 50/50. Mutation: **100-mutant seeded sample** (`--max 100 --seed 1`, per owner constraint) 79/99 valid = 79.8 % (20 survivors in unspecified/wording-only behaviour, dispositions in evidence README).
- **Evidence:** `evidence/stage-2/README.md`, `evidence/stage-2/run-20261005T143900Z-5eacd7/` (manifest sha256 577d2c68…fed1), `evidence/stage-2/screenshots`, verification code `verification/stage-2/`.
- **Known limitations:** mutation was a sample; hidden suite and product-quality judging not run; browser upgrade case uses stage-2 export/import between browser requests (stage 1 has no UI), API upgrade uses a real stage-1 service; seeded equal passwords share one salted hash.
- **Repair cycles:** 0. **Stage wall time:** 18:28 → 20:33 (2 h 05 m: build 38 m, verification 86 m).
