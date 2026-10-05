@24bec109/verifier STAGE 3 VERIFICATION HANDOFF — part 7/9: complete plan/stage-3.md (commit 74a9c78) verbatim

# Stage 3 plan — Pocketful: statements and payment corrections

Author: Planner. Source: `/home/bajrangi/Wins/dark-factory-wearedevs/pocketful/spec/stage-3.md` ("S3"),
plus every stage-1 and stage-2 requirement (R-01..R-37, R2-01..R2-28), which stay in force.

- Build folder: `/home/bajrangi/Wins/band-work/result/stage-3/` — a copy of the **accepted** `stage-2/`
  revision (no nested `.git`), committed alone, then extended. `stage-2/` is frozen.
- `stage-3/` must solve stage 3 only: no refunds, no batch corrections (stage 4).
- Regression set: suites 1 and 2 must still pass fully; the UI keeps working.

## Requirements

- **R3-01 Payment timestamps.** "Every payment's `created_at` is an RFC 3339 instant with an offset identifying when it moved money." Seeded payments may supply `created_at`; omission = reset time, ordered before later API payments. "A seeded `created_at` in the future gives `422 validation_failed` … with no state change." Loading seeded payments never changes the seeded `balance`.
- **R3-02 Opening balances.** "Opening balances equal seeded ending balances minus the net effect of original seeded payments. Corrections must not change those opening balances. New accounts open at zero."
- **R3-03 `GET /me?as_of=`** RFC 3339 instant with offset; anything else (naive, bare date, empty) 422. Balance = after every payment with effective time ≤ `as_of` (inclusive). `as_of` ≥ latest → current; before earliest → opening balance. Echo `as_of` exactly as given. Without temporal params the response is unchanged and reports current corrected values.
- **R3-04 `GET /statement?from&to&limit&offset`** half-open `[from, to)`, `from` default wallet opening, `to` default now; caller's sent/received payments only (feed visibility irrelevant); oldest first by effective time then payment id ascending; `{opening_balance, entries:[{payment, delta, balance_after, revision, effective_at, recorded_at}], closing_balance, has_more, snapshot}`; opening = balance immediately before `from`, closing = immediately before `to`; opening + all deltas in the full window = closing; sent negative, received positive; pagination never changes `balance_after`, opening or closing. limit/offset as `GET /requests`.
- **R3-05 Revisions.** Revision 1 = original amount, `effective_at = recorded_at = created_at` (settlement members: shared `committed_at`). `GET /payments/{id}/revisions` → `{"revisions":[…]}` in order incl. revision 1 (`reason: ""`); only the two parties; third party 404 even for public; no token 401; unknown 404.
- **R3-06 `POST /payments/{id}/corrections`** idempotency key required; original sender only (non-sender 403; unknown 404). Body `{expected_revision, amount, effective_at, reason}` all required: revision positive integer; amount integer 0..1000000000 (0 reverses the whole payment); reason string 1..200 chars; effective_at RFC 3339 with offset, not later than now; invalid → 422. 201 `{payment_id, revision, amount, effective_at, recorded_at, reason}`. Parties and visibility unchanged. Stale expected revision 409 `stale_revision`. Replay → 200 original revision even after newer revisions; different body 409 `idempotency_key_reuse`. Recorded times per payment strictly increase.
- **R3-07 Money movement of a correction.** The difference from the previous amount moves between the same two wallets atomically: increase debits the sender, decrease debits the receiver. Currently unaffordable debit (vs `available`) → 409 `insufficient_funds` (takes precedence). Otherwise, if any user's corrected `total` or `available` is negative at any effective/event-time boundary under the latest revisions (movements at the same instant combined) → 409 `historical_overdraft`. Either failure changes nothing (balances, revisions, statements, idempotency). Sum of balances equals the seeded total in every historical view.
- **R3-08 Originals preserved.** Original payment and every original idempotent response unchanged; `GET /activity` shows the original payment; corrections are not feed payments.
- **R3-09 `known_at`** on `GET /me` and `GET /statement`: per payment select the latest revision recorded at or before `known_at` (none → contributes nothing); omission = everything known when the read begins; then apply by effective time. Both instants may be in the future. Invalid/empty → 422. Echo `known_at` exactly. Statement ordering by selected `effective_at`, then payment id; `payment.amount` in an entry is the selected amount; zero-amount revisions appear with delta 0; never count a correction alongside the revision it replaces. No corrections + no `known_at` → previous behaviour unchanged.
- **R3-10 Snapshots.** Every first `GET /statement` returns an opaque `snapshot`; `?snapshot=<t>&limit&offset` pages exactly that frozen result (selected revisions, window, balances, entries, default `to`) even after later payments/corrections/lifecycle events. With a snapshot, `from`/`to`/`known_at` → 422. Unknown, other user's, or pre-reset token → 404. Tokens last until reset. `has_more` correct on the final partial page and beyond the end.
- **R3-11 Concurrency.** Concurrent corrections with the same expected revision cannot both succeed; snapshots unchanged under concurrent writes; serializable as stage 2.
- **R3-12 Linked payments immutable.** Correction of a settlement member or a capture payment → 422 `linked_payment_immutable`.
- **R3-13 Upgrade.** Accept exports from the accepted stage-1 and stage-2 services: build revision 1 for every payment, account for authorizations and captures.
- **R3-14 Historical holds.** `GET /me?as_of=T&known_at=K` → `balance = total`, `held`, `available = total − held` all for that view. A hold starts at authorization creation; non-final capture reduces it at capture time; final capture, void or expiry release the remainder at that event's time; expiry takes effect at `expires_at`. Lifecycle events are known at their server event time; once creation is known its expiry deadline is known; for queries beyond now an open hold expires at its deadline; without `as_of` use the instant the request began. Authorizations expose `closed_at` (null while open; event time when closed — for clock expiry, `expires_at`). Seeded open holds created at reset unless `created_at` supplied; seeded closed holds need not reconstruct history.
- **R3-15 Statement content.** Money movements only (authorization, release, expiry are not entries); captures appear exactly once with their links.

