# Mutation campaign report

Generated from `mutation-report.json`; do not edit by hand.

| | |
|---|---|
| Target | `stage-1` |
| Check | `/tmp/vf-s1/verification/stage-1/kill.sh {url}` |
| Seed / selection | 1 / all |
| Discovered / executed | 782 / 782 |
| Killed | 653 |
| Survived | 53 |
| Timeout | 0 |
| Invalid (never started) | 13 |
| Error (check could not run) | 0 |
| Equivalent (excluded, justified) | 63 |
| **Kill rate** | **92.5%** |
| Detection rate (timeouts count) | 92.5% |

killRate = killed / (killed + survived + timeout); detectionRate counts timeouts as detected; invalid, error and equivalent are excluded from both and listed.

Replay one mutant: `node commit/mutate.ts --target stage-1 --start 'node src/server.js' --check '/tmp/vf-s1/verification/stage-1/kill.sh {url}' --only <id> --out <new dir>`

## Kills by verification layer

| Layer | Killed | Killed by this layer alone |
|---|---|---|
| adversarial | 2 | 2 |
| contract | 495 | 495 |
| extra | 16 | 16 |
| reference | 0 | 0 |
| semantic-import | 25 | 25 |
| survivors | 115 | 115 |


## Survived — bad work the suite accepted (53)

