# Mutation campaign report

Generated from `mutation-report.json`; do not edit by hand.

| | |
|---|---|
| Target | `../../../../../tmp/vf-s1/stage-1` |
| Check | `~/Wins/band-work/result/verification/stage-1/kill.sh {url}` |
| Seed / selection | 1 / all |
| Discovered / executed | 782 / 782 |
| Killed | 530 |
| Survived | 233 |
| Timeout | 6 |
| Invalid (never started) | 13 |
| Error (check could not run) | 0 |
| Equivalent (excluded, justified) | 0 |
| **Kill rate** | **68.9%** |
| Detection rate (timeouts count) | 69.7% |

killRate = killed / (killed + survived + timeout); detectionRate counts timeouts as detected; invalid, error and equivalent are excluded from both and listed.

Replay one mutant: `node commit/mutate.ts --target /tmp/vf-s1/stage-1 --start 'node src/server.js' --check '~/Wins/band-work/result/verification/stage-1/kill.sh {url}' --only <id> --out <new dir>`

## Kills by verification layer

| Layer | Killed | Killed by this layer alone |
|---|---|---|
| adversarial | 2 | 2 |
| contract | 487 | 487 |
| extra | 16 | 16 |
| reference | 0 | 0 |
| semantic-import | 25 | 25 |


## Survived — bad work the suite accepted (233)

