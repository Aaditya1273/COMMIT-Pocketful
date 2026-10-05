# Stage 4 plan — Pocketful: refunds and batch corrections

Author: Planner. Source: `/home/bajrangi/Wins/dark-factory-wearedevs/pocketful/spec/stage-4.md` ("S4"),
plus every stage-1..3 requirement (R-01..R-37, R2-01..R2-28, R3-01..R3-15), which stay in force.

- Build folder: `/home/bajrangi/Wins/band-work/result/stage-4/` — a copy of the **accepted** `stage-3/`
  revision (no nested `.git`), committed alone, then extended. `stage-3/` is frozen.
- Regression set: suites 1, 2, 3 must still pass fully; UI keeps working.
- Ten idempotent write paths: stage 1's five, authorizations, captures, corrections, refunds, correction batches.

## Requirements

- **R4-01 `POST /payments/{id}/refunds`** body `{"amount": N}`, idempotency key required. Only the original receiver (else 403); unknown 404. Target may be a direct payment, request payment, capture or settlement member — never a refund (422 `invalid_refund_target`). Invalid amount 422 `validation_failed`. Cumulative refunds ≤ the payment's current corrected amount, else 422 `refund_exceeds_payment`.
- **R4-02 Refund payment.** A new payment in the opposite direction (from the original receiver to the original sender) with `refund_of` = target id, `request_id: null`, `authorization_id: null`, `settlement_id: null`, original note and visibility. 201 with that payment; replay 200 original body. Debits the receiver's **available** funds atomically or 409 `insufficient_funds`. Never reopens a request or authorization, never restores a released hold, never changes settlement membership. All other payments carry `refund_of: null` (every payment shape, everywhere, including replays of new requests and statements). Refunds are ordinary money movements: they appear in the feed by visibility and in statements.
- **R4-03 Corrections with refunds.** Stage-3 corrections remain for ordinary direct/request payments. Captures and refund payments → 422 `linked_payment_immutable`. A correction may not reduce a payment below its already-refunded amount → 422 `refund_exceeds_payment`. Correction debits checked against available funds. Single-payment corrections of settlement members remain 422 `linked_payment_immutable`.
- **R4-04 `POST /correction-batches`** operator + key; 401 without token, 403 non-operator (same rules as settlements). Body `{"corrections":[{payment_id, expected_revision, amount, effective_at, reason}, …]}`, 1..32 items, distinct payment_ids, else 422. Each item: ordinary correction validation (422); unknown payment 404; stale expected revision 409 `stale_revision`; captures/refunds 422 `linked_payment_immutable`; reducing below refunded 422 `refund_exceeds_payment`. Operator may correct ordinary, request and settlement payments of any users. Unknown fields ignored.
- **R4-05 Settlement completeness.** Correcting any settlement member requires every member of that settlement in the batch, else 422 `incomplete_settlement`. Members of one settlement must have identical effective instants (compare instants; offset spellings may differ), else 422 `validation_failed`.
- **R4-06 Precedence.** Item errors in input order → settlement completeness (and identical instants) → resulting current available funds (409 `insufficient_funds`) → historical total and available at every effective/event boundary (409 `historical_overdraft`). Affordability uses the combined effect of all proposed revisions. A rejected batch changes nothing (history, balances, idempotency).
- **R4-07 Batch response.** 201 `{correction_batch_id, recorded_at, revisions:[…in input order]}`; all new revisions share `recorded_at`, strictly later than every member's previous `recorded_at`; each revision exposes `correction_batch_id`. Effective times ≤ now. Originals and receipts never change; original payment and settlement retries return original bodies; new statements reflect new revisions; earlier snapshots keep their frozen entries; replay 200 original batch response.
- **R4-08 Concurrency.** Concurrent corrections (single or batch) sharing any expected payment revision cannot both succeed; serializable.
- **R4-09 Upgrade.** Accept exports from the accepted stage-1, stage-2 and stage-3 services, retaining settlement membership, corrections and snapshots.

## Edge cases
1. Refund exactly the remaining refundable amount succeeds; one more unit → 422 `refund_exceeds_payment`.
2. Refund after a correction reduced the payment: limit is the corrected amount; after a correction to 0, any refund → 422.
3. Refund when the receiver's money is held → 409 `insufficient_funds`.
4. Refund of a capture is allowed; correction of that capture or of the refund is 422 `linked_payment_immutable`.
5. Batch with a settlement member but not all members → 422 `incomplete_settlement`; with all members but differing effective instants → 422 `validation_failed`; same instant in `Z` and `+00:00` spellings → valid.
6. Batch item 1 stale and item 2 unknown → 409 `stale_revision` (input order).
7. Batch with 33 items, 0 items, duplicate payment_id, non-array → 422.
8. Batch whose combined effect is affordable even though one item alone is not → succeeds.
9. Snapshot taken before a batch still pages the old entries afterwards.

## Ambiguity log
- **A4-01 Refund `amount`** is required (integer 1..1000000000); missing → 422.
- **A4-02 Refund check order:** 401 → body 400 → key → claimed-key resolution → 404 → 403 → 422 amount → 422 `invalid_refund_target` → 422 `refund_exceeds_payment` → 409 `insufficient_funds`.
- **A4-03 Batch item check order** (per item, items in input order): field validation 422 → 404 → 422 `linked_payment_immutable` → 409 `stale_revision` → 422 `refund_exceeds_payment`. Then completeness 422 `incomplete_settlement`, then identical-instant 422 `validation_failed`, then 409 `insufficient_funds`, then 409 `historical_overdraft`.
- **A4-04 `correction_batch_id`** appears on every revision object (null for revision 1 and single-payment corrections).
- **A4-05 Batch `transfers` shape errors** (non-array, non-object item, wrong field types) → 422 `validation_failed`, matching the settlement batch rule.

## Checks
```sh
cd /home/bajrangi/Wins/dark-factory-wearedevs
env -u PYTHONHOME -u PYTHONPATH .venv/bin/python -m harness run --track pocketful --repo /home/bajrangi/Wins/band-work/result --stage 4 --mode isolated --out /home/bajrangi/Wins/band-work/checks/<new-dir>
```
Expected: suites 1–4 fully passed (no overshoot suite above 4). Mutation: 100-mutant seeded sample.

## Status
DRAFT — dispatched only after stage 3 is ACCEPTED and only if time before the 23:00 IST stop allows.
