'use strict';
// Builder's stage-2 API checks: holds, captures, voids, expiry, available-funds checks,
// fixture rules, export/import (including the stage-1 export layout) and content
// negotiation. Starts the server in-process, or targets POCKETFUL_URL.

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
const user = (handle, balance, extra = {}) => ({ id: `u_${handle}`, email: `${handle}@example.com`, password: PW, display_name: handle, handle, balance, ...extra });
const fixture = (over = {}) => ({ currency: 'EUR', minor_units: 2, users: [user('ada', 10000), user('bob', 2500), user('cy', 500)], ...over });
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const HOUR = 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { token, body, raw, idem, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (idem !== undefined) h['idempotency-key'] = idem;
  let payload;
  if (raw !== undefined) payload = raw; else if (body !== undefined) payload = JSON.stringify(body);
  if (payload !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: payload });
  const text = await res.text();
  const ct = res.headers.get('content-type') || '';
  const json = text && ct.startsWith('application/json') ? JSON.parse(text) : null;
  assert.ok(res.status < 500, `5xx ${method} ${path}: ${text}`);
  if (res.status >= 400) assert.ok(json && json.error && json.error.code, `envelope: ${text}`);
  return { status: res.status, body: json, text, ct };
}
const err = (r) => [r.status, r.body && r.body.error && r.body.error.code];
async function reset(f = fixture()) { const r = await call('POST', '/_test/reset', { body: f }); assert.equal(r.status, 204, r.text); }
async function login(handle) { const r = await call('POST', '/auth/login', { body: { email: `${handle}@example.com`, password: PW } }); assert.equal(r.status, 200); return r.body.token; }
async function world(f) { await reset(f); return { ada: await login('ada'), bob: await login('bob'), cy: await login('cy') }; }
const me = async (t) => (await call('GET', '/me', { token: t })).body;
const authorize = (t, body, idem = key()) => call('POST', '/authorizations', { token: t, body, idem });
const capture = (t, id, body, idem = key()) => call('POST', `/authorizations/${id}/capture`, { token: t, body, idem });
const voidAuth = (t, id) => call('POST', `/authorizations/${id}/void`, { token: t });
const pay = (t, body, idem = key()) => call('POST', '/payments', { token: t, body, idem });

test('a hold reserves money without moving it; /me exposes total, available, held', async () => {
  const w = await world();
  const a = await authorize(w.ada, { to_handle: 'bob', amount: 2000, note: 'deposit', visibility: 'private' });
  assert.equal(a.status, 201);
  assert.deepEqual(Object.keys(a.body).sort(), ['amount', 'authorization_id', 'captured_amount', 'created_at', 'currency', 'expires_at',
    'from_handle', 'from_user_id', 'note', 'payment_id', 'payment_ids', 'remaining_amount', 'status', 'to_handle', 'to_user_id', 'visibility']);
  assert.equal(a.body.status, 'open');
  assert.equal(a.body.captured_amount, 0);
  assert.equal(a.body.remaining_amount, 2000);
  assert.equal(a.body.payment_id, null);
  assert.deepEqual(a.body.payment_ids, []);
  assert.equal(Date.parse(a.body.expires_at) - Date.parse(a.body.created_at), 600 * 1000);
  assert.deepEqual(await me(w.ada), { user_id: 'u_ada', display_name: 'ada', handle: 'ada', balance: 10000, total: 10000, available: 8000, held: 2000, currency: 'EUR', minor_units: 2 });
  assert.equal((await me(w.bob)).total, 2500);
  // open authorizations are not feed items
  assert.deepEqual((await call('GET', '/activity', { token: w.ada })).body.payments, []);
  assert.deepEqual((await call('GET', '/activity', { token: w.cy })).body.payments, []);
});

