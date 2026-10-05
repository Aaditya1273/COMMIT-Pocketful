'use strict';
// Builder's stage-4 checks: refunds, corrections with refunds, correction batches
// (precedence, settlements, combined affordability, shared recorded_at, replay,
// concurrency) and snapshots. In-process server, or POCKETFUL_URL (run serially).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

let base = process.env.POCKETFUL_URL;
let server;
before(async () => {
  if (base) return;
  process.env.PORT = '0';
  const { start } = require('../src/server.js');
  server = start();
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) { server.closeAllConnections(); server.close(); } });

const key = () => crypto.randomUUID();
const PW = 'correct horse';
const user = (handle, balance) => ({ id: `u_${handle}`, email: `${handle}@example.com`, password: PW, display_name: handle, handle, balance });
const fixture = (over = {}) => ({ currency: 'EUR', minor_units: 2, users: [user('ada', 10000), user('bob', 2500), user('cy', 500), user('op', 0)], settlement_operator_ids: ['u_op'], ...over });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { token, body, idem } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (idem !== undefined) h['idempotency-key'] = idem;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  assert.ok(res.status < 500, `5xx ${method} ${path}: ${text}`);
  if (res.status >= 400) assert.ok(json && json.error && json.error.code, text);
  return { status: res.status, body: json };
}
const err = (r) => [r.status, r.body && r.body.error && r.body.error.code];
async function world(f = fixture()) {
  assert.equal((await call('POST', '/_test/reset', { body: f })).status, 204);
  const t = {};
  for (const h of ['ada', 'bob', 'cy', 'op']) t[h] = (await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: PW } })).body.token;
  return t;
}
const pay = async (t, to, amount, extra = {}) => { const r = await call('POST', '/payments', { token: t, body: { to_handle: to, amount, ...extra }, idem: key() }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
const refund = (t, id, amount, idem = key()) => call('POST', `/payments/${id}/refunds`, { token: t, body: { amount }, idem });
const bal = async (t) => (await call('GET', '/me', { token: t })).body;
const batch = (t, corrections, idem = key()) => call('POST', '/correction-batches', { token: t, body: { corrections }, idem });
const item = (p, amount, extra = {}) => ({ payment_id: p.payment_id, expected_revision: 1, amount, effective_at: p.created_at, reason: 'fix', ...extra });

test('refund: linked reverse payment, limits, permissions, replay, feed and statement', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000, { note: 'dinner', visibility: 'private' });
  assert.equal(p.refund_of, null);
  const k = key();
  const r = await refund(w.bob, p.payment_id, 300, k);
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.from_handle, r.body.to_handle, r.body.amount, r.body.refund_of, r.body.request_id, r.body.authorization_id, r.body.settlement_id, r.body.note, r.body.visibility],
    ['bob', 'ada', 300, p.payment_id, null, null, null, 'dinner', 'private']);
  assert.deepEqual((await refund(w.bob, p.payment_id, 300, k)).body, r.body);
  assert.deepEqual(err(await refund(w.bob, p.payment_id, 301, k)), [409, 'idempotency_key_reuse']);
  assert.deepEqual([(await bal(w.ada)).total, (await bal(w.bob)).total], [9300, 3200]);
  assert.deepEqual(err(await refund(w.ada, p.payment_id, 1)), [403, 'forbidden']);
  assert.deepEqual(err(await refund(w.cy, p.payment_id, 1)), [403, 'forbidden']);
  assert.deepEqual(err(await refund(w.bob, 'nope', 1)), [404, 'not_found']);
  for (const a of [0, -1, 1.5, '1', null, 1000000001]) assert.deepEqual(err(await refund(w.bob, p.payment_id, a)), [422, 'validation_failed'], String(a));
  assert.deepEqual(err(await call('POST', `/payments/${p.payment_id}/refunds`, { token: w.bob, body: {}, idem: key() })), [422, 'validation_failed']);
  assert.deepEqual(err(await call('POST', `/payments/${p.payment_id}/refunds`, { token: w.bob, body: { amount: 1 } })), [400, 'missing_idempotency_key']);
  assert.deepEqual(err(await refund(w.ada, r.body.payment_id, 1)), [422, 'invalid_refund_target']);
  assert.deepEqual(err(await refund(w.bob, p.payment_id, 701)), [422, 'refund_exceeds_payment']);
  assert.equal((await refund(w.bob, p.payment_id, 700)).status, 201);
  assert.deepEqual(err(await refund(w.bob, p.payment_id, 1)), [422, 'refund_exceeds_payment']);
  const feed = (await call('GET', '/activity', { token: w.ada })).body.payments;
  assert.equal(feed.filter((x) => x.refund_of === p.payment_id).length, 2);
  assert.equal((await call('GET', '/activity', { token: w.cy })).body.payments.length, 0, 'refunds keep the original visibility');
  const st = (await call('GET', '/statement', { token: w.ada })).body;
  assert.deepEqual(st.entries.map((e) => e.delta), [-1000, 300, 700]);
  assert.equal(st.closing_balance, 10000);
});

