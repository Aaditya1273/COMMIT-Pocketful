#!/usr/bin/env node
// Stage-4 contract checks: refunds, refund_of, corrections vs refunded amounts, correction
// batches (authority, shape, item precedence, settlement completeness, identical instants,
// combined affordability, shared recorded_at, replay, atomic rejection), snapshots.
// Written from pocketful/spec/stage-4.md (planner decisions tagged plan:A4-nn).
import { writeFileSync } from 'node:fs';
import { client, code, fixture, seed, newKey, deepEqual } from './lib.mjs';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : a), []));
const c = client(args['base-url']);
const results = [];
async function t(id, reqs, fn) {
  if (args.only && !id.includes(args.only)) return;
  const fails = [];
  const A = {
    eq(a, e, l) { if (!deepEqual(a, e)) fails.push(`${l}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)?.slice(0, 300)}`); },
    ok(cnd, l) { if (!cnd) fails.push(l); },
    err(r, s, cd, l) { if (r.status !== s || code(r) !== cd) fails.push(`${l}: expected ${s} ${cd}, got ${r.status} ${r.text?.slice(0, 200)}`); },
    st(r, s, l) { if (r.status !== s) fails.push(`${l}: expected ${s}, got ${r.status} ${r.text?.slice(0, 200)}`); },
  };
  try { await fn(A); } catch (e) { fails.push(`exception: ${e?.stack ?? e}`); }
  results.push({ id, requirements: reqs, passed: !fails.length, failures: fails });
  console.log(`${fails.length ? 'FAIL' : 'ok  '} ${id}${fails.length ? '\n      ' + fails.join('\n      ') : ''}`);
}
const q = encodeURIComponent;
const bal = async (s, h) => (await c.req('GET', '/me', { token: s.tok[h] })).body;
const pay = async (s, f, to, amount, extra = {}) => (await c.req('POST', '/payments', { token: s.tok[f], key: newKey(), body: { to_handle: to, amount, ...extra } })).body;
const refund = (s, who, pid, body, key = newKey('rf')) => c.req('POST', `/payments/${pid}/refunds`, { token: s.tok[who], key, body });
const correct = (s, who, pid, body) => c.req('POST', `/payments/${pid}/corrections`, { token: s.tok[who], key: newKey(), body });
const batch = (s, who, corrections, key = newKey('cb')) => c.req('POST', '/correction-batches', { token: s.tok[who], key, body: { corrections } });
const sum = async (s) => { let n = 0; for (const h of Object.keys(s.tok)) n += (await bal(s, h)).total; return n; };
const nowIso = () => new Date().toISOString().replace('Z', '+00:00');
const fx = () => fixture({ payments: [], requests: [] });

