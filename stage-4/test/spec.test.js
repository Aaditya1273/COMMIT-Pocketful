'use strict';
// Builder's own checks for stage 1, written from the specification. They start the
// server in-process (or target POCKETFUL_URL, e.g. a running container) and talk HTTP.
//   node --test test/
//   POCKETFUL_URL=http://127.0.0.1:9000 node --test test/

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
after(() => {
  if (server) {
    server.closeAllConnections();
    server.close();
  }
});

const key = () => crypto.randomUUID();
const PW = 'correct horse';
const user = (handle, balance, extra = {}) => ({
  id: `u_${handle}`, email: `${handle}@example.com`, password: PW,
  display_name: handle, handle, balance, ...extra,
});
const fixture = (over = {}) => ({
  currency: 'EUR', minor_units: 2,
  users: [user('ada', 10000), user('bob', 2500), user('cy', 500)],
  payments: [], requests: [], ...over,
});

async function call(method, path, { token, body, raw, idem, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (idem !== undefined) h['idempotency-key'] = idem;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) payload = JSON.stringify(body);
  if (payload !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  if (text) json = JSON.parse(text);
  if (res.status >= 400) {
    assert.ok(json && json.error && typeof json.error.code === 'string' && typeof json.error.message === 'string',
      `error envelope missing: ${res.status} ${text}`);
  }
  if (res.status !== 204) {
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  }
  assert.ok(res.status < 500, `5xx: ${method} ${path} ${res.status} ${text}`);
  return { status: res.status, body: json };
}
const err = (r) => [r.status, r.body && r.body.error && r.body.error.code];

async function reset(f = fixture()) {
  const r = await call('POST', '/_test/reset', { body: f });
  assert.equal(r.status, 204, JSON.stringify(r.body));
}
async function login(handle) {
  const r = await call('POST', '/auth/login', { body: { email: `${handle}@example.com`, password: PW } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}
async function world(f) {
  await reset(f);
  return { ada: await login('ada'), bob: await login('bob'), cy: await login('cy') };
}
const bal = async (t) => (await call('GET', '/me', { token: t })).body.balance;
const pay = (t, body, idem = key()) => call('POST', '/payments', { token: t, body, idem });
const ask = (t, body, idem = key()) => call('POST', '/requests', { token: t, body, idem });
const TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?[+-]\d\d:\d\d$/;

// ---- runtime contract ----------------------------------------------------------

test('health, unknown routes and wrong methods', async () => {
  assert.deepEqual((await call('GET', '/health')).body, { status: 'ok' });
  assert.deepEqual(err(await call('GET', '/nope')), [404, 'not_found']);
  assert.deepEqual(err(await call('DELETE', '/payments')), [404, 'not_found']);
});

test('reset replaces state, invalidates tokens, rejects bad fixtures unchanged', async () => {
  const w = await world();
  await pay(w.ada, { to_handle: 'bob', amount: 100 });
  await reset();
  assert.deepEqual(err(await call('GET', '/me', { token: w.ada })), [401, 'unauthenticated']);
  const ada = await login('ada');
  assert.equal(await bal(ada), 10000);
  assert.deepEqual((await call('GET', '/activity', { token: ada })).body.payments, []);
  const bad = [
    fixture({ users: [user('ada', -1)] }),
    fixture({ minor_units: 1 }),
    fixture({ users: [user('ada', 1), user('ada', 2, { id: 'u_x', email: 'x@e.com' })] }),
    fixture({ users: [user('ada', 1), { ...user('bob', 1), id: 'u_ada' }] }),
    fixture({ users: [{ ...user('ada', 1), handle: 'ADA' }] }),
    fixture({ users: [user('ada', 1.5)] }),
    fixture({ payments: [{ id: 'p', from_user_id: 'u_zz', to_user_id: 'u_ada', amount: 1 }] }),
    fixture({ settlement_operator_ids: ['u_zz'] }),
  ];
  for (const f of bad) {
    assert.deepEqual(err(await call('POST', '/_test/reset', { body: f })), [422, 'validation_failed'], JSON.stringify(f));
  }
  assert.deepEqual(err(await call('POST', '/_test/reset', { raw: '{nope' })), [400, 'malformed_request']);
  assert.equal(await bal(ada), 10000, 'rejected fixtures change nothing');
});

test('reset with 300 users stays fast and every seeded user can log in', async () => {
  const users = Array.from({ length: 300 }, (_, i) => user(`u${i}`, 10, i % 3 ? {} : { password: `pw-${i}-long` }));
  const t0 = Date.now();
  await reset(fixture({ users }));
  assert.ok(Date.now() - t0 < 5000, `reset took ${Date.now() - t0}ms`);
  const r = await call('POST', '/auth/login', { body: { email: 'u3@example.com', password: 'pw-3-long' } });
  assert.equal(r.status, 200);
  const r2 = await call('POST', '/auth/login', { body: { email: 'u4@example.com', password: PW } });
  assert.equal(r2.status, 200);
});

test('fixture currencies and seeded data shapes', async () => {
  for (const [currency, mu] of [['JPY', 0], ['BHD', 3], ['EUR', 2]]) {
    await reset(fixture({ currency, minor_units: mu }));
    const t = await login('ada');
    const me = (await call('GET', '/me', { token: t })).body;
    assert.deepEqual(me, { user_id: 'u_ada', display_name: 'ada', handle: 'ada', balance: 10000, total: 10000, available: 10000, held: 0, currency, minor_units: mu });
  }
});

// ---- auth ----------------------------------------------------------------------

test('signup derives handles, validates, and rejects conflicts', async () => {
  const w = await world();
  let r = await call('POST', '/auth/signup', { body: { email: 'Dee.Ann+tag@Example.com', password: '12345678', display_name: 'Dee' } });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body).sort(), ['display_name', 'token', 'user_id']);
  const me = (await call('GET', '/me', { token: r.body.token })).body;
  assert.equal(me.handle, 'dee_ann_tag');
  assert.equal(me.balance, 0);
  // receive immediately and be asked immediately
  assert.equal((await pay(w.ada, { to_handle: 'dee_ann_tag', amount: 5 })).status, 201);
  assert.equal((await ask(w.ada, { payer_handle: 'dee_ann_tag', amount: 50 })).status, 201);
  // login is case-insensitive on email
  assert.equal((await call('POST', '/auth/login', { body: { email: 'dee.ann+tag@example.com', password: '12345678' } })).status, 200);
  assert.deepEqual(err(await call('POST', '/auth/signup', { body: { email: 'dee.ann+tag@example.com', password: '12345678', display_name: 'x' } })), [409, 'email_taken']);
  assert.deepEqual(err(await call('POST', '/auth/signup', { body: { email: 'ada@other.com', password: '12345678', display_name: 'x' } })), [409, 'handle_taken']);
  assert.deepEqual(err(await call('POST', '/auth/login', { body: { email: 'ada@other.com', password: '12345678' } })), [401, 'unauthenticated']);
  assert.deepEqual(err(await call('POST', '/auth/signup', { body: { email: 'eve@example.com', password: '1234567', display_name: 'x' } })), [422, 'validation_failed']);
  for (const email of ['noat', '@example.com', 'eve@', 'a@b@c', 'e ve@example.com']) {
    assert.deepEqual(err(await call('POST', '/auth/signup', { body: { email, password: '12345678', display_name: 'x' } })), [422, 'validation_failed'], email);
  }
  assert.deepEqual(err(await call('POST', '/auth/signup', { body: { email: 5, password: '12345678', display_name: 'x' } })), [400, 'malformed_request']);
  assert.deepEqual(err(await call('POST', '/auth/signup', { body: { password: '12345678', display_name: 'x' } })), [422, 'validation_failed']);
  r = await call('POST', '/auth/signup', { body: { email: `${'Z'.repeat(25)}@example.com`, password: '12345678', display_name: 'L' } });
  assert.equal((await call('GET', '/me', { token: r.body.token })).body.handle, 'z'.repeat(20));
});

test('login failures and bearer token handling', async () => {
  const w = await world();
  assert.deepEqual(err(await call('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'wrong pass' } })), [401, 'unauthenticated']);
  assert.deepEqual(err(await call('POST', '/auth/login', { body: { email: 'zz@example.com', password: PW } })), [401, 'unauthenticated']);
  for (const h of [undefined, 'Bearer', 'Bearer nope', `Basic ${w.ada}`, w.ada]) {
    const headers = h === undefined ? {} : { authorization: h };
    assert.deepEqual(err(await call('GET', '/me', { headers })), [401, 'unauthenticated'], String(h));
  }
  const second = await login('ada');
  assert.equal(await bal(second), await bal(w.ada), 'concurrent sessions');
});

test('50 concurrent logins finish well inside the timeout', async () => {
  await world();
  const t0 = Date.now();
  const out = await Promise.all(Array.from({ length: 50 }, () => call('POST', '/auth/login', { body: { email: 'ada@example.com', password: PW } })));
  assert.ok(out.every((r) => r.status === 200));
  assert.ok(Date.now() - t0 < 4000, `${Date.now() - t0}ms`);
});

// ---- payments and validation precedence -----------------------------------------

test('payment shape, defaults, timestamps', async () => {
  const w = await world();
  const r = await pay(w.ada, { to_handle: 'bob', amount: 1500, note: 'dinner' });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body).sort(), ['amount', 'created_at', 'currency', 'from_handle', 'from_user_id', 'note',
    'payment_id', 'request_id', 'settlement_id', 'to_handle', 'to_user_id', 'visibility', 'authorization_id', 'refund_of'].sort());
  assert.equal(r.body.visibility, 'public');
  assert.equal(r.body.settlement_id, null);
  assert.match(r.body.created_at, TS_RE);
  assert.ok(r.body.payment_id.length <= 64);
  assert.equal(await bal(w.ada), 8500);
  assert.equal(await bal(w.bob), 4000);
});

test('amount, note and visibility validation', async () => {
  const w = await world();
  for (const amount of [0, -1, '1000', true, null, 1.5, 1000000001, 1e400, -0]) {
    assert.deepEqual(err(await call('POST', '/payments', { token: w.ada, idem: key(), raw: `{"to_handle":"bob","amount":${JSON.stringify(amount) ?? 'null'}}` })), [422, 'validation_failed'], String(amount));
  }
  assert.deepEqual(err(await call('POST', '/payments', { token: w.ada, idem: key(), raw: '{"to_handle":"bob","amount":1e400}' })), [422, 'validation_failed']);
  assert.deepEqual(err(await call('POST', '/payments', { token: w.ada, idem: key(), raw: '{"to_handle":"bob","amount":1.0000000001e9}' })), [422, 'validation_failed']);
  assert.equal((await call('POST', '/payments', { token: w.ada, idem: key(), raw: '{"to_handle":"bob","amount":1e3}' })).body.amount, 1000);
  assert.equal((await call('POST', '/payments', { token: w.ada, idem: key(), raw: '{"to_handle":"bob","amount":10.0}' })).body.amount, 10);
  assert.deepEqual(err(await pay(w.ada, { to_handle: 'bob' })), [422, 'validation_failed']);
  assert.deepEqual(err(await pay(w.ada, { amount: 5 })), [422, 'validation_failed']);
  assert.deepEqual(err(await pay(w.ada, { to_handle: 7, amount: 5 })), [400, 'malformed_request']);
  for (const note of [null, 5, 'x'.repeat(201), '😀'.repeat(201)]) {
    assert.deepEqual(err(await pay(w.ada, { to_handle: 'bob', amount: 1, note })), [422, 'validation_failed']);
  }
  const note = '  café 😀 <b>&amp;</b>\n\u0000 ñ  ';
  assert.equal((await pay(w.ada, { to_handle: 'bob', amount: 1, note })).body.note, note);
  assert.equal((await pay(w.ada, { to_handle: 'bob', amount: 1, note: '😀'.repeat(200) })).status, 201);
  assert.equal((await pay(w.ada, { to_handle: 'bob', amount: 1, note: '' })).status, 201);
  for (const visibility of ['Public', '', null, 1, 'secret']) {
    assert.deepEqual(err(await pay(w.ada, { to_handle: 'bob', amount: 1, visibility })), [422, 'validation_failed']);
  }
  for (const raw of ['{nope', '[]', '"x"', '3', 'null', '']) {
    assert.deepEqual(err(await call('POST', '/payments', { token: w.ada, idem: key(), raw })), [400, 'malformed_request'], raw);
  }
  for (const h of ['nobody', 'ADA', '@ada', '']) {
    assert.deepEqual(err(await pay(w.ada, { to_handle: h, amount: 1 })), [404, 'not_found']);
  }
  assert.deepEqual(err(await pay(w.ada, { to_handle: 'ada', amount: 1 })), [422, 'self_payment']);
  assert.deepEqual(err(await pay(w.ada, { to_handle: 'bob', amount: 1000000000 })), [409, 'insufficient_funds']);
  assert.equal((await pay(w.ada, { to_handle: 'bob', amount: 1, colour: 'blue' })).status, 201);
});

test('error precedence: 401 before 400 before missing key before key length', async () => {
  const w = await world();
  assert.deepEqual(err(await call('POST', '/payments', { raw: '{nope' })), [401, 'unauthenticated']);
  assert.deepEqual(err(await call('POST', '/payments', { token: w.ada, raw: '{nope' })), [400, 'malformed_request']);
  assert.deepEqual(err(await call('POST', '/payments', { token: w.ada, body: { amount: -1 } })), [400, 'missing_idempotency_key']);
  assert.deepEqual(err(await call('POST', '/payments', { token: w.ada, body: { amount: 1 }, idem: '' })), [400, 'missing_idempotency_key']);
  assert.deepEqual(err(await call('POST', '/payments', { token: w.ada, body: { amount: -1 }, idem: 'k'.repeat(256) })), [422, 'validation_failed']);
  assert.equal((await pay(w.ada, { to_handle: 'bob', amount: 1 }, 'k'.repeat(255))).status, 201);
  assert.equal((await pay(w.ada, { to_handle: 'bob', amount: 1 }, 'k')).status, 201);
  assert.deepEqual(err(await pay(w.ada, { to_handle: 'bob', amount: 1 }, 'k'.repeat(10000))), [422, 'validation_failed']);
});

test('exact balance boundary and insufficient funds leave no trace', async () => {
  const w = await world();
  assert.deepEqual(err(await pay(w.cy, { to_handle: 'bob', amount: 501 })), [409, 'insufficient_funds']);
  assert.equal((await call('GET', '/activity', { token: w.cy })).body.payments.length, 0);
  assert.equal((await pay(w.cy, { to_handle: 'bob', amount: 500 })).status, 201);
  assert.equal(await bal(w.cy), 0);
});

// ---- idempotency ---------------------------------------------------------------

test('replay, reuse, scoping and failed keys', async () => {
  const w = await world();
  const k = key();
  const first = await call('POST', '/payments', { token: w.ada, idem: k, raw: '{"to_handle":"bob","amount":300,"note":"a"}' });
  assert.equal(first.status, 201);
  const replay = await call('POST', '/payments', { token: w.ada, idem: k, raw: '{ "note":"a", "amount":3e2,   "to_handle":"bob"}' });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.equal(await bal(w.ada), 9700);
  assert.deepEqual(err(await pay(w.ada, { to_handle: 'bob', amount: 301, note: 'a' }, k)), [409, 'idempotency_key_reuse']);
  // reuse resolved before field validation
  assert.deepEqual(err(await pay(w.ada, { to_handle: 'bob', amount: -5 }, k)), [409, 'idempotency_key_reuse']);
  assert.deepEqual(err(await pay(w.ada, { to_handle: 'nobody', amount: 1 }, k)), [409, 'idempotency_key_reuse']);
  // different path is not a replay
  assert.equal((await ask(w.ada, { payer_handle: 'bob', amount: 300, note: 'a' }, k)).status, 201);
  // different user is independent
  assert.equal((await pay(w.bob, { to_handle: 'cy', amount: 1 }, k)).status, 201);
  // failed keys are reusable with any body
  for (const failing of [{ to_handle: 'nobody', amount: 1 }, { to_handle: 'bob', amount: -1 }, { to_handle: 'bob', amount: 99999999 }]) {
    const fk = key();
    assert.ok((await pay(w.ada, failing, fk)).status >= 400);
    assert.equal((await pay(w.ada, { to_handle: 'cy', amount: 2 }, fk)).status, 201);
  }
});

test('replay returns the original body after the resource changed', async () => {
  const w = await world();
  const k = key();
  const rq = await ask(w.bob, { payer_handle: 'ada', amount: 100 }, k);
  assert.equal((await call('POST', `/requests/${rq.body.request_id}/cancel`, { token: w.bob })).body.status, 'cancelled');
  const again = await ask(w.bob, { payer_handle: 'ada', amount: 100 }, k);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, rq.body);
  assert.equal(again.body.status, 'pending');
});

test('50 concurrent identical requests with one unused key: one 201, 49 identical 200s', async () => {
  for (const path of ['/payments', '/requests', '/splits']) {
    const w = await world();
    const k = key();
    const body = path === '/payments' ? { to_handle: 'bob', amount: 100 }
      : path === '/requests' ? { payer_handle: 'bob', amount: 100 }
        : { amount: 100, participant_handles: ['ada', 'bob', 'cy'] };
    const out = await Promise.all(Array.from({ length: 50 }, () => call('POST', path, { token: w.ada, body, idem: k })));
    assert.equal(out.filter((r) => r.status === 201).length, 1, path);
    assert.equal(out.filter((r) => r.status === 200).length, 49, path);
    for (const r of out) assert.deepEqual(r.body, out[0].body);
    if (path === '/payments') assert.equal(await bal(w.ada), 9900);
    if (path === '/requests') assert.equal((await call('GET', '/requests', { token: w.ada })).body.requests.length, 1);
    if (path === '/splits') assert.equal((await call('GET', '/requests', { token: w.ada })).body.requests.length, 2);
  }
});

// ---- concurrency and conservation -------------------------------------------------

test('concurrent drains, rings and many wallets conserve money and never go negative', async () => {
  const users = Array.from({ length: 50 }, (_, i) => user(`w${i}`, 1000));
  await reset(fixture({ users }));
  const tokens = await Promise.all(users.map((u) => login(u.handle)));
  // drain one wallet in parts from 50 clients at once
  const drain = await Promise.all(Array.from({ length: 50 }, () => pay(tokens[0], { to_handle: 'w1', amount: 30 })));
  assert.equal(drain.filter((r) => r.status === 201).length, 33);
  assert.ok(drain.every((r) => r.status === 201 || err(r)[1] === 'insufficient_funds'));
  assert.equal(await bal(tokens[0]), 10);
  // ring: everyone pays the next one, repeatedly, in parallel
  const ring = [];
  for (let round = 0; round < 4; round++) {
    users.forEach((u, i) => ring.push(pay(tokens[i], { to_handle: users[(i + 1) % users.length].handle, amount: 400 })));
  }
  const out = await Promise.all(ring);
  assert.ok(out.every((r) => r.status === 201 || err(r)[1] === 'insufficient_funds'));
  const balances = await Promise.all(tokens.map(bal));
  assert.ok(balances.every((b) => b >= 0));
  assert.equal(balances.reduce((a, b) => a + b, 0), 50 * 1000);
});

test('concurrent pay of one request with different keys moves money once; pay vs decline', async () => {
  const w = await world();
  const rq = (await ask(w.bob, { payer_handle: 'ada', amount: 700 })).body.request_id;
  const out = await Promise.all(Array.from({ length: 20 }, () => call('POST', `/requests/${rq}/pay`, { token: w.ada, body: {}, idem: key() })));
  assert.equal(out.filter((r) => r.status === 201).length, 1);
  assert.ok(out.filter((r) => r.status !== 201).every((r) => err(r)[1] === 'request_not_pending'));
  assert.equal(await bal(w.ada), 9300);
  const rq2 = (await ask(w.bob, { payer_handle: 'ada', amount: 700 })).body.request_id;
  const [p, d] = await Promise.all([
    call('POST', `/requests/${rq2}/pay`, { token: w.ada, body: {}, idem: key() }),
    call('POST', `/requests/${rq2}/decline`, { token: w.ada }),
  ]);
  const listed = (await call('GET', '/requests', { token: w.ada })).body.requests.find((r) => r.request_id === rq2);
  if (p.status === 201) {
    assert.equal(listed.status, 'paid');
    assert.deepEqual(err(d), [409, 'request_not_pending']);
  } else {
    assert.equal(listed.status, 'declined');
    assert.deepEqual(err(p), [409, 'request_not_pending']);
  }
  assert.equal(await bal(w.ada) + await bal(w.bob) + await bal(w.cy), 13000);
});

// ---- requests ------------------------------------------------------------------

test('request lifecycle, permissions and listing', async () => {
  const w = await world();
  const r = await ask(w.bob, { payer_handle: 'ada', amount: 50000, note: 'big' });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body).sort(), ['amount', 'created_at', 'currency', 'note', 'payer_handle', 'payer_id',
    'payment_id', 'request_id', 'requester_handle', 'requester_id', 'status']);
  const id = r.body.request_id;
  assert.deepEqual(err(await ask(w.bob, { payer_handle: 'bob', amount: 1 })), [422, 'self_request']);
  assert.deepEqual(err(await ask(w.bob, { payer_handle: 'zz', amount: 1 })), [404, 'not_found']);
  assert.deepEqual(err(await ask(w.bob, { payer_handle: 'ada', amount: 0 })), [422, 'validation_failed']);
  // short: 409, stays pending, payable later with the same key
  const k = key();
  assert.deepEqual(err(await call('POST', `/requests/${id}/pay`, { token: w.ada, body: {}, idem: k })), [409, 'insufficient_funds']);
  assert.equal((await pay(w.bob, { to_handle: 'ada', amount: 2500 })).status, 201);
  assert.equal((await pay(w.cy, { to_handle: 'ada', amount: 500 })).status, 201);
  assert.deepEqual(err(await call('POST', `/requests/${id}/pay`, { token: w.ada, body: {}, idem: k })), [409, 'insufficient_funds']);
  // third parties: 403 on every action, never listed
  assert.deepEqual(err(await call('POST', `/requests/${id}/pay`, { token: w.cy, body: {}, idem: key() })), [403, 'forbidden']);
  assert.deepEqual(err(await call('POST', `/requests/${id}/decline`, { token: w.cy })), [403, 'forbidden']);
  assert.deepEqual(err(await call('POST', `/requests/${id}/cancel`, { token: w.cy })), [403, 'forbidden']);
  assert.deepEqual(err(await call('POST', `/requests/${id}/decline`, { token: w.bob })), [403, 'forbidden']);
  assert.deepEqual(err(await call('POST', `/requests/${id}/cancel`, { token: w.ada })), [403, 'forbidden']);
  assert.deepEqual(err(await call('POST', `/requests/${id}/pay`, { token: w.bob, body: {}, idem: key() })), [403, 'forbidden']);
  assert.deepEqual(err(await call('POST', '/requests/nope/pay', { token: w.ada, body: {}, idem: key() })), [404, 'not_found']);
  assert.deepEqual(err(await call('POST', '/requests/nope/decline', { token: w.ada })), [404, 'not_found']);
  assert.deepEqual((await call('GET', '/requests', { token: w.cy })).body, { requests: [], has_more: false });
  // pay with private visibility via an empty-body-equivalent key semantics
  const small = (await ask(w.bob, { payer_handle: 'ada', amount: 10 })).body.request_id;
  const pk = key();
  const paid = await call('POST', `/requests/${small}/pay`, { token: w.ada, idem: pk });
  assert.equal(paid.status, 201, 'empty body is {}');
  assert.equal(paid.body.visibility, 'public');
  assert.equal(paid.body.request_id, small);
  assert.equal((await call('POST', `/requests/${small}/pay`, { token: w.ada, body: {}, idem: pk })).status, 200);
  assert.deepEqual(err(await call('POST', `/requests/${small}/pay`, { token: w.ada, body: { visibility: 'public' }, idem: pk })), [409, 'idempotency_key_reuse']);
  assert.deepEqual(err(await call('POST', `/requests/${small}/pay`, { token: w.ada, body: {}, idem: key() })), [409, 'request_not_pending']);
  assert.deepEqual(err(await call('POST', `/requests/${small}/cancel`, { token: w.bob })), [409, 'request_not_pending']);
  assert.deepEqual(err(await call('POST', `/requests/${small}/decline`, { token: w.ada })), [409, 'request_not_pending']);
  const listed = (await call('GET', '/requests', { token: w.ada, })).body.requests.find((x) => x.request_id === small);
  assert.equal(listed.status, 'paid');
  assert.equal(listed.payment_id, paid.body.payment_id);
  // decline twice ok, cancel of declined 409; cancel twice ok, decline of cancelled 409
  assert.equal((await call('POST', `/requests/${id}/decline`, { token: w.ada, raw: 'garbage' })).body.status, 'declined');
  assert.equal((await call('POST', `/requests/${id}/decline`, { token: w.ada })).status, 200);
  assert.deepEqual(err(await call('POST', `/requests/${id}/cancel`, { token: w.bob })), [409, 'request_not_pending']);
  const c = (await ask(w.bob, { payer_handle: 'ada', amount: 10 })).body.request_id;
  assert.equal((await call('POST', `/requests/${c}/cancel`, { token: w.bob })).body.status, 'cancelled');
  assert.equal((await call('POST', `/requests/${c}/cancel`, { token: w.bob })).status, 200);
  assert.deepEqual(err(await call('POST', `/requests/${c}/decline`, { token: w.ada })), [409, 'request_not_pending']);
  // invalid visibility on pay after resolving payer
  const v = (await ask(w.bob, { payer_handle: 'ada', amount: 10 })).body.request_id;
  assert.deepEqual(err(await call('POST', `/requests/${v}/pay`, { token: w.ada, body: { visibility: 'x' }, idem: key() })), [422, 'validation_failed']);
});