test('held funds cannot fund payments, request payments, authorizations or settlement debits', async () => {
  const w = await world(fixture({ settlement_operator_ids: ['u_cy'] }));
  assert.equal((await authorize(w.ada, { to_handle: 'bob', amount: 9000 })).status, 201);
  assert.deepEqual(err(await pay(w.ada, { to_handle: 'bob', amount: 1001 })), [409, 'insufficient_funds']);
  assert.deepEqual(err(await authorize(w.ada, { to_handle: 'cy', amount: 1001 })), [409, 'insufficient_funds']);
  const rq = (await call('POST', '/requests', { token: w.bob, body: { payer_handle: 'ada', amount: 1001 }, idem: key() })).body.request_id;
  assert.deepEqual(err(await call('POST', `/requests/${rq}/pay`, { token: w.ada, body: {}, idem: key() })), [409, 'insufficient_funds']);
  assert.deepEqual(err(await call('POST', '/settlements', { token: w.cy, idem: key(), body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 1001 }] } })), [409, 'insufficient_funds']);
  // exactly the available amount still works
  assert.equal((await pay(w.ada, { to_handle: 'bob', amount: 1000 })).status, 201);
  const m = await me(w.ada);
  assert.deepEqual([m.total, m.available, m.held], [9000, 0, 9000]);
});

test('default capture is final: full or partial, remainder released at once; then not open', async () => {
  const w = await world();
  const a = (await authorize(w.ada, { to_handle: 'bob', amount: 2000, note: 'n', visibility: 'private' })).body.authorization_id;
  const p = await capture(w.bob, a, { amount: 1500 });
  assert.equal(p.status, 201);
  assert.deepEqual(Object.keys(p.body).sort(), ['amount', 'authorization_id', 'created_at', 'currency', 'from_handle', 'from_user_id', 'note',
    'payment_id', 'request_id', 'settlement_id', 'to_handle', 'to_user_id', 'visibility']);
  assert.deepEqual([p.body.amount, p.body.authorization_id, p.body.request_id, p.body.settlement_id, p.body.note, p.body.visibility, p.body.from_handle, p.body.to_handle],
    [1500, a, null, null, 'n', 'private', 'ada', 'bob']);
  const am = await me(w.ada);
  assert.deepEqual([am.total, am.available, am.held], [8500, 8500, 0]);
  assert.equal((await me(w.bob)).total, 4000);
  const listed = (await call('GET', '/authorizations', { token: w.ada })).body.authorizations[0];
  assert.deepEqual([listed.status, listed.captured_amount, listed.remaining_amount, listed.payment_id, listed.payment_ids], ['captured', 1500, 0, p.body.payment_id, [p.body.payment_id]]);
  assert.deepEqual(err(await capture(w.bob, a, { amount: 1 })), [409, 'authorization_not_open']);
  assert.deepEqual(err(await voidAuth(w.ada, a)), [409, 'authorization_not_open']);
  // captured payment follows the ordinary feed rule (private: parties only)
  assert.equal((await call('GET', '/activity', { token: w.bob })).body.payments[0].payment_id, p.body.payment_id);
  assert.deepEqual((await call('GET', '/activity', { token: w.cy })).body.payments, []);
  // omitted amount captures the whole remainder
  const b = (await authorize(w.ada, { to_handle: 'bob', amount: 700 })).body.authorization_id;
  assert.equal((await capture(w.bob, b, {})).body.amount, 700);
});

