#!/usr/bin/env node
// Contract checks: one or more per rule of pocketful/spec/stage-1.md (and the planner's
// recorded ambiguity decisions, tagged "plan:A-nn"). Written from the specification
// without reading the candidate's source.
//
// usage: node contract.mjs --base-url URL [--out report.json] [--second-url URL] [--only substr]
import { writeFileSync } from 'node:fs';
import { client, code, fixture, seed, balances, total, deepEqual, shares, newKey, PASSWORD, TS_RE } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : a), []));
const base = args['base-url'];
if (!base) { console.error('usage: contract.mjs --base-url URL'); process.exit(2); }
const c = client(base);
const results = [];

async function t(id, reqs, fn) {
  if (args.only && !id.includes(args.only)) return;
  const fails = [];
  const A = {
    eq(actual, expected, label) { if (!deepEqual(actual, expected)) fails.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)?.slice(0, 300)}`); },
    ok(cond, label) { if (!cond) fails.push(label); },
    err(r, status, errCode, label) {
      if (r.status !== status || code(r) !== errCode) fails.push(`${label}: expected ${status} ${errCode}, got ${r.status} ${r.text?.slice(0, 200)}`);
    },
    st(r, status, label) { if (r.status !== status) fails.push(`${label}: expected ${status}, got ${r.status} ${r.text?.slice(0, 200)}`); },
  };
  const t0 = Date.now();
  try { await fn(A); } catch (e) { fails.push(`exception: ${e?.stack ?? e}`); }
  results.push({ id, requirements: reqs, passed: fails.length === 0, failures: fails, ms: Date.now() - t0 });
  process.stdout.write(`${fails.length ? 'FAIL' : 'ok  '} ${id}${fails.length ? '\n      ' + fails.join('\n      ') : ''}\n`);
}

const pay = (s, from, to, amount, extra = {}, key = newKey('pay')) => c.req('POST', '/payments', { token: s.tok[from], key, body: { to_handle: to, amount, ...extra } });
const ask = (s, requester, payer, amount, extra = {}, key = newKey('rq')) => c.req('POST', '/requests', { token: s.tok[requester], key, body: { payer_handle: payer, amount, ...extra } });
const feed = async (s, h, q = '?limit=200') => (await c.req('GET', '/activity' + q, { token: s.tok[h] })).body?.payments ?? [];
const reqs = async (s, h, q = '?limit=200') => (await c.req('GET', '/requests' + q, { token: s.tok[h] })).body?.requests ?? [];
const sumBal = async (s) => Object.values(await balances(c, s.tok)).reduce((a, b) => a + b, 0);
const PAYMENT_KEYS = ['payment_id', 'authorization_id', 'refund_of', 'from_user_id', 'from_handle', 'to_user_id', 'to_handle', 'amount', 'currency', 'note', 'visibility', 'request_id', 'settlement_id', 'created_at'].sort();
const REQUEST_KEYS = ['request_id', 'requester_id', 'requester_handle', 'payer_id', 'payer_handle', 'amount', 'currency', 'note', 'status', 'payment_id', 'created_at'].sort();
const hasKeys = (o, keys) => keys.every((k) => o && Object.prototype.hasOwnProperty.call(o, k));
const sortedByCreatedDesc = (xs) => xs.every((x, i) => i === 0 || Date.parse(xs[i - 1].created_at) >= Date.parse(x.created_at));

// ---------------------------------------------------------------- runtime contract
await t('health', ['R-03', 'R-05'], async (A) => {
  const r = await c.req('GET', '/health');
  A.st(r, 200, 'GET /health'); A.eq(r.body, { status: 'ok' }, 'health body');
  A.ok(/^application\/json;\s*charset=utf-8$/i.test(r.ct), `health content-type ${r.ct}`);
});

await t('unknown-route-envelope', ['R-06', 'plan:A-11'], async (A) => {
  await seed(c);
  A.err(await c.req('GET', '/nope'), 404, 'not_found', 'GET /nope');
  A.err(await c.req('GET', '/payments/zzz/x'), 404, 'not_found', 'GET /payments/zzz/x');
  const r = await c.req('DELETE', '/me');
  A.ok(r.status >= 400 && r.status < 500 && typeof code(r) === 'string', `DELETE /me gives a 4xx envelope (${r.status})`);
});

// ---------------------------------------------------------------- reset / seed
await t('reset-seeds-balances-and-logins', ['R-04', 'R-22'], async (A) => {
  const s = await seed(c);
  const me = await c.req('GET', '/me', { token: s.tok.ada });
  A.st(me, 200, '/me');
  A.eq(me.body, { user_id: s.id.ada, display_name: 'Ada', handle: 'ada', balance: 10000, total: 10000, available: 10000, held: 0, currency: 'EUR', minor_units: 2 }, '/me body (stage 2 adds total/available/held)');
  A.eq(s.id.ada, 'u_ada', 'seeded user id kept');
  A.eq(await balances(c, s.tok), { ada: 10000, bob: 2500, cy: 0, dan: 5000, op: 0 }, 'balances equal fixture (payments not replayed)');
});

await t('reset-seeded-feed-and-requests', ['R-04', 'R-31', 'R-28'], async (A) => {
  const s = await seed(c);
  const f = await feed(s, 'cy');
  A.eq(f.map((p) => p.payment_id), ['p_1'], 'third party sees only public seeded payment');
  const p = f[0];
  A.ok(p && p.from_handle === 'ada' && p.to_handle === 'bob' && p.amount === 500 && p.note === 'coffee' && p.visibility === 'public', `seeded payment fields ${JSON.stringify(p)}`);
  A.ok(p && hasKeys(p, PAYMENT_KEYS), 'seeded payment has every payment field');
  A.eq((await feed(s, 'dan')).map((x) => x.payment_id).sort(), ['p_1', 'p_2'], 'receiver sees private seeded payment');
  const rs = await reqs(s, 'ada');
  A.eq(rs.map((r) => [r.request_id, r.status, r.amount, r.requester_handle, r.payer_handle]), [['rq_1', 'pending', 1200, 'bob', 'ada']], 'seeded request');
  A.ok(rs[0] && hasKeys(rs[0], REQUEST_KEYS), 'seeded request has every request field');
  A.eq(await reqs(s, 'cy'), [], 'third party sees no requests');
});

await t('reset-invalidates-tokens-and-keys', ['R-04'], async (A) => {
  const s = await seed(c);
  const key = newKey();
  A.st(await pay(s, 'ada', 'bob', 10, {}, key), 201, 'first payment');
  const s2 = await seed(c);
  A.err(await c.req('GET', '/me', { token: s.tok.ada }), 401, 'unauthenticated', 'old token after reset');
  A.st(await pay(s2, 'ada', 'bob', 10, {}, key), 201, 'same key after reset is a first use');
  const signup = await c.req('POST', '/auth/signup', { body: { email: 'zed@example.com', password: PASSWORD, display_name: 'Zed' } });
  A.st(signup, 201, 'signup');
  await seed(c);
  A.err(await c.req('POST', '/auth/login', { body: { email: 'zed@example.com', password: PASSWORD } }), 401, 'unauthenticated', 'signed-up user gone after reset');
});

await t('reset-negative-balance-422-unchanged', ['R-04'], async (A) => {
  const s = await seed(c);
  A.st(await pay(s, 'ada', 'cy', 7), 201, 'payment before bad reset');
  const bad = fixture();
  bad.users[2] = { ...bad.users[2], balance: -1 };
  A.err(await c.req('POST', '/_test/reset', { body: bad }), 422, 'validation_failed', 'negative balance fixture');
  A.eq(await balances(c, s.tok), { ada: 9993, bob: 2500, cy: 7, dan: 5000, op: 0 }, 'state unchanged after rejected reset');
});

await t('reset-bad-fixtures-422', ['R-04', 'plan:edge-17'], async (A) => {
  const s = await seed(c);
  const cases = {
    'minor_units 1': { ...fixture(), minor_units: 1 },
    'duplicate handle': (() => { const f = fixture(); f.users[1] = { ...f.users[1], handle: 'ada' }; return f; })(),
    'duplicate user id': (() => { const f = fixture(); f.users[2] = { ...f.users[2], id: 'u_ada' }; return f; })(),
    'invalid handle': (() => { const f = fixture(); f.users[1] = { ...f.users[1], handle: 'Bob!' }; return f; })(),
    'payment to unknown user': fixture({ payments: [{ id: 'p_1', from_user_id: 'u_ada', to_user_id: 'u_ghost', amount: 1, note: '', visibility: 'public' }] }),
    'fractional balance': (() => { const f = fixture(); f.users[1] = { ...f.users[1], balance: 10.5 }; return f; })(),
  };
  for (const [name, fx] of Object.entries(cases)) {
    const r = await c.req('POST', '/_test/reset', { body: fx });
    A.err(r, 422, 'validation_failed', name);
  }
  A.st(await c.req('GET', '/me', { token: s.tok.ada }), 200, 'old state still serves');
  A.err(await c.req('POST', '/_test/reset', { raw: '{"currency":' }), 400, 'malformed_request', 'unparseable fixture');
});

await t('reset-currency-jpy-bhd', ['R-04', 'R-22'], async (A) => {
  for (const [cur, mu] of [['JPY', 0], ['BHD', 3]]) {
    const s = await seed(c, fixture({ currency: cur, minor_units: mu }));
    const me = await c.req('GET', '/me', { token: s.tok.bob });
    A.eq([me.body?.currency, me.body?.minor_units], [cur, mu], `${cur} /me`);
    const p = await pay(s, 'ada', 'bob', 1);
    A.eq(p.body?.currency, cur, `${cur} payment currency`);
  }
});

await t('reset-operator-default-empty', ['R-34'], async (A) => {
  const fx = fixture(); delete fx.settlement_operator_ids;
  const s = await seed(c, fx);
  A.err(await c.req('POST', '/settlements', { token: s.tok.op, key: newKey(), body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 1 }] } }), 403, 'forbidden', 'no operators by default');
});

// ---------------------------------------------------------------- authentication
await t('signup-login-shape', ['R-13', 'R-14', 'R-11'], async (A) => {
  await seed(c);
  const r = await c.req('POST', '/auth/signup', { body: { email: 'Zed.Q+x@Example.com', password: 'eightchr', display_name: 'Zed' } });
  A.st(r, 201, 'signup');
  A.eq(Object.keys(r.body ?? {}).sort(), ['display_name', 'token', 'user_id'], 'signup fields');
  A.eq(r.body?.display_name, 'Zed', 'display_name');
  const me = await c.req('GET', '/me', { token: r.body?.token });
  A.eq([me.body?.handle, me.body?.balance, me.body?.user_id], ['zed_q_x', 0, r.body?.user_id], 'derived handle, zero balance');
  const l = await c.req('POST', '/auth/login', { body: { email: 'Zed.Q+x@Example.com', password: 'eightchr' } });
  A.st(l, 200, 'login');
  A.eq(Object.keys(l.body ?? {}).sort(), ['display_name', 'token', 'user_id'], 'login fields');
  A.eq(l.body?.user_id, r.body?.user_id, 'login user id');
  A.ok(l.body?.token !== r.body?.token, 'login issues a new token');
  A.st(await c.req('GET', '/me', { token: r.body?.token }), 200, 'first token still valid');
  A.st(await c.req('GET', '/me', { token: l.body?.token }), 200, 'second token valid');
});

await t('signup-handle-derivation', ['R-11'], async (A) => {
  await seed(c);
  const cases = [
    ['Ada.Lovelace+X@ex.com', 'ada_lovelace_x'],
    ['abcdefghijklmnopqrstuvwxy@ex.com', 'abcdefghijklmnopqrst'],
    ['ÜBER-ñ@ex.com', '_ber__'],
    ['UPPER_9@ex.com', 'upper_9'],
  ];
  for (const [email, handle] of cases) {
    const r = await c.req('POST', '/auth/signup', { body: { email, password: PASSWORD, display_name: 'X' } });
    A.st(r, 201, `signup ${email}`);
    const me = await c.req('GET', '/me', { token: r.body?.token });
    A.eq(me.body?.handle, handle, `handle for ${email}`);
  }
});

await t('signup-new-user-can-receive-and-be-asked', ['R-13'], async (A) => {
  const s = await seed(c);
  const r = await c.req('POST', '/auth/signup', { body: { email: 'new@ex.com', password: PASSWORD, display_name: 'New' } });
  A.st(await pay(s, 'ada', 'new', 50), 201, 'pay new user');
  A.st(await ask(s, 'ada', 'new', 50), 201, 'request from new user');
  const me = await c.req('GET', '/me', { token: r.body?.token });
  A.eq(me.body?.balance, 50, 'new user received');
});

await t('signup-errors', ['R-13', 'R-09'], async (A) => {
  await seed(c);
  const su = (body) => c.req('POST', '/auth/signup', { body });
  A.err(await su({ email: 'ada@example.com', password: PASSWORD, display_name: 'A' }), 409, 'email_taken', 'email taken');
  A.err(await su({ email: 'ADA@example.com', password: PASSWORD, display_name: 'A' }), 409, 'email_taken', 'email taken, case differs (plan:A-04)');
  A.err(await su({ email: 'ada@other.org', password: PASSWORD, display_name: 'A' }), 409, 'handle_taken', 'handle taken');
  A.err(await c.req('POST', '/auth/login', { body: { email: 'ada@other.org', password: PASSWORD } }), 401, 'unauthenticated', 'no account created on handle_taken');
  A.err(await su({ email: 'short@ex.com', password: '1234567', display_name: 'S' }), 422, 'validation_failed', '7-char password');
  A.st(await su({ email: 'eight@ex.com', password: '12345678', display_name: 'S' }), 201, '8-char password');
  for (const email of ['noatsign', '@ex.com', 'local@', 'a b@ex.com', 'a@b@c.com', '']) {
    A.err(await su({ email, password: PASSWORD, display_name: 'S' }), 422, 'validation_failed', `email ${JSON.stringify(email)}`);
  }
  A.err(await su({ email: 5, password: PASSWORD, display_name: 'S' }), 400, 'malformed_request', 'email number');
  A.err(await su({ email: 'typ@ex.com', password: 12345678, display_name: 'S' }), 400, 'malformed_request', 'password number');
  A.err(await su({ password: PASSWORD, display_name: 'S' }), 422, 'validation_failed', 'email missing');
  A.err(await c.req('POST', '/auth/signup', { raw: '{"email":' }), 400, 'malformed_request', 'unparseable');
  A.err(await c.req('POST', '/auth/signup', { raw: '[1]' }), 400, 'malformed_request', 'array body');
});

await t('login-errors', ['R-14'], async (A) => {
  await seed(c);
  A.err(await c.req('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'wrong horse' } }), 401, 'unauthenticated', 'wrong password');
  A.err(await c.req('POST', '/auth/login', { body: { email: 'ghost@example.com', password: PASSWORD } }), 401, 'unauthenticated', 'unknown email');
  A.err(await c.req('POST', '/auth/login', { raw: 'nope' }), 400, 'malformed_request', 'unparseable');
});

await t('bearer-required', ['R-15'], async (A) => {
  const s = await seed(c);
  const probes = [['GET', '/me'], ['GET', '/activity'], ['GET', '/requests'], ['POST', '/payments'], ['POST', '/requests'], ['POST', '/splits'], ['POST', '/settlements'], ['POST', '/requests/rq_1/pay'], ['POST', '/requests/rq_1/decline'], ['POST', '/requests/rq_1/cancel']];
  for (const [m, p] of probes) {
    const body = m === 'POST' ? { to_handle: 'bob', amount: 1 } : undefined;
    A.err(await c.req(m, p, { body, key: m === 'POST' ? newKey() : undefined }), 401, 'unauthenticated', `${m} ${p} no token`);
    A.err(await c.req(m, p, { body, key: m === 'POST' ? newKey() : undefined, headers: { authorization: `Token ${s.tok.ada}` } }), 401, 'unauthenticated', `${m} ${p} wrong scheme`);
    A.err(await c.req(m, p, { body, key: m === 'POST' ? newKey() : undefined, token: 'not-a-token' }), 401, 'unauthenticated', `${m} ${p} unknown token`);
  }
  A.err(await c.req('GET', '/me', { headers: { authorization: 'Bearer ' } }), 401, 'unauthenticated', 'empty bearer');
  A.eq(await balances(c, s.tok), { ada: 10000, bob: 2500, cy: 0, dan: 5000, op: 0 }, 'nothing moved');
});

await t('password-not-stored-plaintext', ['R-16'], async (A) => {
  const s = await seed(c, fixture({ users: fixture().users.map((u, i) => ({ ...u, password: `pw-${u.handle}-Zq${i}x` })) }));
  await c.req('POST', '/auth/signup', { body: { email: 'pt@ex.com', password: 'Plain-Text-Probe-77', display_name: 'P' } });
  const e = await c.req('GET', '/_test/export');
  for (const pw of [...s.fx.users.map((u) => u.password), 'Plain-Text-Probe-77']) A.ok(!e.text.includes(pw), `export contains plaintext password ${pw}`);
});

// ---------------------------------------------------------------- payments
await t('payment-201-shape-and-balances', ['R-23', 'R-12'], async (A) => {
  const s = await seed(c);
  const r = await pay(s, 'ada', 'bob', 1500, { note: 'dinner', visibility: 'public' });
  A.st(r, 201, 'payment');
  A.eq(Object.keys(r.body ?? {}).sort(), PAYMENT_KEYS, 'payment fields');
  const b = r.body ?? {};
  A.eq([b.from_user_id, b.from_handle, b.to_user_id, b.to_handle, b.amount, b.currency, b.note, b.visibility, b.request_id, b.settlement_id], [s.id.ada, 'ada', s.id.bob, 'bob', 1500, 'EUR', 'dinner', 'public', null, null], 'payment values');
  A.ok(typeof b.payment_id === 'string' && b.payment_id.length >= 1 && b.payment_id.length <= 64, 'payment id');
  A.ok(!['p_1', 'p_2'].includes(b.payment_id), 'new id does not collide with fixture ids');
  A.ok(TS_RE.test(b.created_at ?? ''), 'created_at RFC 3339 with offset');
  A.eq(await balances(c, s.tok), { ada: 8500, bob: 4000, cy: 0, dan: 5000, op: 0 }, 'debit and credit');
  const d = await pay(s, 'ada', 'bob', 1);
  A.eq(d.body?.note, '', 'default note');
  A.eq(d.body?.visibility, 'public', 'default visibility');
  A.ok(d.body?.payment_id !== b.payment_id, 'distinct ids');
  A.eq((await feed(s, 'cy')).some((p) => p.payment_id === b.payment_id), true, 'public payment in third-party feed');
});

await t('payment-amount-forms', ['R-07'], async (A) => {
  const s = await seed(c);
  for (const raw of ['1e3', '1000.0', '1000', '1E3', '10e2']) {
    const r = await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), raw: `{"to_handle":"bob","amount":${raw}}` });
    A.st(r, 201, `amount ${raw}`);
    A.ok(r.body?.amount === 1000 && Number.isInteger(r.body?.amount), `amount ${raw} returned as 1000 (got ${r.body?.amount})`);
  }
  A.eq((await balances(c, s.tok)).ada, 5000, 'five payments of 1000');
});

await t('payment-amount-invalid-422', ['R-07'], async (A) => {
  const s = await seed(c);
  for (const raw of ['1000.5', '"1000"', 'true', 'false', 'null', '0', '-1', '-0', '1000000001', '1e400', '-1e400', '[1000]', '{"v":1}', '1.0000000001e9', '0.5', '1e-3']) {
    const r = await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), raw: `{"to_handle":"bob","amount":${raw}}` });
    A.err(r, 422, 'validation_failed', `amount ${raw}`);
  }
  A.err(await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), body: { to_handle: 'bob' } }), 422, 'validation_failed', 'amount missing');
  A.eq((await balances(c, s.tok)).ada, 10000, 'no money moved');
});

await t('payment-amount-max-boundary', ['R-07', 'R-12'], async (A) => {
  const fx = fixture(); fx.users[0] = { ...fx.users[0], balance: 3000000000 };
  const s = await seed(c, fx);
  A.st(await pay(s, 'ada', 'bob', 1000000000), 201, 'amount 1000000000');
  A.st(await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), raw: '{"to_handle":"bob","amount":1e9}' }), 201, 'amount 1e9');
  A.err(await pay(s, 'ada', 'bob', 1000000001), 422, 'validation_failed', 'amount 1000000001');
  A.st(await pay(s, 'ada', 'bob', 1), 201, 'amount 1');
  A.eq((await balances(c, s.tok)).bob, 2000002501, 'exact arithmetic (2500 + 1e9 + 1e9 + 1)');
});

await t('payment-errors', ['R-23', 'R-09'], async (A) => {
  const s = await seed(c);
  A.err(await pay(s, 'ada', 'ada', 10), 422, 'self_payment', 'self payment');
  A.err(await pay(s, 'ada', 'ghost', 10), 404, 'not_found', 'unknown handle');
  A.err(await pay(s, 'ada', 'GHOST!', 10), 404, 'not_found', 'unknown malformed handle (plan:A-08)');
  A.err(await pay(s, 'cy', 'ada', 1), 409, 'insufficient_funds', 'zero balance');
  A.err(await pay(s, 'bob', 'ada', 2501), 409, 'insufficient_funds', 'one over balance');
  A.err(await pay(s, 'ada', 'bob', 10, { visibility: 'PUBLIC' }), 422, 'validation_failed', 'visibility PUBLIC');
  A.err(await pay(s, 'ada', 'bob', 10, { visibility: null }), 422, 'validation_failed', 'visibility null');
  A.err(await pay(s, 'ada', 'bob', 10, { visibility: 1 }), 422, 'validation_failed', 'visibility number');
  A.err(await pay(s, 'ada', 'bob', 10, { note: null }), 422, 'validation_failed', 'note null');
  A.err(await pay(s, 'ada', 'bob', 10, { note: 5 }), 422, 'validation_failed', 'note number');
  A.err(await pay(s, 'ada', 'bob', 10, { note: 'x'.repeat(201) }), 422, 'validation_failed', 'note 201 chars');
  A.st(await pay(s, 'ada', 'bob', 10, { note: 'x'.repeat(200) }), 201, 'note 200 chars');
  A.st(await pay(s, 'ada', 'bob', 10, { note: '😀'.repeat(200) }), 201, 'note 200 emoji code points (plan:edge-3)');
  A.err(await pay(s, 'ada', 'bob', 10, { note: '😀'.repeat(201) }), 422, 'validation_failed', 'note 201 emoji');
  A.err(await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), body: { to_handle: 5, amount: 10 } }), 400, 'malformed_request', 'to_handle number');
  A.err(await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), body: { amount: 10 } }), 422, 'validation_failed', 'to_handle missing');
  for (const raw of ['{', '[]', '"x"', '3', 'null', '']) {
    A.err(await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), raw }), 400, 'malformed_request', `body ${JSON.stringify(raw)}`);
  }
  A.eq(await balances(c, s.tok), { ada: 10000 - 20, bob: 2520, cy: 0, dan: 5000, op: 0 }, 'only the two valid payments moved money');
  A.eq((await feed(s, 'ada')).length, 1 + 2, 'failed payments leave no feed trace (p_1 + two valid)');
});

await t('payment-exact-balance-and-unknown-fields', ['R-23', 'R-05'], async (A) => {
  const s = await seed(c);
  const r = await pay(s, 'bob', 'cy', 2500, { extra: 'ignored', nested: { a: 1 } });
  A.st(r, 201, 'exact balance with unknown fields');
  A.eq((await balances(c, s.tok)).bob, 0, 'balance drained to zero');
  A.err(await pay(s, 'bob', 'cy', 1), 409, 'insufficient_funds', 'nothing left');
  A.st(await c.req('GET', '/activity?limit=5&foo=bar', { token: s.tok.ada }), 200, 'unknown query param ignored');
});

await t('note-verbatim-roundtrip', ['R-08'], async (A) => {
  const s = await seed(c);
  const note = '  héllo\t👋🏽 <b>&amp;</b> "q" \\ éé \n ';
  const r = await pay(s, 'ada', 'bob', 1, { note });
  A.eq(r.body?.note, note, 'note in response');
  const f = await feed(s, 'bob');
  A.eq(f.find((p) => p.payment_id === r.body?.payment_id)?.note, note, 'note in feed');
  const q = await ask(s, 'ada', 'bob', 1, { note });
  A.eq(q.body?.note, note, 'request note verbatim');
});

// ---------------------------------------------------------------- idempotency
await t('idem-header-rules', ['R-17'], async (A) => {
  const s = await seed(c);
  for (const p of ['/payments', '/requests', '/splits', '/settlements', '/requests/rq_1/pay']) {
    const tok = p === '/settlements' ? s.tok.op : s.tok.ada;
    A.err(await c.req('POST', p, { token: tok, body: {} }), 400, 'missing_idempotency_key', `${p} no key`);
    A.err(await c.req('POST', p, { token: tok, key: '', body: {} }), 400, 'missing_idempotency_key', `${p} empty key`);
    A.err(await c.req('POST', p, { token: tok, key: 'k'.repeat(256), body: {} }), 422, 'validation_failed', `${p} 256-char key`);
  }
  A.st(await pay(s, 'ada', 'bob', 1, {}, 'k'.repeat(255)), 201, '255-char key');
  A.st(await pay(s, 'ada', 'bob', 1, {}, 'x'), 201, '1-char key');
  A.err(await c.req('POST', '/payments', { token: s.tok.ada, body: { to_handle: 'bob', amount: 'x' } }), 400, 'missing_idempotency_key', 'missing key before field validation (plan:A-01)');
  A.eq((await balances(c, s.tok)).ada, 9998, 'only valid payments moved');
});

await t('idem-replay-and-reuse', ['R-19', 'R-21'], async (A) => {
  const s = await seed(c);
  const key = newKey();
  const first = await c.req('POST', '/payments', { token: s.tok.ada, key, raw: '{"to_handle":"bob","amount":300,"note":"n"}' });
  A.st(first, 201, 'first use');
  const replay = await c.req('POST', '/payments', { token: s.tok.ada, key, raw: '{ "note" : "n",\n "amount":300, "to_handle":"bob" }' });
  A.st(replay, 200, 'replay with reordered keys and whitespace');
  A.eq(replay.body, first.body, 'replay body identical');
  A.eq((await balances(c, s.tok)).ada, 9700, 'moved once');
  A.err(await pay(s, 'ada', 'bob', 301, { note: 'n' }, key), 409, 'idempotency_key_reuse', 'different body');
  A.err(await c.req('POST', '/payments', { token: s.tok.ada, key, body: { to_handle: 'bob', amount: 'zzz' } }), 409, 'idempotency_key_reuse', 'invalid body with claimed key');
  A.err(await c.req('POST', '/payments', { token: s.tok.ada, key, body: { to_handle: 'ada', amount: 300, note: 'n' } }), 409, 'idempotency_key_reuse', 'self-payment body with claimed key');
  // Drain ada; a replay is still the original response, not insufficient_funds.
  A.st(await pay(s, 'ada', 'dan', 9700), 201, 'drain');
  const late = await pay(s, 'ada', 'bob', 300, { note: 'n' }, key);
  A.st(late, 200, 'replay after balance drained');
  A.eq(late.body, first.body, 'late replay body');
  A.eq(await balances(c, s.tok), { ada: 0, bob: 2800, cy: 0, dan: 14700, op: 0 }, 'balances');
  A.err(await c.req('POST', '/payments', { token: 'bogus', key, body: { to_handle: 'bob', amount: 300, note: 'n' } }), 401, 'unauthenticated', 'replay without valid token');
  A.err(await c.req('POST', '/payments', { token: s.tok.ada, key, raw: '{"to_handle":' }), 400, 'malformed_request', 'unparseable body with claimed key');
});

await t('idem-numeric-equality', ['R-19', 'plan:A-14'], async (A) => {
  const s = await seed(c);
  const key = newKey();
  const a = await c.req('POST', '/payments', { token: s.tok.ada, key, raw: '{"to_handle":"bob","amount":1000}' });
  const b = await c.req('POST', '/payments', { token: s.tok.ada, key, raw: '{"to_handle":"bob","amount":1e3}' });
  A.st(a, 201, 'first'); A.st(b, 200, '1e3 equals 1000 as a JSON value');
  A.eq(b.body, a.body, 'same body');
});

await t('idem-scope-user-and-path', ['R-18'], async (A) => {
  const s = await seed(c);
  const key = 'shared-key';
  A.st(await pay(s, 'ada', 'cy', 10, {}, key), 201, 'ada key');
  A.st(await pay(s, 'bob', 'cy', 10, {}, key), 201, 'bob same key, same body is independent');
  A.st(await ask(s, 'ada', 'cy', 10, {}, key), 201, 'same key on /requests');
  A.st(await c.req('POST', '/splits', { token: s.tok.ada, key, body: { amount: 10, participant_handles: ['cy'] } }), 201, 'same key on /splits');
  const q = await ask(s, 'ada', 'bob', 5);
  A.st(await c.req('POST', `/requests/${q.body?.request_id}/pay`, { token: s.tok.bob, key, body: {} }), 201, 'same key on /pay');
  A.st(await c.req('POST', '/settlements', { token: s.tok.op, key, body: { transfers: [{ from_handle: 'ada', to_handle: 'cy', amount: 1 }] } }), 201, 'same key on /settlements');
  A.eq((await balances(c, s.tok)).cy, 21, 'each counted once');
});

await t('idem-failed-key-reusable', ['R-19'], async (A) => {
  const s = await seed(c);
  for (const [name, bad] of [['422', { to_handle: 'bob', amount: 0 }], ['404', { to_handle: 'ghost', amount: 5 }], ['409', { to_handle: 'bob', amount: 999999 }], ['422 self', { to_handle: 'ada', amount: 5 }], ['400 type', { to_handle: 7, amount: 5 }]]) {
    const key = newKey();
    const r = await c.req('POST', '/payments', { token: s.tok.ada, key, body: bad });
    A.ok(r.status >= 400 && r.status < 500, `${name} failed (${r.status})`);
    A.st(await pay(s, 'ada', 'bob', 5, {}, key), 201, `key reusable after ${name}`);
  }
  A.eq((await balances(c, s.tok)).ada, 9975, 'five successful payments');
});

await t('idem-replay-after-resource-changed', ['R-19', 'R-25'], async (A) => {
  const s = await seed(c);
  const key = newKey();
  const created = await ask(s, 'ada', 'bob', 100, { note: 'r' }, key);
  A.st(await c.req('POST', `/requests/${created.body?.request_id}/cancel`, { token: s.tok.ada }), 200, 'cancel');
  const replay = await ask(s, 'ada', 'bob', 100, { note: 'r' }, key);
  A.st(replay, 200, 'request replay after cancel');
  A.eq(replay.body, created.body, 'original body (pending) returned');
  const q = await ask(s, 'bob', 'ada', 50);
  const pk = newKey();
  const paid = await c.req('POST', `/requests/${q.body?.request_id}/pay`, { token: s.tok.ada, key: pk, body: { visibility: 'private' } });
  A.st(paid, 201, 'pay');
  const again = await c.req('POST', `/requests/${q.body?.request_id}/pay`, { token: s.tok.ada, key: pk, body: { visibility: 'private' } });
  A.st(again, 200, 'pay replay after paid');
  A.eq(again.body, paid.body, 'pay replay body');
  A.err(await c.req('POST', `/requests/${q.body?.request_id}/pay`, { token: s.tok.ada, key: newKey(), body: { visibility: 'private' } }), 409, 'request_not_pending', 'new key on paid request');
  A.eq((await balances(c, s.tok)).ada, 9950, 'paid once');
});

// ---------------------------------------------------------------- requests
await t('request-create', ['R-24'], async (A) => {
  const s = await seed(c);
  const r = await ask(s, 'cy', 'ada', 999999, { note: 'big' });
  A.st(r, 201, 'request above payer balance is created');
  A.eq(Object.keys(r.body ?? {}).sort(), REQUEST_KEYS, 'request fields');
  const b = r.body ?? {};
  A.eq([b.requester_id, b.requester_handle, b.payer_id, b.payer_handle, b.amount, b.currency, b.note, b.status, b.payment_id], [s.id.cy, 'cy', s.id.ada, 'ada', 999999, 'EUR', 'big', 'pending', null], 'request values');
  A.ok(b.request_id && b.request_id !== 'rq_1', 'fresh id');
  A.eq((await ask(s, 'cy', 'ada', 1)).body?.note, '', 'default note');
  A.err(await ask(s, 'ada', 'ada', 1), 422, 'self_request', 'self request');
  A.err(await ask(s, 'ada', 'ghost', 1), 404, 'not_found', 'unknown payer');
  for (const raw of ['0', '-5', '1000000001', '"5"', 'true', 'null', '2.5']) A.err(await c.req('POST', '/requests', { token: s.tok.ada, key: newKey(), raw: `{"payer_handle":"bob","amount":${raw}}` }), 422, 'validation_failed', `amount ${raw}`);
  A.err(await ask(s, 'ada', 'bob', 1, { note: 'y'.repeat(201) }), 422, 'validation_failed', 'note 201');
  A.err(await ask(s, 'ada', 'bob', 1, { note: null }), 422, 'validation_failed', 'note null');
  A.err(await c.req('POST', '/requests', { token: s.tok.ada, key: newKey(), body: { payer_handle: ['bob'], amount: 1 } }), 400, 'malformed_request', 'payer_handle array');
  A.eq(await balances(c, s.tok), { ada: 10000, bob: 2500, cy: 0, dan: 5000, op: 0 }, 'requests move no money');
  A.eq((await feed(s, 'ada')).length, 1, 'requests never in feed');
});

await t('request-pay', ['R-25', 'R-12'], async (A) => {
  const s = await seed(c);
  const r = await c.req('POST', '/requests/rq_1/pay', { token: s.tok.ada, key: newKey(), body: { visibility: 'private' } });
  A.st(r, 201, 'pay seeded request');
  A.eq(Object.keys(r.body ?? {}).sort(), PAYMENT_KEYS, 'payment fields');
  A.eq([r.body?.from_handle, r.body?.to_handle, r.body?.amount, r.body?.visibility, r.body?.request_id, r.body?.settlement_id], ['ada', 'bob', 1200, 'private', 'rq_1', null], 'payment values');
  const rq = (await reqs(s, 'bob')).find((x) => x.request_id === 'rq_1');
  A.eq([rq?.status, rq?.payment_id], ['paid', r.body?.payment_id], 'request paid with payment id');
  A.eq(await balances(c, s.tok), { ada: 8800, bob: 3700, cy: 0, dan: 5000, op: 0 }, 'money moved');
  A.ok(!(await feed(s, 'cy')).some((p) => p.payment_id === r.body?.payment_id), 'private pay hidden from third party');
  A.ok((await feed(s, 'bob')).some((p) => p.payment_id === r.body?.payment_id), 'private pay visible to receiver');
  // empty body = default public (plan:edge-1)
  const q = await ask(s, 'bob', 'ada', 3);
  const e = await c.req('POST', `/requests/${q.body?.request_id}/pay`, { token: s.tok.ada, key: newKey(), body: {} });
  A.eq([e.status, e.body?.visibility], [201, 'public'], 'default visibility');
});

await t('request-pay-errors', ['R-25', 'plan:A-02'], async (A) => {
  const s = await seed(c);
  A.err(await c.req('POST', '/requests/rq_1/pay', { token: s.tok.bob, key: newKey(), body: {} }), 403, 'forbidden', 'requester cannot pay');
  A.err(await c.req('POST', '/requests/rq_1/pay', { token: s.tok.cy, key: newKey(), body: {} }), 403, 'forbidden', 'third party cannot pay');
  A.err(await c.req('POST', '/requests/rq_ghost/pay', { token: s.tok.ada, key: newKey(), body: {} }), 404, 'not_found', 'unknown request');
  A.err(await c.req('POST', '/requests/rq_1/pay', { token: s.tok.ada, key: newKey(), body: { visibility: 'friends' } }), 422, 'validation_failed', 'bad visibility');
  const q = await ask(s, 'ada', 'cy', 500);
  const id = q.body?.request_id;
  const k1 = newKey();
  A.err(await c.req('POST', `/requests/${id}/pay`, { token: s.tok.cy, key: k1, body: {} }), 409, 'insufficient_funds', 'payer short');
  A.eq((await reqs(s, 'cy')).find((x) => x.request_id === id)?.status, 'pending', 'request stays pending');
  A.st(await pay(s, 'dan', 'cy', 500), 201, 'fund payer');
  const ok = await c.req('POST', `/requests/${id}/pay`, { token: s.tok.cy, key: k1, body: {} });
  A.st(ok, 201, 'payable later with the same (unclaimed) key');
  A.err(await c.req('POST', `/requests/${id}/pay`, { token: s.tok.cy, key: k1, body: { visibility: 'public' } }), 409, 'idempotency_key_reuse', '{} vs {"visibility":"public"} differ');
  A.eq((await balances(c, s.tok)).cy, 0, 'paid exactly once');
  const d = await ask(s, 'ada', 'bob', 5);
  await c.req('POST', `/requests/${d.body?.request_id}/decline`, { token: s.tok.bob });
  A.err(await c.req('POST', `/requests/${d.body?.request_id}/pay`, { token: s.tok.bob, key: newKey(), body: {} }), 409, 'request_not_pending', 'pay declined');
  const x = await ask(s, 'ada', 'bob', 5);
  await c.req('POST', `/requests/${x.body?.request_id}/cancel`, { token: s.tok.ada });
  A.err(await c.req('POST', `/requests/${x.body?.request_id}/pay`, { token: s.tok.bob, key: newKey(), body: {} }), 409, 'request_not_pending', 'pay cancelled');
});

await t('request-decline-cancel', ['R-26', 'R-27', 'plan:A-02'], async (A) => {
  const s = await seed(c);
  const mk = async () => (await ask(s, 'ada', 'bob', 10)).body?.request_id;
  const d = await mk();
  A.err(await c.req('POST', `/requests/${d}/decline`, { token: s.tok.ada }), 403, 'forbidden', 'requester cannot decline');
  A.err(await c.req('POST', `/requests/${d}/decline`, { token: s.tok.cy }), 403, 'forbidden', 'third party cannot decline');
  const r1 = await c.req('POST', `/requests/${d}/decline`, { token: s.tok.bob });
  A.eq([r1.status, r1.body?.status, r1.body?.request_id], [200, 'declined', d], 'decline');
  A.ok(hasKeys(r1.body, REQUEST_KEYS), 'decline returns the request');
  const r2 = await c.req('POST', `/requests/${d}/decline`, { token: s.tok.bob });
  A.eq([r2.status, r2.body?.status], [200, 'declined'], 'decline twice');
  A.err(await c.req('POST', `/requests/${d}/cancel`, { token: s.tok.ada }), 409, 'request_not_pending', 'cancel declined');
  const x = await mk();
  A.err(await c.req('POST', `/requests/${x}/cancel`, { token: s.tok.bob }), 403, 'forbidden', 'payer cannot cancel');
  A.err(await c.req('POST', `/requests/${x}/cancel`, { token: s.tok.cy }), 403, 'forbidden', 'third party cannot cancel');
  const c1 = await c.req('POST', `/requests/${x}/cancel`, { token: s.tok.ada });
  A.eq([c1.status, c1.body?.status], [200, 'cancelled'], 'cancel');
  A.eq((await c.req('POST', `/requests/${x}/cancel`, { token: s.tok.ada })).status, 200, 'cancel twice');
  A.err(await c.req('POST', `/requests/${x}/decline`, { token: s.tok.bob }), 409, 'request_not_pending', 'decline cancelled');
  const p = await mk();
  A.st(await c.req('POST', `/requests/${p}/pay`, { token: s.tok.bob, key: newKey(), body: {} }), 201, 'pay');
  A.err(await c.req('POST', `/requests/${p}/decline`, { token: s.tok.bob }), 409, 'request_not_pending', 'decline paid');
  A.err(await c.req('POST', `/requests/${p}/cancel`, { token: s.tok.ada }), 409, 'request_not_pending', 'cancel paid');
  A.err(await c.req('POST', '/requests/nope/decline', { token: s.tok.bob }), 404, 'not_found', 'decline unknown');
  A.err(await c.req('POST', '/requests/nope/cancel', { token: s.tok.bob }), 404, 'not_found', 'cancel unknown');
  A.st(await c.req('POST', `/requests/${await mk()}/decline`, { token: s.tok.bob, raw: '' }), 200, 'empty body decline (plan:A-12)');
});

await t('get-requests-filters-order-paging', ['R-28', 'R-10'], async (A) => {
  const s = await seed(c);
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await ask(s, 'ada', 'bob', 10 + i)).body?.request_id);
  const inc = (await ask(s, 'bob', 'ada', 7)).body?.request_id;
  await c.req('POST', `/requests/${ids[1]}/decline`, { token: s.tok.bob });
  await c.req('POST', `/requests/${ids[2]}/cancel`, { token: s.tok.ada });
  const all = await reqs(s, 'ada');
  A.eq(all.length, 7, 'all of ada\'s requests incl. seeded rq_1');
  A.ok(sortedByCreatedDesc(all), 'newest first by created_at');
  A.ok(all.slice(0, 6).map((r) => r.request_id).includes(inc), 'newest include the last created');
  const out = await reqs(s, 'ada', '?direction=outgoing&limit=200');
  A.eq(out.map((r) => r.request_id).sort(), [...ids, inc].filter((x) => x !== inc).sort(), 'outgoing = caller is requester');
  const incoming = await reqs(s, 'ada', '?direction=incoming');
  A.eq(incoming.map((r) => r.request_id).sort(), ['rq_1', inc].sort(), 'incoming = caller is payer');
  A.eq((await reqs(s, 'ada', '?status=declined')).map((r) => r.request_id), [ids[1]], 'status=declined');
  A.eq((await reqs(s, 'ada', '?status=cancelled&direction=outgoing')).map((r) => r.request_id), [ids[2]], 'status+direction');
  A.eq((await reqs(s, 'ada', '?status=paid')).length, 0, 'status=paid');
  A.eq((await reqs(s, 'ada', '?status=pending')).length, 5, 'status=pending');
  const p1 = await c.req('GET', '/requests?limit=3&offset=0', { token: s.tok.ada });
  const p2 = await c.req('GET', '/requests?limit=3&offset=3', { token: s.tok.ada });
  const p3 = await c.req('GET', '/requests?limit=3&offset=6', { token: s.tok.ada });
  A.eq([p1.body?.has_more, p2.body?.has_more, p3.body?.has_more], [true, true, false], 'has_more');
  A.eq([...p1.body.requests, ...p2.body.requests, ...p3.body.requests].map((r) => r.request_id), all.map((r) => r.request_id), 'pages concatenate to the full list');
  A.eq((await c.req('GET', '/requests?limit=7', { token: s.tok.ada })).body?.has_more, false, 'has_more false at exact end');
  A.eq((await c.req('GET', '/requests?offset=50', { token: s.tok.ada })).body, { requests: [], has_more: false }, 'offset past end');
  A.eq((await c.req('GET', '/requests', { token: s.tok.ada })).body?.requests?.length, 7, 'defaults');
  for (const q of ['direction=both', 'direction=', 'status=open', 'status=PAID', 'limit=0', 'limit=201', 'limit=-1', 'limit=abc', 'limit=1e2', 'limit=+4', 'limit=4.0', 'limit=', 'offset=-1', 'offset=1.0', 'offset=+0', 'offset=x', 'limit= 4']) {
    A.err(await c.req('GET', `/requests?${q}`, { token: s.tok.ada }), 422, 'validation_failed', `GET /requests?${q}`);
  }
  A.st(await c.req('GET', '/requests?limit=200&offset=0', { token: s.tok.ada }), 200, 'limit=200 offset=0');
  A.st(await c.req('GET', '/requests?limit=007', { token: s.tok.ada }), 200, 'limit=007 is plain digits');
  A.eq(await reqs(s, 'cy'), [], 'third party sees none of them');
});

// ---------------------------------------------------------------- splits
await t('split-shares-table', ['R-29', 'R-30'], async (A) => {
  const fx = fixture();
  fx.users.push({ id: 'u_eve', email: 'eve@example.com', password: PASSWORD, display_name: 'Eve', handle: 'eve', balance: 0 });
  const s = await seed(c, fx);
  for (const [amount, hs, expect] of [[1000, ['ada', 'bob', 'cy'], [334, 333, 333]], [1, ['ada', 'bob', 'cy'], [1, 0, 0]], [10, ['ada', 'bob', 'cy'], [4, 3, 3]], [999, ['ada', 'bob', 'cy'], [333, 333, 333]], [5, ['ada', 'bob', 'cy', 'dan', 'eve'], [1, 1, 1, 1, 1]], [10, ['cy', 'bob', 'ada'], [4, 3, 3]], [7, ['bob', 'cy', 'dan', 'eve'], [2, 2, 2, 1]]]) {
    const r = await c.req('POST', '/splits', { token: s.tok.ada, key: newKey(), body: { amount, participant_handles: hs, note: 'dinner' } });
    A.st(r, 201, `split ${amount}/${hs.length}`);
    A.eq(r.body?.shares, hs.map((h, i) => ({ handle: h, amount: expect[i] })), `shares ${amount} ${hs}`);
    const others = hs.filter((h) => h !== 'ada');
    A.eq((r.body?.requests ?? []).map((q) => [q.payer_handle, q.requester_handle, q.amount, q.status, q.note]), others.map((h) => [h, 'ada', expect[hs.indexOf(h)], 'pending', 'dinner']), `requests ${amount} ${hs}`);
    A.ok((r.body?.requests ?? []).every((q) => hasKeys(q, REQUEST_KEYS)), 'requests are full request objects');
    A.eq([r.body?.amount, r.body?.currency, r.body?.note], [amount, 'EUR', 'dinner'], 'split fields');
    A.ok(typeof r.body?.split_id === 'string' && TS_RE.test(r.body?.created_at ?? ''), 'split_id, created_at');
  }
  A.eq(await balances(c, s.tok), { ada: 10000, bob: 2500, cy: 0, dan: 5000, op: 0, eve: 0 }, 'splits move no money');
  A.eq((await feed(s, 'ada')).length, 1, 'splits are not feed items');
});

await t('split-caller-only-and-zero-share', ['R-29', 'R-30', 'plan:A-03'], async (A) => {
  const s = await seed(c);
  const solo = await c.req('POST', '/splits', { token: s.tok.ada, key: newKey(), body: { amount: 500, participant_handles: ['ada'] } });
  A.st(solo, 201, 'caller-only split');
  A.eq([solo.body?.shares, solo.body?.requests, solo.body?.note], [[{ handle: 'ada', amount: 500 }], [], ''], 'one share, no requests, default note');
  const z = await c.req('POST', '/splits', { token: s.tok.ada, key: newKey(), body: { amount: 1, participant_handles: ['bob', 'cy', 'dan'] } });
  A.eq(z.body?.shares?.map((x) => x.amount), [1, 0, 0], 'caller omitted: shares over listed handles');
  A.eq(z.body?.requests?.map((q) => [q.payer_handle, q.amount]), [['bob', 1], ['cy', 0], ['dan', 0]], 'zero share still makes a request');
  const zr = z.body?.requests?.[1]?.request_id;
  const pz = await c.req('POST', `/requests/${zr}/pay`, { token: s.tok.cy, key: newKey(), body: {} });
  A.eq([pz.status, pz.body?.amount], [201, 0], 'paying a zero-share request (plan:R-30)');
  A.eq((await sumBal(s)), 17500, 'conservation');
  const visible = (await reqs(s, 'bob')).some((q) => q.request_id === z.body?.requests?.[0]?.request_id);
  A.ok(visible, 'split request visible to its payer');
});

await t('split-errors', ['R-29', 'R-09'], async (A) => {
  const s = await seed(c);
  const sp = (body) => c.req('POST', '/splits', { token: s.tok.ada, key: newKey(), body });
  A.err(await sp({ amount: 10, participant_handles: [] }), 422, 'validation_failed', 'empty participants');
  A.err(await sp({ amount: 10, participant_handles: ['bob', 'bob'] }), 422, 'validation_failed', 'duplicate');
  A.err(await sp({ amount: 10, participant_handles: ['bob', 'ghost'] }), 404, 'not_found', 'unknown handle');
  A.err(await sp({ amount: 0, participant_handles: ['bob'] }), 422, 'validation_failed', 'amount 0');
  A.err(await sp({ amount: 1000000001, participant_handles: ['bob'] }), 422, 'validation_failed', 'amount max+1');
  A.err(await sp({ amount: '10', participant_handles: ['bob'] }), 422, 'validation_failed', 'amount string');
  A.err(await sp({ amount: 10, participant_handles: ['bob'], note: 'n'.repeat(201) }), 422, 'validation_failed', 'note 201');
  A.err(await sp({ amount: 10 }), 422, 'validation_failed', 'participants missing');
  A.err(await sp({ amount: 10, participant_handles: 'bob' }), 400, 'malformed_request', 'participants not array');
  A.st(await sp({ amount: 1000000000, participant_handles: ['bob', 'ada'] }), 201, 'max amount');
  A.eq((await reqs(s, 'bob')).length, 2, 'failed splits created no requests');
});

// ---------------------------------------------------------------- activity
await t('activity-visibility-order-paging', ['R-31', 'R-10'], async (A) => {
  const s = await seed(c);
  const priv = (await pay(s, 'ada', 'bob', 1, { visibility: 'private' })).body?.payment_id;
  const pub = (await pay(s, 'dan', 'cy', 2)).body?.payment_id;
  await ask(s, 'cy', 'dan', 9);
  const vis = async (h) => (await feed(s, h)).map((p) => p.payment_id).sort();
  A.eq(await vis('ada'), ['p_1', priv, pub].sort(), 'sender sees own private');
  A.eq(await vis('bob'), ['p_1', 'p_2', priv, pub].sort(), 'receiver sees private; sender of p_2');
  A.eq(await vis('cy'), ['p_1', pub].sort(), 'third party: public only');
  A.eq(await vis('op'), ['p_1', pub].sort(), 'operator: public only');
  const f = await feed(s, 'bob');
  A.ok(sortedByCreatedDesc(f), 'newest first');
  A.ok(f.every((p) => hasKeys(p, PAYMENT_KEYS)), 'feed items are full payments');
  const priv2 = f.find((p) => p.payment_id === priv);
  A.eq(priv2?.visibility, 'private', 'one visibility value for everyone');
  const p1 = await c.req('GET', '/activity?limit=2', { token: s.tok.bob });
  const p2 = await c.req('GET', '/activity?limit=2&offset=2', { token: s.tok.bob });
  A.eq([p1.body?.has_more, p2.body?.has_more, p1.body?.payments?.length, p2.body?.payments?.length], [true, false, 2, 2], 'paging');
  A.eq(Object.keys(p1.body ?? {}).sort(), ['has_more', 'payments'], 'feed envelope');
  for (const q of ['limit=0', 'limit=201', 'limit=1e9', 'limit=4.0', 'limit=+4', 'offset=-1', 'offset=1e1', 'limit=']) A.err(await c.req('GET', `/activity?${q}`, { token: s.tok.bob }), 422, 'validation_failed', `GET /activity?${q}`);
});

// ---------------------------------------------------------------- settlements
const settle = (s, transfers, key = newKey('st'), who = 'op') => c.req('POST', '/settlements', { token: s.tok[who], key, body: { transfers } });

await t('settlement-201-net-chain', ['R-35', 'R-36', 'R-37'], async (A) => {
  const fx = fixture(); fx.users[1] = { ...fx.users[1], balance: 50 };
  const s = await seed(c, fx);
  const r = await settle(s, [{ from_handle: 'ada', to_handle: 'bob', amount: 100, note: 'a', visibility: 'private' }, { from_handle: 'bob', to_handle: 'cy', amount: 150 }]);
  A.st(r, 201, 'net-affordable chain (bob 50 + 100 - 150 = 0)');
  A.eq(Object.keys(r.body ?? {}).sort(), ['committed_at', 'payments', 'settlement_id'], 'settlement fields');
  const ps = r.body?.payments ?? [];
  A.eq(ps.map((p) => [p.from_handle, p.to_handle, p.amount, p.note, p.visibility, p.request_id, p.settlement_id]), [['ada', 'bob', 100, 'a', 'private', null, r.body?.settlement_id], ['bob', 'cy', 150, '', 'public', null, r.body?.settlement_id]], 'members in input order');
  A.ok(ps.every((p) => p.created_at === r.body?.committed_at && hasKeys(p, PAYMENT_KEYS)), 'members share committed_at');
  A.ok(TS_RE.test(r.body?.committed_at ?? ''), 'committed_at format');
  A.eq(await balances(c, s.tok), { ada: 9900, bob: 0, cy: 150, dan: 5000, op: 0 }, 'net balances');
  A.eq((await feed(s, 'op')).map((p) => p.payment_id).sort(), ['p_1', ps[1]?.payment_id].sort(), 'operator does not see the private member');
  A.ok((await feed(s, 'bob')).some((p) => p.payment_id === ps[0]?.payment_id), 'party sees private member');
  A.ok((await feed(s, 'dan')).some((p) => p.payment_id === ps[1]?.payment_id && p.settlement_id === r.body?.settlement_id), 'public member in third-party feed with settlement_id');
});

await t('settlement-auth-and-shape', ['R-35', 'R-34'], async (A) => {
  const s = await seed(c);
  const one = [{ from_handle: 'ada', to_handle: 'bob', amount: 1 }];
  A.err(await c.req('POST', '/settlements', { key: newKey(), body: { transfers: one } }), 401, 'unauthenticated', 'no token');
  A.err(await settle(s, one, newKey(), 'ada'), 403, 'forbidden', 'non-operator (even a party)');
  A.err(await c.req('POST', '/settlements', { token: s.tok.op, body: { transfers: one } }), 400, 'missing_idempotency_key', 'no key');
  const t32 = Array.from({ length: 32 }, () => ({ from_handle: 'ada', to_handle: 'bob', amount: 1 }));
  A.err(await settle(s, []), 422, 'validation_failed', '0 transfers');
  A.err(await settle(s, [...t32, t32[0]]), 422, 'validation_failed', '33 transfers');
  A.err(await c.req('POST', '/settlements', { token: s.tok.op, key: newKey(), body: {} }), 422, 'validation_failed', 'transfers missing');
  A.err(await c.req('POST', '/settlements', { token: s.tok.op, key: newKey(), body: { transfers: 'x' } }), 422, 'validation_failed', 'transfers not array');
  A.err(await settle(s, [5]), 422, 'validation_failed', 'entry not object');
  A.err(await settle(s, [{ from_handle: 'ada', to_handle: 'bob', amount: 0 }]), 422, 'validation_failed', 'amount 0');
  A.err(await settle(s, [{ from_handle: 'ada', to_handle: 'bob', amount: 1.5 }]), 422, 'validation_failed', 'amount 1.5');
  A.err(await settle(s, [{ from_handle: 'ada', to_handle: 'bob', amount: 1, note: 'z'.repeat(201) }]), 422, 'validation_failed', 'note 201');
  A.err(await settle(s, [{ from_handle: 'ada', to_handle: 'bob', amount: 1, visibility: 'x' }]), 422, 'validation_failed', 'bad visibility');
  A.err(await settle(s, [{ from_handle: 'ada', to_handle: 'ghost', amount: 1 }]), 404, 'not_found', 'unknown handle');
  A.err(await settle(s, [{ from_handle: 'bob', to_handle: 'bob', amount: 1 }]), 422, 'self_payment', 'self transfer');
  A.eq(await balances(c, s.tok), { ada: 10000, bob: 2500, cy: 0, dan: 5000, op: 0 }, 'nothing moved');
  const ok = await settle(s, t32.map((x) => ({ ...x, extra: true })));
  A.st(ok, 201, '32 transfers with unknown fields');
  A.eq(ok.body?.payments?.length, 32, '32 members');
  A.eq((await balances(c, s.tok)).bob, 2532, 'all 32 applied');
});

await t('settlement-precedence-and-atomicity', ['R-35', 'R-36'], async (A) => {
  const s = await seed(c);
  A.err(await settle(s, [{ from_handle: 'ada', to_handle: 'ghost', amount: 1 }, { from_handle: 'bob', to_handle: 'bob', amount: 1 }]), 404, 'not_found', 'entry 1 (404) before entry 2 (422)');
  A.err(await settle(s, [{ from_handle: 'bob', to_handle: 'bob', amount: 1 }, { from_handle: 'ada', to_handle: 'ghost', amount: 1 }]), 422, 'self_payment', 'entry 1 (422) before entry 2 (404)');
  A.err(await settle(s, [{ from_handle: 'cy', to_handle: 'ada', amount: 999 }, { from_handle: 'ada', to_handle: 'ghost', amount: 1 }]), 404, 'not_found', 'entry error before insufficient funds');
  A.err(await settle(s, [{ from_handle: 'ada', to_handle: 'bob', amount: 0 }, { from_handle: 'ada', to_handle: 'ghost', amount: 1 }]), 422, 'validation_failed', 'entry 1 amount before entry 2 404');
  const key = newKey();
  A.err(await settle(s, [{ from_handle: 'ada', to_handle: 'cy', amount: 100 }, { from_handle: 'cy', to_handle: 'dan', amount: 101 }], key), 409, 'insufficient_funds', 'cy net -1');
  A.eq(await balances(c, s.tok), { ada: 10000, bob: 2500, cy: 0, dan: 5000, op: 0 }, 'all-or-nothing');
  const after = await settle(s, [{ from_handle: 'ada', to_handle: 'cy', amount: 100 }, { from_handle: 'cy', to_handle: 'dan', amount: 100 }], key);
  A.st(after, 201, 'failed settlement claimed no key');
  A.eq(await balances(c, s.tok), { ada: 9900, bob: 2500, cy: 0, dan: 5100, op: 0 }, 'pass-through');
  A.err(await settle(s, [{ from_handle: 'bob', to_handle: 'ada', amount: 2501 }]), 409, 'insufficient_funds', 'single over');
  A.st(await settle(s, [{ from_handle: 'bob', to_handle: 'ada', amount: 2500 }, { from_handle: 'ada', to_handle: 'bob', amount: 1 }]), 201, 'bob to zero then back 1');
  const ids = (await feed(s, 'ada')).length;
  A.eq(ids, 1 + 2 + 2, 'only committed members in feed');
});

await t('settlement-replay', ['R-37', 'R-19', 'R-21'], async (A) => {
  const s = await seed(c);
  const key = newKey();
  const body = [{ from_handle: 'ada', to_handle: 'bob', amount: 10 }, { from_handle: 'dan', to_handle: 'cy', amount: 20, visibility: 'private' }];
  const first = await settle(s, body, key);
  A.st(first, 201, 'first');
  const again = await settle(s, body, key);
  A.st(again, 200, 'replay');
  A.eq(again.body, first.body, 'original complete response');
  A.err(await settle(s, [body[0]], key), 409, 'idempotency_key_reuse', 'different body');
  A.err(await settle(s, [], key), 409, 'idempotency_key_reuse', 'invalid body with claimed key');
  A.eq((await balances(c, s.tok)).cy, 20, 'applied once');
});

// ---------------------------------------------------------------- export / import
await t('export-shape-unauthenticated', ['R-32'], async (A) => {
  await seed(c);
  const e = await c.req('GET', '/_test/export');
  A.st(e, 200, 'export');
  A.eq([e.body?.track, e.body?.format_version, typeof e.body?.state, Array.isArray(e.body?.state)], ['pocketful', 1, 'object', false], 'export envelope');
});

await t('export-import-roundtrip', ['R-32', 'R-33', 'R-34'], async (A) => {
  const s = await seed(c);
  const pk = newKey(), rk = newKey(), sk = newKey(), xk = newKey(), fk = newKey();
  const p = await pay(s, 'ada', 'bob', 111, { note: 'pre', visibility: 'private' }, pk);
  const q = await ask(s, 'cy', 'dan', 77, {}, rk);
  const st = await settle(s, [{ from_handle: 'dan', to_handle: 'cy', amount: 5 }], sk);
  const sp = await c.req('POST', '/splits', { token: s.tok.ada, key: xk, body: { amount: 9, participant_handles: ['ada', 'bob', 'cy'] } });
  A.err(await pay(s, 'cy', 'ada', 999999, {}, fk), 409, 'insufficient_funds', 'failed key before export');
  const su = await c.req('POST', '/auth/signup', { body: { email: 'pre@ex.com', password: PASSWORD, display_name: 'Pre' } });
  const exp = await c.req('GET', '/_test/export');
  const snapshot = JSON.stringify(exp.body);
  const balBefore = await balances(c, s.tok);
  const feedBefore = await feed(s, 'bob');
  const reqsBefore = await reqs(s, 'cy');
  // later writes
  await pay(s, 'ada', 'bob', 1);
  const post = await c.req('POST', '/auth/signup', { body: { email: 'post@ex.com', password: PASSWORD, display_name: 'Post' } });
  const exp2 = await c.req('GET', '/_test/export');
  A.ok(JSON.stringify(exp.body) === snapshot, 'already-returned export unchanged');
  A.ok(JSON.stringify(exp2.body) !== snapshot, 'export reflects later writes');
  // fresh reset, then import the earlier export
  await seed(c, fixture({ users: [{ id: 'u_x', email: 'x@ex.com', password: PASSWORD, display_name: 'X', handle: 'x', balance: 1 }], payments: [], requests: [], settlement_operator_ids: [] }));
  A.st(await c.req('POST', '/_test/import', { body: exp.body }), 204, 'import');
  A.st(await c.req('POST', '/_test/import', { body: exp.body }), 204, 'import again');
  A.eq(await balances(c, s.tok), balBefore, 'balances restored, old tokens valid');
  A.eq((await feed(s, 'bob')), feedBefore, 'feed identical (ids, timestamps)');
  A.eq((await reqs(s, 'cy')), reqsBefore, 'requests identical');
  A.st(await c.req('GET', '/me', { token: su.body?.token }), 200, 'signup token from before export valid');
  A.err(await c.req('GET', '/me', { token: post.body?.token }), 401, 'unauthenticated', 'token issued after export invalid');
  A.err(await c.req('POST', '/auth/login', { body: { email: 'x@ex.com', password: PASSWORD } }), 401, 'unauthenticated', 'destination data removed');
  A.st(await c.req('POST', '/auth/login', { body: { email: 'pre@ex.com', password: PASSWORD } }), 200, 'hashed-password login preserved');
  A.st(await c.req('POST', '/auth/login', { body: { email: 'ada@example.com', password: PASSWORD } }), 200, 'seeded login preserved');
  const rp = await pay(s, 'ada', 'bob', 111, { note: 'pre', visibility: 'private' }, pk);
  A.eq([rp.status, rp.body], [200, p.body], 'payment replay after import');
  A.eq((await ask(s, 'cy', 'dan', 77, {}, rk)).body, q.body, 'request replay after import');
  const sr = await settle(s, [{ from_handle: 'dan', to_handle: 'cy', amount: 5 }], sk);
  A.eq([sr.status, sr.body], [200, st.body], 'settlement replay after import (operator kept)');
  const xr = await c.req('POST', '/splits', { token: s.tok.ada, key: xk, body: { amount: 9, participant_handles: ['ada', 'bob', 'cy'] } });
  A.eq([xr.status, xr.body], [200, sp.body], 'split replay after import');
  A.err(await pay(s, 'ada', 'bob', 112, { note: 'pre', visibility: 'private' }, pk), 409, 'idempotency_key_reuse', 'reuse after import');
  A.st(await pay(s, 'cy', 'ada', 1, {}, fk), 201, 'failed key reusable after import');
  A.eq(await balances(c, s.tok), { ...balBefore, cy: balBefore.cy - 1, ada: balBefore.ada + 1 }, 'replays moved nothing');
  const n1 = await pay(s, 'ada', 'dan', 1), n2 = await ask(s, 'ada', 'dan', 1);
  const n3 = await c.req('POST', '/auth/signup', { body: { email: 'post2@ex.com', password: PASSWORD, display_name: 'P2' } });
  const n4 = await settle(s, [{ from_handle: 'ada', to_handle: 'dan', amount: 1 }]);
  const n5 = await c.req('POST', '/splits', { token: s.tok.ada, key: newKey(), body: { amount: 2, participant_handles: ['dan'] } });
  const oldIds = new Set(JSON.stringify(exp.body).match(/"[A-Za-z0-9_\-:.]{1,64}"/g) ?? []);
  A.ok(!oldIds.has(JSON.stringify(n1.body?.payment_id)), `new payment id ${n1.body?.payment_id} collides with imported ids`);
  A.ok(!oldIds.has(JSON.stringify(n2.body?.request_id)), `new request id ${n2.body?.request_id} collides`);
  A.ok(n3.status === 201 && !oldIds.has(JSON.stringify(n3.body?.user_id)), `new user id ${n3.body?.user_id} collides`);
  A.ok(n4.status === 201 && !oldIds.has(JSON.stringify(n4.body?.settlement_id)), `new settlement id collides`);
  A.ok(n5.status === 201 && !oldIds.has(JSON.stringify(n5.body?.split_id)), `new split id collides`);
  // reset clears imported state
  await seed(c);
  A.err(await c.req('GET', '/me', { token: su.body?.token }), 401, 'unauthenticated', 'reset clears imported tokens');
});

await t('import-invalid-unchanged', ['R-33'], async (A) => {
  const s = await seed(c);
  await pay(s, 'ada', 'bob', 3);
  const good = (await c.req('GET', '/_test/export')).body;
  const before = await balances(c, s.tok);
  A.err(await c.req('POST', '/_test/import', { raw: '{"track":' }), 400, 'malformed_request', 'unparseable');
  const bads = {
    'empty object': {},
    'no state': { track: 'pocketful', format_version: 1 },
    'wrong track': { ...good, track: 'tablekeeper' },
    'wrong version': { ...good, format_version: 2 },
    'version string': { ...good, format_version: '1' },
    'state string': { ...good, state: 'x' },
    'state array': { ...good, state: [] },
    'state empty': { ...good, state: {} },
    'state null': { ...good, state: null },
  };
  for (const [name, b] of Object.entries(bads)) A.err(await c.req('POST', '/_test/import', { body: b }), 422, 'validation_failed', name);
  // A JSON array is valid JSON without the required fields: 400 (non-object body) or 422 (missing fields) are both defensible.
  const arr = await c.req('POST', '/_test/import', { raw: '[1,2]' });
  A.ok((arr.status === 400 && code(arr) === 'malformed_request') || (arr.status === 422 && code(arr) === 'validation_failed'), `array body gave ${arr.status} ${code(arr)}`);
  A.eq(await balances(c, s.tok), before, 'destination unchanged');
});

await t('import-corruption-fuzz', ['R-33', 'R-06'], async (A) => {
  const s = await seed(c);
  await pay(s, 'ada', 'bob', 3);
  await ask(s, 'bob', 'ada', 4);
  const good = (await c.req('GET', '/_test/export')).body;
  const before = await balances(c, s.tok);
  const paths = [];
  const walk = (v, p) => { paths.push(p); if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], [...p, k]); };
  walk(good.state, []);
  const r = (await import('./lib.mjs')).rng(Number(args.seed ?? 1337));
  let accepted = 0, rejected = 0;
  const acceptedList = [];
  for (let i = 0; i < 120; i++) {
    const copy = JSON.parse(JSON.stringify(good));
    const p = paths[1 + r.int(paths.length - 1)];
    let parent = copy.state;
    for (const k of p.slice(0, -1)) parent = parent[k];
    const leaf = p[p.length - 1];
    const choice = r.int(4);
    if (choice === 0) { if (Array.isArray(parent)) parent.splice(Number(leaf), 1); else delete parent[leaf]; }
    else if (choice === 1) parent[leaf] = null;
    else if (choice === 2) parent[leaf] = typeof parent[leaf] === 'number' ? -1 : 'corrupt';
    else parent[leaf] = typeof parent[leaf] === 'string' ? 12345 : [];
    const res = await c.req('POST', '/_test/import', { body: copy });
    if (res.status === 204) {
      accepted++;
      acceptedList.push(`${p.join('.')} op${choice}`);
      // Accepted state must still be serviceable without 5xx and balances must be non-negative.
      for (const tok of Object.values(s.tok)) {
        const me = await c.req('GET', '/me', { token: tok });
        if (me.status === 200) A.ok(Number.isInteger(me.body.balance) && me.body.balance >= 0, `accepted corrupted state (${p.join('.')} op ${choice}) exposes balance ${me.body.balance}`);
        await c.req('GET', '/activity', { token: tok });
        await c.req('GET', '/requests', { token: tok });
      }
      await c.req('GET', '/_test/export');
      await c.req('POST', '/_test/import', { body: good });
    } else {
      rejected++;
      A.ok(res.status === 422 && code(res) === 'validation_failed', `corrupted (${p.join('.')} op ${choice}) gave ${res.status} ${code(res)}`);
      const now = await balances(c, s.tok);
      A.eq(now, before, `destination changed by rejected import (${p.join('.')})`);
    }
  }
  console.log(`      import fuzz: ${accepted} accepted, ${rejected} rejected`);
  if (args['show-fuzz']) console.log('      accepted: ' + acceptedList.join('\n      accepted: '));
});

await t('import-into-second-instance', ['R-33'], async (A) => {
  if (!args['second-url']) { A.ok(true, 'skipped'); return; }
  const s = await seed(c);
  const key = newKey();
  const p = await pay(s, 'ada', 'bob', 42, {}, key);
  const exp = (await c.req('GET', '/_test/export')).body;
  const c2 = client(args['second-url']);
  A.st(await c2.req('POST', '/_test/import', { body: exp }), 204, 'import into another process');
  const me = await c2.req('GET', '/me', { token: s.tok.ada });
  A.eq([me.status, me.body?.balance], [200, 9958], 'token and balance work in the other process');
  const r = await c2.req('POST', '/payments', { token: s.tok.ada, key, body: { to_handle: 'bob', amount: 42 } });
  A.eq([r.status, r.body], [200, p.body], 'replay works in the other process');
  c.violations.push(...c2.violations);
});

// ---------------------------------------------------------------- invariant sweep
await t('conservation-after-suite', ['R-12'], async (A) => {
  const s = await seed(c);
  for (let i = 0; i < 20; i++) await pay(s, ['ada', 'bob', 'dan'][i % 3], ['bob', 'dan', 'cy'][i % 3], 7 + i);
  A.eq(await sumBal(s), total(s.fx), 'sum of balances equals seeded total');
});

await t('protocol-violations', ['R-05', 'R-06'], async (A) => {
  A.eq(c.violations, [], 'no 5xx, wrong content type, bad envelope, bad timestamp or long id in any response');
});

const failed = results.filter((r) => !r.passed);
const report = { kind: 'contract-checks', base, checks: results.length, passed: results.length - failed.length, failed: failed.length, requests: c.count, results };
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
console.log(`\ncontract: ${report.passed}/${report.checks} checks passed, ${report.failed} failed, ${c.count} requests`);
process.exit(failed.length ? 1 : 0);