test('request listing filters, ordering and paging', async () => {
  const w = await world();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await ask(w.bob, { payer_handle: 'ada', amount: 10 + i })).body.request_id);
  const out = (await ask(w.ada, { payer_handle: 'bob', amount: 7 })).body.request_id;
  let r = (await call('GET', '/requests', { token: w.ada })).body;
  assert.deepEqual(r.requests.map((x) => x.request_id), [out, ...ids.reverse()]);
  r = (await call('GET', '/requests?direction=incoming', { token: w.ada })).body;
  assert.equal(r.requests.length, 5);
  r = (await call('GET', '/requests?direction=outgoing', { token: w.ada })).body;
  assert.deepEqual(r.requests.map((x) => x.request_id), [out]);
  await call('POST', `/requests/${out}/cancel`, { token: w.ada });
  r = (await call('GET', '/requests?status=cancelled&direction=outgoing', { token: w.ada })).body;
  assert.deepEqual(r.requests.map((x) => x.request_id), [out]);
  r = (await call('GET', '/requests?limit=2&offset=4', { token: w.ada })).body;
  assert.equal(r.requests.length, 2);
  assert.equal(r.has_more, false);
  r = (await call('GET', '/requests?limit=2&offset=3', { token: w.ada })).body;
  assert.equal(r.has_more, true);
  r = (await call('GET', '/requests?limit=200&offset=0&foo=bar', { token: w.ada })).body;
  assert.equal(r.requests.length, 6);
  for (const q of ['direction=both', 'direction=', 'status=open', 'status=', 'limit=0', 'limit=201', 'limit=-1', 'limit=abc',
    'limit=1e2', 'limit=%2B4', 'limit=4.0', 'limit=', 'offset=-1', 'offset=abc', 'offset=1e1']) {
    assert.deepEqual(err(await call('GET', `/requests?${q}`, { token: w.ada })), [422, 'validation_failed'], q);
  }
  assert.deepEqual(err(await call('GET', '/requests?limit=0')), [401, 'unauthenticated']);
});