test('extended capture mode: non-final partial captures keep the rest held; full remainder closes', async () => {
  const w = await world();
  const a = (await authorize(w.ada, { to_handle: 'bob', amount: 2000 })).body.authorization_id;
  const p1 = await capture(w.bob, a, { amount: 700, final: false });
  assert.equal(p1.status, 201);
  let l = (await call('GET', `/authorizations?status=open`, { token: w.bob })).body.authorizations[0];
  assert.deepEqual([l.status, l.captured_amount, l.remaining_amount], ['open', 700, 1300]);
  let m = await me(w.ada);
  assert.deepEqual([m.total, m.available, m.held], [9300, 8000, 1300]);
  assert.deepEqual(err(await capture(w.bob, a, { amount: 1301, final: false })), [422, 'capture_exceeds_authorization']);
  const p2 = await capture(w.bob, a, { amount: 300, final: false });
  const p3 = await capture(w.bob, a, { final: false }); // remainder: 1000, closes even with final:false
  assert.equal(p3.body.amount, 1000);
  l = (await call('GET', '/authorizations', { token: w.bob })).body.authorizations[0];
  assert.deepEqual([l.status, l.captured_amount, l.remaining_amount, l.payment_id, l.payment_ids],
    ['captured', 2000, 0, p3.body.payment_id, [p1.body.payment_id, p2.body.payment_id, p3.body.payment_id]]);
  m = await me(w.ada);
  assert.deepEqual([m.total, m.available, m.held], [8000, 8000, 0]);
  // void after a partial capture releases only the remainder and keeps the captures
  const b = (await authorize(w.ada, { to_handle: 'bob', amount: 1000 })).body.authorization_id;
  await capture(w.bob, b, { amount: 400, final: false });
  const v = await voidAuth(w.ada, b);
  assert.deepEqual([v.status, v.body.status, v.body.captured_amount, v.body.remaining_amount, v.body.payment_ids.length], [200, 'voided', 400, 0, 1]);
  assert.deepEqual(err(await capture(w.bob, b, { amount: 1 })), [409, 'authorization_not_open']);
  assert.equal((await voidAuth(w.ada, b)).status, 200, 'voiding twice is not an error');
  m = await me(w.ada);
  assert.deepEqual([m.total, m.available, m.held], [7600, 7600, 0]);
});

test('capture and void validation, permissions and precedence', async () => {
  const w = await world();
  const a = (await authorize(w.ada, { to_handle: 'bob', amount: 2000 })).body.authorization_id;
  assert.deepEqual(err(await capture(w.ada, a, {})), [403, 'forbidden']);
  assert.deepEqual(err(await capture(w.cy, a, {})), [403, 'forbidden']);
  assert.deepEqual(err(await voidAuth(w.bob, a)), [403, 'forbidden']);
  assert.deepEqual(err(await voidAuth(w.cy, a)), [403, 'forbidden']);
  assert.deepEqual(err(await capture(w.bob, 'nope', {})), [404, 'not_found']);
  assert.deepEqual(err(await voidAuth(w.ada, 'nope')), [404, 'not_found']);
  assert.deepEqual(err(await call('POST', `/authorizations/${a}/capture`, { token: w.bob, body: {} })), [400, 'missing_idempotency_key']);
  for (const amount of [0, -1, 1.5, '100', true, null]) {
    assert.deepEqual(err(await capture(w.bob, a, { amount })), [422, 'validation_failed'], String(amount));
  }
  assert.deepEqual(err(await capture(w.bob, a, { amount: 2001 })), [422, 'capture_exceeds_authorization']);
  assert.deepEqual(err(await capture(w.bob, a, { final: 'no' })), [400, 'malformed_request']);
  assert.deepEqual(err(await call('POST', `/authorizations/${a}/capture`, { token: w.bob, idem: key(), raw: '{bad' })), [400, 'malformed_request']);
  // authorization creation rules
  assert.deepEqual(err(await authorize(w.ada, { to_handle: 'ada', amount: 1 })), [422, 'self_payment']);
  assert.deepEqual(err(await authorize(w.ada, { to_handle: 'zz', amount: 1 })), [404, 'not_found']);
  for (const body of [{ to_handle: 'bob', amount: 0 }, { to_handle: 'bob', amount: 1000000001 }, { to_handle: 'bob', amount: 1, note: null },
    { to_handle: 'bob', amount: 1, note: 'x'.repeat(201) }, { to_handle: 'bob', amount: 1, visibility: 'x' }, { amount: 1 }]) {
    assert.deepEqual(err(await authorize(w.ada, body)), [422, 'validation_failed'], JSON.stringify(body));
  }
  assert.deepEqual(err(await call('POST', '/authorizations', { token: w.ada, body: { to_handle: 'bob', amount: 1 } })), [400, 'missing_idempotency_key']);
  assert.deepEqual(err(await call('POST', '/authorizations', { body: { to_handle: 'bob', amount: 1 }, idem: key() })), [401, 'unauthenticated']);
});

