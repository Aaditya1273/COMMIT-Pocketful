@24bec109/verifier STAGE 1 VERIFICATION HANDOFF — part 5/6: plan/stage-1.md lines 81-end verbatim

## Edge cases the builder must handle (not spelled out by the spec)

1. Body that parses but is not an object (`[]`, `"x"`, `3`, `null`) → 400 `malformed_request`. Empty body on `/requests/{id}/pay` = `{}`.
2. Amounts: `1e3`, `1000.0` valid; `1e9` valid (=1000000000); `1.0000000001e9` 422; `-0` → 0 → 422; very large (`1e400`) → 422, never 5xx.
3. Note exactly 200 code points (incl. emoji, which count as 1) is valid; 201 → 422. `note: ""` valid. `note: null` 422.
4. `limit=200` ok, `limit=201`/`0`/`-1`/`abc`/`1e2`/`+4`/`4.0`/empty string → 422; `offset=0` ok.
5. Insufficient funds exactly at the boundary: balance == amount succeeds and leaves 0.
6. Concurrent payments from one wallet whose sum exceeds its balance: the successes never exceed the balance; no negative balance; sum invariant holds; no 5xx.
7. Concurrent pay of the same request with different keys: exactly one 201, the other(s) 409 `request_not_pending`; money moves once. Concurrent decline vs pay: one wins, state consistent.
8. Concurrent identical `POST` with the same unused key (50 in flight): exactly one 201, rest 200 identical body.
9. Idempotency replay after the resource changed (request cancelled after creation, request paid) → still 200 original body.
10. Same key reused for `POST /payments` then `POST /requests` (different path) → both 201.
11. Key whose original request failed with 422/404/409 → next use with any body is a first use.
12. Split with duplicated handles (`["bob","bob"]`) → 422; with caller absent → n = number of listed handles (see A-03); caller-only split → `requests: []`.
13. Settlement with 0 or 33 transfers → 422; `transfers` not an array / entry not an object → 422; chain `ada→bob 100, bob→cy 150` where bob starts at 50: net bob = 0 → affordable; error in entry 2 and entry 1 → entry 1's error wins.
14. Settlement where the operator is neither sender nor receiver is valid; the operator cannot see private members in their own feed.
15. Third party (neither requester nor payer) acting on a request → 403 (A-02); `GET /requests` never lists it.
16. Generated IDs must never collide with fixture IDs (`p_1`, `rq_1`, `u_ada` style) or imported IDs.
17. Reset with a fixture referencing unknown user ids, duplicate handles/emails/ids, invalid handle format, non-integer balance, or `minor_units` not in {0,2,3} → 422, state unchanged.
18. Signup email with uppercase/punctuation: `Ada.Lovelace+x@ex.com` → handle `ada_lovelace_x`; 25-char local part → truncated to 20.
19. Export taken, then writes, then import of the earlier export → the earlier state exactly (including tokens of that time).
20. Tokens issued before an import or reset → 401 afterwards unless present in the imported state.

## Ambiguity log (decision recorded; conservative choice)