// ---- splits ----------------------------------------------------------------------

test('split rule, requests and validation', async () => {
  const w = await world();
  const cases = [[1000, 3, [334, 333, 333]], [1, 3, [1, 0, 0]], [10, 3, [4, 3, 3]], [999, 3, [333, 333, 333]], [5, 5, [1, 1, 1, 1, 1]]];
  await reset(fixture({ users: [user('ada', 10), user('bob', 0), user('cy', 0), user('dd', 0), user('ee', 0)] }));
  const ada = await login('ada');
  for (const [amount, n, shares] of cases) {
    const handles = ['ada', 'bob', 'cy', 'dd', 'ee'].slice(0, n);
    const r = await call('POST', '/splits', { token: ada, body: { amount, participant_handles: handles, note: 'n' }, idem: key() });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.shares.map((s) => s.amount), shares);
    assert.deepEqual(r.body.shares.map((s) => s.handle), handles);
    assert.deepEqual(r.body.requests.map((x) => x.payer_handle), handles.slice(1));
    assert.deepEqual(r.body.requests.map((x) => x.amount), shares.slice(1));
    assert.ok(r.body.requests.every((x) => x.requester_handle === 'ada' && x.status === 'pending' && x.note === 'n'));
    assert.deepEqual(Object.keys(r.body).sort(), ['amount', 'created_at', 'currency', 'note', 'requests', 'shares', 'split_id']);
  }
  // caller omitted: every listed handle is a participant and gets a request
  const om = await call('POST', '/splits', { token: ada, body: { amount: 10, participant_handles: ['cy', 'bob'] }, idem: key() });
  assert.deepEqual(om.body.shares, [{ handle: 'cy', amount: 5 }, { handle: 'bob', amount: 5 }]);
  assert.equal(om.body.requests.length, 2);
  // only caller
  const solo = await call('POST', '/splits', { token: ada, body: { amount: 999, participant_handles: ['ada'] }, idem: key() });
  assert.deepEqual([solo.body.requests, solo.body.shares], [[], [{ handle: 'ada', amount: 999 }]]);
  // zero-share request can be paid: moves 0 and creates a 0-amount payment
  const z = await call('POST', '/splits', { token: ada, body: { amount: 1, participant_handles: ['ada', 'bob'] }, idem: key() });
  const zr = z.body.requests[0];
  assert.equal(zr.amount, 0);
  const bob = await login('bob');
  const zp = await call('POST', `/requests/${zr.request_id}/pay`, { token: bob, body: {}, idem: key() });
  assert.equal(zp.status, 201);
  assert.equal(zp.body.amount, 0);
  // validation
  const bad = [
    [{ amount: 0, participant_handles: ['ada'] }, 422, 'validation_failed'],
    [{ amount: 10, participant_handles: [] }, 422, 'validation_failed'],
    [{ amount: 10, participant_handles: ['bob', 'bob'] }, 422, 'validation_failed'],
    [{ amount: 10 }, 422, 'validation_failed'],
    [{ amount: 10, participant_handles: ['bob'], note: null }, 422, 'validation_failed'],
    [{ amount: 10, participant_handles: ['bob', 'zz'] }, 404, 'not_found'],
    [{ amount: 10, participant_handles: 'bob' }, 400, 'malformed_request'],
    [{ amount: 10, participant_handles: Array.from({ length: 1000 }, (_, i) => `h${i}`) }, 404, 'not_found'],
  ];
  for (const [body, s, c] of bad) {
    assert.deepEqual(err(await call('POST', '/splits', { token: ada, body, idem: key() })), [s, c], JSON.stringify(body).slice(0, 80));
  }
  // split checks no balance
  assert.equal((await call('POST', '/splits', { token: ada, body: { amount: 1000000000, participant_handles: ['bob', 'cy'] }, idem: key() })).status, 201);
});