await t('refund-basics', ['R4-01', 'R4-02', 'plan:A4-01', 'plan:A4-02'], async (A) => {
  const s = await seed(c, fx());
  const p = await pay(s, 'ada', 'bob', 1000, { note: 'dinner', visibility: 'private' });
  A.eq(p.refund_of, null, 'ordinary payments carry refund_of null');
  const key = newKey();
  const r = await refund(s, 'bob', p.payment_id, { amount: 300 }, key);
  A.st(r, 201, 'refund');
  const b = r.body ?? {};
  A.eq([b.from_handle, b.to_handle, b.amount, b.refund_of, b.request_id, b.authorization_id, b.settlement_id, b.note, b.visibility], ['bob', 'ada', 300, p.payment_id, null, null, null, 'dinner', 'private'], 'refund is a reverse payment with refund_of');
  A.ok(b.payment_id && b.payment_id !== p.payment_id && typeof b.created_at === 'string', 'new payment id and created_at');
  A.eq([(await bal(s, 'ada')).total, (await bal(s, 'bob')).total], [9300, 3200], 'money moved back (bob 2500 + 1000 - 300)');
  const rep = await refund(s, 'bob', p.payment_id, { amount: 300 }, key);
  A.eq([rep.status, rep.body], [200, b], 'replay 200 original');
  A.err(await refund(s, 'bob', p.payment_id, { amount: 301 }, key), 409, 'idempotency_key_reuse', 'reuse');
  A.err(await refund(s, 'ada', p.payment_id, { amount: 1 }), 403, 'forbidden', 'sender cannot refund');
  A.err(await refund(s, 'cy', p.payment_id, { amount: 1 }), 403, 'forbidden', 'third party cannot refund');
  A.err(await refund(s, 'bob', 'nope', { amount: 1 }), 404, 'not_found', 'unknown payment');
  for (const v of [0, -1, 1.5, '5', null, true, 1000000001]) A.err(await refund(s, 'bob', p.payment_id, { amount: v }), 422, 'validation_failed', `amount ${JSON.stringify(v)}`);
  A.err(await refund(s, 'bob', p.payment_id, {}), 422, 'validation_failed', 'amount missing (plan:A4-01)');
  A.err(await c.req('POST', `/payments/${p.payment_id}/refunds`, { token: s.tok.bob, body: { amount: 1 } }), 400, 'missing_idempotency_key', 'key required');
  A.err(await c.req('POST', `/payments/${p.payment_id}/refunds`, { key: newKey(), body: { amount: 1 } }), 401, 'unauthenticated', 'token required');
  A.st(await refund(s, 'bob', p.payment_id, { amount: 700 }), 201, 'refund exactly the rest');
  A.err(await refund(s, 'bob', p.payment_id, { amount: 1 }), 422, 'refund_exceeds_payment', 'one more unit');
  A.err(await refund(s, 'ada', b.payment_id, { amount: 1 }), 422, 'invalid_refund_target', 'refund of a refund');
  A.err(await correct(s, 'bob', b.payment_id, { expected_revision: 1, amount: 1, effective_at: b.created_at, reason: 'x' }), 422, 'linked_payment_immutable', 'refund payment immutable');
  const feed = (await c.req('GET', '/activity?limit=200', { token: s.tok.ada })).body.payments;
  A.ok(feed.some((x) => x.payment_id === b.payment_id && x.refund_of === p.payment_id), 'refund in parties feed');
  A.ok(!(await c.req('GET', '/activity?limit=200', { token: s.tok.cy })).body.payments.some((x) => x.payment_id === b.payment_id), 'private refund hidden from third parties');
  const st = (await c.req('GET', '/statement?limit=200', { token: s.tok.bob })).body;
  A.ok(st.entries.some((e) => e.payment.payment_id === b.payment_id && e.delta === -300 && e.payment.refund_of === p.payment_id), 'refund in statement as a money movement');
  A.ok(st.entries.every((e) => 'refund_of' in e.payment), 'statement payments expose refund_of');
  A.eq(await sum(s), 17500, 'conservation');
});

