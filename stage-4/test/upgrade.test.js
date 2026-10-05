'use strict';
// Upgrade checks: exports from the accepted stage-1 and stage-2 services import into this
// stage-3 service. Needs running services:
//   POCKETFUL_S1_URL=http://127.0.0.1:8081 POCKETFUL_S2_URL=http://127.0.0.1:8082 \
//   POCKETFUL_URL=http://127.0.0.1:8080 node --test --test-concurrency=1 test/upgrade.test.js
// Skipped when those URLs are not set.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const S3 = process.env.POCKETFUL_URL;
const S1 = process.env.POCKETFUL_S1_URL;
const S2 = process.env.POCKETFUL_S2_URL;
const skip = !(S3 && S1 && S2) && 'set POCKETFUL_URL, POCKETFUL_S1_URL and POCKETFUL_S2_URL';
const key = () => crypto.randomUUID();
const PW = 'correct horse';
const user = (handle, balance) => ({ id: `u_${handle}`, email: `${handle}@example.com`, password: PW, display_name: handle, handle, balance });
const fixture = (over = {}) => ({ currency: 'EUR', minor_units: 2, users: [user('ada', 10000), user('bob', 2500), user('cy', 500)], settlement_operator_ids: ['u_cy'], ...over });

async function call(base, method, path, { token, body, idem } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (idem !== undefined) h['idempotency-key'] = idem;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  assert.ok(res.status < 500, `5xx ${method} ${path}: ${text}`);
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const login = async (base, h) => (await call(base, 'POST', '/auth/login', { body: { email: `${h}@example.com`, password: PW } })).body.token;

async function checkLedger(tokens) {
  let sum = 0;
  for (const t of tokens) {
    const me = (await call(S3, 'GET', '/me', { token: t })).body;
    const st = (await call(S3, 'GET', '/statement?limit=200', { token: t })).body;
    const deltas = st.entries.reduce((s, e) => s + e.delta, 0);
    assert.equal(st.opening_balance + deltas, st.closing_balance);
    assert.equal(st.closing_balance, me.balance, 'statement closes at the current balance');
    let run = st.opening_balance;
    for (const e of st.entries) { run += e.delta; assert.equal(e.balance_after, run); assert.equal(e.revision, 1); }
    sum += me.total;
  }
  return sum;
}

async function writes(base, { holds }) {
  await call(base, 'POST', '/_test/reset', { body: fixture() });
  const [ada, bob, cy] = [await login(base, 'ada'), await login(base, 'bob'), await login(base, 'cy')];
  const lostKey = key();
  const lostBody = { to_handle: 'bob', amount: 700, note: 'lost before export' };
  const lost = (await call(base, 'POST', '/payments', { token: ada, body: lostBody, idem: lostKey })).body;
  const settle = (await call(base, 'POST', '/settlements', { token: cy, idem: key(), body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 100 }, { from_handle: 'bob', to_handle: 'cy', amount: 50 }] } })).body;
  const rq = (await call(base, 'POST', '/requests', { token: bob, idem: key(), body: { payer_handle: 'ada', amount: 300 } })).body;
  const out = { ada, bob, cy, lostKey, lostBody, lost, settle, rq };
  if (holds) {
    out.open = (await call(base, 'POST', '/authorizations', { token: ada, idem: key(), body: { to_handle: 'bob', amount: 2000 } })).body;
    const capA = (await call(base, 'POST', '/authorizations', { token: ada, idem: key(), body: { to_handle: 'cy', amount: 1000 } })).body;
    out.capA = capA;
    out.cap1 = (await call(base, 'POST', `/authorizations/${capA.authorization_id}/capture`, { token: cy, idem: key(), body: { amount: 300, final: false } })).body;
    out.cap2 = (await call(base, 'POST', `/authorizations/${capA.authorization_id}/capture`, { token: cy, idem: key(), body: { amount: 200 } })).body;
    const v = (await call(base, 'POST', '/authorizations', { token: bob, idem: key(), body: { to_handle: 'ada', amount: 50 } })).body;
    await call(base, 'POST', `/authorizations/${v.authorization_id}/void`, { token: bob });
    out.voided = v;
  }
  out.export = (await call(base, 'GET', '/_test/export')).body;
  return out;
}