test('paying every split request in full conserves money', async () => {
  const w = await world();
  const total = async () => (await bal(w.ada)) + (await bal(w.bob)) + (await bal(w.cy));
  for (const [amount, handles] of [[1000, ['ada', 'bob', 'cy']], [7, ['cy', 'bob', 'ada']], [301, ['bob', 'cy']]]) {
    const s = (await call('POST', '/splits', { token: w.ada, body: { amount, participant_handles: handles }, idem: key() })).body;
    for (const r of s.requests) {
      const t = r.payer_handle === 'bob' ? w.bob : w.cy;
      assert.equal((await call('POST', `/requests/${r.request_id}/pay`, { token: t, body: {}, idem: key() })).status, 201);
    }
  }
  assert.equal(await total(), 13000);
});

// ---- activity feed ------------------------------------------------------------------

test('feed contract: public to all, private to the two parties only, newest first', async () => {
  const w = await world(fixture({
    payments: [{ id: 'p_1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 500, note: 'coffee', visibility: 'private' },
      { id: 'p_2', from_user_id: 'u_bob', to_user_id: 'u_cy', amount: 5, note: '', visibility: 'public' }],
  }));
  assert.deepEqual((await call('GET', '/activity', { token: w.cy })).body.payments.map((p) => p.payment_id), ['p_2']);
  assert.deepEqual((await call('GET', '/activity', { token: w.ada })).body.payments.map((p) => p.payment_id), ['p_2', 'p_1']);
  const a = (await pay(w.ada, { to_handle: 'bob', amount: 1, visibility: 'private' })).body.payment_id;
  const b = (await pay(w.bob, { to_handle: 'ada', amount: 1 })).body.payment_id;
  const feedA = (await call('GET', '/activity', { token: w.ada })).body.payments;
  assert.deepEqual(feedA.map((p) => p.payment_id), [b, a, 'p_2', 'p_1']);
  const times = feedA.map((p) => Date.parse(p.created_at));
  assert.deepEqual(times, [...times].sort((x, y) => y - x));
  assert.deepEqual((await call('GET', '/activity', { token: w.cy })).body.payments.map((p) => p.payment_id), [b, 'p_2']);
  // requests never appear; pay-of-request private hidden from third party
  const rq = (await ask(w.cy, { payer_handle: 'ada', amount: 3 })).body.request_id;
  await call('POST', `/requests/${rq}/pay`, { token: w.ada, body: { visibility: 'private' }, idem: key() });
  assert.equal((await call('GET', '/activity', { token: w.bob })).body.payments.length, 4);
  assert.equal((await call('GET', '/activity', { token: w.cy })).body.payments.length, 3);
  const page = (await call('GET', '/activity?limit=2&offset=1&status=open', { token: w.ada })).body;
  assert.equal(page.payments.length, 2);
  assert.equal(page.has_more, true);
  for (const q of ['limit=0', 'limit=201', 'offset=-1', 'offset=abc', 'limit=%2B4']) {
    assert.deepEqual(err(await call('GET', `/activity?${q}`, { token: w.ada })), [422, 'validation_failed'], q);
  }
});

// ---- settlements --------------------------------------------------------------------

test('settlements: permissions, validation order, net affordability, atomicity, replay', async () => {
  await reset(fixture({ users: [user('ada', 10000), user('bob', 50), user('cy', 0), user('op', 0)], settlement_operator_ids: ['u_op'] }));
  const [ada, bob, cy, op] = await Promise.all(['ada', 'bob', 'cy', 'op'].map(login));
  const settle = (t, body, idem = key()) => call('POST', '/settlements', { token: t, body, idem });
  assert.deepEqual(err(await call('POST', '/settlements', { body: { transfers: [] }, idem: key() })), [401, 'unauthenticated']);
  assert.deepEqual(err(await settle(ada, { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 1 }] })), [403, 'forbidden']);
  assert.deepEqual(err(await call('POST', '/settlements', { token: op, body: { transfers: [] } })), [400, 'missing_idempotency_key']);
  const t = (from, to, amount, extra = {}) => ({ from_handle: from, to_handle: to, amount, ...extra });
  const bad = [
    [{}, 422, 'validation_failed'],
    [{ transfers: {} }, 422, 'validation_failed'],
    [{ transfers: [] }, 422, 'validation_failed'],
    [{ transfers: Array.from({ length: 33 }, () => t('ada', 'bob', 1)) }, 422, 'validation_failed'],
    [{ transfers: [5] }, 422, 'validation_failed'],
    [{ transfers: [t(1, 'bob', 1)] }, 422, 'validation_failed'],
    [{ transfers: [t('ada', 'bob', '1')] }, 422, 'validation_failed'],
    [{ transfers: [t('ada', 'bob', 1, { note: null })] }, 422, 'validation_failed'],
    [{ transfers: [t('ada', 'bob', 1, { visibility: 'x' })] }, 422, 'validation_failed'],
    [{ transfers: [t('ada', 'zz', 1)] }, 404, 'not_found'],
    [{ transfers: [t('ada', 'ada', 1)] }, 422, 'self_payment'],
    // entry order wins: entry 1's 404 before entry 2's 422; insufficient funds last
    [{ transfers: [t('cy', 'bob', 5), t('ada', 'zz', 1), t('ada', 'bob', 0)] }, 404, 'not_found'],
    [{ transfers: [t('cy', 'bob', 5), t('ada', 'ada', 1), t('ada', 'zz', 1)] }, 422, 'self_payment'],
    [{ transfers: [t('cy', 'bob', 5), t('ada', 'bob', 1)] }, 409, 'insufficient_funds'],
  ];
  for (const [body, s, c] of bad) {
    assert.deepEqual(err(await settle(op, body)), [s, c], JSON.stringify(body).slice(0, 100));
  }
  assert.deepEqual((await call('GET', '/activity', { token: ada })).body.payments, [], 'failed settlements create nothing');
  // chain: bob holds 50, receives 100 and sends 150 -> net 0, affordable
  const k = key();
  const body = { transfers: [t('ada', 'bob', 100), t('bob', 'cy', 150, { visibility: 'private', note: 'x' })] };
  const ok = await settle(op, body, k);
  assert.equal(ok.status, 201);
  assert.deepEqual(Object.keys(ok.body).sort(), ['committed_at', 'payments', 'settlement_id']);
  assert.match(ok.body.committed_at, TS_RE);
  assert.equal(ok.body.payments.length, 2);
  assert.deepEqual(ok.body.payments.map((p) => [p.from_handle, p.to_handle, p.amount, p.visibility, p.note]),
    [['ada', 'bob', 100, 'public', ''], ['bob', 'cy', 150, 'private', 'x']]);
  for (const p of ok.body.payments) {
    assert.equal(p.settlement_id, ok.body.settlement_id);
    assert.equal(p.request_id, null);
    assert.equal(p.created_at, ok.body.committed_at);
  }
  assert.deepEqual(await Promise.all([ada, bob, cy, op].map(bal)), [9900, 0, 150, 0]);
  const replay = await settle(op, { transfers: [t('ada', 'bob', 100), t('bob', 'cy', 150, { note: 'x', visibility: 'private' })] }, k);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, ok.body);
  assert.deepEqual(err(await settle(op, { transfers: [t('ada', 'bob', 101)] }, k)), [409, 'idempotency_key_reuse']);
  assert.deepEqual(await Promise.all([ada, bob, cy, op].map(bal)), [9900, 0, 150, 0]);
  // operator sees public member but not the private one; parties see both
  const opFeed = (await call('GET', '/activity', { token: op })).body.payments;
  assert.deepEqual(opFeed.map((p) => p.amount), [100]);
  assert.equal((await call('GET', '/activity', { token: cy })).body.payments.length, 2);
  // operator permission grants no access to others' requests
  const rq = (await ask(bob, { payer_handle: 'ada', amount: 1 })).body.request_id;
  assert.deepEqual((await call('GET', '/requests', { token: op })).body.requests, []);
  assert.deepEqual(err(await call('POST', `/requests/${rq}/decline`, { token: op })), [403, 'forbidden']);
  // concurrent settlements draining one wallet never overdraw
  const many = await Promise.all(Array.from({ length: 30 }, () => settle(op, { transfers: [t('ada', 'cy', 400), t('cy', 'bob', 400)] })));
  assert.ok(many.every((r) => r.status === 201 || err(r)[1] === 'insufficient_funds'));
  assert.equal(many.filter((r) => r.status === 201).length, 24);
  const balances = await Promise.all([ada, bob, cy, op].map(bal));
  assert.ok(balances.every((b) => b >= 0));
  assert.equal(balances.reduce((a, b) => a + b, 0), 10050);
});