test('refund funds come from available; holds block it; requests and captures stay closed', async () => {
  const w = await world();
  const p = await pay(w.ada, 'cy', 1000); // cy 1500
  await call('POST', '/authorizations', { token: w.cy, idem: key(), body: { to_handle: 'bob', amount: 1200 } }); // cy available 300
  assert.deepEqual(err(await refund(w.cy, p.payment_id, 301)), [409, 'insufficient_funds']);
  assert.equal((await refund(w.cy, p.payment_id, 300)).status, 201);
  // request payment refund does not reopen the request
  const rq = (await call('POST', '/requests', { token: w.bob, idem: key(), body: { payer_handle: 'ada', amount: 200 } })).body;
  const rp = (await call('POST', `/requests/${rq.request_id}/pay`, { token: w.ada, idem: key(), body: {} })).body;
  assert.equal((await refund(w.bob, rp.payment_id, 200)).status, 201);
  const listed = (await call('GET', '/requests', { token: w.bob })).body.requests.find((x) => x.request_id === rq.request_id);
  assert.equal(listed.status, 'paid');
  // capture refund does not reopen the authorization; captures and refunds are immutable
  const a = (await call('POST', '/authorizations', { token: w.ada, idem: key(), body: { to_handle: 'bob', amount: 500 } })).body;
  const cap = (await call('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.bob, idem: key(), body: { amount: 400 } })).body;
  const cr = await refund(w.bob, cap.payment_id, 400);
  assert.equal(cr.status, 201);
  const auth = (await call('GET', '/authorizations', { token: w.ada })).body.authorizations.find((x) => x.authorization_id === a.authorization_id);
  assert.deepEqual([auth.status, auth.remaining_amount], ['captured', 0]);
  assert.equal((await bal(w.ada)).held, 0);
  const corr = (id, t) => call('POST', `/payments/${id}/corrections`, { token: t, idem: key(), body: { expected_revision: 1, amount: 1, effective_at: cap.created_at, reason: 'r' } });
  assert.deepEqual(err(await corr(cap.payment_id, w.ada)), [422, 'linked_payment_immutable']);
  assert.deepEqual(err(await corr(cr.body.payment_id, w.bob)), [422, 'linked_payment_immutable']);
});

test('corrections and refunds interact: corrected limit, refunded floor', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  assert.equal((await refund(w.bob, p.payment_id, 400)).status, 201);
  const c = (amount, er = 1) => call('POST', `/payments/${p.payment_id}/corrections`, { token: w.ada, idem: key(), body: { expected_revision: er, amount, effective_at: p.created_at, reason: 'r' } });
  assert.deepEqual(err(await c(399)), [422, 'refund_exceeds_payment']);
  const ok = await c(400);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.correction_batch_id, null);
  assert.deepEqual(err(await refund(w.bob, p.payment_id, 1)), [422, 'refund_exceeds_payment'], 'limit follows the corrected amount');
  assert.equal((await bal(w.ada)).total + (await bal(w.bob)).total, 12500);
  assert.deepEqual([(await bal(w.ada)).total, (await bal(w.bob)).total], [10000, 2500]);
});