test('a stage-1 export upgrades: tokens, statements, revisions, replay, linked immutability', { skip }, async () => {
  const w = await writes(S1, { holds: false });
  await call(S3, 'POST', '/_test/reset', { body: fixture({ users: [user('zed', 1)] }) });
  assert.equal((await call(S3, 'POST', '/_test/import', { body: w.export })).status, 204);
  const me = (await call(S3, 'GET', '/me', { token: w.ada })).body;
  assert.deepEqual([me.balance, me.total, me.available, me.held], [9200, 9200, 9200, 0]);
  assert.equal(await checkLedger([w.ada, w.bob, w.cy]), 13000);
  const replay = await call(S3, 'POST', '/payments', { token: w.ada, body: w.lostBody, idem: w.lostKey });
  assert.deepEqual([replay.status, replay.body.payment_id, replay.body.amount], [200, w.lost.payment_id, 700]);
  const revs = (await call(S3, 'GET', `/payments/${w.lost.payment_id}/revisions`, { token: w.bob })).body.revisions;
  assert.deepEqual(revs.map((r) => [r.revision, r.amount, r.effective_at, r.recorded_at, r.reason]), [[1, 700, w.lost.created_at, w.lost.created_at, '']]);
  const member = w.settle.payments[0];
  const mrev = (await call(S3, 'GET', `/payments/${member.payment_id}/revisions`, { token: w.ada })).body.revisions[0];
  assert.deepEqual([mrev.effective_at, mrev.recorded_at], [w.settle.committed_at, w.settle.committed_at]);
  const lm = await call(S3, 'POST', `/payments/${member.payment_id}/corrections`, { token: w.ada, idem: key(), body: { expected_revision: 1, amount: 1, effective_at: member.created_at, reason: 'r' } });
  assert.deepEqual([lm.status, lm.body.error.code], [422, 'linked_payment_immutable']);
  const c = await call(S3, 'POST', `/payments/${w.lost.payment_id}/corrections`, { token: w.ada, idem: key(), body: { expected_revision: 1, amount: 500, effective_at: w.lost.created_at, reason: 'after upgrade' } });
  assert.equal(c.status, 201);
  assert.equal((await call(S3, 'GET', '/me', { token: w.ada })).body.balance, 9400);
  const before = (await call(S3, 'GET', `/me?as_of=${encodeURIComponent(new Date(Date.parse(w.lost.created_at) - 1).toISOString())}`, { token: w.ada })).body;
  assert.equal(before.balance, 10000, 'opening balance survives the upgrade and the correction');
  const pay = await call(S3, 'POST', `/requests/${w.rq.request_id}/pay`, { token: w.ada, idem: key(), body: {} });
  assert.equal(pay.status, 201);
});

test('a stage-2 export upgrades: holds, captures, closed_at, historical held, immutability', { skip }, async () => {
  const w = await writes(S2, { holds: true });
  await call(S3, 'POST', '/_test/reset', { body: fixture() });
  assert.equal((await call(S3, 'POST', '/_test/import', { body: w.export })).status, 204);
  const me = (await call(S3, 'GET', '/me', { token: w.ada })).body;
  assert.deepEqual([me.total, me.available, me.held], [8700, 6700, 2000]);
  assert.equal(await checkLedger([w.ada, w.bob, w.cy]), 13000);
  const auths = (await call(S3, 'GET', '/authorizations', { token: w.ada })).body.authorizations;
  const byId = Object.fromEntries(auths.map((a) => [a.authorization_id, a]));
  assert.equal(byId[w.open.authorization_id].closed_at, null);
  assert.equal(byId[w.capA.authorization_id].status, 'captured');
  assert.equal(byId[w.capA.authorization_id].closed_at, w.cap2.created_at);
  // historical held: right after the open hold was created, both holds were open
  const v = (await call(S3, 'GET', `/me?as_of=${encodeURIComponent(w.capA.created_at)}`, { token: w.ada })).body;
  assert.deepEqual([v.held, v.available, v.total], [3000, 9200 - 3000, 9200]);
  const v2 = (await call(S3, 'GET', `/me?as_of=${encodeURIComponent(w.cap1.created_at)}`, { token: w.ada })).body;
  assert.deepEqual([v2.held, v2.total], [2700, 8900]);
  const lm = await call(S3, 'POST', `/payments/${w.cap1.payment_id}/corrections`, { token: w.ada, idem: key(), body: { expected_revision: 1, amount: 1, effective_at: w.cap1.created_at, reason: 'r' } });
  assert.deepEqual([lm.status, lm.body.error.code], [422, 'linked_payment_immutable']);
  const st = (await call(S3, 'GET', '/statement', { token: w.cy })).body;
  assert.equal(st.entries.filter((e) => e.payment.authorization_id === w.capA.authorization_id).length, 2, 'each capture once');
  const cap = await call(S3, 'POST', `/authorizations/${w.open.authorization_id}/capture`, { token: w.bob, idem: key(), body: {} });
  assert.equal(cap.status, 201);
  const replay = await call(S3, 'POST', '/payments', { token: w.ada, body: w.lostBody, idem: w.lostKey });
  assert.deepEqual(replay.body, w.lost);
});