// ---- export / import -------------------------------------------------------------------

test('export/import round trip preserves tokens, receipts, retries and ids', async () => {
  await reset(fixture({ settlement_operator_ids: ['u_ada'] }));
  const ada = await login('ada');
  const bob = await login('bob');
  const pk = key(); const rk = key(); const sk = key(); const stk = key(); const failed = key();
  const p = await pay(ada, { to_handle: 'bob', amount: 100, visibility: 'private' }, pk);
  const r = await ask(bob, { payer_handle: 'ada', amount: 40 }, rk);
  const s = await call('POST', '/splits', { token: ada, body: { amount: 9, participant_handles: ['bob', 'cy'] }, idem: sk });
  const st = await call('POST', '/settlements', { token: ada, body: { transfers: [{ from_handle: 'bob', to_handle: 'cy', amount: 5 }] }, idem: stk });
  assert.equal((await pay(ada, { to_handle: 'nobody', amount: 1 }, failed)).status, 404);
  const signup = await call('POST', '/auth/signup', { body: { email: 'neo@example.com', password: 'longpassword', display_name: 'Neo' } });
  const ex = await call('GET', '/_test/export');
  assert.equal(ex.status, 200);
  assert.equal(ex.body.track, 'pocketful');
  assert.equal(ex.body.format_version, 1);
  assert.ok(!JSON.stringify(ex.body).includes(PW), 'no plaintext password in export');
  assert.ok(!JSON.stringify(ex.body).includes('longpassword'));
  const snapshot = JSON.stringify(ex.body);
  // later writes do not change the returned export
  await pay(ada, { to_handle: 'bob', amount: 1 });
  assert.equal(JSON.stringify(ex.body), snapshot);
  // replace with a fresh fixture, then import the earlier export
  await reset(fixture({ users: [user('zed', 5)] }));
  for (let i = 0; i < 2; i++) {
    assert.equal((await call('POST', '/_test/import', { raw: snapshot })).status, 204);
  }
  assert.equal(await bal(ada), 10000 - 100, 'old tokens valid; nothing replayed');
  assert.equal(await bal(signup.body.token), 0);
  assert.deepEqual(err(await call('POST', '/auth/login', { body: { email: 'zed@example.com', password: PW } })), [401, 'unauthenticated']);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'neo@example.com', password: 'longpassword' } })).status, 200);
  const feed = (await call('GET', '/activity', { token: ada })).body.payments;
  assert.deepEqual(feed.find((x) => x.payment_id === p.body.payment_id), p.body);
  assert.equal(feed.length, 2, 'import is replacement, not merge');
  // retries after import replay originals, different bodies 409, failed keys reusable
  const rp = await pay(ada, { to_handle: 'bob', amount: 100, visibility: 'private' }, pk);
  assert.deepEqual([rp.status, rp.body], [200, p.body]);
  assert.deepEqual((await ask(bob, { payer_handle: 'ada', amount: 40 }, rk)).body, r.body);
  assert.deepEqual((await call('POST', '/splits', { token: ada, body: { amount: 9, participant_handles: ['bob', 'cy'] }, idem: sk })).body, s.body);
  assert.deepEqual((await call('POST', '/settlements', { token: ada, body: { transfers: [{ from_handle: 'bob', to_handle: 'cy', amount: 5 }] }, idem: stk })).body, st.body);
  assert.deepEqual(err(await pay(ada, { to_handle: 'bob', amount: 101 }, pk)), [409, 'idempotency_key_reuse']);
  assert.equal((await pay(ada, { to_handle: 'bob', amount: 1 }, failed)).status, 201);
  assert.equal(await bal(ada), 9899);
  // new ids never collide with imported ones
  const fresh = await pay(ada, { to_handle: 'cy', amount: 1 });
  const ids = (await call('GET', '/activity', { token: ada, })).body.payments.map((x) => x.payment_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes(fresh.body.payment_id));
  // operator permission survived
  assert.equal((await call('POST', '/settlements', { token: ada, body: { transfers: [{ from_handle: 'ada', to_handle: 'cy', amount: 5 }] }, idem: key() })).status, 201);
  // invalid imports: 400 / 422 and destination unchanged
  const before = await bal(ada);
  const doc = JSON.parse(snapshot);
  const bads = [
    [{ ...doc, track: 'other' }, 422], [{ ...doc, format_version: 2 }, 422], [{ track: 'pocketful', format_version: 1 }, 422],
    [{ ...doc, state: 'x' }, 422], [{ ...doc, state: { ...doc.state, users: 'x' } }, 422],
    [{ ...doc, state: { ...doc.state, payments: [{ id: 'p' }] } }, 422],
  ];
  for (const [b, s2] of bads) assert.equal((await call('POST', '/_test/import', { body: b })).status, s2);
  assert.deepEqual(err(await call('POST', '/_test/import', { raw: '{nope' })), [400, 'malformed_request']);
  assert.equal(await bal(ada), before);
  // reset clears imported state
  await reset();
  assert.deepEqual(err(await call('GET', '/me', { token: ada })), [401, 'unauthenticated']);
});

