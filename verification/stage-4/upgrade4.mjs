#!/usr/bin/env node
// R4-09 (stage-3 → stage-4 with corrections and snapshots) and R4-08 (concurrent single and
// batch corrections sharing an expected revision). usage: node upgrade4.mjs S3_URL S4_URL
import { client, fixture, seed, newKey, deepEqual } from './lib.mjs';
const [u3, u4] = process.argv.slice(2);
const c3 = client(u3), c4 = client(u4);
const fails = []; let n = 0;
const ok = (l, cond) => { n++; if (!cond) fails.push(l); };
const q = encodeURIComponent;

const s = await seed(c3, fixture({ payments: [], requests: [] }));
const p = (await c3.req('POST', '/payments', { token: s.tok.ada, key: 'k1', body: { to_handle: 'bob', amount: 900 } })).body;
const cr = (await c3.req('POST', `/payments/${p.payment_id}/corrections`, { token: s.tok.ada, key: 'kc', body: { expected_revision: 1, amount: 700, effective_at: p.created_at, reason: 'fix' } })).body;
const st = (await c3.req('POST', '/settlements', { token: s.tok.op, key: 'ks', body: { transfers: [{ from_handle: 'dan', to_handle: 'cy', amount: 30 }, { from_handle: 'cy', to_handle: 'bob', amount: 10 }] } })).body;
const snapRes = (await c3.req('GET', '/statement?limit=1', { token: s.tok.ada })).body;
const frozen = (await c3.req('GET', `/statement?snapshot=${q(snapRes.snapshot)}&limit=200`, { token: s.tok.ada })).body;
const exp = (await c3.req('GET', '/_test/export')).body;
const r = await c4.req('POST', '/_test/import', { body: exp });
ok(`stage-3 export imports into stage 4 (${r.status})`, r.status === 204);
ok('balances kept', (await c4.req('GET', '/me', { token: s.tok.ada })).body?.balance === 9300);
const rv = (await c4.req('GET', `/payments/${p.payment_id}/revisions`, { token: s.tok.ada })).body?.revisions;
ok(`corrections kept (${JSON.stringify(rv?.map((x) => [x.revision, x.amount]))})`, rv?.length === 2 && rv[1].amount === 700);
const again = (await c4.req('GET', `/statement?snapshot=${q(snapRes.snapshot)}&limit=200`, { token: s.tok.ada })).body;
ok('snapshot kept across the upgrade', deepEqual([again?.entries?.map((e) => [e.payment.payment_id, e.revision, e.delta]), again?.closing_balance], [frozen.entries.map((e) => [e.payment.payment_id, e.revision, e.delta]), frozen.closing_balance]));
const rep = await c4.req('POST', `/payments/${p.payment_id}/corrections`, { token: s.tok.ada, key: 'kc', body: { expected_revision: 1, amount: 700, effective_at: p.created_at, reason: 'fix' } });
ok('correction replay after upgrade', rep.status === 200 && rep.body?.revision === cr.revision && rep.body?.amount === 700);
const rs = await c4.req('POST', '/settlements', { token: s.tok.op, key: 'ks', body: { transfers: [{ from_handle: 'dan', to_handle: 'cy', amount: 30 }, { from_handle: 'cy', to_handle: 'bob', amount: 10 }] } });
ok('settlement retry returns the original body', rs.status === 200 && deepEqual(rs.body, st));
const b = await c4.req('POST', '/correction-batches', { token: s.tok.op, key: newKey(), body: { corrections: st.payments.map((m) => ({ payment_id: m.payment_id, expected_revision: 1, amount: m.amount, effective_at: st.committed_at, reason: 'membership kept' })) } });
ok(`settlement membership kept: complete batch succeeds (${b.status})`, b.status === 201);
const inc = await c4.req('POST', '/correction-batches', { token: s.tok.op, key: newKey(), body: { corrections: [{ payment_id: st.payments[0].payment_id, expected_revision: 2, amount: 1, effective_at: st.committed_at, reason: 'x' }] } });
ok(`incomplete batch after upgrade → 422 incomplete_settlement (${inc.status})`, inc.status === 422 && inc.body?.error?.code === 'incomplete_settlement');
const rf = await c4.req('POST', `/payments/${p.payment_id}/refunds`, { token: s.tok.bob, key: newKey(), body: { amount: 701 } });
ok('refund limit is the imported corrected amount', rf.status === 422 && rf.body?.error?.code === 'refund_exceeds_payment');

// Concurrency: single and batch corrections sharing an expected revision; at most one wins.
for (let round = 0; round < 5; round++) {
  const s2 = await seed(c4, fixture({ payments: [], requests: [] }));
  const pp = (await c4.req('POST', '/payments', { token: s2.tok.ada, key: newKey(), body: { to_handle: 'bob', amount: 500 } })).body;
  const body = (amount) => ({ expected_revision: 1, amount, effective_at: pp.created_at, reason: 'race' });
  const ops = [];
  for (let i = 0; i < 10; i++) {
    ops.push(c4.req('POST', `/payments/${pp.payment_id}/corrections`, { token: s2.tok.ada, key: newKey(), body: body(400 - i) }));
    ops.push(c4.req('POST', '/correction-batches', { token: s2.tok.op, key: newKey(), body: { corrections: [{ payment_id: pp.payment_id, ...body(300 - i) }] } }));
  }
  const res = await Promise.all(ops);
  const wins = res.filter((x) => x.status === 201);
  ok(`round ${round}: exactly one of 20 single/batch corrections wins (${wins.length}; ${[...new Set(res.map((x) => x.status + ' ' + (x.body?.error?.code ?? '')))]})`, wins.length === 1 && res.every((x) => x.status === 201 || (x.status === 409 && x.body?.error?.code === 'stale_revision')));
  const revs = (await c4.req('GET', `/payments/${pp.payment_id}/revisions`, { token: s2.tok.ada })).body.revisions;
  const amt = wins[0]?.body?.amount ?? wins[0]?.body?.revisions?.[0]?.amount;
  ok(`round ${round}: one revision appended, money matches`, revs.length === 2 && (await c4.req('GET', '/me', { token: s2.tok.bob })).body.balance === 2500 + amt);
}
if (c3.violations.length || c4.violations.length) fails.push(...c3.violations, ...c4.violations);
console.log(fails.length ? `upgrade4: ${fails.length} of ${n} failed\n  ${fails.join('\n  ')}` : `upgrade4: ${n}/${n} passed`);
process.exit(fails.length ? 1 : 0);