await t('refund-available-and-corrected-limits', ['R4-01', 'R4-03', 'plan:edge-2', 'plan:edge-3'], async (A) => {
  const s = await seed(c, fx());
  const p = await pay(s, 'ada', 'cy', 400);
  await c.req('POST', '/authorizations', { token: s.tok.cy, key: newKey(), body: { to_handle: 'dan', amount: 400 } });
  A.eq((await bal(s, 'cy')).available, 0, 'cy has nothing available');
  A.err(await refund(s, 'cy', p.payment_id, { amount: 100 }), 409, 'insufficient_funds', 'refund debits available, held money excluded');
  const s2 = await seed(c, fx());
  const q1 = await pay(s2, 'ada', 'bob', 1000);
  A.st(await correct(s2, 'ada', q1.payment_id, { expected_revision: 1, amount: 600, effective_at: q1.created_at, reason: 'less' }), 201, 'correct down to 600');
  A.err(await refund(s2, 'bob', q1.payment_id, { amount: 601 }), 422, 'refund_exceeds_payment', 'limit is the corrected amount');
  A.st(await refund(s2, 'bob', q1.payment_id, { amount: 500 }), 201, 'refund within the corrected amount');
  A.err(await correct(s2, 'ada', q1.payment_id, { expected_revision: 2, amount: 499, effective_at: q1.created_at, reason: 'below refunded' }), 422, 'refund_exceeds_payment', 'correction below the refunded amount');
  A.st(await correct(s2, 'ada', q1.payment_id, { expected_revision: 2, amount: 500, effective_at: q1.created_at, reason: 'equal' }), 201, 'correction to exactly the refunded amount');
  const q2 = await pay(s2, 'dan', 'cy', 50);
  await correct(s2, 'dan', q2.payment_id, { expected_revision: 1, amount: 0, effective_at: q2.created_at, reason: 'void' });
  A.err(await refund(s2, 'cy', q2.payment_id, { amount: 1 }), 422, 'refund_exceeds_payment', 'after correction to 0 any refund exceeds');
  const rq = (await c.req('POST', '/requests', { token: s2.tok.cy, key: newKey(), body: { payer_handle: 'dan', amount: 70 } })).body;
  const rp = (await c.req('POST', `/requests/${rq.request_id}/pay`, { token: s2.tok.dan, key: newKey(), body: {} })).body;
  const rr = await refund(s2, 'cy', rp.payment_id, { amount: 70 });
  A.eq([rr.status, rr.body?.request_id], [201, null], 'request payment refundable; refund has request_id null');
  A.eq((await c.req('GET', '/requests?limit=200', { token: s2.tok.cy })).body.requests.find((x) => x.request_id === rq.request_id)?.status, 'paid', 'refund never reopens the request');
  const au = (await c.req('POST', '/authorizations', { token: s2.tok.dan, key: newKey(), body: { to_handle: 'cy', amount: 200 } })).body;
  const cap = (await c.req('POST', `/authorizations/${au.authorization_id}/capture`, { token: s2.tok.cy, key: newKey(), body: { amount: 150 } })).body;
  const cr = await refund(s2, 'cy', cap.payment_id, { amount: 150 });
  A.eq([cr.status, cr.body?.authorization_id, cr.body?.refund_of], [201, null, cap.payment_id], 'capture refundable; refund has authorization_id null');
  const a2 = ((await c.req('GET', '/authorizations', { token: s2.tok.dan })).body.authorizations).find((x) => x.authorization_id === au.authorization_id);
  A.eq([a2.status, (await bal(s2, 'dan')).held], ['captured', 0], 'refund never reopens the authorization or restores the hold');
  A.err(await correct(s2, 'dan', cap.payment_id, { expected_revision: 1, amount: 1, effective_at: cap.created_at, reason: 'x' }), 422, 'linked_payment_immutable', 'capture still immutable');
  const st = await c.req('POST', '/settlements', { token: s2.tok.op, key: newKey(), body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 40 }] } });
  const sr = await refund(s2, 'bob', st.body.payments[0].payment_id, { amount: 10 });
  A.eq([sr.status, sr.body?.settlement_id], [201, null], 'settlement member refundable; refund is not a member');
  const replaySt = await c.req('POST', '/settlements', { token: s2.tok.op, key: st.req?.key ?? newKey(), body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 40 }] } });
  void replaySt;
  A.eq(await sum(s2), 17500, 'conservation');
});

