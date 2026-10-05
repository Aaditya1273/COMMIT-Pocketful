# Mutation campaign report

Generated from `mutation-report.json`; do not edit by hand.

| | |
|---|---|
| Target | `stage-2` |
| Check | `/tmp/vf-s2/verification/stage-2/kill.sh {url}` |
| Seed / selection | 1 / seeded-sample |
| Discovered / executed | 1768 / 100 |
| Killed | 56 |
| Survived | 6 |
| Timeout | 37 |
| Invalid (never started) | 1 |
| Error (check could not run) | 0 |
| Equivalent (excluded, justified) | 0 |
| **Kill rate** | **56.6%** |
| Detection rate (timeouts count) | 93.9% |

killRate = killed / (killed + survived + timeout); detectionRate counts timeouts as detected; invalid, error and equivalent are excluded from both and listed.

Replay one mutant: `node commit/mutate.ts --target stage-2 --start 'node src/server.js' --check '/tmp/vf-s2/verification/stage-2/kill.sh {url}' --only <id> --out <new dir>`

## Kills by verification layer

| Layer | Killed | Killed by this layer alone |
|---|---|---|
| adversarial | 0 | 0 |
| adversarial-holds | 0 | 0 |
| auth-contract | 9 | 9 |
| contract | 36 | 36 |
| reference | 0 | 0 |
| reference-holds | 0 | 0 |
| survivors | 8 | 8 |
| ui | 3 | 3 |


## Survived — bad work the suite accepted (6)

| id | location | operator | change | note |
|---|---|---|---|---|
| `m-0a4cd6e0fa` | src/server.js:991 | logical | `\|\|` → `&&` |  |
| `m-356b801f77` | src/server.js:1000 | negation-removal | `!` → `` |  |
| `m-866cfeb300` | src/server.js:1000 | literal-boundary | `0` → `1` |  |
| `m-250f118255` | src/server.js:1194 | guard-bypass | `!isNullableString(r.payment_id) \|\| !isNullableString(r.split_id)` → `false` |  |
| `m-83838935be` | src/server.js:1227 | logical | `\|\|` → `&&` |  |
| `m-465861ed14` | src/server.js:1240 | guard-bypass | `typeof a.expires_ts !== 'number' \|\| !Number.isFinite(a.expires_ts) \|\| !isTsString(a.expires_at)
      \|\| typeof a.ts !== 'number' \|\| !Number.isFinite(a.ts) \|\| !isTsString(a.created_at) \|\| !isCount(a.seq)` → `false` |  |

## Timeout (37)

| id | location | operator | change | note |
|---|---|---|---|---|
| `m-41bed97f43` | src/public/app.js:94 | negation-removal | `!` → `` |  |
| `m-d8c3c084ab` | src/public/app.js:98 | equality-negation | `===` → `!==` |  |
| `m-4a402db808` | src/public/app.js:101 | literal-boundary | `13` → `14` |  |
| `m-3e0762cece` | src/public/app.js:103 | literal-boundary | `0` → `1` |  |
| `m-a94f1e5ca5` | src/public/app.js:111 | literal-boundary | `0` → `1` |  |
| `m-6b53cc7482` | src/public/app.js:153 | guard-bypass | `overrides && overrides[code]` → `false` |  |
| `m-862aca960b` | src/public/app.js:167 | guard-bypass | `opts.key` → `false` |  |
| `m-f5eff56aa8` | src/public/app.js:187 | boundary | `>=` → `>` |  |
| `m-b33ede986c` | src/public/app.js:190 | negation-removal | `!` → `` |  |
| `m-cdc8eb53fe` | src/public/app.js:224 | guard-bypass | `r.ok && accept('me', ticket)` → `false` |  |
| `m-0e312501c1` | src/public/app.js:225 | statement-deletion | `S.me = r.data;` → `;` |  |
| `m-43591fe772` | src/public/app.js:242 | statement-deletion | `paintFeed();` → `;` |  |
| `m-e0a3c13199` | src/public/app.js:272 | logical | `&&` → `\|\|` |  |
| `m-0b63eb25ae` | src/public/app.js:317 | guard-bypass | `screen.auth && !S.token` → `false` |  |
| `m-8ddc9d48c1` | src/public/app.js:332 | equality-negation | `!==` → `===` |  |
| `m-7ec5d90ffd` | src/public/app.js:380 | logical | `\|\|` → `&&` |  |
| `m-c8482a1706` | src/public/app.js:422 | arithmetic | `+` → `-` |  |
| `m-db6af8a390` | src/public/app.js:489 | logical | `\|\|` → `&&` |  |
| `m-e52a62c27e` | src/public/app.js:595 | equality-negation | `===` → `!==` |  |
| `m-eed44315ec` | src/public/app.js:602 | guard-bypass | `f.sig !== sig \|\| !f.key` → `false` |  |
| `m-9696c11b5f` | src/public/app.js:624 | boolean-literal | `false` → `true` |  |
| `m-d20f874947` | src/public/app.js:636 | equality-negation | `===` → `!==` |  |
| `m-821de60ad8` | src/public/app.js:652 | statement-deletion | `body.replaceChildren(...notes, h('ul', { class: 'feed', testid: 'activity-list' }, a.items.map(feedItem)));` → `;` |  |
| `m-6113e4d75e` | src/public/app.js:709 | negation-removal | `!` → `` |  |
| `m-ed37e43046` | src/public/app.js:728 | arithmetic | `+` → `-` |  |
| `m-f6db5dc6d1` | src/public/app.js:803 | equality-negation | `===` → `!==` |  |
| `m-4a96dd84b0` | src/public/app.js:822 | literal-boundary | `1` → `2` |  |
| `m-e64bd40e3d` | src/public/app.js:849 | statement-deletion | `h('div', { id: 'preview-body', 'aria-live': 'polite' }))));` → `;` |  |
| `m-889fb2388f` | src/public/app.js:887 | guard-bypass | `!slot` → `false` |  |
| `m-2be14982d7` | src/public/app.js:889 | guard-bypass | `f.status === 'uncertain'` → `false` |  |
| `m-b1463e2d48` | src/public/app.js:963 | equality-negation | `===` → `!==` |  |
| `m-79675899c4` | src/public/app.js:967 | equality-negation | `===` → `!==` |  |
| `m-f2b482b58e` | src/public/app.js:984 | equality-negation | `===` → `!==` |  |
| `m-be044f24fe` | src/public/app.js:1000 | logical | `&&` → `\|\|` |  |
| `m-2eb0b7ccb0` | src/server.js:24 | literal-boundary | `2` → `3` |  |
| `m-9dfcd8b178` | src/server.js:73 | boundary | `>` → `>=` |  |
| `m-c63a952161` | src/server.js:94 | literal-boundary | `1` → `2` |  |