| id | location | operator | change | note |
|---|---|---|---|---|
| `m-25895f0f53` | src/server.js:22 | literal-boundary | `64` → `65` |  |
| `m-697a22647e` | src/server.js:22 | literal-boundary | `1024` → `1025` |  |
| `m-6ebf44c1ba` | src/server.js:22 | literal-boundary | `1024` → `1025` |  |
| `m-1aa2ee1b46` | src/server.js:90 | boundary | `>=` → `>` |  |
| `m-22183280cb` | src/server.js:90 | literal-boundary | `2` → `3` |  |
| `m-c4235cdbc8` | src/server.js:90 | boundary | `<=` → `<` |  |
| `m-18712c3a87` | src/server.js:90 | literal-boundary | `1048576` → `1048577` |  |
| `m-66780682b7` | src/server.js:90 | literal-boundary | `1` → `2` |  |
| `m-cc353e3ef3` | src/server.js:90 | boundary | `>=` → `>` |  |
| `m-8e628d1490` | src/server.js:90 | literal-boundary | `1` → `2` |  |
| `m-a83b941ae0` | src/server.js:90 | boundary | `<=` → `<` |  |
| `m-3cc566b14d` | src/server.js:90 | boundary | `<=` → `<` |  |
| `m-45332a8f43` | src/server.js:95 | guard-bypass | `!m` → `false` |  |
| `m-0e7027ac9c` | src/server.js:95 | boolean-literal | `false` → `true` |  |
| `m-6c338e49ac` | src/server.js:102 | literal-boundary | `256` → `257` |  |
| `m-a825a117bc` | src/server.js:102 | literal-boundary | `1024` → `1025` |  |
| `m-a9a4a60a73` | src/server.js:102 | literal-boundary | `1024` → `1025` |  |
| `m-5ff53ca016` | src/server.js:883 | literal-boundary | `0` → `1` |  |
| `m-7fc74df736` | src/server.js:898 | logical | `\|\|` → `&&` |  |
| `m-10bed28720` | src/server.js:907 | logical | `\|\|` → `&&` |  |
| `m-8523820780` | src/server.js:911 | guard-bypass | `!isNullableString(r.payment_id) \|\| !isNullableString(r.split_id)` → `false` |  |
| `m-9e7ea837dc` | src/server.js:911 | logical | `\|\|` → `&&` |  |
| `m-4111232163` | src/server.js:912 | logical | `\|\|` → `&&` |  |
| `m-1d83d3cd37` | src/server.js:921 | guard-bypass | `!isObject(sp) \|\| !isId(sp.id) \|\| st.splits.has(sp.id) \|\| !st.users.has(sp.requester)` → `false` |  |
| `m-859201692b` | src/server.js:921 | logical | `\|\|` → `&&` |  |
| `m-5d0cb3cf8f` | src/server.js:921 | logical | `\|\|` → `&&` |  |
| `m-6bcef38f6a` | src/server.js:921 | logical | `\|\|` → `&&` |  |
| `m-be851ce7cd` | src/server.js:922 | guard-bypass | `!isSafeInt(sp.amount) \|\| typeof sp.note !== 'string' \|\| !isTsString(sp.created_at)` → `false` |  |
| `m-0db27c8174` | src/server.js:922 | logical | `\|\|` → `&&` |  |
| `m-3f685996e9` | src/server.js:922 | logical | `\|\|` → `&&` |  |
| `m-7176fdd4be` | src/server.js:923 | logical | `&&` → `\|\|` |  |
| `m-8f58df63a3` | src/server.js:923 | logical | `&&` → `\|\|` |  |
| `m-558cc7053f` | src/server.js:934 | guard-bypass | `!isObject(se) \|\| !isId(se.id) \|\| st.settlements.has(se.id)` → `false` |  |
| `m-4164af8496` | src/server.js:934 | logical | `\|\|` → `&&` |  |
| `m-9480c164b0` | src/server.js:934 | logical | `\|\|` → `&&` |  |
| `m-557d8c326c` | src/server.js:936 | guard-bypass | `!isTsString(se.committed_at)` → `false` |  |
| `m-8d922f017f` | src/server.js:942 | logical | `\|\|` → `&&` |  |
| `m-e588f8d0cc` | src/server.js:943 | logical | `\|\|` → `&&` |  |
| `m-f9acfa877e` | src/server.js:943 | logical | `\|\|` → `&&` |  |
| `m-b15542fb8a` | src/server.js:943 | literal-boundary | `0` → `1` |  |
| `m-4bf5bf080e` | src/server.js:943 | logical | `\|\|` → `&&` |  |
| `m-f49e4659db` | src/server.js:943 | logical | `\|\|` → `&&` |  |
| `m-e6f9fc89f2` | src/server.js:1026 | literal-boundary | `0` → `1` |  |
| `m-1cf1035799` | src/server.js:1028 | statement-deletion | `size += c.length;` → `;` |  |
| `m-a166a60d8e` | src/server.js:1028 | compound-assignment | `+=` → `-=` |  |
| `m-d89f9ed874` | src/server.js:1029 | guard-bypass | `size > MAX_BODY` → `false` |  |
| `m-16713448e7` | src/server.js:1029 | boundary | `>` → `>=` |  |
| `m-e3d1c13a95` | src/server.js:1030 | statement-deletion | `reject(new HttpError(413, 'payload_too_large', 'request body is too large'));` → `;` |  |
| `m-2a4a32c7df` | src/server.js:1030 | literal-boundary | `413` → `414` |  |
| `m-39a54b3287` | src/server.js:1031 | statement-deletion | `req.resume();` → `;` |  |
| `m-6b5948a877` | src/server.js:1037 | statement-deletion | `req.on('error', reject);` → `;` |  |
| `m-293a457746` | src/server.js:1062 | logical | `&&` → `\|\|` |  |
| `m-dc4d9ac48a` | src/server.js:1062 | literal-boundary | `8080` → `8081` |  |

## Equivalent — excluded with justification (63)

