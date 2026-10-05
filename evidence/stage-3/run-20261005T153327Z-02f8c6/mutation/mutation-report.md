# Mutation campaign report

Generated from `mutation-report.json`; do not edit by hand.

| | |
|---|---|
| Target | `stage-3` |
| Check | `/tmp/vf-s3/verification/stage-3/kill.sh {url}` |
| Seed / selection | 1 / seeded-sample |
| Discovered / executed | 2145 / 100 |
| Killed | 86 |
| Survived | 14 |
| Timeout | 0 |
| Invalid (never started) | 0 |
| Error (check could not run) | 0 |
| Equivalent (excluded, justified) | 0 |
| **Kill rate** | **86.0%** |
| Detection rate (timeouts count) | 86.0% |

killRate = killed / (killed + survived + timeout); detectionRate counts timeouts as detected; invalid, error and equivalent are excluded from both and listed.

Replay one mutant: `node commit/mutate.ts --target stage-3 --start 'node src/server.js' --check '/tmp/vf-s3/verification/stage-3/kill.sh {url}' --only <id> --out <new dir>`

## Kills by verification layer

| Layer | Killed | Killed by this layer alone |
|---|---|---|
| adversarial | 0 | 0 |
| adversarial-holds | 0 | 0 |
| adversarial-ledger | 0 | 0 |
| auth-contract | 15 | 15 |
| contract | 30 | 30 |
| extra | 3 | 3 |
| ledger-contract | 11 | 11 |
| reference | 0 | 0 |
| reference-holds | 0 | 0 |
| reference-ledger | 0 | 0 |
| survivors | 1 | 1 |
| ui | 26 | 26 |


## Survived — bad work the suite accepted (14)

| id | location | operator | change | note |
|---|---|---|---|---|
| `m-f1cfc527e6` | src/public/app.js:51 | logical | `\|\|` → `&&` |  |
| `m-dc31f45b69` | src/public/app.js:112 | literal-boundary | `1000` → `1001` |  |
| `m-2998744283` | src/public/app.js:122 | arithmetic | `+` → `-` |  |
| `m-79c3fff388` | src/public/app.js:155 | logical | `\|\|` → `&&` |  |
| `m-836af053f3` | src/server.js:138 | literal-boundary | `0` → `1` |  |
| `m-abcdf4ef4b` | src/server.js:870 | literal-boundary | `1` → `2` |  |
| `m-f4a630c277` | src/server.js:874 | boundary | `>` → `>=` |  |
| `m-cf345476cf` | src/server.js:1553 | logical | `&&` → `\|\|` |  |
| `m-e2e17a0e00` | src/server.js:1581 | boundary | `<` → `<=` |  |
| `m-2f9d406e83` | src/server.js:1584 | logical | `\|\|` → `&&` |  |
| `m-3bc4ca1e85` | src/server.js:1587 | logical | `\|\|` → `&&` |  |
| `m-96cfb1f526` | src/server.js:1722 | literal-boundary | `204` → `205` |  |
| `m-b9f5d19bfb` | src/server.js:1759 | compound-assignment | `+=` → `-=` |  |
| `m-293c69d59c` | src/server.js:1781 | equality-negation | `===` → `!==` |  |
