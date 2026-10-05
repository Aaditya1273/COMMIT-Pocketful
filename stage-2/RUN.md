# Pocketful — stage 1

A JSON HTTP API for payments, requests, splits, an activity feed and atomic net settlements.
Node.js 22 with no runtime dependencies (`node:http`, `node:crypto` scrypt). State is held in
memory and is ephemeral.

## Build and run

From this folder (`stage-1/`):

```sh
docker build -t pocketful-stage-1 . && docker run --rm -e PORT=8080 -p 8080:8080 pocketful-stage-1
```

- The service listens on `0.0.0.0:$PORT` (default `8080`).
- `GET /health` returns `200 {"status":"ok"}` within about a second of start.
- No outbound network is needed at run time; it runs with `--network none` too:
  `docker run --rm --network none -e PORT=9000 pocketful-stage-1`.
- Seed it with `POST /_test/reset` (fixture body as in the specification §4).

Without Docker (Node.js ≥ 22): `PORT=8080 node src/server.js`.

## Tests

The builder's own specification checks start the server in-process:

```sh
node --test test/*.test.js
```

To run them against a running container instead:

```sh
POCKETFUL_URL=http://127.0.0.1:8080 node --test test/*.test.js
```

## Design notes

- Every state change runs in one synchronous section of the event loop, so balance checks,
  debits/credits, settlements and idempotency-key claims are atomic; concurrent requests cannot
  overdraw a wallet or apply a key twice.
- Passwords are stored as salted scrypt hashes (N=16384, r=8, p=1). For a reset, users that share
  a seeded password share one salted hash so large fixtures load within the 10 s reset budget.
- `GET /_test/export` returns the full state (users with password hashes, tokens, payments,
  requests, splits, settlements, operator permissions, idempotency records with their original
  responses, ID counters); `POST /_test/import` validates it and replaces the state atomically.