| id | location | operator | change | note |
|---|---|---|---|---|
| `m-77e69fcee2` | src/server.js:26 | literal-boundary | `8` → `9` | scrypt cost/salt parameters for new hashes: the hash stays a valid scrypt hash verified with its own stored parameters; only timing and the opaque export string differ. |
| `m-3e1912bf12` | src/server.js:26 | literal-boundary | `1` → `2` | scrypt cost/salt parameters for new hashes: the hash stays a valid scrypt hash verified with its own stored parameters; only timing and the opaque export string differ. |
| `m-7c49948028` | src/server.js:26 | literal-boundary | `32` → `33` | scrypt cost/salt parameters for new hashes: the hash stays a valid scrypt hash verified with its own stored parameters; only timing and the opaque export string differ. |
| `m-66f5e7a71f` | src/server.js:33 | logical | `\|\|` → `&&` | changes only the human-readable error message, whose wording the specification leaves free (§5 "any wording"). |
| `m-1268f8deff` | src/server.js:40 | logical | `\|\|` → `&&` | changes only the human-readable not_found message; §5 allows any wording. |
| `m-a9453d23ce` | src/server.js:41 | logical | `\|\|` → `&&` | changes only the human-readable forbidden message; §5 allows any wording. |
| `m-cbe2c5f35e` | src/server.js:69 | boundary | `>` → `>=` | sign test for an infinite number in the canonical body form: +Infinity and -Infinity stay distinct under v>0, v>=0 and v>1, so body equality is unchanged. |
| `m-5a50baa811` | src/server.js:69 | literal-boundary | `0` → `1` | sign test for an infinite number in the canonical body form: +Infinity and -Infinity stay distinct under v>0, v>=0 and v>1, so body equality is unchanged. |
| `m-64198eda3d` | src/server.js:78 | literal-boundary | `16` → `17` | salt length for new hashes (16 vs 17 random bytes): no observable difference other than the opaque hash string. |
| `m-ce774fc6ab` | src/server.js:80 | literal-boundary | `64` → `65` | scrypt maxmem for new hashes: N=16384, r=8 needs 16 MiB, below every mutated limit, so hashing behaves identically. |
| `m-2a97864ae6` | src/server.js:80 | literal-boundary | `1024` → `1025` | scrypt maxmem for new hashes: N=16384, r=8 needs 16 MiB, below every mutated limit, so hashing behaves identically. |
| `m-fdd2fbe01c` | src/server.js:80 | literal-boundary | `1024` → `1025` | scrypt maxmem for new hashes: N=16384, r=8 needs 16 MiB, below every mutated limit, so hashing behaves identically. |
| `m-539e48fef9` | src/server.js:117 | literal-boundary | `2` → `3` | initial pre-reset state value; every reset and import overwrites it before any user (and so any authenticated request) exists. |
| `m-705d19a82f` | src/server.js:128 | literal-boundary | `0` → `1` | initial pre-reset id counter; overwritten by reset/import, and ids are opaque strings, so an offset start is unobservable. |
| `m-de2ccff6b9` | src/server.js:129 | literal-boundary | `0` → `1` | initial pre-reset sequence number; overwritten by reset/import and only used for relative ordering. |
| `m-a8856185ca` | src/server.js:130 | literal-boundary | `0` → `1` | initial pre-reset clock floor; overwritten by reset/import, and Date.now() exceeds it either way. |
| `m-8a62450842` | src/server.js:144 | literal-boundary | `1` → `2` | id counter step 1 vs 2: ids are opaque strings (§3.4); skipping numbers is unobservable. |
| `m-96ec2ebc96` | src/server.js:157 | literal-boundary | `24` → `25` | token length (24 vs 25 random bytes): tokens are opaque; both are unguessable bearer tokens. |
| `m-381fce1e63` | src/server.js:202 | arithmetic | `-` → `+` | tie-break between items with an identical timestamp: §8 leaves the order of same-second items unspecified. |
| `m-944ca59a09` | src/server.js:264 | guard-bypass | `typeof header !== 'string'` → `false` | a missing Authorization header still fails the Bearer regex (RegExp.exec coerces undefined to "undefined"), so the response is the same 401. |
| `m-f9a230da0e` | src/server.js:376 | boundary | `<` → `<=` | loop bound i<n vs i<=n in equalSplit: the extra (n+1)th share is never read, shares[0..n-1] are identical. |
| `m-d9bcf882c1` | src/server.js:462 | equality-negation | `===` → `!==` | changes only the human-readable forbidden message; §5 allows any wording. |
| `m-b56a0102fb` | src/server.js:537 | statement-deletion | `st.splits.set(splitId, split);` → `;` | the split record map is never read by any endpoint; split replays come from idempotency records, and the export state is opaque. |
| `m-a2bd718280` | src/server.js:646 | statement-deletion | `conflicts();` → `;` | the first of two identical conflict checks; the re-check after hashing returns the same 409 codes, only later. |
| `m-d41a6d3942` | src/server.js:670 | guard-bypass | `dummyHash` → `false` | dummy hash for unknown-email logins only equalises timing; the response is the same 401. |
| `m-77b4a7d927` | src/server.js:704 | guard-bypass | `!isObject(u)` → `false` | a non-object fixture user still fails the next typeof id check with the same 422. |
| `m-6cb665550d` | src/server.js:727 | guard-bypass | `!isObject(p)` → `false` | a non-object seeded payment still fails the next typeof id check with the same 422. |
| `m-57968b4b73` | src/server.js:788 | literal-boundary | `0` → `1` | shifts every seeded timestamp by 1 ms into the past; relative order and the RFC 3339 form are unchanged. |
| `m-cbff45532a` | src/server.js:790 | statement-deletion | `i += 1;` → `;` | seeded timestamps spaced 0 or 2 ms instead of 1 ms (or all equal, ordered by sequence): fixture order and newest-first order are unchanged. |
| `m-385f839863` | src/server.js:790 | literal-boundary | `1` → `2` | seeded timestamps spaced 0 or 2 ms instead of 1 ms (or all equal, ordered by sequence): fixture order and newest-first order are unchanged. |
| `m-1ef38d9fb2` | src/server.js:792 | arithmetic | `-` → `+` | shifts seeded timestamps by 1-2 ms into the past; order unchanged. |
| `m-d9555db638` | src/server.js:792 | literal-boundary | `1` → `2` | shifts seeded timestamps by 1-2 ms into the past; order unchanged. |
| `m-2c8d1aca14` | src/server.js:800 | statement-deletion | `st.lastTs = Math.max(st.lastTs, base);` → `;` | clock floor after reset: now() takes max(Date.now(), floor) and Date.now() is already >= the reset time. |
| `m-88be4a9265` | src/server.js:866 | statement-deletion | `st.counter = s.counter;` → `;` | imported id counter not restored: newId() skips ids already present, so no collision and ids stay opaque. |
| `m-614f929860` | src/server.js:867 | statement-deletion | `st.seq = s.seq;` → `;` | imported sequence number not restored: sequence only breaks ties between identical timestamps, which §8 leaves unordered. |
| `m-47f8858adf` | src/server.js:868 | statement-deletion | `st.lastTs = s.last_ts;` → `;` | imported clock floor not restored: new timestamps come from Date.now(), which is later than any exported time. |
| `m-3ab9b402e8` | src/server.js:1000 | guard-bypass | `res.headersSent \|\| res.destroyed` → `false` | headersSent/destroyed guard: every handler sends exactly once, so the guard never changes behaviour. |
| `m-1ec8236ab3` | src/server.js:1000 | logical | `\|\|` → `&&` | headersSent/destroyed guard: every handler sends exactly once, so the guard never changes behaviour. |
| `m-5a8188f402` | src/server.js:1001 | guard-bypass | `status === 204` → `false` | Node never writes a body on a 204 response, so the 204 special case is behaviourally identical to the JSON path. |
| `m-591f6f3644` | src/server.js:1001 | literal-boundary | `204` → `205` | Node never writes a body on a 204 response, so the 204 special case is behaviourally identical to the JSON path. |
| `m-5574c77b85` | src/server.js:1018 | statement-deletion | `console.error(e);` → `;` | logging of an unexpected error to stderr; no HTTP-observable effect. |
| `m-29e21ec300` | src/server.js:1019 | statement-deletion | `send(res, 500, { error: { code: 'internal_error', message: 'internal error' } });` → `;` | the 500 fallback is unreachable: no handler throws a non-HttpError in any exercised path (no 5xx was ever observed). |
| `m-70dba4bfce` | src/server.js:1019 | literal-boundary | `500` → `501` | the 500 fallback is unreachable: no handler throws a non-HttpError in any exercised path (no 5xx was ever observed). |
| `m-0b4fdb60c1` | src/server.js:1063 | literal-boundary | `64` → `65` | maxHeaderSize 64 KiB vs 65 KiB: no specified request comes near the header size limit. |
| `m-09db0fefb8` | src/server.js:1063 | literal-boundary | `1024` → `1025` | maxHeaderSize 64 KiB vs 65 KiB: no specified request comes near the header size limit. |
| `m-2af82f23bf` | src/server.js:1064 | statement-deletion | `server.keepAliveTimeout = 75 * 1000;` → `;` | keep-alive timeout of 75 s vs 76 s: far beyond the 5 s per-request window. |
| `m-b2b7220559` | src/server.js:1064 | literal-boundary | `75` → `76` | keep-alive timeout of 75 s vs 76 s: far beyond the 5 s per-request window. |
| `m-3510900e37` | src/server.js:1064 | literal-boundary | `1000` → `1001` | keep-alive timeout of 75 s vs 76 s: far beyond the 5 s per-request window. |
| `m-02fe3714d4` | src/server.js:1065 | statement-deletion | `server.headersTimeout = 76 * 1000;` → `;` | headers timeout of 76 s vs 77 s: far beyond the 5 s per-request window. |
| `m-102d3c5cb3` | src/server.js:1065 | literal-boundary | `76` → `77` | headers timeout of 76 s vs 77 s: far beyond the 5 s per-request window. |
| `m-31c460c75c` | src/server.js:1065 | literal-boundary | `1000` → `1001` | headers timeout of 76 s vs 77 s: far beyond the 5 s per-request window. |
| `m-aabb72392e` | src/server.js:1066 | statement-deletion | `server.requestTimeout = 0;` → `;` | requestTimeout 0 vs 1 ms / default: Node applies it only to slow uploads; every specified request body arrives within it. |
| `m-88ce05de6b` | src/server.js:1066 | literal-boundary | `0` → `1` | requestTimeout 0 vs 1 ms / default: Node applies it only to slow uploads; every specified request body arrives within it. |
| `m-6a5d2c86b1` | src/server.js:1068 | statement-deletion | `console.log(`pocketful stage 1 listening on 0.0.0.0:${port}`);` → `;` | startup log line; no HTTP-observable effect. |
| `m-d4b2421473` | src/server.js:1070 | statement-deletion | `hashPassword(crypto.randomBytes(12).toString('hex')).then((h) => { dummyHash = h; });` → `;` | dummy hash for timing equalisation on unknown-email login; responses are unchanged. |
| `m-d332e7c718` | src/server.js:1070 | literal-boundary | `12` → `13` | dummy hash for timing equalisation on unknown-email login; responses are unchanged. |
| `m-287b9e4efa` | src/server.js:1071 | literal-boundary | `0` → `1` | graceful shutdown timing on SIGTERM/SIGINT; state need not survive a restart (§2). |
| `m-475473ce21` | src/server.js:1071 | logical | `&&` → `\|\|` | graceful shutdown timing on SIGTERM/SIGINT; state need not survive a restart (§2). |
| `m-2a0e5e700f` | src/server.js:1071 | literal-boundary | `0` → `1` | graceful shutdown timing on SIGTERM/SIGINT; state need not survive a restart (§2). |
| `m-af20daadda` | src/server.js:1071 | literal-boundary | `500` → `501` | graceful shutdown timing on SIGTERM/SIGINT; state need not survive a restart (§2). |
| `m-5e03ed8c9a` | src/server.js:1072 | statement-deletion | `process.on('SIGTERM', stop);` → `;` | SIGTERM handler; the container is stopped either way and state is ephemeral (§2). |
| `m-126fe27986` | src/server.js:1073 | statement-deletion | `process.on('SIGINT', stop);` → `;` | SIGINT handler; no HTTP-observable effect. |
| `m-eb5f42efce` | src/server.js:1079 | statement-deletion | `module.exports = { start, equalSplit, deriveHandle, canonical };` → `;` | module.exports for in-process tests; the service is started as a program and exports are unused. |