await t('correction-batches', ['R4-04', 'R4-05', 'R4-06', 'R4-07', 'plan:A4-03', 'plan:A4-04', 'plan:A4-05'], async (A) => {
  const s = await seed(c, fx());
  const st = (await c.req('POST', '/settlements', { token: s.tok.op, key: 'st1', body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 300 }, { from_handle: 'dan', to_handle: 'cy', amount: 200 }] } })).body;
  const [m1, m2] = st.payments;
  const p = await pay(s, 'ada', 'cy', 100);
  const item = (pp, amount, eff = pp.created_at, rev = 1) => ({ payment_id: pp.payment_id, expected_revision: rev, amount, effective_at: eff, reason: 'batch' });
  A.err(await c.req('POST', '/correction-batches', { key: newKey(), body: { corrections: [item(p, 50)] } }), 401, 'unauthenticated', 'no token');
  A.err(await batch(s, 'ada', [item(p, 50)]), 403, 'forbidden', 'non-operator');
  A.err(await c.req('POST', '/correction-batches', { token: s.tok.op, body: { corrections: [item(p, 50)] } }), 400, 'missing_idempotency_key', 'key');
  A.err(await batch(s, 'op', []), 422, 'validation_failed', '0 items');
  A.err(await batch(s, 'op', Array.from({ length: 33 }, () => item(p, 50))), 422, 'validation_failed', '33 items');
  A.err(await batch(s, 'op', [item(p, 50), item(p, 60)]), 422, 'validation_failed', 'duplicate payment_id');
  A.err(await c.req('POST', '/correction-batches', { token: s.tok.op, key: newKey(), body: { corrections: 'x' } }), 422, 'validation_failed', 'non-array (plan:A4-05)');
  A.err(await batch(s, 'op', [5]), 422, 'validation_failed', 'non-object item');
  A.err(await batch(s, 'op', [{ ...item(p, 50), reason: '' }]), 422, 'validation_failed', 'item validation');
  A.err(await batch(s, 'op', [{ ...item(p, 50), effective_at: new Date(Date.now() + 3600e3).toISOString() }]), 422, 'validation_failed', 'future effective time');
  A.err(await batch(s, 'op', [item(p, 50, p.created_at, 2), { ...item(p, 1), payment_id: 'ghost' }]), 409, 'stale_revision', 'item 1 stale before item 2 unknown');
  A.err(await batch(s, 'op', [{ ...item(p, 1), payment_id: 'ghost' }, item(p, 50, p.created_at, 2)]), 404, 'not_found', 'item 1 unknown before item 2 stale');
  A.err(await batch(s, 'op', [item(m1, 100, st.committed_at)]), 422, 'incomplete_settlement', 'missing a settlement member');
  A.err(await batch(s, 'op', [item(m1, 100, st.committed_at), item(m2, 100, p.created_at)]), 422, 'validation_failed', 'members with different instants');
  const before = [(await bal(s, 'ada')).total, (await bal(s, 'bob')).total, (await bal(s, 'cy')).total, (await bal(s, 'dan')).total];
  const zSpelling = new Date(Date.parse(st.committed_at)).toISOString();
  const key = newKey();
  const ok = await batch(s, 'op', [item(m1, 100, st.committed_at), item(m2, 50, zSpelling), item(p, 0)], key);
  A.st(ok, 201, 'complete settlement (Z and +00:00 spellings) plus an ordinary payment');
  A.eq(Object.keys(ok.body ?? {}).sort(), ['correction_batch_id', 'recorded_at', 'revisions'], 'batch fields');
  A.eq(ok.body?.revisions?.map((r) => [r.payment_id, r.revision, r.amount, r.correction_batch_id]), [[m1.payment_id, 2, 100, ok.body?.correction_batch_id], [m2.payment_id, 2, 50, ok.body?.correction_batch_id], [p.payment_id, 2, 0, ok.body?.correction_batch_id]], 'revisions in input order with correction_batch_id');
  A.ok(ok.body?.revisions?.every((r) => r.recorded_at === ok.body.recorded_at), 'shared recorded_at');
  A.eq([(await bal(s, 'ada')).total, (await bal(s, 'bob')).total, (await bal(s, 'cy')).total, (await bal(s, 'dan')).total], [before[0] + 200 + 100, before[1] - 200, before[2] - 150 - 100, before[3] + 150], 'combined money movement');
  const rep = await batch(s, 'op', [item(m1, 100, st.committed_at), item(m2, 50, zSpelling), item(p, 0)], key);
  A.eq([rep.status, rep.body], [200, ok.body], 'replay 200 original batch');
  const rv = (await c.req('GET', `/payments/${m1.payment_id}/revisions`, { token: s.tok.ada })).body.revisions;
  A.eq(rv.map((r) => r.correction_batch_id), [null, ok.body.correction_batch_id], 'correction_batch_id on revision objects (null for revision 1) (plan:A4-04)');
  const rs = await c.req('POST', '/settlements', { token: s.tok.op, key: 'st1', body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 300 }, { from_handle: 'dan', to_handle: 'cy', amount: 200 }] } });
  A.eq([rs.status, rs.body], [200, st], 'original settlement retry returns the original body');
  A.err(await correct(s, 'ada', m1.payment_id, { expected_revision: 2, amount: 1, effective_at: st.committed_at, reason: 'x' }), 422, 'linked_payment_immutable', 'single correction of a member still immutable');
  A.eq(await sum(s), 17500, 'conservation');
});

