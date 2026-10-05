# Stage 1 plan — Pocketful: payments and settlements (JSON API)

Author: Planner. Source of truth: `/home/bajrangi/Wins/dark-factory-wearedevs/pocketful/spec/stage-1.md`
(quoted below as "§n"). Delivery rules: `/home/bajrangi/Wins/dark-factory-wearedevs/docs/participant-guide.md`.

- Result repository: `/home/bajrangi/Wins/band-work/result`
- Build folder: `/home/bajrangi/Wins/band-work/result/stage-1/` (Dockerfile, RUN.md, source; builder's own tests may live inside it)
- Verification code / evidence: `verification/` and `evidence/` at the repo root — never inside `stage-1/`
- Regression set from earlier stages: none (this is the first stage)
- A `stage-1/` folder must solve stage 1 only. Do not implement stage-2 features (UI, authorizations/holds) here.

## Recommended shape (builder may deviate with reason)

Single process, in-memory state, all state mutations (and multi-read snapshots) serialized
through one lock / one event-loop critical section, so atomicity, no-negative-balance and
exactly-once idempotency follow structurally rather than from per-row locking. Node.js ≥ 22
with zero runtime npm dependencies (`node:http`, `node:crypto` scrypt) fits well and carries
forward to a stage-2 UI served from the same image; any stack is allowed. Password hashing
must be a real KDF (scrypt/bcrypt/argon2) but tuned so that a reset of ~200 seeded users
finishes well inside 10 s and 50 concurrent logins stay inside 5 s on 2 vCPU (hash
asynchronously / off the lock).

## Requirements

Each: source → acceptance condition → evidence.

### Runtime and delivery
- **R-01 Container delivery.** §2 "Deliver an HTTP service, a `Dockerfile` and a `RUN.md` with a command that builds and starts the service without manual setup." "The image must run on its own with `-e PORT=<port>` and a port mapping. Runtime networking has no outbound access."
  Accept: `docker build stage-1/` succeeds from that folder alone; `docker run --network none -e PORT=9000` (or the harness isolated mode, internal network, 2 vCPU / 2 GiB) serves. RUN.md contains the exact build+run commands. Evidence: build log, isolated-mode harness report.
- **R-02 Listening.** §3.1 "Listen on `0.0.0.0` using the `PORT` environment variable, default `8080`." Accept: no PORT → 8080; PORT=9000 → 9000.
- **R-03 Health.** §3.2 `GET /health -> 200 {"status":"ok"}` within 60 s of start. Accept: first 200 under 60 s (target < 5 s).
- **R-04 Reset.** §3.3 "Replace all service state with the fixture … When reset returns 204, subsequent requests must see only that fixture. Repeated resets are supported." Unauthenticated. §4 fixture format; "A `balance` below zero in a fixture is a reset error: return `422 validation_failed` … and change nothing." `minor_units` ∈ {0,2,3}. `settlement_operator_ids` optional, default `[]` (§11). Seeded users log in immediately with their password; `balance` is post-payment (do not replay seeded payments). Reset invalidates all previous tokens, idempotency records, users, payments, requests, settlements.
  Accept: after reset, `/me` for each seeded user equals the fixture balance; old tokens → 401; a fixture with a negative balance → 422 and the prior state still serves unchanged.
- **R-05 Conventions.** §3.4: JSON `application/json; charset=utf-8`; timestamps RFC 3339 with explicit offset; unknown body fields and unknown query params ignored; IDs opaque strings ≤ 64 chars.
  Accept: every response has that content type (204 has no body); every timestamp matches `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?([+-]\d\d:\d\d|Z)$` (use `+00:00`); every ID ≤ 64 chars.
- **R-06 Error envelope.** §5 "Every 4xx and 5xx response carries this body: `{ "error": { "code": …, "message": … } }`." Accept: every non-2xx (including unknown routes → 404 `not_found`) has that shape. No 5xx ever, including under 50 concurrent requests.

### Model and validation
- **R-07 Amounts.** §4 "API amounts must have an integral numeric value: JSON `1000`, `1000.0` and `1e3` all represent the same valid minor-unit amount. Booleans and strings are not numbers here." §5 "invalid `amount` values (including strings and booleans) … are 422 `validation_failed`." Range 1..1000000000 for payments/requests/splits/settlement transfers. Accept: `1e3`, `1000.0` accepted as 1000; `1000.5`, `"1000"`, `true`, `null`, `0`, `-1`, `1000000001`, missing → 422.
- **R-08 Optional fields.** §5 "non-string `note` values (including `null`), and any `visibility` other than `public` or `private` are 422 `validation_failed`. Omission alone selects the optional-field defaults." Note default `""`, max 200 characters (Unicode code points); visibility default `"public"`. Notes stored verbatim (§8: "no trimming, no escaping, no normalisation. Unicode and emoji survive a round trip byte for byte").
- **R-09 Wrong-type vs invalid.** §5 400 `malformed_request` for "Unparseable body, or a field of the wrong JSON type" (fields other than amount/note/visibility); body that is valid JSON but not an object → 400. Correct type, invalid value → 422.
- **R-10 Query parameters.** §5 "An integer-valued query parameter is written as plain decimal digits: `1e9`, `4.0` and `+4` are 422". `limit` 1..200 default 50; `offset` ≥ 0 default 0; outside → 422.
- **R-11 Handles.** §4 handle unique, `^[a-z0-9_]{1,20}$`, immutable. Signup derives it: "take the local part, lowercase it, replace every character outside `[a-z0-9_]` with `_`, and truncate to 20 characters."
- **R-12 Arithmetic.** §4 exact integers; no balance outside ±2⁵³; sum of balances always equals the seeded total (§1.1); no balance ever negative, even transiently (§1.2).

### Authentication
- **R-13 Signup.** §6 `POST /auth/signup {email,password,display_name}` → 201 `{user_id, display_name, token}`; new user balance 0, can receive and be asked immediately. Errors: email taken 409 `email_taken`; password < 8 chars 422; email not `local@domain` 422; derived handle taken 409 `handle_taken` and no account created.
- **R-14 Login.** §6 `POST /auth/login` → 200 `{user_id, display_name, token}`; wrong password or unknown email 401 `unauthenticated`. Multiple tokens per account valid concurrently; tokens never expire.
- **R-15 Bearer auth.** §6 every other endpoint requires `Authorization: Bearer <token>` except `/health`, `/_test/*`, signup, login. Missing/malformed/unknown → 401 `unauthenticated`.
- **R-16 Password storage.** §6 bcrypt/scrypt/Argon2 or equivalent; no plaintext anywhere in state (including export).

### Idempotency (§7) — applies independently to POST /payments, /requests, /requests/{id}/pay, /splits, /settlements
- **R-17 Header.** Absent or empty → 400 `missing_idempotency_key`; length > 255 → 422 `validation_failed`.
- **R-18 Scope.** Keyed by authenticated user. Different users, same key → independent. "The same key with the same body on a different path is a different request, not a replay, and must succeed normally." → scope = (user, method, path, key).
- **R-19 Replay.** Same key + same body (JSON-value equality: key order/whitespace irrelevant; `1e3` vs `1000` numerically equal is the same value) → 200 with body identical to the original 201 body, no state change, "even after the resource changes or is cancelled". Different body → 409 `idempotency_key_reuse`. Original failed with 4xx → key unclaimed, treated as first use.
- **R-20 Concurrency.** "For concurrent identical requests with an unused key, exactly one returns 201. The others return 200 with the same body. The operation takes effect only once."
- **R-21 Precedence.** "After the body has parsed as a JSON object and the caller is authenticated, an already claimed key is resolved before endpoint field validation or current-resource checks." Changing a successful request to an invalid body with the same key → 409.

### API (§8)
- **R-22 `GET /me`** → `{user_id, display_name, handle, balance, currency, minor_units}`.
- **R-23 `POST /payments`** body `{to_handle, amount, note?, visibility?}` → 201 payment `{payment_id, from_user_id, from_handle, to_user_id, to_handle, amount, currency, note, visibility, request_id: null, settlement_id: null, created_at}`. Errors: balance < amount 409 `insufficient_funds`; amount invalid 422; own handle 422 `self_payment`; note > 200 422; bad visibility 422; unknown handle 404. Debit+credit atomic; failure leaves no trace.
- **R-24 `POST /requests`** body `{payer_handle, amount, note?}`; caller is requester → 201 request `{request_id, requester_id, requester_handle, payer_id, payer_handle, amount, currency, note, status:"pending", payment_id:null, created_at}`. Errors: amount 422; own handle 422 `self_request`; note 422; unknown 404. Payer balance NOT checked.
- **R-25 `POST /requests/{id}/pay`** body `{visibility?}` only; payer only. 201 with a payment (as R-23) with `request_id` set; request → `paid` with `payment_id`. Errors: not pending 409 `request_not_pending`; payer balance < amount 409 `insufficient_funds` (request stays pending, payable later); not payer 403 `forbidden`; unknown 404. Replay of a successful pay → 200 original body, even though now `paid`; never 409. `{}` vs `{"visibility":"public"}` are different bodies → 409 reuse.
- **R-26 `POST /requests/{id}/decline`** payer only, no key. 200 request `declined`; already declined → 200 current state; paid/cancelled → 409 `request_not_pending`; not payer 403; unknown 404.
- **R-27 `POST /requests/{id}/cancel`** requester only, no key. 200 `cancelled`; already cancelled → 200; paid/declined → 409; not requester 403; unknown 404.
- **R-28 `GET /requests`** only caller's requests (requester or payer), newest first by `created_at`; `direction` ∈ {incoming, outgoing} or absent; `status` ∈ {pending, paid, declined, cancelled} or absent; unknown value 422; `limit`/`offset` per R-10; `{requests:[…], has_more}` where `has_more` true iff items exist beyond the last returned.
- **R-29 `POST /splits`** body `{amount, participant_handles, note?}` → 201 `{split_id, amount, currency, note, shares:[{handle,amount}], requests:[…], created_at}`. Shares per §9 in handle order; one pending request per participant except the caller, same order, caller is requester. Errors: amount 422; empty or duplicate handles 422; note 422; any unknown handle 404. Only-caller split valid → one share, `requests: []`. No balance checks.
- **R-30 Equal-split rule.** §9 "Shares must be whole minor units, sum exactly to `amount` and differ by at most one minor unit. When the amount does not divide evenly, the larger shares go to the first participants." Table: 1000/3 → 334,333,333; 1/3 → 1,0,0; 10/3 → 4,3,3; 999/3 → 333×3; 5/5 → 1×5. Zero share still produces a request (amount 0; paying it moves 0 and creates a 0-amount payment).
- **R-31 `GET /activity`** payments only; visible iff `visibility == public` or caller is sender or receiver (§4 feed contract); newest first; `{payments:[…], has_more}`; limit/offset as R-28.

### Export / import (§10)
- **R-32 Export.** `GET /_test/export` unauthenticated → 200 `{track:"pocketful", format_version:1, state:{…}}`; atomic read-only snapshot; later writes do not change an already-returned export.
- **R-33 Import.** `POST /_test/import` with that whole object → 204; atomic replacement (not merge); idempotent when repeated; preserves accounts, hashed-password login, existing bearer tokens, currency, balances, payments, requests, splits, settlements, operator permissions, all completed idempotency records with original responses (replay after import → 200 same body; different body → 409); failed keys stay reusable; IDs and timestamps unchanged; nothing replayed against balances; ID generation after import never collides with imported IDs. Removes all previous destination data and tokens. Invalid JSON → 400; missing fields, wrong `track`/`format_version`, invalid `state` → 422 and destination unchanged. Reset afterwards clears imported state.

### Settlements (§11)
- **R-34 Operators.** Fixture `settlement_operator_ids` (default `[]`). Operator permission does not grant access to others' requests or private activity.
- **R-35 `POST /settlements`** operator + key required. No token 401; non-operator 403 `forbidden`. Body `{transfers:[{from_handle,to_handle,amount,note?,visibility?}]}`, 1..32 entries. Malformed batch shape 422; per entry ordinary amount/note/visibility rules (422); unknown handle 404; self-transfer 422 `self_payment`; "Entry errors take precedence in input order, before insufficient funds."
- **R-36 Net affordability.** "A settlement is affordable when every wallet's balance after all incoming and outgoing transfers is nonnegative." Otherwise 409 `insufficient_funds`. All-or-nothing. Failed validation claims no key, creates nothing.
- **R-37 Response.** 201 `{settlement_id, committed_at, payments:[…in input order]}`; each member an ordinary payment with `settlement_id` set, `request_id: null`, `created_at == committed_at`. Members appear in feeds per the ordinary rule. Replay → 200 original complete response.

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
