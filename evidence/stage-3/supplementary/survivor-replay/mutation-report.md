# Mutation campaign report

Generated from `mutation-report.json`; do not edit by hand.

| | |
|---|---|
| Target | `stage-3` |
| Check | `/tmp/vf-s3/verification/stage-3/kill.sh {url}` |
| Seed / selection | 1 / only |
| Discovered / executed | 2145 / 2 |
| Killed | 2 |
| Survived | 0 |
| Timeout | 0 |
| Invalid (never started) | 0 |
| Error (check could not run) | 0 |
| Equivalent (excluded, justified) | 0 |
| **Kill rate** | **100.0%** |
| Detection rate (timeouts count) | 100.0% |

killRate = killed / (killed + survived + timeout); detectionRate counts timeouts as detected; invalid, error and equivalent are excluded from both and listed.

Replay one mutant: `node commit/mutate.ts --target stage-3 --start 'node src/server.js' --check '/tmp/vf-s3/verification/stage-3/kill.sh {url}' --only <id> --out <new dir>`

## Kills by verification layer

| Layer | Killed | Killed by this layer alone |
|---|---|---|
| auth-contract | 0 | 0 |
| contract | 0 | 0 |
| ledger-contract | 2 | 2 |

