'use strict';
// Builder's stage-3 checks: as_of / known_at, statements (window, order, arithmetic,
// pagination, snapshots), corrections (validation, precedence, stale revisions,
// insufficient vs historical overdraft, linked payments, replay), revisions visibility,
// historical holds and upgrades. In-process server, or POCKETFUL_URL (run serially).

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
const fixture = (over = {}) => ({ currency: 'EUR', minor_units: 2, users: [user('ada', 10000), user('bob', 2500), user('cy', 500)], ...over });
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600 * 1000;

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
const q = (params) => '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
async function reset(f = fixture()) { const r = await call('POST', '/_test/reset', { body: f }); assert.equal(r.status, 204, JSON.stringify(r.body)); }
async function login(h) { return (await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: PW } })).body.token; }
async function world(f) { await reset(f); return { ada: await login('ada'), bob: await login('bob'), cy: await login('cy') }; }
const pay = async (t, to, amount, extra = {}) => { const r = await call('POST', '/payments', { token: t, body: { to_handle: to, amount, ...extra }, idem: key() }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
const me = async (t, params) => (await call('GET', '/me' + (params ? q(params) : ''), { token: t })).body;
const statement = async (t, params = {}) => call('GET', '/statement' + (Object.keys(params).length ? q(params) : ''), { token: t });
const correct = (t, id, body, idem = key()) => call('POST', `/payments/${id}/corrections`, { token: t, body, idem });

test('as_of: inclusive instant, opening balance before history, echo, validation', async () => {
  const past = Date.now() - 3 * HOUR;
  const w = await world(fixture({ payments: [{ id: 'p_1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 500, created_at: iso(past) }] }));
  assert.equal((await me(w.ada, { as_of: iso(past - 1) })).balance, 10500, 'opening = seeded balance + seeded outflow');
  assert.equal((await me(w.ada, { as_of: iso(past) })).balance, 10000, 'a payment at exactly as_of counts');
  const p = await pay(w.ada, 'bob', 300);
  const at = Date.parse(p.created_at);
  assert.equal((await me(w.ada, { as_of: iso(at - 1) })).balance, 10000);
  assert.equal((await me(w.ada, { as_of: p.created_at })).balance, 9700);
  // a +05:30 wall-clock label 6 h ahead of UTC is a real instant 30 min after the payment
  const raw = new Date(at + 6 * HOUR).toISOString().replace('Z', '+05:30');
  const body = await me(w.ada, { as_of: raw });
  assert.equal(body.as_of, raw);
  assert.deepEqual([body.balance, body.total, body.available, body.held], [9700, 9700, 9700, 0]);
  // a raw "+" offset in the query is not a space
  const r = await call('GET', '/me?as_of=2030-01-01T00:00:00+05:30', { token: w.ada });
  assert.equal(r.status, 200);
  assert.equal(r.body.as_of, '2030-01-01T00:00:00+05:30');
  for (const bad of ['', '2026-09-24', '2026-09-24T10:00:00', '2026-02-30T10:00:00Z', '2026-09-24T25:00:00Z', 'yesterday', '1727000000']) {
    assert.deepEqual(err(await call('GET', `/me?as_of=${encodeURIComponent(bad)}`, { token: w.ada })), [422, 'validation_failed'], bad);
    assert.deepEqual(err(await call('GET', `/me?known_at=${encodeURIComponent(bad)}`, { token: w.ada })), [422, 'validation_failed'], bad);
  }
  assert.ok(!('as_of' in (await me(w.ada))));
  assert.deepEqual(err(await call('GET', '/me?as_of=2030-01-01T00:00:00Z')), [401, 'unauthenticated']);
});

test('seeded created_at: future is 422 unchanged; omitted uses reset time before later payments', async () => {
  await reset();
  const ada0 = await login('ada');
  const future = fixture({ payments: [{ id: 'p_f', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, created_at: iso(Date.now() + HOUR) }] });
  assert.deepEqual(err(await call('POST', '/_test/reset', { body: future })), [422, 'validation_failed']);
  assert.equal((await me(ada0)).balance, 10000);
  const t0 = Date.now();
  await sleep(5);
  const w = await world(fixture({ payments: [{ id: 'p_1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 500 }] }));
  const p = await pay(w.ada, 'bob', 1);
  const st = (await statement(w.ada)).body;
  assert.deepEqual(st.entries.map((e) => e.payment.payment_id), ['p_1', p.payment_id]);
  assert.ok(Date.parse(st.entries[0].payment.created_at) >= t0);
  assert.ok(Date.parse(st.entries[0].payment.created_at) < Date.parse(p.created_at));
  assert.equal(st.opening_balance, 10500);
  assert.equal((await me(w.ada, { as_of: iso(t0) })).balance, 10500);
});

test('statement: half-open window, order, arithmetic, other people excluded, pagination invariants', async () => {
  const w = await world();
  const ps = [];
  for (const [t, to, amt] of [[w.ada, 'bob', 100], [w.bob, 'ada', 250], [w.ada, 'cy', 40], [w.bob, 'cy', 7], [w.ada, 'bob', 1]]) {
    ps.push(await pay(t, to, amt));
    await sleep(3);
  }
  const full = (await statement(w.ada)).body;
  assert.deepEqual(full.entries.map((e) => e.payment.payment_id), [ps[0], ps[1], ps[2], ps[4]].map((p) => p.payment_id));
  assert.deepEqual(full.entries.map((e) => e.delta), [-100, 250, -40, -1]);
  assert.deepEqual(full.entries.map((e) => e.balance_after), [9900, 10150, 10110, 10109]);
  assert.equal(full.opening_balance, 10000);
  assert.equal(full.closing_balance, 10109);
  assert.equal(typeof full.snapshot, 'string');
  for (const e of full.entries) {
    assert.equal(e.revision, 1);
    assert.equal(e.effective_at, e.payment.created_at);
    assert.equal(e.recorded_at, e.payment.created_at);
  }
  // window [ps1, ps4): includes ps1 exactly at from, excludes ps4 exactly at to
  const win = (await statement(w.ada, { from: ps[1].created_at, to: ps[4].created_at })).body;
  assert.deepEqual(win.entries.map((e) => e.payment.payment_id), [ps[1].payment_id, ps[2].payment_id]);
  assert.deepEqual([win.opening_balance, win.closing_balance], [9900, 10110]);
  // pagination: page 2 keeps balances of the full window
  const pg = (await statement(w.ada, { limit: 2, offset: 2 })).body;
  assert.deepEqual(pg.entries.map((e) => e.balance_after), [10110, 10109]);
  assert.deepEqual([pg.opening_balance, pg.closing_balance, pg.has_more], [10000, 10109, false]);
  const pg1 = (await statement(w.ada, { limit: 3 })).body;
  assert.equal(pg1.has_more, true);
  const beyond = (await statement(w.ada, { offset: 10 })).body;
  assert.deepEqual([beyond.entries, beyond.has_more, beyond.closing_balance], [[], false, 10109]);
  // validation
  for (const params of [{ from: '2026-09-24' }, { to: '' }, { known_at: 'x' }, { from: ps[4].created_at, to: ps[0].created_at }, { limit: 0 }, { offset: -1 }]) {
    assert.deepEqual(err(await statement(w.ada, params)), [422, 'validation_failed'], JSON.stringify(params));
  }
  const empty = (await statement(w.ada, { from: ps[2].created_at, to: ps[2].created_at })).body;
  assert.deepEqual([empty.entries, empty.opening_balance, empty.closing_balance], [[], 10150, 10150]);
  assert.deepEqual(err(await statement(null)), [401, 'unauthenticated']);
  // cy's statement holds only cy's payments
  const cy = (await statement(w.cy)).body;
  assert.deepEqual(cy.entries.map((e) => e.delta), [40, 7]);
});

test('snapshots freeze a statement across later payments and corrections; misuse is 422/404', async () => {
  const w = await world();
  const a = await pay(w.ada, 'bob', 100);
  await pay(w.ada, 'bob', 200);
  const first = (await statement(w.ada, { limit: 1 })).body;
  const token = first.snapshot;
  await pay(w.ada, 'bob', 300);
  assert.equal((await correct(w.ada, a.payment_id, { expected_revision: 1, amount: 50, effective_at: a.created_at, reason: 'fix' })).status, 201);
  const p2 = (await call('GET', `/statement?snapshot=${encodeURIComponent(token)}&limit=1&offset=1`, { token: w.ada })).body;
  assert.equal(p2.entries.length, 1);
  assert.deepEqual([p2.entries[0].delta, p2.entries[0].balance_after, p2.opening_balance, p2.closing_balance, p2.has_more], [-200, 9700, 10000, 9700, false]);
  const p1 = (await call('GET', `/statement?snapshot=${encodeURIComponent(token)}`, { token: w.ada })).body;
  assert.deepEqual(p1.entries.map((e) => e.payment.amount), [100, 200]);
  const fresh = (await statement(w.ada)).body;
  assert.deepEqual(fresh.entries.map((e) => e.payment.amount), [50, 200, 300]);
  assert.equal(fresh.closing_balance, 9450);
  for (const extra of ['from=2020-01-01T00:00:00Z', 'to=2030-01-01T00:00:00Z', 'known_at=2030-01-01T00:00:00Z']) {
    assert.deepEqual(err(await call('GET', `/statement?snapshot=${token}&${extra}`, { token: w.ada })), [422, 'validation_failed']);
  }
  assert.deepEqual(err(await call('GET', `/statement?snapshot=${token}`, { token: w.bob })), [404, 'not_found']);
  assert.deepEqual(err(await call('GET', '/statement?snapshot=nope', { token: w.ada })), [404, 'not_found']);
  await reset();
  const ada = await login('ada');
  assert.deepEqual(err(await call('GET', `/statement?snapshot=${token}`, { token: ada })), [404, 'not_found']);
});

test('corrections: shape, money movement, revisions, originals preserved, replay, stale', async () => {
  const w = await world();
  const k0 = key();
  const p = (await call('POST', '/payments', { token: w.ada, body: { to_handle: 'bob', amount: 1000, note: 'n' }, idem: k0 })).body;
  const ck = key();
  const body = { expected_revision: 1, amount: 400, effective_at: p.created_at, reason: 'corrected amount' };
  const c = await correct(w.ada, p.payment_id, body, ck);
  assert.equal(c.status, 201);
  assert.deepEqual(Object.keys(c.body).sort(), ['amount', 'correction_batch_id', 'effective_at', 'payment_id', 'reason', 'recorded_at', 'revision']);
  assert.deepEqual([c.body.payment_id, c.body.revision, c.body.amount, c.body.effective_at, c.body.reason], [p.payment_id, 2, 400, p.created_at, 'corrected amount']);
  assert.ok(Date.parse(c.body.recorded_at) > Date.parse(p.created_at));
  assert.deepEqual([(await me(w.ada)).balance, (await me(w.bob)).balance], [9600, 2900]);
  // increase debits the sender
  const c3 = await correct(w.ada, p.payment_id, { expected_revision: 2, amount: 700, effective_at: p.created_at, reason: 'up' });
  assert.equal(c3.body.revision, 3);
  assert.ok(Date.parse(c3.body.recorded_at) > Date.parse(c.body.recorded_at));
  assert.deepEqual([(await me(w.ada)).balance, (await me(w.bob)).balance], [9300, 3200]);
  // replay returns the original revision even after newer ones; different body 409
  const rp = await correct(w.ada, p.payment_id, body, ck);
  assert.deepEqual([rp.status, rp.body], [200, c.body]);
  assert.deepEqual(err(await correct(w.ada, p.payment_id, { ...body, amount: 401 }, ck)), [409, 'idempotency_key_reuse']);
  assert.deepEqual(err(await correct(w.ada, p.payment_id, { ...body, expected_revision: 2 })), [409, 'stale_revision']);
  // revisions list, parties only
  const revs = (await call('GET', `/payments/${p.payment_id}/revisions`, { token: w.bob })).body.revisions;
  assert.deepEqual(revs.map((r) => [r.revision, r.amount, r.reason]), [[1, 1000, ''], [2, 400, 'corrected amount'], [3, 700, 'up']]);
  assert.equal(revs[0].effective_at, p.created_at);
  assert.equal(revs[0].recorded_at, p.created_at);
  assert.deepEqual(err(await call('GET', `/payments/${p.payment_id}/revisions`, { token: w.cy })), [404, 'not_found']);
  assert.deepEqual(err(await call('GET', `/payments/${p.payment_id}/revisions`)), [401, 'unauthenticated']);
  assert.deepEqual(err(await call('GET', '/payments/nope/revisions', { token: w.ada })), [404, 'not_found']);
  // originals: feed and the original payment replay are unchanged
  const feed = (await call('GET', '/activity', { token: w.cy })).body.payments;
  assert.deepEqual(feed, [p]);
  const orig = await call('POST', '/payments', { token: w.ada, body: { to_handle: 'bob', amount: 1000, note: 'n' }, idem: k0 });
  assert.deepEqual([orig.status, orig.body], [200, p]);
  // statement uses the selected revision; known_at selects older revisions
  const st = (await statement(w.ada)).body;
  assert.deepEqual([st.entries[0].payment.amount, st.entries[0].revision, st.entries[0].delta, st.closing_balance], [700, 3, -700, 9300]);
  const old = (await statement(w.ada, { known_at: p.created_at })).body;
  assert.deepEqual([old.entries[0].payment.amount, old.entries[0].revision, old.closing_balance, old.known_at], [1000, 1, 9000, p.created_at]);
  const mid = await me(w.ada, { known_at: c.body.recorded_at });
  assert.deepEqual([mid.balance, mid.known_at], [9600, c.body.recorded_at]);
  const before = await me(w.ada, { known_at: iso(Date.parse(p.created_at) - 1) });
  assert.equal(before.balance, 10000, 'not yet known payments contribute nothing');
  // zero reverses the payment; entry remains with delta 0
  await correct(w.ada, p.payment_id, { expected_revision: 3, amount: 0, effective_at: p.created_at, reason: 'reverse' });
  const z = (await statement(w.ada)).body;
  assert.deepEqual([z.entries.length, z.entries[0].delta, z.closing_balance], [1, 0, 10000]);
  assert.equal((await me(w.bob)).balance, 2500);
});

test('corrections: validation, permissions, precedence, linked payments', async () => {
  const w = await world(fixture({ settlement_operator_ids: ['u_cy'] }));
  const p = await pay(w.ada, 'bob', 1000);
  const good = { expected_revision: 1, amount: 400, effective_at: p.created_at, reason: 'r' };
  assert.deepEqual(err(await call('POST', `/payments/${p.payment_id}/corrections`, { token: w.ada, body: good })), [400, 'missing_idempotency_key']);
  assert.deepEqual(err(await correct(w.bob, p.payment_id, good)), [403, 'forbidden']);
  assert.deepEqual(err(await correct(w.cy, p.payment_id, good)), [403, 'forbidden']);
  assert.deepEqual(err(await correct(w.ada, 'nope', good)), [404, 'not_found']);
  const bads = [
    { ...good, expected_revision: 0 }, { ...good, expected_revision: 1.5 }, { ...good, expected_revision: '1' },
    { ...good, amount: -1 }, { ...good, amount: 1000000001 }, { ...good, amount: 1.5 }, { ...good, amount: '4' },
    { ...good, reason: '' }, { ...good, reason: 'x'.repeat(201) }, { ...good, reason: 5 },
    { ...good, effective_at: '2026-09-24' }, { ...good, effective_at: iso(Date.now() + HOUR) }, { ...good, effective_at: null },
    { expected_revision: 1, amount: 1, effective_at: p.created_at },
  ];
  for (const b of bads) assert.deepEqual(err(await correct(w.ada, p.payment_id, b)), [422, 'validation_failed'], JSON.stringify(b));
  assert.equal((await correct(w.ada, p.payment_id, { ...good, reason: '😀'.repeat(200) })).status, 201);
  // settlement members and captures are immutable
  const s = (await call('POST', '/settlements', { token: w.cy, idem: key(), body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 5 }] } })).body;
  assert.deepEqual(err(await correct(w.ada, s.payments[0].payment_id, { ...good, expected_revision: 1 })), [422, 'linked_payment_immutable']);
  const a = (await call('POST', '/authorizations', { token: w.ada, idem: key(), body: { to_handle: 'bob', amount: 100 } })).body;
  const cap = (await call('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.bob, idem: key(), body: {} })).body;
  assert.deepEqual(err(await correct(w.ada, cap.payment_id, { ...good, expected_revision: 1 })), [422, 'linked_payment_immutable']);
  // request-paid payments are ordinary and correctable
  const rq = (await call('POST', '/requests', { token: w.bob, idem: key(), body: { payer_handle: 'ada', amount: 50 } })).body;
  const rp = (await call('POST', `/requests/${rq.request_id}/pay`, { token: w.ada, idem: key(), body: {} })).body;
  assert.equal((await correct(w.ada, rp.payment_id, { ...good, amount: 40 })).status, 201);
  // linked check precedes stale revision; validation precedes linked
  assert.deepEqual(err(await correct(w.ada, s.payments[0].payment_id, { ...good, expected_revision: 9 })), [422, 'linked_payment_immutable']);
  assert.deepEqual(err(await correct(w.ada, s.payments[0].payment_id, { ...good, amount: -1 })), [422, 'validation_failed']);
});

test('insufficient_funds (now) precedes historical_overdraft (past); failures change nothing', async () => {
  const w = await world();
  const p1 = await pay(w.bob, 'cy', 2000); // cy: 500 -> 2500
  await sleep(5);
  await pay(w.cy, 'ada', 2400); // cy spends it: 100 left
  // decreasing p1 by 1900 needs cy to give back 1900 now: unaffordable now
  assert.deepEqual(err(await correct(w.bob, p1.payment_id, { expected_revision: 1, amount: 100, effective_at: p1.created_at, reason: 'r' })), [409, 'insufficient_funds']);
  // cy receives more later; now affordable, but cy would have been negative in the past
  await pay(w.ada, 'cy', 5000);
  const r = await correct(w.bob, p1.payment_id, { expected_revision: 1, amount: 100, effective_at: p1.created_at, reason: 'r' });
  assert.deepEqual(err(r), [409, 'historical_overdraft']);
  assert.equal((await me(w.cy)).balance, 5100);
  assert.equal((await call('GET', `/payments/${p1.payment_id}/revisions`, { token: w.bob })).body.revisions.length, 1);
  // the same key is reusable after a failure
  // backdating to after the spend is fine: at the new effective time cy is not negative
  const ok = await correct(w.bob, p1.payment_id, { expected_revision: 1, amount: 100, effective_at: iso(Date.now() - 1), reason: 'late' });
  assert.equal(ok.status, 409, 'moving the effective time later still leaves cy short between the two times');
  // increasing a payment: sender must afford now
  const p2 = await pay(w.cy, 'bob', 100);
  assert.deepEqual(err(await correct(w.cy, p2.payment_id, { expected_revision: 1, amount: 100000, effective_at: p2.created_at, reason: 'r' })), [409, 'insufficient_funds']);
  // sum of balances holds in every view
  const views = [{}, { as_of: p1.created_at }, { known_at: p1.created_at }];
  for (const v of views) {
    const sum = (await me(w.ada, v)).balance + (await me(w.bob, v)).balance + (await me(w.cy, v)).balance;
    assert.equal(sum, 13000, JSON.stringify(v));
  }
});

test('a backdated correction moves a payment between statement windows', async () => {
  const w = await world();
  const t0 = Date.now();
  await sleep(20);
  const p = await pay(w.ada, 'bob', 100);
  const mid = iso(t0 + 5);
  assert.equal((await correct(w.ada, p.payment_id, { expected_revision: 1, amount: 100, effective_at: mid, reason: 'backdate' })).status, 201);
  const early = (await statement(w.ada, { to: iso(t0 + 10) })).body;
  assert.deepEqual([early.entries.length, early.entries[0].effective_at, early.closing_balance], [1, mid, 9900]);
  const late = (await statement(w.ada, { from: iso(t0 + 10) })).body;
  assert.deepEqual([late.entries.length, late.opening_balance], [0, 9900]);
  assert.equal((await me(w.ada, { as_of: iso(t0 + 6) })).balance, 9900);
  // known before the correction, the payment sat at its original time
  const kn = (await statement(w.ada, { to: iso(t0 + 10), known_at: p.created_at })).body;
  assert.equal(kn.entries.length, 0);
});

test('concurrent corrections with the same expected revision: exactly one succeeds', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  const out = await Promise.all(Array.from({ length: 20 }, (_, i) => correct(w.ada, p.payment_id, { expected_revision: 1, amount: 900 - i, effective_at: p.created_at, reason: 'race' })));
  assert.equal(out.filter((r) => r.status === 201).length, 1);
  assert.ok(out.filter((r) => r.status !== 201).every((r) => err(r)[1] === 'stale_revision'));
  const revs = (await call('GET', `/payments/${p.payment_id}/revisions`, { token: w.ada })).body.revisions;
  assert.equal(revs.length, 2);
  assert.equal((await me(w.ada)).balance + (await me(w.bob)).balance, 12500);
});

test('historical holds: four money fields per view, closed_at, expiry at deadline, captures', async () => {
  const w = await world(fixture({ authorization_ttl_seconds: 2 }));
  const a = (await call('POST', '/authorizations', { token: w.ada, idem: key(), body: { to_handle: 'bob', amount: 3000 } })).body;
  assert.equal(a.closed_at, null);
  const tA = Date.parse(a.created_at);
  await sleep(10);
  const cap = (await call('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.bob, idem: key(), body: { amount: 1000, final: false } })).body;
  const tC = Date.parse(cap.created_at);
  let v = await me(w.ada, { as_of: iso(tA - 1) });
  assert.deepEqual([v.balance, v.total, v.available, v.held], [10000, 10000, 10000, 0]);
  v = await me(w.ada, { as_of: a.created_at });
  assert.deepEqual([v.total, v.available, v.held], [10000, 7000, 3000]);
  v = await me(w.ada, { as_of: cap.created_at });
  assert.deepEqual([v.total, v.available, v.held], [9000, 7000, 2000]);
  v = await me(w.ada, { as_of: iso(Date.parse(a.expires_at) + 1000) });
  assert.deepEqual([v.total, v.available, v.held], [9000, 9000, 0], 'beyond now an open hold expires at its deadline');
  v = await me(w.ada, { as_of: cap.created_at, known_at: iso(tC - 1) });
  assert.deepEqual([v.total, v.available, v.held], [10000, 7000, 3000], 'capture not yet known');
  await sleep(2100);
  const list = (await call('GET', '/authorizations', { token: w.ada })).body.authorizations[0];
  assert.deepEqual([list.status, list.closed_at], ['expired', a.expires_at]);
  v = await me(w.ada, { as_of: iso(Date.parse(a.expires_at) - 1) });
  assert.deepEqual([v.available, v.held], [7000, 2000]);
  v = await me(w.ada, { as_of: a.expires_at });
  assert.deepEqual([v.available, v.held], [9000, 0]);
  // void closes at its event time
  const b = (await call('POST', '/authorizations', { token: w.ada, idem: key(), body: { to_handle: 'bob', amount: 500 } })).body;
  const vd = (await call('POST', `/authorizations/${b.authorization_id}/void`, { token: w.ada })).body;
  assert.ok(vd.closed_at && Date.parse(vd.closed_at) >= Date.parse(b.created_at));
  v = await me(w.ada, { as_of: b.created_at, known_at: b.created_at });
  assert.equal(v.held, 500);
  // the capture appears exactly once in the statement, with its link; holds do not
  const st = (await statement(w.ada)).body;
  assert.deepEqual(st.entries.map((e) => [e.payment.authorization_id, e.delta]), [[a.authorization_id, -1000]]);
});

test('historical_overdraft also guards available against past holds', async () => {
  const w = await world();
  const p = await pay(w.bob, 'ada', 1000); // ada 11000
  await sleep(5);
  await call('POST', '/authorizations', { token: w.ada, idem: key(), body: { to_handle: 'cy', amount: 10500 } }); // ada available 500
  await sleep(5);
  const a2 = (await call('POST', '/authorizations', { token: w.bob, idem: key(), body: { to_handle: 'cy', amount: 1 } })).body;
  assert.ok(a2.authorization_id);
  // ada now: total 11000, held 10500. Decreasing p by 600 is unaffordable now (available 500).
  assert.deepEqual(err(await correct(w.bob, p.payment_id, { expected_revision: 1, amount: 400, effective_at: p.created_at, reason: 'r' })), [409, 'insufficient_funds']);
  // Decreasing by 400 is affordable now (available 500 -> 100) and never negative in the past.
  assert.equal((await correct(w.bob, p.payment_id, { expected_revision: 1, amount: 600, effective_at: p.created_at, reason: 'r' })).status, 201);
});

test('export/import keeps revisions, snapshots and hold history; stage-2 layout derives revision 1', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  await correct(w.ada, p.payment_id, { expected_revision: 1, amount: 600, effective_at: p.created_at, reason: 'fix' });
  const snap = (await statement(w.ada)).body.snapshot;
  const a = (await call('POST', '/authorizations', { token: w.ada, idem: key(), body: { to_handle: 'bob', amount: 100 } })).body;
  await call('POST', `/authorizations/${a.authorization_id}/void`, { token: w.ada });
  const ex = (await call('GET', '/_test/export')).body;
  await reset();
  assert.equal((await call('POST', '/_test/import', { body: ex })).status, 204);
  assert.equal((await call('GET', `/payments/${p.payment_id}/revisions`, { token: w.ada })).body.revisions.length, 2);
  assert.equal((await call('GET', `/statement?snapshot=${snap}`, { token: w.ada })).body.closing_balance, 9400);
  assert.equal((await me(w.ada, { known_at: p.created_at })).balance, 9000);
  const auth = (await call('GET', '/authorizations', { token: w.ada })).body.authorizations[0];
  assert.equal(auth.status, 'voided');
  assert.ok(auth.closed_at);
  // stage-2 layout: strip stage-3 fields
  const s2 = JSON.parse(JSON.stringify(ex));
  for (const pp of s2.state.payments) delete pp.revisions;
  for (const u of s2.state.users) delete u.opening;
  for (const aa of s2.state.authorizations) { delete aa.closed_ts; delete aa.no_history; }
  delete s2.state.snapshots;
  assert.equal((await call('POST', '/_test/import', { body: s2 })).status, 204);
  const revs = (await call('GET', `/payments/${p.payment_id}/revisions`, { token: w.ada })).body.revisions;
  assert.deepEqual(revs.map((r) => r.revision), [1]);
  assert.equal((await statement(w.ada)).body.opening_balance + (await statement(w.ada)).body.entries.reduce((s, e) => s + e.delta, 0), (await me(w.ada)).balance);
});
