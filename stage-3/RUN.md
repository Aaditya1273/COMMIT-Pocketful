# Pocketful — stage 2

The stage-1 JSON API plus payment authorizations (holds, captures, voids, expiry) and a
browser UI. Node.js 22, no runtime dependencies. The UI (script, styles, icon) is served from
the same image; nothing is fetched at run time. State is in memory and ephemeral.

## Build and run

From this folder (`stage-2/`):

```sh
docker build -t pocketful-stage-2 . && docker run --rm -e PORT=8080 -p 8080:8080 pocketful-stage-2
```

- Listens on `0.0.0.0:$PORT` (default `8080`); `GET /health` → `200 {"status":"ok"}`.
- Works with no network at run time: `docker run --rm --network none -e PORT=9000 pocketful-stage-2`.
- Seed with `POST /_test/reset`, then open `http://localhost:8080/login`.
- Browser routes: `/`, `/requests`, `/split`, `/authorizations`, `/signup`, `/login`.
  `/requests` and `/authorizations` serve the page for `Accept: text/html` and JSON otherwise.
- Exports from the stage-1 service import unchanged (`POST /_test/import`).

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
- Passwords are salted scrypt hashes; seeded users that share a password share one salted hash
  so large resets stay inside the 10 s budget.