test('seeded fixture ids never collide with generated ids', async () => {
  await reset(fixture({
    users: [user('ada', 1000), user('bob', 0, { id: 'usr_1' }), user('cy', 0, { id: 'usr_2' })],
    payments: [{ id: 'pay_1', from_user_id: 'u_ada', to_user_id: 'usr_1', amount: 1 }, { id: 'pay_2', from_user_id: 'u_ada', to_user_id: 'usr_1', amount: 1 }],
    requests: [{ id: 'req_3', requester_id: 'usr_1', payer_id: 'u_ada', amount: 5, status: 'pending' }],
  }));
  const ada = await login('ada');
  const p = (await pay(ada, { to_handle: 'bob', amount: 1 })).body.payment_id;
  assert.ok(!['pay_1', 'pay_2'].includes(p));
  const r = (await ask(ada, { payer_handle: 'bob', amount: 1 })).body.request_id;
  assert.notEqual(r, 'req_3');
  const s = await call('POST', '/auth/signup', { body: { email: 'neo@example.com', password: 'longpassword', display_name: 'n' } });
  assert.ok(!['u_ada', 'usr_1', 'usr_2'].includes(s.body.user_id));
  // the seeded request is payable and listed newest-last against new ones
  const listed = (await call('GET', '/requests', { token: ada })).body.requests.map((x) => x.request_id);
  assert.deepEqual(listed, [r, 'req_3']);
});

test('fixture created_at is honoured verbatim; a future one is a reset error (stage 3)', async () => {
  const future = fixture({ payments: [{ id: 'p_future', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, created_at: '2099-01-01T00:00:00+00:00' }] });
  assert.deepEqual(err(await call('POST', '/_test/reset', { body: future })), [422, 'validation_failed']);
  await reset(fixture({
    payments: [{ id: 'p_old', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, created_at: '2020-01-01T10:00:00+02:00' },
      { id: 'p_mid', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, created_at: '2024-01-01T00:00:00+00:00' }],
  }));
  const ada = await login('ada');
  const fresh = (await pay(ada, { to_handle: 'bob', amount: 1 })).body;
  assert.ok(Date.parse(fresh.created_at) < Date.parse('2090-01-01T00:00:00Z'), fresh.created_at);
  const feed = (await call('GET', '/activity', { token: ada })).body.payments;
  assert.deepEqual(feed.map((p) => p.payment_id), [fresh.payment_id, 'p_mid', 'p_old']);
  assert.equal(feed[2].created_at, '2020-01-01T10:00:00+02:00');
});
