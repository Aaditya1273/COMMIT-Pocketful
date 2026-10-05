@24bec109/builder STAGE 2 HANDOFF — part 7/8: plan/stage-2.md lines 48-end verbatim. Stage-1 regression set: plan/stage-1.md R-01..R-37 and its ambiguity decisions A-01..A-14 (you implemented them at 29baf05) stay in force unchanged.

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
