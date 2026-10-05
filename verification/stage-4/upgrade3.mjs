#!/usr/bin/env node
// R3-13: exports from the accepted stage-1 and stage-2 services import into stage 3 with
// revision 1 for every payment, statements that close at the current balance, linked
// payments immutable, holds/captures accounted for. usage: node upgrade3.mjs S1_URL S2_URL S3_URL
import { client, fixture, seed, newKey, deepEqual } from './lib.mjs';
const [u1, u2, u3] = process.argv.slice(2);
const c3 = client(u3);
const fails = []; let n = 0;
const ok = (l, cond) => { n++; if (!cond) fails.push(l); };
const q = encodeURIComponent;

async function scenario(label, src, withHolds) {
  const cs = client(src);
  const s = await seed(cs, fixture());
  const key = newKey('lost');
  const lost = await cs.req('POST', '/payments', { token: s.tok.ada, key, body: { to_handle: 'bob', amount: 700 } });
  const st = await cs.req('POST', '/settlements', { token: s.tok.op, key: newKey(), body: { transfers: [{ from_handle: 'dan', to_handle: 'cy', amount: 50 }, { from_handle: 'dan', to_handle: 'bob', amount: 25 }] } });
  let cap = null, openAuth = null;
  if (withHolds) {
    const a = (await cs.req('POST', '/authorizations', { token: s.tok.dan, key: newKey(), body: { to_handle: 'cy', amount: 1000 } })).body;
    cap = (await cs.req('POST', `/authorizations/${a.authorization_id}/capture`, { token: s.tok.cy, key: newKey(), body: { amount: 300, final: false } })).body;
    openAuth = a;
  }
  const before = {};
  for (const h of Object.keys(s.tok)) before[h] = (await cs.req('GET', '/me', { token: s.tok[h] })).body;
  const exp = (await cs.req('GET', '/_test/export')).body;
  const r = await c3.req('POST', '/_test/import', { body: exp });
  ok(`${label}: import ${r.status} ${r.text.slice(0, 120)}`, r.status === 204);
  let sum = 0;
  for (const h of Object.keys(s.tok)) {
    const m = (await c3.req('GET', '/me', { token: s.tok[h] })).body;
    sum += m?.balance;
    ok(`${label}: ${h} balance kept (${m?.balance} vs ${before[h].balance})`, m?.balance === before[h].balance);
    if (withHolds) ok(`${label}: ${h} held kept`, m?.held === before[h].held && m?.available === before[h].available);
    const stt = (await c3.req('GET', '/statement?limit=200', { token: s.tok[h] })).body;
    ok(`${label}: ${h} statement closes at the balance and opening+deltas=closing`, stt?.closing_balance === m?.balance && stt.opening_balance + stt.entries.reduce((x, e) => x + e.delta, 0) === stt.closing_balance);
    ok(`${label}: ${h} entries are revision 1 at created_at`, stt.entries.every((e) => e.revision === 1 && Date.parse(e.effective_at) === Date.parse(e.payment.created_at) && e.recorded_at === e.effective_at || Date.parse(e.recorded_at) === Date.parse(e.effective_at)));
  }
  ok(`${label}: sum kept`, sum === 17500);
  const rep = await c3.req('POST', '/payments', { token: s.tok.ada, key, body: { to_handle: 'bob', amount: 700 } });
  ok(`${label}: lost payment replays identical`, rep.status === 200 && deepEqual(rep.body, lost.body));
  const rv = await c3.req('GET', `/payments/${lost.body.payment_id}/revisions`, { token: s.tok.bob });
  ok(`${label}: revision 1 present`, rv.status === 200 && rv.body.revisions.length === 1 && rv.body.revisions[0].amount === 700 && rv.body.revisions[0].reason === '');
  const mem = st.body.payments[0];
  const rmem = (await c3.req('GET', `/payments/${mem.payment_id}/revisions`, { token: s.tok.dan })).body?.revisions?.[0];
  ok(`${label}: settlement member revision 1 at committed_at`, rmem && Date.parse(rmem.effective_at) === Date.parse(st.body.committed_at) && Date.parse(rmem.recorded_at) === Date.parse(st.body.committed_at));
  const lm = await c3.req('POST', `/payments/${mem.payment_id}/corrections`, { token: s.tok.dan, key: newKey(), body: { expected_revision: 1, amount: 40, effective_at: mem.created_at, reason: 'x' } });
  ok(`${label}: settlement member correction → 422 linked_payment_immutable (${lm.status})`, lm.status === 422 && lm.body?.error?.code === 'linked_payment_immutable');
  const openBefore = (await c3.req('GET', '/statement?limit=200', { token: s.tok.ada })).body.opening_balance;
  ok(`${label}: ada opening = seeded 10000 + seeded p_1 500 (${openBefore})`, openBefore === 10500);
  const cr = await c3.req('POST', `/payments/${lost.body.payment_id}/corrections`, { token: s.tok.ada, key: newKey(), body: { expected_revision: 1, amount: 600, effective_at: lost.body.created_at, reason: 'post-upgrade' } });
  ok(`${label}: imported payment correctable (${cr.status})`, cr.status === 201);
  const ada = (await c3.req('GET', '/statement?limit=200', { token: s.tok.ada })).body;
  ok(`${label}: correction keeps the opening balance`, ada.opening_balance === openBefore);
  if (withHolds) {
    const cc = await c3.req('POST', `/payments/${cap.payment_id}/corrections`, { token: s.tok.dan, key: newKey(), body: { expected_revision: 1, amount: 1, effective_at: cap.created_at, reason: 'x' } });
    ok(`${label}: capture correction → 422 linked (${cc.status})`, cc.status === 422 && cc.body?.error?.code === 'linked_payment_immutable');
    const au = ((await c3.req('GET', '/authorizations', { token: s.tok.dan })).body.authorizations).find((a) => a.authorization_id === openAuth.authorization_id);
    ok(`${label}: open hold imported with closed_at null`, au?.status === 'open' && au?.closed_at === null && au?.remaining_amount === 700);
    const hist = (await c3.req('GET', `/me?as_of=${q(cap.created_at)}`, { token: s.tok.dan })).body;
    ok(`${label}: historical held at the capture = 700 (${hist?.held})`, hist?.held === 700);
    const capNow = await c3.req('POST', `/authorizations/${openAuth.authorization_id}/capture`, { token: s.tok.cy, key: newKey(), body: {} });
    ok(`${label}: open hold capturable after upgrade`, capNow.status === 201);
    const es = (await c3.req('GET', '/statement?limit=200', { token: s.tok.cy })).body.entries;
    ok(`${label}: each capture once in the statement`, es.filter((e) => e.payment.authorization_id === openAuth.authorization_id).length === 2);
  }
  if (cs.violations.length) fails.push(...cs.violations);
}
await scenario('stage-1 → stage-3', u1, false);
await scenario('stage-2 → stage-3', u2, true);
if (c3.violations.length) fails.push(...c3.violations);
console.log(fails.length ? `upgrade3: ${fails.length} of ${n} failed\n  ${fails.join('\n  ')}` : `upgrade3: ${n}/${n} passed`);
process.exit(fails.length ? 1 : 0);
