# Pocketful — stage 4

The stage-1 JSON API, stage-2 payment authorizations and browser UI, plus a revisioned
ledger: historical balances (`GET /me?as_of=&known_at=`), statements with stable snapshots
(`GET /statement`), payment corrections (`POST /payments/{id}/corrections`) and revision
history (`GET /payments/{id}/revisions`), refunds (`POST /payments/{id}/refunds`) and operator
correction batches (`POST /correction-batches`). Node.js 22, no runtime dependencies. The UI (script, styles, icon) is served from
the same image; nothing is fetched at run time. State is in memory and ephemeral.

## Build and run

From this folder (`stage-4/`):

```sh
docker build -t pocketful-stage-4 . && docker run --rm -e PORT=8080 -p 8080:8080 pocketful-stage-4
```

- Listens on `0.0.0.0:$PORT` (default `8080`); `GET /health` → `200 {"status":"ok"}`.
- Works with no network at run time: `docker run --rm --network none -e PORT=9000 pocketful-stage-4`.
- Seed with `POST /_test/reset`, then open `http://localhost:8080/login`.
- Browser routes: `/`, `/requests`, `/split`, `/authorizations`, `/signup`, `/login`.
  `/requests` and `/authorizations` serve the page for `Accept: text/html` and JSON otherwise.
- Exports from the stage-1, stage-2 and stage-3 services import unchanged (`POST /_test/import`);
  every imported payment becomes revision 1 of its own history.

Without Docker (Node.js ≥ 22): `PORT=8080 node src/server.js`.

## Tests

API checks (each file starts its own server in-process):

```sh
node --test test/*.test.js
```

Against one running service the files share state, so run them one at a time:

```sh
POCKETFUL_URL=http://127.0.0.1:8080 node --test --test-concurrency=1 test/*.test.js
```

Upgrade checks (need running stage-1 and stage-2 services):

```sh
POCKETFUL_URL=http://127.0.0.1:8080 POCKETFUL_S1_URL=http://127.0.0.1:8081 POCKETFUL_S2_URL=http://127.0.0.1:8082 \
  node --test --test-concurrency=1 test/upgrade.test.js
```

Browser checks (need Python with pytest, httpx and playwright + Chromium, e.g. the harness venv),
against a running service; `POCKETFUL_S1_URL` optionally points at a running stage-1 service for
the upgrade check:

```sh
POCKETFUL_URL=http://127.0.0.1:8080 POCKETFUL_S1_URL=http://127.0.0.1:8081 \
  python -m pytest -q -p no:cacheprovider test/test_ui_spec.py
```

## Design notes

- Every state change runs in one synchronous section of the event loop, so transfers, holds,
  captures, settlements and idempotency claims are atomic and serializable.
- `available = total − held`; every insufficient-funds check (payments, request payments,
  settlements, new authorizations) uses `available`. Expiry is evaluated against the clock on
  every read and write, so an expired hold releases its remainder without any timer.
- The UI keeps one idempotency key per form body: resubmitting an unchanged form (after a
  success, a refusal or a lost response) replays instead of paying twice; editing a field
  starts a new payment. A lost or 5xx response shows `pay-uncertain`, never `pay-error`.
  Reads use latest-refresh-wins tickets so a delayed older response never overwrites newer data.
- Ledger: each payment keeps an append-only revision list (revision 1 = the original, with
  `effective_at = recorded_at = created_at`). A view (as_of T, known_at K) takes, per payment,
  the latest revision recorded at or before K and applies it at its effective time if at or
  before T, starting from each wallet's opening balance. Holds are replayed the same way from
  their creation, capture, close and expiry times. A correction moves the amount difference
  between the same two wallets; it is refused with `insufficient_funds` if unaffordable now,
  else with `historical_overdraft` if total or available would be negative at any past
  boundary. Statement snapshots freeze the full result and are kept until reset.
- Refunds are new reverse payments (`refund_of` set) debited from the receiver's available funds;
  cumulative refunds never exceed the corrected amount, and corrections never go below it.
  Correction batches check items in input order, then settlement completeness and identical
  member instants, then combined current affordability, then historical total/available; all
  revisions commit together with one shared `recorded_at` and `correction_batch_id`.
- Passwords are salted scrypt hashes; seeded users that share a password share one salted hash
  so large resets stay inside the 10 s budget.