test('idempotency on authorize and capture: replay, reuse, {} vs explicit amount, failed keys', async () => {
  const w = await world();
  const k = key();
  const first = await authorize(w.ada, { to_handle: 'bob', amount: 2000 }, k);
  const again = await authorize(w.ada, { amount: 2000, to_handle: 'bob' }, k);
  assert.deepEqual([again.status, again.body], [200, first.body]);
  assert.equal((await me(w.ada)).held, 2000);
  assert.deepEqual(err(await authorize(w.ada, { to_handle: 'bob', amount: 2001 }, k)), [409, 'idempotency_key_reuse']);
  const a = first.body.authorization_id;
  const ck = key();
  const c1 = await capture(w.bob, a, {}, ck);
  assert.equal(c1.status, 201);
  const c2 = await capture(w.bob, a, {}, ck);
  assert.deepEqual([c2.status, c2.body], [200, c1.body], 'replay after the hold closed still returns the original');
  assert.deepEqual(err(await capture(w.bob, a, { amount: 2000 }, ck)), [409, 'idempotency_key_reuse']);
  assert.equal((await me(w.bob)).total, 4500);
  // a key whose capture failed is reusable
  const b = (await authorize(w.ada, { to_handle: 'bob', amount: 500 })).body.authorization_id;
  const fk = key();
  assert.deepEqual(err(await capture(w.bob, b, { amount: 501 }, fk)), [422, 'capture_exceeds_authorization']);
  assert.equal((await capture(w.bob, b, { amount: 500 }, fk)).status, 201);
});

test('expiry by the clock: holds release, status expired, capture 409 expired, void 409 not open', async () => {
  const w = await world(fixture({ authorization_ttl_seconds: 1 }));
  const a = (await authorize(w.ada, { to_handle: 'bob', amount: 3000 })).body;
  assert.equal(Date.parse(a.expires_at) - Date.parse(a.created_at), 1000);
  const b = (await authorize(w.ada, { to_handle: 'bob', amount: 1000 })).body.authorization_id;
  await capture(w.bob, b, { amount: 200, final: false });
  assert.equal((await me(w.ada)).held, 3800);
  await sleep(1200);
  const m = await me(w.ada);
  assert.deepEqual([m.total, m.available, m.held], [9800, 9800, 0]);
  const list = (await call('GET', '/authorizations', { token: w.ada })).body.authorizations;
  assert.deepEqual(list.map((x) => [x.status, x.remaining_amount]), [['expired', 0], ['expired', 0]]);
  assert.equal(list[0].captured_amount, 200, 'expiry preserves capture records');
  assert.deepEqual((await call('GET', '/authorizations?status=open', { token: w.ada })).body.authorizations, []);
  assert.equal((await call('GET', '/authorizations?status=expired', { token: w.bob })).body.authorizations.length, 2);
  assert.deepEqual(err(await capture(w.bob, a.authorization_id, {})), [409, 'authorization_expired']);
  assert.deepEqual(err(await voidAuth(w.ada, a.authorization_id)), [409, 'authorization_not_open']);
});