await t('batch-affordability-and-atomicity', ['R4-06', 'plan:edge-8'], async (A) => {
  const s = await seed(c, fx());
  const p1 = await pay(s, 'ada', 'cy', 400); // cy 400
  const p2 = await pay(s, 'cy', 'dan', 400); // cy 0
  const it = (pp, amount) => ({ payment_id: pp.payment_id, expected_revision: 1, amount, effective_at: pp.created_at, reason: 'r' });
  A.err(await batch(s, 'op', [it(p1, 0)]), 409, 'insufficient_funds', 'alone: cy cannot give back 400');
  const k = newKey();
  const ok = await batch(s, 'op', [it(p1, 0), it(p2, 0)], k);
  A.st(ok, 201, 'combined effect affordable');
  A.eq([(await bal(s, 'ada')).total, (await bal(s, 'cy')).total, (await bal(s, 'dan')).total], [10000, 0, 5000], 'both reversed');
  const s2 = await seed(c, fx());
  const a = await pay(s2, 'ada', 'cy', 400);
  const b = await pay(s2, 'cy', 'dan', 400);
  await pay(s2, 'dan', 'cy', 400); // cy back to 400
  const snap = (await c.req('GET', '/statement?limit=200', { token: s2.tok.cy })).body;
  const before = [(await bal(s2, 'cy')).total, (await bal(s2, 'ada')).total];
  const key = newKey();
  A.err(await batch(s2, 'op', [{ payment_id: a.payment_id, expected_revision: 1, amount: 0, effective_at: a.created_at, reason: 'r' }], key), 409, 'historical_overdraft', 'affordable now, negative in the past');
  A.eq([(await bal(s2, 'cy')).total, (await bal(s2, 'ada')).total], before, 'rejected batch changes nothing');
  A.eq((await c.req('GET', `/payments/${a.payment_id}/revisions`, { token: s2.tok.ada })).body.revisions.length, 1, 'no revision appended');
  A.st(await batch(s2, 'op', [{ payment_id: b.payment_id, expected_revision: 1, amount: 400, effective_at: b.created_at, reason: 'noop' }], key), 201, 'key reusable after rejection');
  const frozen = (await c.req('GET', `/statement?snapshot=${q(snap.snapshot)}&limit=200`, { token: s2.tok.cy })).body;
  A.eq([frozen.entries.map((e) => [e.payment.payment_id, e.revision]), frozen.closing_balance], [snap.entries.map((e) => [e.payment.payment_id, e.revision]), snap.closing_balance], 'snapshot taken before a batch keeps its entries');
  const live = (await c.req('GET', '/statement?limit=200', { token: s2.tok.cy })).body;
  A.ok(live.entries.find((e) => e.payment.payment_id === b.payment_id)?.revision === 2, 'new statements reflect the batch revision');
  A.ok(live.entries.every((e) => e.payment.refund_of === null), 'statement payments refund_of null');
  A.ok(Date.parse((await c.req('GET', `/payments/${b.payment_id}/revisions`, { token: s2.tok.dan })).body.revisions[1].recorded_at) > Date.parse(b.created_at), 'batch recorded_at strictly later than previous');
  void nowIso;
});

await t('protocol-violations', ['R-05', 'R-06'], async (A) => { A.eq(c.violations, [], 'no 5xx or protocol violations'); });
const failed = results.filter((r) => !r.passed);
const report = { kind: 'contract-checks', checks: results.length, passed: results.length - failed.length, failed: failed.length, requests: c.count, results };
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
console.log(`\nrefund-contract: ${report.passed}/${report.checks} checks passed, ${report.failed} failed`);
process.exit(failed.length ? 1 : 0);