| id | location | operator | change | note |
|---|---|---|---|---|
| `m-25895f0f53` | src/server.js:22 | literal-boundary | `64` → `65` |  |
| `m-697a22647e` | src/server.js:22 | literal-boundary | `1024` → `1025` |  |
| `m-6ebf44c1ba` | src/server.js:22 | literal-boundary | `1024` → `1025` |  |
| `m-223f44d261` | src/server.js:23 | literal-boundary | `53` → `54` |  |
| `m-77e69fcee2` | src/server.js:26 | literal-boundary | `8` → `9` |  |
| `m-3e1912bf12` | src/server.js:26 | literal-boundary | `1` → `2` |  |
| `m-7c49948028` | src/server.js:26 | literal-boundary | `32` → `33` |  |
| `m-66f5e7a71f` | src/server.js:33 | logical | `\|\|` → `&&` |  |
| `m-1268f8deff` | src/server.js:40 | logical | `\|\|` → `&&` |  |
| `m-a9453d23ce` | src/server.js:41 | logical | `\|\|` → `&&` |  |
| `m-c23d849aed` | src/server.js:53 | boundary | `<=` → `<` |  |
| `m-40693872f5` | src/server.js:62 | guard-bypass | `Array.isArray(v)` → `false` |  |
| `m-759b5a48f8` | src/server.js:65 | arithmetic | `+` → `-` |  |
| `m-98dbce3ad0` | src/server.js:67 | guard-bypass | `typeof v === 'number'` → `false` |  |
| `m-cbe2c5f35e` | src/server.js:69 | boundary | `>` → `>=` |  |
| `m-5a50baa811` | src/server.js:69 | literal-boundary | `0` → `1` |  |
| `m-64198eda3d` | src/server.js:78 | literal-boundary | `16` → `17` |  |
| `m-ce774fc6ab` | src/server.js:80 | literal-boundary | `64` → `65` |  |
| `m-2a97864ae6` | src/server.js:80 | literal-boundary | `1024` → `1025` |  |
| `m-fdd2fbe01c` | src/server.js:80 | literal-boundary | `1024` → `1025` |  |
| `m-263ab164c9` | src/server.js:89 | literal-boundary | `1` → `2` |  |
| `m-30e16161a7` | src/server.js:89 | literal-boundary | `2` → `3` |  |
| `m-1aa2ee1b46` | src/server.js:90 | boundary | `>=` → `>` |  |
| `m-22183280cb` | src/server.js:90 | literal-boundary | `2` → `3` |  |
| `m-e36f56ba92` | src/server.js:90 | logical | `&&` → `\|\|` |  |
| `m-c4235cdbc8` | src/server.js:90 | boundary | `<=` → `<` |  |
| `m-18712c3a87` | src/server.js:90 | literal-boundary | `1048576` → `1048577` |  |
| `m-18c9b8f8c3` | src/server.js:90 | logical | `&&` → `\|\|` |  |
| `m-66780682b7` | src/server.js:90 | literal-boundary | `1` → `2` |  |
| `m-8ee3282e3e` | src/server.js:90 | logical | `&&` → `\|\|` |  |
| `m-cc353e3ef3` | src/server.js:90 | boundary | `>=` → `>` |  |
| `m-8e628d1490` | src/server.js:90 | literal-boundary | `1` → `2` |  |
| `m-d837cba158` | src/server.js:90 | logical | `&&` → `\|\|` |  |
| `m-a83b941ae0` | src/server.js:90 | boundary | `<=` → `<` |  |
| `m-e871ce6a95` | src/server.js:90 | literal-boundary | `32` → `33` |  |
| `m-c8d5fb6cef` | src/server.js:90 | logical | `&&` → `\|\|` |  |
| `m-eced865f22` | src/server.js:90 | logical | `&&` → `\|\|` |  |
| `m-3cc566b14d` | src/server.js:90 | boundary | `<=` → `<` |  |
| `m-2ffc30ef53` | src/server.js:90 | literal-boundary | `16` → `17` |  |
| `m-45332a8f43` | src/server.js:95 | guard-bypass | `!m` → `false` |  |
| `m-0e7027ac9c` | src/server.js:95 | boolean-literal | `false` → `true` |  |
| `m-354b6ca027` | src/server.js:99 | guard-bypass | `expected.length === 0` → `false` |  |
| `m-3fcd90f439` | src/server.js:99 | literal-boundary | `0` → `1` |  |
| `m-425ebcb7c7` | src/server.js:99 | boolean-literal | `false` → `true` |  |
| `m-6c338e49ac` | src/server.js:102 | literal-boundary | `256` → `257` |  |
| `m-a825a117bc` | src/server.js:102 | literal-boundary | `1024` → `1025` |  |
| `m-a9a4a60a73` | src/server.js:102 | literal-boundary | `1024` → `1025` |  |
| `m-6374cb6f63` | src/server.js:105 | boolean-literal | `false` → `true` |  |
| `m-539e48fef9` | src/server.js:117 | literal-boundary | `2` → `3` |  |
| `m-705d19a82f` | src/server.js:128 | literal-boundary | `0` → `1` |  |
| `m-de2ccff6b9` | src/server.js:129 | literal-boundary | `0` → `1` |  |
| `m-a8856185ca` | src/server.js:130 | literal-boundary | `0` → `1` |  |
| `m-c25b41dab0` | src/server.js:137 | statement-deletion | `st.lastTs = Math.max(Date.now(), st.lastTs);` → `;` |  |
| `m-8a62450842` | src/server.js:144 | literal-boundary | `1` → `2` |  |
| `m-96ec2ebc96` | src/server.js:157 | literal-boundary | `24` → `25` |  |
| `m-2bb54305b6` | src/server.js:202 | logical | `\|\|` → `&&` |  |
| `m-381fce1e63` | src/server.js:202 | arithmetic | `-` → `+` |  |
| `m-2a3a7c4058` | src/server.js:239 | literal-boundary | `50` → `51` |  |
| `m-29101234fc` | src/server.js:244 | boundary | `<` → `<=` |  |
| `m-a72dc10549` | src/server.js:244 | literal-boundary | `1` → `2` |  |
| `m-944ca59a09` | src/server.js:264 | guard-bypass | `typeof header !== 'string'` → `false` |  |
| `m-5064d71c0c` | src/server.js:276 | guard-bypass | `raw.length === 0 && emptyAs !== undefined` → `false` |  |
| `m-0cb1a09086` | src/server.js:276 | literal-boundary | `0` → `1` |  |
| `m-60f8b0f61d` | src/server.js:279 | boolean-literal | `true` → `false` |  |
| `m-f9a230da0e` | src/server.js:376 | boundary | `<` → `<=` |  |
| `m-d9bcf882c1` | src/server.js:462 | equality-negation | `===` → `!==` |  |
| `m-2b4ff157cf` | src/server.js:505 | guard-bypass | `typeof h !== 'string'` → `false` |  |
| `m-b56a0102fb` | src/server.js:537 | statement-deletion | `st.splits.set(splitId, split);` → `;` |  |
| `m-ec6d90a866` | src/server.js:575 | guard-bypass | `!isObject(t)` → `false` |  |
| `m-34a98ccc95` | src/server.js:577 | guard-bypass | `typeof t.to_handle !== 'string'` → `false` |  |
| `m-93898bb896` | src/server.js:582 | guard-bypass | `!from` → `false` |  |
| `m-4e72f52f50` | src/server.js:629 | literal-boundary | `0` → `1` |  |
| `m-739fcf7f7f` | src/server.js:629 | literal-boundary | `1` → `2` |  |
| `m-a2bd718280` | src/server.js:646 | statement-deletion | `conflicts();` → `;` |  |
| `m-d41a6d3942` | src/server.js:670 | guard-bypass | `dummyHash` → `false` |  |
| `m-a23867c724` | src/server.js:686 | guard-bypass | `typeof v !== 'string'` → `false` |  |
| `m-b7a148cde9` | src/server.js:692 | guard-bypass | `typeof v !== 'string' \|\| Number.isNaN(Date.parse(v))` → `false` |  |
| `m-4028a28ba5` | src/server.js:692 | logical | `\|\|` → `&&` |  |
| `m-becc3ce2e0` | src/server.js:699 | literal-boundary | `0` → `1` |  |
| `m-77b4a7d927` | src/server.js:704 | guard-bypass | `!isObject(u)` → `false` |  |
| `m-b0798e9ffe` | src/server.js:705 | guard-bypass | `typeof u.id !== 'string' \|\| u.id.length === 0 \|\| u.id.length > 64 \|\| ids.has(u.id)` → `false` |  |
| `m-510bda7b35` | src/server.js:705 | logical | `\|\|` → `&&` |  |
| `m-66ec4faf65` | src/server.js:705 | literal-boundary | `0` → `1` |  |
| `m-ef7810d664` | src/server.js:705 | logical | `\|\|` → `&&` |  |
| `m-46da585d66` | src/server.js:705 | boundary | `>` → `>=` |  |
| `m-80406ce7a0` | src/server.js:705 | literal-boundary | `64` → `65` |  |
| `m-cd07d947e1` | src/server.js:705 | logical | `\|\|` → `&&` |  |
| `m-ce27b63a1f` | src/server.js:708 | guard-bypass | `typeof u.email !== 'string' \|\| u.email.length === 0 \|\| emails.has(u.email.toLowerCase())` → `false` |  |
| `m-e03aea8ae3` | src/server.js:708 | logical | `\|\|` → `&&` |  |
| `m-fce5241b9b` | src/server.js:708 | literal-boundary | `0` → `1` |  |
| `m-f5fae4e89b` | src/server.js:708 | logical | `\|\|` → `&&` |  |
| `m-53e789d937` | src/server.js:720 | logical | `\|\|` → `&&` |  |
| `m-d6298bfec2` | src/server.js:721 | logical | `\|\|` → `&&` |  |
| `m-10f385df80` | src/server.js:722 | guard-bypass | `!Array.isArray(payments)` → `false` |  |
| `m-d589877886` | src/server.js:723 | guard-bypass | `!Array.isArray(requests)` → `false` |  |
| `m-6cb665550d` | src/server.js:727 | guard-bypass | `!isObject(p)` → `false` |  |
| `m-49cb375c8a` | src/server.js:728 | guard-bypass | `typeof p.id !== 'string' \|\| p.id.length === 0 \|\| p.id.length > 64 \|\| paymentIds.has(p.id)` → `false` |  |
| `m-2f381d42fb` | src/server.js:728 | logical | `\|\|` → `&&` |  |
| `m-4b4df51b44` | src/server.js:728 | literal-boundary | `0` → `1` |  |
| `m-a2d2214c48` | src/server.js:728 | logical | `\|\|` → `&&` |  |
| `m-9580081ae7` | src/server.js:728 | boundary | `>` → `>=` |  |
| `m-f2ede8add5` | src/server.js:728 | literal-boundary | `64` → `65` |  |
| `m-a6ad27d358` | src/server.js:728 | logical | `\|\|` → `&&` |  |
| `m-d50ebe27de` | src/server.js:730 | boundary | `<` → `<=` |  |
| `m-1e86e60046` | src/server.js:730 | literal-boundary | `0` → `1` |  |
| `m-c190676be0` | src/server.js:731 | logical | `\|\|` → `&&` |  |
| `m-331b205349` | src/server.js:732 | guard-bypass | `!VISIBILITIES.has(visibility)` → `false` |  |
| `m-0183ca07d0` | src/server.js:733 | statement-deletion | `paymentIds.add(p.id);` → `;` |  |
| `m-822514455e` | src/server.js:746 | guard-bypass | `!isObject(r)` → `false` |  |
| `m-2a1a6e7125` | src/server.js:747 | guard-bypass | `typeof r.id !== 'string' \|\| r.id.length === 0 \|\| r.id.length > 64 \|\| requestIds.has(r.id)` → `false` |  |
| `m-f26cdb369e` | src/server.js:747 | logical | `\|\|` → `&&` |  |
| `m-370f64110e` | src/server.js:747 | literal-boundary | `0` → `1` |  |
| `m-174267ae65` | src/server.js:747 | logical | `\|\|` → `&&` |  |
| `m-4813de37c8` | src/server.js:747 | boundary | `>` → `>=` |  |
| `m-c0ee9d02d0` | src/server.js:747 | literal-boundary | `64` → `65` |  |
| `m-b78e13930d` | src/server.js:747 | logical | `\|\|` → `&&` |  |
| `m-b7a58fa447` | src/server.js:748 | guard-bypass | `!ids.has(r.requester_id) \|\| !ids.has(r.payer_id)` → `false` |  |
| `m-87fe2a2f3d` | src/server.js:748 | logical | `\|\|` → `&&` |  |
| `m-ed991d87ca` | src/server.js:749 | guard-bypass | `!isSafeInt(r.amount) \|\| r.amount < 0` → `false` |  |
| `m-d54addfcd5` | src/server.js:749 | logical | `\|\|` → `&&` |  |
| `m-faf9ad3f01` | src/server.js:749 | boundary | `<` → `<=` |  |
| `m-4245bd0e8c` | src/server.js:749 | literal-boundary | `0` → `1` |  |
| `m-d135e371e3` | src/server.js:750 | logical | `\|\|` → `&&` |  |
| `m-fd149a0cd7` | src/server.js:752 | statement-deletion | `requestIds.add(r.id);` → `;` |  |
| `m-d20f32595e` | src/server.js:758 | equality-negation | `===` → `!==` |  |
| `m-36f9146c3e` | src/server.js:787 | arithmetic | `+` → `-` |  |
| `m-57968b4b73` | src/server.js:788 | literal-boundary | `0` → `1` |  |
| `m-cbff45532a` | src/server.js:790 | statement-deletion | `i += 1;` → `;` |  |
| `m-6cd66f9fee` | src/server.js:790 | compound-assignment | `+=` → `-=` |  |
| `m-385f839863` | src/server.js:790 | literal-boundary | `1` → `2` |  |
| `m-02bd5388ef` | src/server.js:792 | arithmetic | `-` → `+` |  |
| `m-3f3c8e5977` | src/server.js:792 | arithmetic | `-` → `+` |  |
| `m-1ef38d9fb2` | src/server.js:792 | arithmetic | `-` → `+` |  |
| `m-d9555db638` | src/server.js:792 | literal-boundary | `1` → `2` |  |
| `m-2c8d1aca14` | src/server.js:800 | statement-deletion | `st.lastTs = Math.max(st.lastTs, base);` → `;` |  |
| `m-7d8dc7b82f` | src/server.js:845 | logical | `&&` → `\|\|` |  |
| `m-c7e74f8bcf` | src/server.js:846 | boundary | `>` → `>=` |  |
| `m-87302f9cfb` | src/server.js:846 | literal-boundary | `0` → `1` |  |
| `m-8dbdfc2cae` | src/server.js:846 | boundary | `<=` → `<` |  |
| `m-ddde481d27` | src/server.js:846 | literal-boundary | `64` → `65` |  |
| `m-721134945b` | src/server.js:860 | literal-boundary | `0` → `1` |  |
| `m-2c256e8266` | src/server.js:861 | literal-boundary | `0` → `1` |  |
| `m-3a7c142620` | src/server.js:861 | literal-boundary | `3` → `4` |  |
| `m-839f7bc17e` | src/server.js:862 | guard-bypass | `!isCount(s.counter) \|\| !isCount(s.seq) \|\| !isCount(s.last_ts)` → `false` |  |
| `m-d8d1e2e47c` | src/server.js:862 | logical | `\|\|` → `&&` |  |
| `m-24af375a28` | src/server.js:862 | logical | `\|\|` → `&&` |  |
| `m-2b974d00f0` | src/server.js:864 | statement-deletion | `st.currency = s.currency;` → `;` |  |
| `m-6deee665f5` | src/server.js:865 | statement-deletion | `st.minorUnits = s.minor_units;` → `;` |  |
| `m-88be4a9265` | src/server.js:866 | statement-deletion | `st.counter = s.counter;` → `;` |  |
| `m-614f929860` | src/server.js:867 | statement-deletion | `st.seq = s.seq;` → `;` |  |
| `m-47f8858adf` | src/server.js:868 | statement-deletion | `st.lastTs = s.last_ts;` → `;` |  |
| `m-676c4baf75` | src/server.js:871 | logical | `\|\|` → `&&` |  |
| `m-c5c143762b` | src/server.js:874 | guard-bypass | `typeof u.display_name !== 'string'` → `false` |  |
| `m-5ff53ca016` | src/server.js:883 | literal-boundary | `0` → `1` |  |
| `m-1377666d49` | src/server.js:895 | boundary | `<` → `<=` |  |
| `m-81972d1282` | src/server.js:895 | literal-boundary | `0` → `1` |  |
| `m-8ab9a60a84` | src/server.js:897 | guard-bypass | `!isNullableString(p.request_id) \|\| !isNullableString(p.settlement_id)` → `false` |  |
| `m-aa16dcebae` | src/server.js:897 | logical | `\|\|` → `&&` |  |
| `m-7fc74df736` | src/server.js:898 | logical | `\|\|` → `&&` |  |
| `m-10bed28720` | src/server.js:907 | logical | `\|\|` → `&&` |  |
| `m-638ec2afae` | src/server.js:909 | guard-bypass | `!isSafeInt(r.amount) \|\| r.amount < 0` → `false` |  |
| `m-a7ed73f93d` | src/server.js:909 | logical | `\|\|` → `&&` |  |
| `m-dc74e6ce79` | src/server.js:909 | boundary | `<` → `<=` |  |
| `m-30d56c1efa` | src/server.js:909 | literal-boundary | `0` → `1` |  |
| `m-8523820780` | src/server.js:911 | guard-bypass | `!isNullableString(r.payment_id) \|\| !isNullableString(r.split_id)` → `false` |  |
| `m-9e7ea837dc` | src/server.js:911 | logical | `\|\|` → `&&` |  |
| `m-1c3e2d7040` | src/server.js:912 | guard-bypass | `typeof r.ts !== 'number' \|\| !Number.isFinite(r.ts) \|\| !isTsString(r.created_at) \|\| !isCount(r.seq)` → `false` |  |
| `m-4111232163` | src/server.js:912 | logical | `\|\|` → `&&` |  |
| `m-7f8513d8f4` | src/server.js:912 | logical | `\|\|` → `&&` |  |
| `m-2b1303adf8` | src/server.js:912 | logical | `\|\|` → `&&` |  |
| `m-1d83d3cd37` | src/server.js:921 | guard-bypass | `!isObject(sp) \|\| !isId(sp.id) \|\| st.splits.has(sp.id) \|\| !st.users.has(sp.requester)` → `false` |  |
| `m-859201692b` | src/server.js:921 | logical | `\|\|` → `&&` |  |
| `m-5d0cb3cf8f` | src/server.js:921 | logical | `\|\|` → `&&` |  |
| `m-6bcef38f6a` | src/server.js:921 | logical | `\|\|` → `&&` |  |
| `m-be851ce7cd` | src/server.js:922 | guard-bypass | `!isSafeInt(sp.amount) \|\| typeof sp.note !== 'string' \|\| !isTsString(sp.created_at)` → `false` |  |
| `m-0db27c8174` | src/server.js:922 | logical | `\|\|` → `&&` |  |
| `m-3f685996e9` | src/server.js:922 | logical | `\|\|` → `&&` |  |
| `m-c66f824328` | src/server.js:923 | guard-bypass | `!Array.isArray(sp.shares) \|\| !sp.shares.every((x) => isObject(x) && typeof x.handle === 'string' && isSafeInt(x.amount))` → `false` |  |
| `m-0b7e7bb8c7` | src/server.js:923 | logical | `\|\|` → `&&` |  |
| `m-7176fdd4be` | src/server.js:923 | logical | `&&` → `\|\|` |  |
| `m-8f58df63a3` | src/server.js:923 | logical | `&&` → `\|\|` |  |
| `m-77e19b67da` | src/server.js:926 | guard-bypass | `!Array.isArray(sp.request_ids) \|\| !sp.request_ids.every((id) => st.requests.has(id))` → `false` |  |
| `m-2986ba4bce` | src/server.js:926 | logical | `\|\|` → `&&` |  |
| `m-558cc7053f` | src/server.js:934 | guard-bypass | `!isObject(se) \|\| !isId(se.id) \|\| st.settlements.has(se.id)` → `false` |  |
| `m-4164af8496` | src/server.js:934 | logical | `\|\|` → `&&` |  |
| `m-9480c164b0` | src/server.js:934 | logical | `\|\|` → `&&` |  |
| `m-366129a51d` | src/server.js:935 | guard-bypass | `!Array.isArray(se.payment_ids) \|\| !se.payment_ids.every((id) => st.payments.has(id))` → `false` |  |
| `m-02fa4935c6` | src/server.js:935 | logical | `\|\|` → `&&` |  |
| `m-557d8c326c` | src/server.js:936 | guard-bypass | `!isTsString(se.committed_at)` → `false` |  |
| `m-8d922f017f` | src/server.js:942 | logical | `\|\|` → `&&` |  |
| `m-e588f8d0cc` | src/server.js:943 | logical | `\|\|` → `&&` |  |
| `m-f9acfa877e` | src/server.js:943 | logical | `\|\|` → `&&` |  |
| `m-b15542fb8a` | src/server.js:943 | literal-boundary | `0` → `1` |  |
| `m-4bf5bf080e` | src/server.js:943 | logical | `\|\|` → `&&` |  |
| `m-f49e4659db` | src/server.js:943 | logical | `\|\|` → `&&` |  |
| `m-3ab9b402e8` | src/server.js:1000 | guard-bypass | `res.headersSent \|\| res.destroyed` → `false` |  |
| `m-1ec8236ab3` | src/server.js:1000 | logical | `\|\|` → `&&` |  |
| `m-5a8188f402` | src/server.js:1001 | guard-bypass | `status === 204` → `false` |  |
| `m-591f6f3644` | src/server.js:1001 | literal-boundary | `204` → `205` |  |
| `m-5574c77b85` | src/server.js:1018 | statement-deletion | `console.error(e);` → `;` |  |
| `m-29e21ec300` | src/server.js:1019 | statement-deletion | `send(res, 500, { error: { code: 'internal_error', message: 'internal error' } });` → `;` |  |
| `m-70dba4bfce` | src/server.js:1019 | literal-boundary | `500` → `501` |  |
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
| `m-0b4fdb60c1` | src/server.js:1063 | literal-boundary | `64` → `65` |  |
| `m-09db0fefb8` | src/server.js:1063 | literal-boundary | `1024` → `1025` |  |
| `m-2af82f23bf` | src/server.js:1064 | statement-deletion | `server.keepAliveTimeout = 75 * 1000;` → `;` |  |
| `m-b2b7220559` | src/server.js:1064 | literal-boundary | `75` → `76` |  |
| `m-3510900e37` | src/server.js:1064 | literal-boundary | `1000` → `1001` |  |
| `m-02fe3714d4` | src/server.js:1065 | statement-deletion | `server.headersTimeout = 76 * 1000;` → `;` |  |
| `m-102d3c5cb3` | src/server.js:1065 | literal-boundary | `76` → `77` |  |
| `m-31c460c75c` | src/server.js:1065 | literal-boundary | `1000` → `1001` |  |
| `m-aabb72392e` | src/server.js:1066 | statement-deletion | `server.requestTimeout = 0;` → `;` |  |
| `m-88ce05de6b` | src/server.js:1066 | literal-boundary | `0` → `1` |  |
| `m-6a5d2c86b1` | src/server.js:1068 | statement-deletion | `console.log(`pocketful stage 1 listening on 0.0.0.0:${port}`);` → `;` |  |
| `m-d4b2421473` | src/server.js:1070 | statement-deletion | `hashPassword(crypto.randomBytes(12).toString('hex')).then((h) => { dummyHash = h; });` → `;` |  |
| `m-d332e7c718` | src/server.js:1070 | literal-boundary | `12` → `13` |  |
| `m-287b9e4efa` | src/server.js:1071 | literal-boundary | `0` → `1` |  |
| `m-475473ce21` | src/server.js:1071 | logical | `&&` → `\|\|` |  |
| `m-2a0e5e700f` | src/server.js:1071 | literal-boundary | `0` → `1` |  |
| `m-af20daadda` | src/server.js:1071 | literal-boundary | `500` → `501` |  |
| `m-5e03ed8c9a` | src/server.js:1072 | statement-deletion | `process.on('SIGTERM', stop);` → `;` |  |
| `m-126fe27986` | src/server.js:1073 | statement-deletion | `process.on('SIGINT', stop);` → `;` |  |
| `m-eb5f42efce` | src/server.js:1079 | statement-deletion | `module.exports = { start, equalSplit, deriveHandle, canonical };` → `;` |  |

## Timeout (6)

| id | location | operator | change | note |
|---|---|---|---|---|
| `m-c4d2afce4e` | src/server.js:144 | statement-deletion | `st.counter += 1;` → `;` |  |
| `m-5f5c14093a` | src/server.js:145 | statement-deletion | `id = prefix + st.counter;` → `;` |  |
| `m-634ea18039` | src/server.js:145 | arithmetic | `+` → `-` |  |
| `m-1a4979bc60` | src/server.js:1003 | statement-deletion | `res.end();` → `;` |  |
| `m-0bfb823b99` | src/server.js:1016 | statement-deletion | `send(res, e.status, { error: { code: e.code, message: e.message } });` → `;` |  |
| `m-6fb7449647` | src/server.js:1056 | statement-deletion | `sendError(res, e);` → `;` |  |