test('batch: operator rules, shape, item precedence, settlement completeness and instants', async () => {
  const w = await world();
  const p1 = await pay(w.ada, 'bob', 100);
  const p2 = await pay(w.bob, 'cy', 50);
  const s = (await call('POST', '/settlements', { token: w.op, idem: key(), body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 30 }, { from_handle: 'bob', to_handle: 'cy', amount: 20 }] } })).body;
  const [m1, m2] = s.payments;
  assert.deepEqual(err(await call('POST', '/correction-batches', { body: { corrections: [item(p1, 1)] }, idem: key() })), [401, 'unauthenticated']);
  assert.deepEqual(err(await batch(w.ada, [item(p1, 1)])), [403, 'forbidden']);
  assert.deepEqual(err(await call('POST', '/correction-batches', { token: w.op, body: { corrections: [item(p1, 1)] } })), [400, 'missing_idempotency_key']);
  for (const corrections of [[], Array.from({ length: 33 }, () => item(p1, 1)), [item(p1, 1), item(p1, 2)], 'x', [5]]) {
    assert.deepEqual(err(await call('POST', '/correction-batches', { token: w.op, idem: key(), body: { corrections } })), [422, 'validation_failed']);
  }
  assert.deepEqual(err(await batch(w.op, [item(p1, 1, { expected_revision: 2 }), { ...item(p2, 1), payment_id: 'nope' }])), [409, 'stale_revision'], 'input order');
  assert.deepEqual(err(await batch(w.op, [{ ...item(p2, 1), payment_id: 'nope' }, item(p1, 1, { expected_revision: 2 })])), [404, 'not_found']);
  assert.deepEqual(err(await batch(w.op, [item(p1, 1, { reason: '' }), { ...item(p2, 1), payment_id: 'nope' }])), [422, 'validation_failed']);
  assert.deepEqual(err(await batch(w.op, [item(m1, 0)])), [422, 'incomplete_settlement']);
  assert.deepEqual(err(await batch(w.op, [item(m1, 0), item(m2, 0, { effective_at: p1.created_at })])), [422, 'validation_failed']);
  // the same instant spelled with a different offset is identical
  const instant = Date.parse(m1.created_at);
  const plus0530 = new Date(instant + 5.5 * 3600000).toISOString().replace('Z', '+05:30');
  const ok = await batch(w.op, [item(m1, 0), item(m2, 0, { effective_at: plus0530 }), item(p1, 60)]);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(Object.keys(ok.body).sort(), ['correction_batch_id', 'recorded_at', 'revisions']);
  assert.deepEqual(ok.body.revisions.map((r) => [r.payment_id, r.revision, r.amount, r.correction_batch_id, r.recorded_at]),
    [[m1.payment_id, 2, 0, ok.body.correction_batch_id, ok.body.recorded_at], [m2.payment_id, 2, 0, ok.body.correction_batch_id, ok.body.recorded_at], [p1.payment_id, 2, 60, ok.body.correction_batch_id, ok.body.recorded_at]]);
  assert.deepEqual([(await bal(w.ada)).total, (await bal(w.bob)).total, (await bal(w.cy)).total], [9940, 2510, 550]);
  // single corrections of settlement members stay immutable; originals unchanged
  assert.deepEqual(err(await call('POST', `/payments/${m1.payment_id}/corrections`, { token: w.ada, idem: key(), body: item(m1, 5, { expected_revision: 2 }) })), [422, 'linked_payment_immutable']);
  const revs = (await call('GET', `/payments/${m1.payment_id}/revisions`, { token: w.ada })).body.revisions;
  assert.deepEqual(revs.map((r) => r.correction_batch_id), [null, ok.body.correction_batch_id]);
  // captures and refunds are immutable inside batches too; refunded floor applies
  const rf = (await refund(w.bob, p2.payment_id === undefined ? p1.payment_id : p1.payment_id, 10)).body;
  assert.deepEqual(err(await batch(w.op, [item(rf, 1)])), [422, 'linked_payment_immutable']);
  assert.deepEqual(err(await batch(w.op, [item(p1, 5, { expected_revision: 2 })])), [422, 'refund_exceeds_payment']);
});