test('listing: only own, direction, status, newest first, paging, bad params', async () => {
  const w = await world();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await authorize(w.ada, { to_handle: 'bob', amount: 10 + i })).body.authorization_id);
  const inc = (await authorize(w.bob, { to_handle: 'ada', amount: 5 })).body.authorization_id;
  assert.deepEqual((await call('GET', '/authorizations', { token: w.cy })).body, { authorizations: [], has_more: false });
  let r = (await call('GET', '/authorizations', { token: w.ada })).body;
  assert.deepEqual(r.authorizations.map((x) => x.authorization_id), [inc, ...[...ids].reverse()]);
  r = (await call('GET', '/authorizations?direction=incoming', { token: w.ada })).body;
  assert.deepEqual(r.authorizations.map((x) => x.authorization_id), [inc]);
  r = (await call('GET', '/authorizations?direction=outgoing&limit=2', { token: w.ada })).body;
  assert.deepEqual([r.authorizations.length, r.has_more], [2, true]);
  await voidAuth(w.ada, ids[0]);
  r = (await call('GET', '/authorizations?status=voided', { token: w.bob })).body;
  assert.deepEqual(r.authorizations.map((x) => x.authorization_id), [ids[0]]);
  for (const q of ['direction=both', 'status=pending', 'status=', 'limit=0', 'limit=201', 'offset=-1', 'limit=1e1']) {
    assert.deepEqual(err(await call('GET', `/authorizations?${q}`, { token: w.ada })), [422, 'validation_failed'], q);
  }
});

test('concurrency: competing captures never over-capture; payments vs authorizations never overdraw available', async () => {
  const w = await world();
  const a = (await authorize(w.ada, { to_handle: 'bob', amount: 1000 })).body.authorization_id;
  const out = await Promise.all(Array.from({ length: 30 }, () => capture(w.bob, a, { amount: 100, final: false })));
  assert.equal(out.filter((r) => r.status === 201).length, 10);
  assert.ok(out.filter((r) => r.status !== 201).every((r) => ['authorization_not_open', 'capture_exceeds_authorization'].includes(err(r)[1])));
  assert.equal((await me(w.bob)).total, 3500);
  const mixed = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2
    ? authorize(w.ada, { to_handle: 'cy', amount: 300 }) : pay(w.ada, { to_handle: 'cy', amount: 300 }))));
  assert.ok(mixed.every((r) => r.status === 201 || err(r)[1] === 'insufficient_funds'));
  const m = await me(w.ada);
  assert.ok(m.available >= 0 && m.available < 300, JSON.stringify(m));
  assert.equal(m.total - m.held, m.available);
  const totals = (await me(w.ada)).total + (await me(w.bob)).total + (await me(w.cy)).total;
  assert.equal(totals, 13000);
  // same key, 30 concurrent captures: exactly one 201
  const b = (await authorize(w.bob, { to_handle: 'cy', amount: 100 })).body.authorization_id;
  const k = key();
  const same = await Promise.all(Array.from({ length: 30 }, () => capture(w.cy, b, {}, k)));
  assert.equal(same.filter((r) => r.status === 201).length, 1);
  assert.equal(same.filter((r) => r.status === 200).length, 29);
});

test('fixture: ttl rules, seeded holds derive available, past holds are expired, oversized holds rejected', async () => {
  for (const t of [0, -1, 1.5, '600', true]) {
    assert.deepEqual(err(await call('POST', '/_test/reset', { body: fixture({ authorization_ttl_seconds: t }) })), [422, 'validation_failed'], String(t));
  }
  const future = iso(Date.now() + 2 * HOUR);
  const past = iso(Date.now() - 2 * HOUR);
  const seeded = (id, amount, status, expires) => ({ id, from_user_id: 'u_ada', to_user_id: 'u_bob', amount, note: 'deposit', visibility: 'public', status, expires_at: expires });
  await reset(fixture({ authorizations: [seeded('a_1', 2000, 'open', future), seeded('a_2', 5000, 'open', past), seeded('a_3', 100, 'captured', past)] }));
  const ada = await login('ada');
  const m = await me(ada);
  assert.deepEqual([m.balance, m.total, m.available, m.held], [10000, 10000, 8000, 2000]);
  const list = (await call('GET', '/authorizations', { token: ada })).body.authorizations;
  assert.deepEqual(list.map((x) => [x.authorization_id, x.status]).sort(), [['a_1', 'open'], ['a_2', 'expired'], ['a_3', 'captured']]);
  assert.equal(list.find((x) => x.authorization_id === 'a_1').expires_at, future);
  const bob = await login('bob');
  assert.equal((await capture(bob, 'a_1', { amount: 500 })).status, 201);
  assert.deepEqual(err(await capture(bob, 'a_2', {})), [409, 'authorization_expired']);
  // an oversized sum of unexpired open holds is a reset error that changes nothing
  const bad = fixture({ authorizations: [seeded('a_1', 6000, 'open', future), seeded('a_2', 4001, 'open', future)] });
  assert.deepEqual(err(await call('POST', '/_test/reset', { body: bad })), [422, 'validation_failed']);
  assert.equal((await me(ada)).total, 9500, 'state unchanged after a rejected fixture');
  // past open holds do not count toward that check
  await reset(fixture({ authorizations: [seeded('a_1', 10000, 'open', future), seeded('a_2', 5000, 'open', past)] }));
});

