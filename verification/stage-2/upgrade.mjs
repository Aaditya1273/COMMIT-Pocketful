#!/usr/bin/env node
// R2-02: an export from the accepted stage-1 service imports into stage 2 with tokens,
// pending requests, idempotency records (a lost-response payment replays) and balances.
// usage: node upgrade.mjs <stage-1 url> <stage-2 url>
import { client, code, fixture, seed, newKey, deepEqual } from './lib.mjs';
const [u1, u2] = process.argv.slice(2);
const c1 = client(u1), c2 = client(u2);
const fails = []; let n = 0;
const ok = (l, cond) => { n++; if (!cond) fails.push(l); };
const s = await seed(c1, fixture());
const key = newKey('lost');
const lost = await c1.req('POST', '/payments', { token: s.tok.ada, key, body: { to_handle: 'bob', amount: 700, note: 'lost response' } });
const q = await c1.req('POST', '/requests', { token: s.tok.bob, key: newKey(), body: { payer_handle: 'ada', amount: 300 } });
const st = await c1.req('POST', '/settlements', { token: s.tok.op, key: newKey(), body: { transfers: [{ from_handle: 'dan', to_handle: 'cy', amount: 5 }] } });
const exp = await c1.req('GET', '/_test/export');
ok('stage-1 export', exp.status === 200 && exp.body?.format_version === 1);
const r = await c2.req('POST', '/_test/import', { body: exp.body });
ok(`stage-2 imports the stage-1 export (${r.status} ${r.text.slice(0, 120)})`, r.status === 204);
const me = (await c2.req('GET', '/me', { token: s.tok.ada })).body;
ok(`old token works; /me gains total/available/held (${JSON.stringify(me)})`, me?.balance === 9300 && me?.total === 9300 && me?.available === 9300 && me?.held === 0);
const rep = await c2.req('POST', '/payments', { token: s.tok.ada, key, body: { to_handle: 'bob', amount: 700, note: 'lost response' } });
ok(`lost-response payment replays 200 with the original body (${rep.status})`, rep.status === 200 && deepEqual(rep.body, lost.body));
ok('balance unchanged by the replay', (await c2.req('GET', '/me', { token: s.tok.ada })).body?.total === 9300);
const pay = await c2.req('POST', `/requests/${q.body.request_id}/pay`, { token: s.tok.ada, key: newKey(), body: {} });
ok(`pending stage-1 request payable after upgrade (${pay.status})`, pay.status === 201 && pay.body?.authorization_id === null && pay.body?.request_id === q.body.request_id);
const feed = (await c2.req('GET', '/activity?limit=200', { token: s.tok.cy })).body?.payments ?? [];
ok('imported payments carry authorization_id null', feed.length > 0 && feed.every((p) => p.authorization_id === null || typeof p.authorization_id === 'string') && feed.find((p) => p.payment_id === st.body?.payments?.[0]?.payment_id)?.authorization_id === null);
const a = await c2.req('POST', '/authorizations', { token: s.tok.ada, key: newKey(), body: { to_handle: 'bob', amount: 100 } });
ok(`authorizations work after upgrade, default ttl 600 (${a.status})`, a.status === 201 && Date.parse(a.body?.expires_at) - Date.parse(a.body?.created_at) === 600000);
ok('operator kept', (await c2.req('POST', '/settlements', { token: s.tok.op, key: newKey(), body: { transfers: [{ from_handle: 'dan', to_handle: 'cy', amount: 1 }] } })).status === 201);
const ex2 = await c2.req('GET', '/_test/export');
ok('stage-2 re-export imports into stage-2', (await c2.req('POST', '/_test/import', { body: ex2.body })).status === 204 && (await c2.req('GET', '/me', { token: s.tok.ada })).body?.held === 100);
if (c1.violations.length || c2.violations.length) fails.push(...c1.violations, ...c2.violations);
console.log(fails.length ? `upgrade: ${fails.length} of ${n} failed\n  ${fails.join('\n  ')}` : `upgrade: ${n}/${n} passed`);
process.exit(fails.length ? 1 : 0);
void code;