## Edge cases
1. Payment at exactly `as_of` counts; payment at exactly `to` is excluded from the statement; at exactly `from` included.
2. Correction backdated before the payment's original time moves it into an earlier statement window; forward-dated is impossible (effective_at ≤ now).
3. Correction to 0 → entry with delta 0 remains in statements; revision list grows.
4. Two corrections in the same millisecond → recorded_at still strictly increasing (bump).
5. Correction that is affordable now but makes the receiver negative at a past boundary (receiver spent the money in between) → 409 `historical_overdraft`.
6. Decrease when the receiver's current `available` is short (money held) → 409 `insufficient_funds`.
7. `as_of`/`known_at` with `Z`, `+05:30`, fractional seconds; `2026-02-30T…`, `2026-09-24`, `2026-09-24T10:00:00` (no offset), empty → 422.
8. `known_at` before a payment's creation → payment absent from `/me` and statement under that view.
9. Snapshot + `from` → 422; snapshot of another user → 404; snapshot after reset → 404; offset beyond end → empty entries, `has_more: false`.
10. Statement `from` > `to` → 422 (A3-04).
11. Settlement member correction → 422 `linked_payment_immutable` even with a valid body.
12. Payment created by paying a request is correctable (not linked-immutable) (A3-03).

## Ambiguity log
- **A3-01 Query decoding.** Percent-decode query values without turning `+` into a space, so a raw `+05:30` stays an offset; echo the decoded string exactly.
- **A3-02 Correction check order:** 401 → body parse 400 → key 400/422 → claimed-key resolution → 404 unknown payment → 403 non-sender → field validation 422 → 422 `linked_payment_immutable` → 409 `stale_revision` → 409 `insufficient_funds` → 409 `historical_overdraft`.
- **A3-03 Linked-immutable set** = settlement members and capture payments only; request-paid payments are ordinary payments and correctable.
- **A3-04 `from` > `to`** → 422 `validation_failed`; `from == to` → empty window, opening == closing.
- **A3-05 Activity feed after a correction** shows the original payment object (revision-1 amount); current `/me` reflects the corrected amount.
- **A3-06 Selected effective time** of a payment = its selected revision's `effective_at`; balances, statement windows and order use it.
- **A3-07 Timestamp precision** milliseconds in responses (`2026-09-24T11:04:03.123+00:00` is valid RFC 3339); ordering and boundaries use full precision.
- **A3-08 Snapshots and import.** Snapshots are included in export state and survive import; reset invalidates them.
- **A3-09 Payment `id` tie-break** is plain string (code-point) comparison of `payment_id`.

## Checks
```sh
cd /home/bajrangi/Wins/dark-factory-wearedevs
env -u PYTHONHOME -u PYTHONPATH .venv/bin/python -m harness run --track pocketful --repo /home/bajrangi/Wins/band-work/result --stage 3 --mode isolated --out /home/bajrangi/Wins/band-work/checks/<new-dir>
```
Expected: suites 1, 2, 3 fully passed; suite 4 fails (overshoot probe). Mutation step: 100-mutant seeded sample (`--max 100 --seed 1`).

## Status
Dispatched 2026-10-05T20:34 after stage 2 ACCEPT (ef962af). Start point for the copy: stage-2/ at ef962af.