test('batch: combined affordability, historical overdraft, shared recorded_at, replay, snapshots', async () => {
  const w = await world();
  const p1 = await pay(w.ada, 'cy', 400); // cy 900
  await sleep(3);
  const p2 = await pay(w.cy, 'bob', 800); // cy 100
  // reducing p1 by 400 alone: cy must return 400 now with only 100 available -> insufficient
  assert.deepEqual(err(await batch(w.op, [item(p1, 0)])), [409, 'insufficient_funds']);
  // combined with reducing p2 by 800 (bob returns 800 to cy), cy can afford it now
  // ...but historically cy spent the 400 before getting the 800 back? p2's new revision is
  // effective at its own time, so at p1's time cy has 500 - 0 = 500 and at p2's 500 - 0 -> fine
  const snap = (await call('GET', '/statement', { token: w.cy })).body.snapshot;
  const k = key();
  const ok = await batch(w.op, [item(p1, 0), item(p2, 0)], k);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.ok(Date.parse(ok.body.recorded_at) > Date.parse(p2.created_at));
  assert.deepEqual([(await bal(w.ada)).total, (await bal(w.bob)).total, (await bal(w.cy)).total], [10000, 2500, 500]);
  const replay = await batch(w.op, [item(p1, 0), item(p2, 0)], k);
  assert.deepEqual([replay.status, replay.body], [200, ok.body]);
  assert.deepEqual(err(await batch(w.op, [item(p1, 1), item(p2, 0)], k)), [409, 'idempotency_key_reuse']);
  const frozen = (await call('GET', `/statement?snapshot=${snap}`, { token: w.cy })).body;
  assert.deepEqual(frozen.entries.map((e) => e.delta), [400, -800]);
  const fresh = (await call('GET', '/statement', { token: w.cy })).body;
  assert.deepEqual(fresh.entries.map((e) => e.delta), [0, 0]);
  // original payment retry returns the original body
  // historical overdraft: bob receives 1000 then spends it; reversing the receipt (now affordable
  // after a later top-up) would make bob negative in between
  const w2 = await world();
  const q1 = await pay(w2.ada, 'cy', 3000); // cy 3500
  await sleep(3);
  await pay(w2.cy, 'bob', 3400); // cy 100
  await sleep(3);
  await pay(w2.ada, 'cy', 5000); // cy 5100
  assert.deepEqual(err(await batch(w2.op, [item(q1, 0)])), [409, 'historical_overdraft']);
  assert.equal((await call('GET', `/payments/${q1.payment_id}/revisions`, { token: w2.ada })).body.revisions.length, 1);
});

test('concurrent corrections sharing an expected revision: exactly one succeeds', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  const q = await pay(w.ada, 'cy', 10);
  const jobs = [];
  for (let i = 0; i < 10; i++) {
    jobs.push(batch(w.op, [item(p, 900 - i), item(q, 5)]));
    jobs.push(call('POST', `/payments/${p.payment_id}/corrections`, { token: w.ada, idem: key(), body: item(p, 800 - i) }));
  }
  const out = await Promise.all(jobs);
  assert.equal(out.filter((r) => r.status === 201).length, 1);
  assert.ok(out.filter((r) => r.status !== 201).every((r) => err(r)[1] === 'stale_revision'));
  const t = (await bal(w.ada)).total + (await bal(w.bob)).total + (await bal(w.cy)).total + (await bal(w.op)).total;
  assert.equal(t, 13000);
});

test('export/import keeps refunds and batch revisions; stage-3 layout imports', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  await refund(w.bob, p.payment_id, 100);
  const b = (await batch(w.op, [item(p, 500)])).body;
  const ex = (await call('GET', '/_test/export')).body;
  await call('POST', '/_test/reset', { body: fixture() });
  assert.equal((await call('POST', '/_test/import', { body: ex })).status, 204);
  assert.deepEqual(err(await refund(w.bob, p.payment_id, 401)), [422, 'refund_exceeds_payment']);
  const revs = (await call('GET', `/payments/${p.payment_id}/revisions`, { token: w.bob })).body.revisions;
  assert.equal(revs[1].correction_batch_id, b.correction_batch_id);
  const s3 = JSON.parse(JSON.stringify(ex));
  for (const pp of s3.state.payments) { delete pp.refund_of; for (const r of pp.revisions) delete r.correction_batch_id; }
  delete s3.state.correction_batches;
  s3.state.payments = s3.state.payments.filter((pp) => pp.amount !== 100 || pp.from !== 'u_bob');
  assert.equal((await call('POST', '/_test/import', { body: s3 })).status, 204);
  const feed = (await call('GET', '/activity', { token: w.ada })).body.payments;
  assert.ok(feed.every((x) => x.refund_of === null));
});
