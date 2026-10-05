# Mutation campaign report

Generated from `mutation-report.json`; do not edit by hand.

| | |
|---|---|
| Target | `stage-4` |
| Check | `/tmp/vf-s4/verification/stage-4/kill.sh {url}` |
| Seed / selection | 1 / seeded-sample |
| Discovered / executed | 2242 / 100 |
| Killed | 77 |
| Survived | 23 |
| Timeout | 0 |
| Invalid (never started) | 0 |
| Error (check could not run) | 0 |
| Equivalent (excluded, justified) | 0 |
| **Kill rate** | **77.0%** |
| Detection rate (timeouts count) | 77.0% |

killRate = killed / (killed + survived + timeout); detectionRate counts timeouts as detected; invalid, error and equivalent are excluded from both and listed.

Replay one mutant: `node commit/mutate.ts --target stage-4 --start 'node src/server.js' --check '/tmp/vf-s4/verification/stage-4/kill.sh {url}' --only <id> --out <new dir>`

## Kills by verification layer

| Layer | Killed | Killed by this layer alone |
|---|---|---|
| adversarial | 0 | 0 |
| adversarial-holds | 0 | 0 |
| adversarial-ledger | 0 | 0 |
| auth-contract | 8 | 8 |
| contract | 25 | 25 |
| ledger-contract | 6 | 6 |
| reference | 0 | 0 |
| reference-holds | 0 | 0 |
| reference-ledger | 2 | 2 |
| refund-contract | 7 | 7 |
| survivors | 2 | 2 |
| ui | 27 | 27 |


## Survived — bad work the suite accepted (23)

| id | location | operator | change | note |
|---|---|---|---|---|
| `m-67b6d62554` | src/public/app.js:69 | literal-boundary | `16` → `17` |  |
| `m-285c32e015` | src/public/app.js:91 | guard-bypass | `text === ''` → `false` |  |
| `m-c280bdd23f` | src/public/app.js:119 | guard-bypass | `diff <= 0` → `false` |  |
| `m-6308121432` | src/public/app.js:120 | guard-bypass | `diff < 60 * 1000` → `false` |  |
| `m-4d768e3609` | src/public/app.js:152 | logical | `&&` → `\|\|` |  |
| `m-05a861f4f8` | src/public/app.js:154 | guard-bypass | `FRIENDLY[code]` → `false` |  |
| `m-194a324c56` | src/public/app.js:238 | guard-bypass | `!r.ended` → `false` |  |
| `m-26481170ad` | src/public/app.js:281 | guard-bypass | `S.authorizations.status !== 'ready'` → `false` |  |
| `m-8fc017248a` | src/public/app.js:359 | boolean-literal | `true` → `false` |  |
| `m-2905bc8166` | src/public/app.js:388 | guard-bypass | `slot && S.me` → `false` |  |
| `m-eadb3d5fd6` | src/public/app.js:423 | boolean-literal | `true` → `false` |  |
| `m-0ce46fe58e` | src/public/app.js:465 | boolean-literal | `true` → `false` |  |
| `m-3a463cb912` | src/public/app.js:636 | negation-removal | `!` → `` |  |
| `m-aa5a44ac16` | src/public/app.js:717 | equality-negation | `===` → `!==` |  |
| `m-cefe00e151` | src/public/app.js:785 | boolean-literal | `true` → `false` |  |
| `m-bc46ffa82d` | src/public/app.js:789 | arithmetic | `+` → `-` |  |
| `m-60d0fd8845` | src/public/app.js:1049 | arithmetic | `+` → `-` |  |
| `m-e898fb6527` | src/server.js:202 | boundary | `<=` → `<` |  |
| `m-021310e0a5` | src/server.js:1071 | equality-negation | `!==` → `===` |  |
| `m-da33f5534f` | src/server.js:1713 | guard-bypass | `typeof t !== 'number' \|\| !Number.isInteger(t) \|\| t < 1 \|\| t > 1e12` → `false` |  |
| `m-14fad41821` | src/server.js:1719 | boundary | `<` → `<=` |  |
| `m-4bbf85486a` | src/server.js:1754 | guard-bypass | `heldBy(st, u.id) > u.balance` → `false` |  |
| `m-6a90fae101` | src/server.js:1867 | literal-boundary | `204` → `205` |  |
