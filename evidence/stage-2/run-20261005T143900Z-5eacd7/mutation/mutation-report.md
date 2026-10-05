# Mutation campaign report

Generated from `mutation-report.json`; do not edit by hand.

| | |
|---|---|
| Target | `stage-2` |
| Check | `/tmp/vf-s2/verification/stage-2/kill.sh {url}` |
| Seed / selection | 1 / seeded-sample |
| Discovered / executed | 1768 / 100 |
| Killed | 79 |
| Survived | 20 |
| Timeout | 0 |
| Invalid (never started) | 1 |
| Error (check could not run) | 0 |
| Equivalent (excluded, justified) | 0 |
| **Kill rate** | **79.8%** |
| Detection rate (timeouts count) | 79.8% |

killRate = killed / (killed + survived + timeout); detectionRate counts timeouts as detected; invalid, error and equivalent are excluded from both and listed.

Replay one mutant: `node commit/mutate.ts --target stage-2 --start 'node src/server.js' --check '/tmp/vf-s2/verification/stage-2/kill.sh {url}' --only <id> --out <new dir>`

## Kills by verification layer

| Layer | Killed | Killed by this layer alone |
|---|---|---|
| adversarial | 0 | 0 |
| adversarial-holds | 0 | 0 |
| auth-contract | 10 | 10 |
| contract | 36 | 36 |
| reference | 0 | 0 |
| reference-holds | 0 | 0 |
| survivors | 9 | 9 |
| ui | 24 | 24 |


## Survived — bad work the suite accepted (20)

| id | location | operator | change | note |
|---|---|---|---|---|
| `m-d8c3c084ab` | src/public/app.js:98 | equality-negation | `===` → `!==` |  |
| `m-4a402db808` | src/public/app.js:101 | literal-boundary | `13` → `14` |  |
| `m-a94f1e5ca5` | src/public/app.js:111 | literal-boundary | `0` → `1` |  |
| `m-6b53cc7482` | src/public/app.js:153 | guard-bypass | `overrides && overrides[code]` → `false` |  |
| `m-e0a3c13199` | src/public/app.js:272 | logical | `&&` → `\|\|` |  |
| `m-8ddc9d48c1` | src/public/app.js:332 | equality-negation | `!==` → `===` |  |
| `m-2771f07fab` | src/public/app.js:512 | arithmetic | `+` → `-` |  |
| `m-19367d6bcb` | src/public/app.js:636 | logical | `\|\|` → `&&` |  |
| `m-ed37e43046` | src/public/app.js:728 | arithmetic | `+` → `-` |  |
| `m-f6db5dc6d1` | src/public/app.js:803 | equality-negation | `===` → `!==` |  |
| `m-889fb2388f` | src/public/app.js:887 | guard-bypass | `!slot` → `false` |  |
| `m-2be14982d7` | src/public/app.js:889 | guard-bypass | `f.status === 'uncertain'` → `false` |  |
| `m-b1463e2d48` | src/public/app.js:963 | equality-negation | `===` → `!==` |  |
| `m-9dfcd8b178` | src/server.js:73 | boundary | `>` → `>=` |  |
| `m-c63a952161` | src/server.js:94 | literal-boundary | `1` → `2` |  |
| `m-356b801f77` | src/server.js:1000 | negation-removal | `!` → `` |  |
| `m-866cfeb300` | src/server.js:1000 | literal-boundary | `0` → `1` |  |
| `m-250f118255` | src/server.js:1194 | guard-bypass | `!isNullableString(r.payment_id) \|\| !isNullableString(r.split_id)` → `false` |  |
| `m-83838935be` | src/server.js:1227 | logical | `\|\|` → `&&` |  |
| `m-465861ed14` | src/server.js:1240 | guard-bypass | `typeof a.expires_ts !== 'number' \|\| !Number.isFinite(a.expires_ts) \|\| !isTsString(a.expires_at)
      \|\| typeof a.ts !== 'number' \|\| !Number.isFinite(a.ts) \|\| !isTsString(a.created_at) \|\| !isCount(a.seq)` → `false` |  |
