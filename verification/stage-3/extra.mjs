#!/usr/bin/env node
// Additional spot probes written while the mutation campaign ran (the campaign's kill
// suite was frozen, so these live in their own file). usage: node extra.mjs URL
import { client, code, fixture, seed, balances, newKey, PASSWORD } from './lib.mjs';
const c = client(process.argv[2]);
const fails = [];
let n = 0;
const expect = (label, r, status, errCode) => { n++; if (r.status !== status || (errCode && code(r) !== errCode)) fails.push(`${label}: expected ${status} ${errCode ?? ''}, got ${r.status} ${r.text?.slice(0, 160)}`); };
const ok = (label, cond) => { n++; if (!cond) fails.push(label); };

let s = await seed(c);
const su = (body) => c.req('POST', '/auth/signup', { body });
expect('signup display_name missing', await su({ email: 'dn@ex.com', password: PASSWORD }), 422, 'validation_failed');
expect('signup display_name number', await su({ email: 'dn2@ex.com', password: PASSWORD, display_name: 7 }), 400, 'malformed_request');
expect('signup password missing', await su({ email: 'dn3@ex.com', display_name: 'x' }), 422, 'validation_failed');
expect('login email case-insensitive (plan:A-04)', await c.req('POST', '/auth/login', { body: { email: 'ADA@Example.com', password: PASSWORD } }), 200);
expect('login missing password', await c.req('POST', '/auth/login', { body: { email: 'ada@example.com' } }), 422, 'validation_failed');
expect('login password number', await c.req('POST', '/auth/login', { body: { email: 'ada@example.com', password: 5 } }), 400, 'malformed_request');
expect('pay body array', await c.req('POST', '/requests/rq_1/pay', { token: s.tok.ada, key: newKey(), raw: '[]' }), 400, 'malformed_request');
expect('pay visibility number', await c.req('POST', '/requests/rq_1/pay', { token: s.tok.ada, key: newKey(), body: { visibility: 1 } }), 422, 'validation_failed');
expect('path traversal id', await c.req('POST', '/requests/%2e%2e/pay', { token: s.tok.ada, key: newKey(), body: {} }), 404, 'not_found');
expect('very long id', await c.req('POST', `/requests/${'z'.repeat(2000)}/decline`, { token: s.tok.ada }), 404, 'not_found');
expect('encoded unicode id', await c.req('POST', '/requests/%F0%9F%98%80/cancel', { token: s.tok.ada }), 404, 'not_found');
expect('bad percent-encoding id', await c.req('POST', '/requests/%E0%A4%A/cancel', { token: s.tok.ada }), 404, 'not_found');
const st = (transfers, who = 'op') => c.req('POST', '/settlements', { token: s.tok[who], key: newKey(), body: { transfers } });
expect('settlement entry amount missing', await st([{ from_handle: 'ada', to_handle: 'bob' }]), 422, 'validation_failed');
expect('settlement handle number (plan:A-07)', await st([{ from_handle: 5, to_handle: 'bob', amount: 1 }]), 422, 'validation_failed');
expect('settlement note null', await st([{ from_handle: 'ada', to_handle: 'bob', amount: 1, note: null }]), 422, 'validation_failed');
expect('settlement transfers null', await c.req('POST', '/settlements', { token: s.tok.op, key: newKey(), body: { transfers: null } }), 422, 'validation_failed');
expect('settlement operator short as party', await st([{ from_handle: 'op', to_handle: 'ada', amount: 1 }]), 409, 'insufficient_funds');
const ok1 = await c.req('POST', '/settlements', { token: s.tok.op, key: newKey(), raw: '{"transfers":[{"from_handle":"ada","to_handle":"op","amount":1e3,"note":"' + 'é'.repeat(200) + '"}]}' });
expect('settlement 1e3 + 200-char note', ok1, 201);
ok('settlement amount normalised', ok1.body?.payments?.[0]?.amount === 1000);
expect('operator settles own wallet', await st([{ from_handle: 'op', to_handle: 'ada', amount: 1000 }]), 201);
ok('operator balance back to 0', (await balances(c, s.tok)).op === 0);
expect('non-operator settlement body invalid still 403', await st([], 'ada'), 403, 'forbidden');
// operator permission does not grant access to others' requests
expect('operator cannot decline others request', await c.req('POST', '/requests/rq_1/decline', { token: s.tok.op }), 403, 'forbidden');
ok('operator sees no foreign requests', ((await c.req('GET', '/requests', { token: s.tok.op })).body?.requests ?? []).length === 0);
// fixture created_at honoured and ordering (plan:A-09)
const fx = fixture({ payments: [
  { id: 'p_old', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, note: '', visibility: 'public', created_at: '2026-01-01T10:00:00+00:00' },
  { id: 'p_new', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, note: '', visibility: 'public', created_at: '2026-02-01T10:00:00+02:00' },
] });
s = await seed(c, fx);
const f = (await c.req('GET', '/activity', { token: s.tok.cy })).body?.payments ?? [];
ok(`seeded payments newest first: ${f.map((p) => p.payment_id)}`, f[0]?.payment_id === 'p_new' && f[1]?.payment_id === 'p_old');
ok('fixture created_at preserved as an instant', Date.parse(f[0]?.created_at) === Date.parse('2026-02-01T10:00:00+02:00'));
const p = await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), body: { to_handle: 'bob', amount: 1 } });
const f2 = (await c.req('GET', '/activity', { token: s.tok.cy })).body?.payments ?? [];
ok('new payment first in feed', f2[0]?.payment_id === p.body?.payment_id);
// a fixture with a user missing a password / bad email / non-integer amount on a seeded payment
for (const [label, mut] of [
  ['user without password', (x) => { delete x.users[1].password; }],
  ['seeded payment amount 0.5', (x) => { x.payments[0].amount = 0.5; }],
  ['seeded request status bogus', (x) => { x.requests[0].status = 'bogus'; }],
  ['operator id unknown', (x) => { x.settlement_operator_ids = ['u_ghost']; }],
  ['users missing', (x) => { delete x.users; }],
  ['currency number', (x) => { x.currency = 5; }],
]) { const x = fixture(); mut(x); expect(`reset: ${label}`, await c.req('POST', '/_test/reset', { body: x }), 422, 'validation_failed'); }
expect('state intact after rejected resets', await c.req('GET', '/me', { token: s.tok.ada }), 200);
// whitespace in idempotency key and auth header case
expect('key " " is a 1-char key', await c.req('POST', '/payments', { token: s.tok.ada, key: ' x ', body: { to_handle: 'bob', amount: 1 } }), 201);
expect('lowercase bearer scheme', await c.req('GET', '/me', { headers: { authorization: `bearer ${s.tok.ada}` } }), 200);
console.log(c.violations.length ? `protocol violations: ${c.violations.join('; ')}` : 'protocol: clean');
if (c.violations.length) fails.push(...c.violations);
console.log(fails.length ? `extra: ${fails.length} of ${n} failed\n  ${fails.join('\n  ')}` : `extra: ${n}/${n} passed`);
process.exit(fails.length ? 1 : 0);