test('export/import carries holds; a stage-1 layout export imports with defaults', async () => {
  const w = await world(fixture({ authorization_ttl_seconds: 900 }));
  const a = (await authorize(w.ada, { to_handle: 'bob', amount: 2000 })).body.authorization_id;
  const ck = key();
  const c = await capture(w.bob, a, { amount: 500, final: false }, ck);
  const ex = (await call('GET', '/_test/export')).body;
  await reset();
  assert.equal((await call('POST', '/_test/import', { body: ex })).status, 204);
  let m = await me(w.ada);
  assert.deepEqual([m.total, m.available, m.held], [9500, 8000, 1500]);
  assert.deepEqual((await capture(w.bob, a, { amount: 500, final: false }, ck)).body, c.body);
  const n = (await authorize(w.ada, { to_handle: 'cy', amount: 1 })).body;
  assert.equal(Date.parse(n.expires_at) - Date.parse(n.created_at), 900 * 1000, 'ttl survives import');
  assert.notEqual(n.authorization_id, a);
  // stage-1 layout: no authorizations, no ttl, payments without authorization_id
  const s1 = JSON.parse(JSON.stringify(ex));
  delete s1.state.authorizations;
  delete s1.state.authorization_ttl_seconds;
  for (const p of s1.state.payments) delete p.authorization_id;
  assert.equal((await call('POST', '/_test/import', { body: s1 })).status, 204);
  m = await me(w.ada);
  assert.deepEqual([m.total, m.available, m.held], [9500, 9500, 0]);
  const feed = (await call('GET', '/activity', { token: w.ada })).body.payments;
  assert.ok(feed.every((p) => 'authorization_id' in p));
  // an import whose holds exceed a balance is invalid and changes nothing
  const bad = JSON.parse(JSON.stringify(ex));
  bad.state.authorizations[0].remaining = 1500;
  bad.state.users.find((u) => u.id === 'u_ada').balance = 100;
  assert.equal((await call('POST', '/_test/import', { body: bad })).status, 422);
  assert.equal((await me(w.ada)).held, 0);
});

test('content negotiation: pages for text/html, JSON otherwise; assets are served locally', async () => {
  const w = await world();
  for (const p of ['/', '/split', '/signup', '/login']) {
    const r = await call('GET', p);
    assert.equal(r.status, 200);
    assert.ok(r.ct.startsWith('text/html'), p);
  }
  for (const p of ['/requests', '/authorizations']) {
    const html = await call('GET', p, { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
    assert.ok(html.status === 200 && html.ct.startsWith('text/html'), p);
    assert.deepEqual(err(await call('GET', p)), [401, 'unauthenticated']);
    assert.equal((await call('GET', p, { token: w.ada, headers: { accept: 'application/json' } })).status, 200);
  }
  for (const p of ['/assets/app.js', '/assets/app.css', '/favicon.svg']) {
    assert.equal((await call('GET', p)).status, 200, p);
  }
  const shell = (await call('GET', '/')).text;
  assert.ok(!/https?:\/\//.test(shell.replace('http://www.w3.org', '')), 'no external URLs in the page shell');
});
