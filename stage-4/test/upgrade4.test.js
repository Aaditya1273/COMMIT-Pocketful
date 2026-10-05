'use strict';
// A populated stage-3 export (settlement, holds and captures, a correction, a snapshot)
// upgrades into this stage-4 service. Needs running services:
//   POCKETFUL_URL=http://127.0.0.1:8080 POCKETFUL_S3_URL=http://127.0.0.1:8083 \
//   node --test --test-concurrency=1 test/upgrade4.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const S4 = process.env.POCKETFUL_URL;
const S3 = process.env.POCKETFUL_S3_URL;
const skip = !(S4 && S3) && 'set POCKETFUL_URL and POCKETFUL_S3_URL';
const key = () => crypto.randomUUID();
const PW = 'correct horse';
const user = (handle, balance) => ({ id: `u_${handle}`, email: `${handle}@example.com`, password: PW, display_name: handle, handle, balance });
const fixture = { currency: 'EUR', minor_units: 2, users: [user('ada', 10000), user('bob', 2500), user('cy', 500)], settlement_operator_ids: ['u_cy'] };

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

test('a populated stage-3 export upgrades into stage 4', { skip }, async () => {
  await call(S3, 'POST', '/_test/reset', { body: fixture });
  const [ada, bob, cy] = [await login(S3, 'ada'), await login(S3, 'bob'), await login(S3, 'cy')];
  const pk = key();
  const pbody = { to_handle: 'bob', amount: 1000, note: 'n' };
  const p = (await call(S3, 'POST', '/payments', { token: ada, body: pbody, idem: pk })).body;
  const corr = (await call(S3, 'POST', `/payments/${p.payment_id}/corrections`, { token: ada, idem: key(), body: { expected_revision: 1, amount: 600, effective_at: p.created_at, reason: 'fix' } })).body;
  const sk = key();
  const sbody = { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 100 }, { from_handle: 'bob', to_handle: 'cy', amount: 40 }] };
  const s = (await call(S3, 'POST', '/settlements', { token: cy, body: sbody, idem: sk })).body;
  const a = (await call(S3, 'POST', '/authorizations', { token: ada, idem: key(), body: { to_handle: 'bob', amount: 2000 } })).body;
  const cap = (await call(S3, 'POST', `/authorizations/${a.authorization_id}/capture`, { token: bob, idem: key(), body: { amount: 500, final: false } })).body;
  const snapBody = (await call(S3, 'GET', '/statement', { token: ada })).body;
  const ex = (await call(S3, 'GET', '/_test/export')).body;

  await call(S4, 'POST', '/_test/reset', { body: fixture });
  assert.equal((await call(S4, 'POST', '/_test/import', { body: ex })).status, 204);
  const me = (await call(S4, 'GET', '/me', { token: ada })).body;
  assert.deepEqual([me.total, me.available, me.held], [8800, 7300, 1500]);
  // snapshot from stage 3 still pages its frozen entries
  const snap = (await call(S4, 'GET', `/statement?snapshot=${snapBody.snapshot}`, { token: ada })).body;
  assert.deepEqual(snap.entries, snapBody.entries);
  // corrections and settlement membership retained; original retries return original bodies
  const revs = (await call(S4, 'GET', `/payments/${p.payment_id}/revisions`, { token: ada })).body.revisions;
  assert.deepEqual(revs.map((r) => [r.revision, r.amount, r.correction_batch_id]), [[1, 1000, null], [2, 600, null]]);
  assert.equal(revs[1].recorded_at, corr.recorded_at);
  assert.deepEqual((await call(S4, 'POST', '/payments', { token: ada, body: pbody, idem: pk })).body, p);
  assert.deepEqual((await call(S4, 'POST', '/settlements', { token: cy, body: sbody, idem: sk })).body, s);
  // every payment now carries refund_of: null
  const feed = (await call(S4, 'GET', '/activity?limit=200', { token: ada })).body.payments;
  assert.ok(feed.length >= 4 && feed.every((x) => x.refund_of === null));
  // refund limit follows the corrected amount; capture refundable; settlement batch needs all members
  assert.equal((await call(S4, 'POST', `/payments/${p.payment_id}/refunds`, { token: bob, idem: key(), body: { amount: 601 } })).body.error.code, 'refund_exceeds_payment');
  assert.equal((await call(S4, 'POST', `/payments/${p.payment_id}/refunds`, { token: bob, idem: key(), body: { amount: 600 } })).status, 201);
  assert.equal((await call(S4, 'POST', `/payments/${cap.payment_id}/refunds`, { token: bob, idem: key(), body: { amount: 500 } })).status, 201);
  const [m1, m2] = s.payments;
  const it = (m, amount) => ({ payment_id: m.payment_id, expected_revision: 1, amount, effective_at: m.created_at, reason: 'r' });
  assert.equal((await call(S4, 'POST', '/correction-batches', { token: cy, idem: key(), body: { corrections: [it(m1, 0)] } })).body.error.code, 'incomplete_settlement');
  const b = await call(S4, 'POST', '/correction-batches', { token: cy, idem: key(), body: { corrections: [it(m1, 0), it(m2, 0)] } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  let sum = 0;
  for (const t of [ada, bob, cy]) {
    const st = (await call(S4, 'GET', '/statement?limit=200', { token: t })).body;
    assert.equal(st.opening_balance + st.entries.reduce((x, e) => x + e.delta, 0), st.closing_balance);
    sum += (await call(S4, 'GET', '/me', { token: t })).body.total;
  }
  assert.equal(sum, 13000);
});