- **A-01 Check order for idempotent writes.** Options: key-check before body parse, or after. Spec §7 says replay resolution happens "after the body has parsed as a JSON object and the caller is authenticated". Chosen order: 401 auth → 400 `malformed_request` (unparseable / non-object body) → 400 `missing_idempotency_key` → 422 key length → claimed-key resolution (200 replay / 409 reuse / wait if in flight) → 403 permission (operator / payer) → field validation (400 wrong type, then 422) → resource existence 404 → semantic 422 (`self_payment`, `self_request`) → 409 state (`request_not_pending`, `insufficient_funds`). For `/requests/{id}/pay`, an unknown request id is 404 and non-payer 403 after key resolution.
- **A-02 Third party on a request** (neither payer nor requester). §5 says 404 for "not visible", the endpoint tables say "not the payer → 403". Chosen: **403 `forbidden`** for any authenticated non-authorised caller of an existing request (endpoint table is more specific). Unknown id → 404.
- **A-03 Split with the caller omitted.** "The caller may be included in `participant_handles` or omitted" and "shares covers every participant including the caller, in the order given". Options: (a) participants = exactly the listed handles; (b) caller implicitly added. Chosen (a): shares are computed over the listed handles only, in the given order; if the caller is listed it gets a share and no request; if omitted, every listed handle gets a request. Reason: only (a) has a defined "order given" for every share.
- **A-04 Email comparison.** Chosen: case-insensitive for uniqueness (`email_taken`) and login; stored as given. Check `email_taken` before `handle_taken`.
- **A-05 Email format.** `local@domain`: exactly one `@`, non-empty local and domain, no whitespace. Otherwise 422.
- **A-06 `display_name` on signup.** Treated as a required string (missing 422, wrong type 400); empty string accepted.
- **A-07 Wrong JSON type inside settlement `transfers`.** "malformed batch shape is 422" → any shape/type error inside the batch (non-array, non-object entry, non-string handle) is 422 `validation_failed`, not 400. Within one entry: field validation (422) → unknown handle (404) → self (422 `self_payment`); first failing entry in input order decides.
- **A-08 Unknown handle with invalid format** (e.g. `"ADA!"`) → 404 `not_found` (endpoint rule "No user has that handle"), not 422.
- **A-09 Timestamps & ordering.** Emit UTC with `+00:00`, second or millisecond precision. Order "newest first" by created_at, ties broken by insertion order (later inserted first). Seeded payments/requests get timestamps at reset preserving fixture order (later in list = newer); if a fixture item carries `created_at`, honour it.
- **A-10 Fixture extras.** Accept optional `created_at`, `request_id`, `settlement_id` on seeded payments and `payment_id` on seeded requests; validate references; reject structurally invalid fixtures with 422 and no change.
- **A-11 Unknown routes / wrong method** → 404 `not_found` with the error envelope.
- **A-12 Decline/cancel body.** Ignored; an empty body is fine.
- **A-13 Concurrent same-key requests while the first is in flight** → wait for its outcome: if it succeeded, 200 replay (or 409 if body differs); if it failed 4xx, process as a first use.
- **A-14 Idempotency body equality** uses parsed JSON-value equality; numbers compare by numeric value.

## Build order and dependencies

1. R-01..R-06 skeleton (server, health, error envelope, JSON parsing) →
2. R-04 reset + model (users, wallets) + R-13..R-16 auth →
3. R-07..R-12 validation helpers →
4. R-17..R-21 idempotency layer (generic, wraps the five write paths) →
5. R-22..R-31 endpoints →
6. R-34..R-37 settlements →
7. R-32..R-33 export/import (must capture every structure above, including idempotency records and ID counters) →
8. Concurrency hardening (R-12, R-20) and isolated-mode container run.

## Checks to run

Official (the only interpreter to use):

```sh
cd /home/bajrangi/Wins/dark-factory-wearedevs
.venv/bin/python -m harness run --track pocketful --repo /home/bajrangi/Wins/band-work/result --stage 1 --mode isolated --out /home/bajrangi/Wins/band-work/checks/<new-unique-dir>
```

Judge from `report.json` per-suite collected/passed/failed/errors, never from the exit code.
For stage 1 the expected shape is: suite 1 all passed (collected > 0, failed 0, errors 0);
suite 2 fails (overshoot probe — a stage-1 folder must not pass it). The shipped checks are
~79 % of suite 1; the spec above is the contract.

## Regression set carried to later stages

All of R-01..R-37 stay in force for stages 2–4.

## Resource accounting

| Event | Time (Asia/Kolkata, +05:30) |
|---|---|
| Dispatch received | 2026-10-05T13:08 |
| Plan committed / handoff to builder | (recorded below) |

Repair cycles: 0 so far. Outcome: in progress.
