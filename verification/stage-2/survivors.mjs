#!/usr/bin/env node
// Checks written for observable survivors of mutation campaign #1 (each names the rule it
// pins and the mutant family that showed the gap). usage: node survivors.mjs URL
import { client, code, fixture, seed, balances, newKey, deepEqual, PASSWORD } from './lib.mjs';
const c = client(process.argv[2]);
const fails = [];
let n = 0;
const expect = (label, r, status, errCode) => { n++; if (r.status !== status || (errCode && code(r) !== errCode)) fails.push(`${label}: expected ${status} ${errCode ?? ''}, got ${r.status} ${r.text?.slice(0, 160)}`); };
const ok = (label, cond) => { n++; if (!cond) fails.push(label); };

let s = await seed(c);

// §7 "same body" = same JSON value. Bodies that differ only in an (ignored) unknown field's
// name or value are still different JSON values -> 409, never a replay.
{
  const key = newKey();
  expect('first use with unknown field', await c.req('POST', '/payments', { token: s.tok.ada, key, raw: '{"to_handle":"bob","amount":5,"zz":1}' }), 201);
  expect('unknown field renamed is a different body', await c.req('POST', '/payments', { token: s.tok.ada, key, raw: '{"to_handle":"bob","amount":5,"zy":1}' }), 409, 'idempotency_key_reuse');
  expect('unknown field value changed is a different body', await c.req('POST', '/payments', { token: s.tok.ada, key, raw: '{"to_handle":"bob","amount":5,"zz":2}' }), 409, 'idempotency_key_reuse');
  expect('unknown field null vs 1e400', await c.req('POST', '/payments', { token: s.tok.ada, key, raw: '{"to_handle":"bob","amount":5,"zz":null}' }), 409, 'idempotency_key_reuse');
  expect('same unknown field = replay', await c.req('POST', '/payments', { token: s.tok.ada, key, raw: '{"zz":1,"amount":5,"to_handle":"bob"}' }), 200);
  const k2 = newKey();
  expect('first use with null extra', await c.req('POST', '/payments', { token: s.tok.ada, key: k2, raw: '{"to_handle":"bob","amount":5,"x":null}' }), 201);
  expect('null vs 1e400 are different JSON values', await c.req('POST', '/payments', { token: s.tok.ada, key: k2, raw: '{"to_handle":"bob","amount":5,"x":1e400}' }), 409, 'idempotency_key_reuse');
  const k3 = newKey();
  expect('split first use', await c.req('POST', '/splits', { token: s.tok.ada, key: k3, body: { amount: 10, participant_handles: ['bob', 'cy'] } }), 201);
  expect('array vs object with index keys differ', await c.req('POST', '/splits', { token: s.tok.ada, key: k3, body: { amount: 10, participant_handles: { 0: 'bob', 1: 'cy' } } }), 409, 'idempotency_key_reuse');
  expect('array order matters', await c.req('POST', '/splits', { token: s.tok.ada, key: k3, body: { amount: 10, participant_handles: ['cy', 'bob'] } }), 409, 'idempotency_key_reuse');
  const k4 = newKey();
  expect('nested first use', await c.req('POST', '/payments', { token: s.tok.ada, key: k4, body: { to_handle: 'bob', amount: 1, meta: { a: [1, { b: 2 }] } } }), 201);
  expect('nested change', await c.req('POST', '/payments', { token: s.tok.ada, key: k4, body: { to_handle: 'bob', amount: 1, meta: { a: [1, { b: 3 }] } } }), 409, 'idempotency_key_reuse');
  expect('string vs number', await c.req('POST', '/payments', { token: s.tok.ada, key: k4, body: { to_handle: 'bob', amount: 1, meta: { a: ['1', { b: 2 }] } } }), 409, 'idempotency_key_reuse');
  expect('nested replay reordered', await c.req('POST', '/payments', { token: s.tok.ada, key: k4, raw: '{"meta":{"a":[1,{"b":2}]},"amount":1,"to_handle":"bob"}' }), 200);
}

// §4 arithmetic range: a balance of exactly 2^53 is inside ±2^53 and must be accepted by
// reset; balances are exact integers.
{
  const fx = fixture(); fx.users[0] = { ...fx.users[0], balance: 2 ** 53 };
  expect('reset with balance 2^53', await c.req('POST', '/_test/reset', { body: fx }), 204);
  const l = await c.req('POST', '/auth/login', { body: { email: 'ada@example.com', password: PASSWORD } });
  const me = await c.req('GET', '/me', { token: l.body?.token });
  ok(`balance 2^53 exact (${me.text})`, me.text.includes('"balance":9007199254740992'));
  const p = await c.req('POST', '/payments', { token: l.body?.token, key: newKey(), body: { to_handle: 'bob', amount: 1000000000 } });
  expect('pay out of a 2^53 balance', p, 201);
  const me2 = await c.req('GET', '/me', { token: l.body?.token });
  ok(`2^53 - 1e9 exact (${me2.text})`, me2.text.includes('"balance":9007198254740992'));
  const fx2 = fixture(); fx2.users[0] = { ...fx2.users[0], balance: 2 ** 53 + 2 };
  expect('reset with balance above 2^53 rejected', await c.req('POST', '/_test/reset', { body: fx2 }), 422, 'validation_failed');
}

// §8 GET /requests and /activity: limit defaults to 50; limit=1 is valid; has_more at 50.
{
  s = await seed(c);
  for (let i = 0; i < 52; i++) await c.req('POST', '/requests', { token: s.tok.ada, key: newKey(), body: { payer_handle: 'cy', amount: 1 } });
  const d = await c.req('GET', '/requests', { token: s.tok.ada });
  ok(`default limit 50 on /requests (got ${d.body?.requests?.length}, has_more ${d.body?.has_more})`, d.body?.requests?.length === 50 && d.body?.has_more === true);
  const one = await c.req('GET', '/requests?limit=1', { token: s.tok.ada });
  ok('limit=1 on /requests', one.status === 200 && one.body?.requests?.length === 1 && one.body?.has_more === true);
  const lastPage = await c.req('GET', '/requests?offset=50', { token: s.tok.ada });
  ok('offset=50 returns the remaining 3 (52 + seeded rq_1)', lastPage.body?.requests?.length === 3 && lastPage.body?.has_more === false);
  for (let i = 0; i < 50; i++) await c.req('POST', '/payments', { token: s.tok.dan, key: newKey(), body: { to_handle: 'cy', amount: 1 } });
  const a = await c.req('GET', '/activity', { token: s.tok.cy });
  ok(`default limit 50 on /activity (got ${a.body?.payments?.length})`, a.body?.payments?.length === 50 && a.body?.has_more === true);
  const a1 = await c.req('GET', '/activity?limit=1&offset=0', { token: s.tok.cy });
  ok('limit=1 on /activity', a1.status === 200 && a1.body?.payments?.length === 1);
}

// §8 newest first by created_at, observed with distinct timestamps; created_at is the
// actual creation time (server clock), not a constant.
{
  s = await seed(c);
  const pause = () => new Promise((r) => setTimeout(r, 15));
  const made = [];
  for (let i = 0; i < 6; i++) {
    made.push((await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), body: { to_handle: 'bob', amount: 1 + i } })).body);
    await c.req('POST', '/requests', { token: s.tok.ada, key: newKey(), body: { payer_handle: 'bob', amount: 1 + i } });
    await pause();
  }
  const f = (await c.req('GET', '/activity?limit=200', { token: s.tok.cy })).body?.payments ?? [];
  ok(`activity newest first: ${f.map((p) => p.amount)}`, JSON.stringify(f.slice(0, 6).map((p) => p.payment_id)) === JSON.stringify(made.map((p) => p.payment_id).reverse()));
  const rq = (await c.req('GET', '/requests?limit=200&direction=outgoing', { token: s.tok.ada })).body?.requests ?? [];
  ok(`requests newest first: ${rq.map((q) => q.amount)}`, JSON.stringify(rq.map((q) => q.amount)) === JSON.stringify([6, 5, 4, 3, 2, 1]));
  const drift = Math.abs(Date.parse(made.at(-1).created_at) - Date.now());
  ok(`created_at is the creation time (drift ${drift} ms)`, drift < 5 * 60 * 1000);
  ok('created_at strictly increases across paced writes', made.every((p, i) => i === 0 || Date.parse(p.created_at) > Date.parse(made[i - 1].created_at)));
  // fixture order vs stated created_at: newest by created_at first, regardless of list order
  const fx = fixture({ payments: [
    { id: 'p_b', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, note: '', visibility: 'public', created_at: '2026-03-01T00:00:00+00:00' },
    { id: 'p_a', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, note: '', visibility: 'public', created_at: '2026-01-01T00:00:00+00:00' },
    { id: 'p_c', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, note: '', visibility: 'public', created_at: '2026-02-01T00:00:00+00:00' },
  ] });
  s = await seed(c, fx);
  const g = (await c.req('GET', '/activity', { token: s.tok.cy })).body?.payments ?? [];
  ok(`stated created_at order (plan:A-09): ${g.map((p) => p.payment_id)}`, JSON.stringify(g.map((p) => p.payment_id)) === '["p_b","p_c","p_a"]');
}

// §5 unparseable body: invalid UTF-8 is not valid JSON text.
{
  s = await seed(c);
  const bad = Buffer.concat([Buffer.from('{"to_handle":"bob","amount":1,"note":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
  expect('invalid UTF-8 body', await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), raw: bad }), 400, 'malformed_request');
  ok('no money moved by the rejected body', (await balances(c, s.tok)).ada === 10000);
  // plan edge-1: an empty body on /pay is {}
  const q = await c.req('POST', '/requests', { token: s.tok.bob, key: newKey(), body: { payer_handle: 'ada', amount: 3 } });
  const e = await c.req('POST', `/requests/${q.body?.request_id}/pay`, { token: s.tok.ada, key: newKey(), raw: '' });
  ok(`empty body on /pay is {} (${e.status})`, e.status === 201 && e.body?.visibility === 'public');
  expect('single space body on /pay is not empty JSON', await c.req('POST', `/requests/${q.body?.request_id}/pay`, { token: s.tok.ada, key: newKey(), raw: ' ' }), 400, 'malformed_request');
}

// §6/§10 hashed-password login after import: a wrong password is 401 even when the stored
// hash uses extreme (but well-formed) cost parameters; malformed parameters are invalid state.
{
  s = await seed(c);
  const exp = (await c.req('GET', '/_test/export')).body;
  const hashKey = Object.keys(exp.state?.users?.[0] ?? {}).find((k) => /hash/.test(k));
  if (hashKey && typeof exp.state.users[0][hashKey] === 'string' && exp.state.users[0][hashKey].startsWith('scrypt$')) {
    const withParams = (N, r, p) => { const x = JSON.parse(JSON.stringify(exp)); const parts = x.state.users[0][hashKey].split('$'); parts[1] = String(N); parts[2] = String(r); parts[3] = String(p); x.state.users[0][hashKey] = parts.join('$'); return x; };
    const heavy = withParams(1048576, 32, 1);
    const ri = await c.req('POST', '/_test/import', { body: heavy });
    if (ri.status === 204) {
      const l = await c.req('POST', '/auth/login', { body: { email: s.fx.users[0].email, password: 'definitely wrong' } });
      expect('wrong password against an extreme-cost hash', l, 401, 'unauthenticated');
    }
    for (const [label, args] of [['N not a power of two', [3, 8, 1]], ['N = 1', [1, 8, 1]], ['N too large', [2097152, 8, 1]], ['r = 0', [16384, 0, 1]], ['r too large', [16384, 33, 1]], ['p = 0', [16384, 8, 0]], ['p too large', [16384, 8, 17]]]) {
      expect(`import hash with ${label}`, await c.req('POST', '/_test/import', { body: withParams(...args) }), 422, 'validation_failed');
    }
    expect('import of the unmodified export', await c.req('POST', '/_test/import', { body: exp }), 204);
    expect('login after import', await c.req('POST', '/auth/login', { body: { email: s.fx.users[0].email, password: s.fx.users[0].password } }), 200);
  } else ok('export exposes a scrypt hash field (format-specific probe)', false);
}

// §10 import preserves currency and minor units (a JPY / BHD state stays JPY / BHD).
for (const [cur, mu] of [['JPY', 0], ['BHD', 3]]) {
  s = await seed(c, fixture({ currency: cur, minor_units: mu }));
  const p = await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), body: { to_handle: 'bob', amount: 5 } });
  const exp = (await c.req('GET', '/_test/export')).body;
  await seed(c);
  expect(`import ${cur} state`, await c.req('POST', '/_test/import', { body: exp }), 204);
  const me = await c.req('GET', '/me', { token: s.tok.ada });
  ok(`${cur} survives import (/me ${me.body?.currency}/${me.body?.minor_units})`, me.body?.currency === cur && me.body?.minor_units === mu);
  const r = await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), body: { to_handle: 'bob', amount: 1 } });
  ok(`${cur} on payments created after import`, r.body?.currency === cur);
  const rp = await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), body: { to_handle: 'bob', amount: 1 } });
  ok('new ids after import are distinct', rp.body?.payment_id !== r.body?.payment_id && r.body?.payment_id !== p.body?.payment_id);
  const f = (await c.req('GET', '/activity?limit=3', { token: s.tok.ada })).body?.payments ?? [];
  ok('post-import payments are newest in the feed', f[0]?.payment_id === rp.body?.payment_id && f[1]?.payment_id === r.body?.payment_id);
}

// §11 settlements: unknown from_handle is 404 (never a 5xx); non-string handles are a
// malformed batch (422, plan:A-07).
{
  s = await seed(c);
  const st = (transfers) => c.req('POST', '/settlements', { token: s.tok.op, key: newKey(), body: { transfers } });
  expect('unknown from_handle', await st([{ from_handle: 'ghost', to_handle: 'bob', amount: 1 }]), 404, 'not_found');
  expect('unknown from_handle in entry 2', await st([{ from_handle: 'ada', to_handle: 'bob', amount: 1 }, { from_handle: 'ghost', to_handle: 'ada', amount: 1 }]), 404, 'not_found');
  expect('to_handle number', await st([{ from_handle: 'ada', to_handle: 7, amount: 1 }]), 422, 'validation_failed');
  expect('to_handle missing', await st([{ from_handle: 'ada', amount: 1 }]), 422, 'validation_failed');
  expect('entry null', await st([null]), 422, 'validation_failed');
  expect('entry array', await st([['ada', 'bob', 1]]), 422, 'validation_failed');
  ok('nothing moved', (await balances(c, s.tok)).ada === 10000);
}

// §8 splits: a non-string participant handle is a wrong JSON type (400).
{
  s = await seed(c);
  expect('participant handle number', await c.req('POST', '/splits', { token: s.tok.ada, key: newKey(), body: { amount: 3, participant_handles: ['bob', 5] } }), 400, 'malformed_request');
  expect('participant handle null', await c.req('POST', '/splits', { token: s.tok.ada, key: newKey(), body: { amount: 3, participant_handles: [null] } }), 400, 'malformed_request');
}

// §6 email form local@domain: one-character local part and domain are valid.
{
  s = await seed(c);
  expect('signup q@z', await c.req('POST', '/auth/signup', { body: { email: 'q@z', password: PASSWORD, display_name: 'Q' } }), 201);
  expect('signup qq@zz.io', await c.req('POST', '/auth/signup', { body: { email: 'qq@zz.io', password: PASSWORD, display_name: 'Q' } }), 201);
}

// §3.3 / §4 seeded items: listed order is age order (later = newer), all before anything
// created after the reset; stated created_at values are kept for requests too.
{
  s = await seed(c, fixture({
    payments: [
      { id: 'p_1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, note: '', visibility: 'public' },
      { id: 'p_2', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 2, note: '', visibility: 'public' },
      { id: 'p_3', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 3, note: '', visibility: 'public' },
    ],
    requests: [
      { id: 'rq_1', requester_id: 'u_bob', payer_id: 'u_ada', amount: 1, note: '', status: 'pending', created_at: '2026-05-05T05:05:05+00:00' },
      { id: 'rq_2', requester_id: 'u_bob', payer_id: 'u_ada', amount: 2, note: '', status: 'declined' },
    ],
  }));
  const now0 = Date.now();
  const p = await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), body: { to_handle: 'bob', amount: 9 } });
  const f = (await c.req('GET', '/activity', { token: s.tok.cy })).body?.payments ?? [];
  ok(`new payment first, then p_3, p_2, p_1: ${f.map((x) => x.payment_id)}`, JSON.stringify(f.map((x) => x.payment_id)) === JSON.stringify([p.body?.payment_id, 'p_3', 'p_2', 'p_1']));
  ok('seeded created_at not in the future', f.slice(1).every((x) => Date.parse(x.created_at) <= now0 + 1000));
  const rq = (await c.req('GET', '/requests', { token: s.tok.ada })).body?.requests ?? [];
  const r1 = rq.find((x) => x.request_id === 'rq_1');
  ok(`stated request created_at kept (${r1?.created_at})`, r1 && Date.parse(r1.created_at) === Date.parse('2026-05-05T05:05:05+00:00'));
  ok('seeded statuses kept', rq.find((x) => x.request_id === 'rq_2')?.status === 'declined');
}

// §3.3 + plan edge-17: structurally invalid fixtures are 422 and change nothing.
{
  s = await seed(c);
  const cases = {
    'user entry not an object': (x) => { x.users.push('nobody'); },
    'empty user id': (x) => { x.users[2].id = ''; },
    'user id over 64 chars': (x) => { x.users[2].id = 'u'.repeat(65); },
    'duplicate user id (unreferenced user)': (x) => { x.users[2].id = 'u_ada'; },
    'user id number': (x) => { x.users[2].id = 7; },
    'empty email': (x) => { x.users[2].email = ''; },
    'duplicate email, other case': (x) => { x.users[2].email = 'ADA@example.com'; },
    'empty currency': (x) => { x.currency = ''; },
    'payments not an array': (x) => { x.payments = {}; },
    'requests not an array': (x) => { x.requests = 'none'; },
    'payment entry not an object': (x) => { x.payments.push(1); },
    'duplicate payment id': (x) => { x.payments.push({ ...x.payments[0] }); },
    'payment id over 64 chars': (x) => { x.payments[0].id = 'p'.repeat(65); },
    'payment id number': (x) => { x.payments[0].id = 5; },
    'payment negative amount': (x) => { x.payments[0].amount = -1; },
    'payment visibility bogus': (x) => { x.payments[0].visibility = 'friends'; },
    'payment note number': (x) => { x.payments[0].note = 5; },
    'payment created_at garbage': (x) => { x.payments[0].created_at = 'last tuesday'; },
    'request entry not an object': (x) => { x.requests.push(null); },
    'duplicate request id': (x) => { x.requests.push({ ...x.requests[0] }); },
    'empty request id': (x) => { x.requests[0].id = ''; },
    'request id number': (x) => { x.requests[0].id = 6; },
    'request id over 64 chars': (x) => { x.requests[0].id = 'r'.repeat(65); },
    'request unknown payer': (x) => { x.requests[0].payer_id = 'u_ghost'; },
    'request unknown requester': (x) => { x.requests[0].requester_id = 'u_ghost'; },
    'request negative amount': (x) => { x.requests[0].amount = -5; },
    'request fractional amount': (x) => { x.requests[0].amount = 2.5; },
  };
  for (const [label, mut] of Object.entries(cases)) {
    const x = fixture(); mut(x);
    expect(`reset: ${label}`, await c.req('POST', '/_test/reset', { body: x }), 422, 'validation_failed');
  }
  const x = fixture(); x.users[1].id = 'u'.repeat(64);
  x.payments = x.payments.map((p) => ({ ...p, from_user_id: p.from_user_id === 'u_bob' ? x.users[1].id : p.from_user_id, to_user_id: p.to_user_id === 'u_bob' ? x.users[1].id : p.to_user_id }));
  x.requests = x.requests.map((r) => ({ ...r, requester_id: r.requester_id === 'u_bob' ? x.users[1].id : r.requester_id }));
  x.settlement_operator_ids = [];
  expect('reset: 64-char user id is valid', await c.req('POST', '/_test/reset', { body: x }), 204);
  s = await seed(c);
  expect('state serves after rejected resets', await c.req('GET', '/me', { token: s.tok.ada }), 200);
}

// §10 invalid state (format-specific, from this candidate's own export output): bad ids,
// counters, minor units and field types are 422 and leave the destination unchanged.
{
  s = await seed(c);
  await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), body: { to_handle: 'bob', amount: 3 } });
  const good = (await c.req('GET', '/_test/export')).body;
  const st0 = good.state ?? {};
  const has = (k) => Object.prototype.hasOwnProperty.call(st0, k);
  const cases = [];
  if (has('minor_units')) cases.push(['minor_units 1', (t) => { t.minor_units = 1; }]);
  for (const k of ['counter', 'seq', 'last_ts']) if (has(k)) { cases.push([`${k} -1`, (t) => { t[k] = -1; }]); cases.push([`${k} string`, (t) => { t[k] = '1'; }]); }
  if (Array.isArray(st0.users)) {
    cases.push(['user id empty', (t) => { t.users[0].id = ''; }]);
    cases.push(['user id 65 chars', (t) => { t.users[0].id = 'u'.repeat(65); }]);
    cases.push(['user email number', (t) => { t.users[0].email = 5; }]);
    cases.push(['user display_name number', (t) => { t.users[0].display_name = 5; }]);
    cases.push(['user entry not object', (t) => { t.users.push(3); }]);
  }
  if (Array.isArray(st0.payments) && st0.payments.length) {
    cases.push(['payment id empty', (t) => { t.payments[0].id = ''; }]);
    cases.push(['payment id 65 chars', (t) => { t.payments[0].id = 'p'.repeat(65); }]);
    cases.push(['payment amount -1', (t) => { t.payments[0].amount = -1; }]);
    for (const k of Object.keys(st0.payments[0]).filter((k) => /request_id|settlement_id/.test(k))) cases.push([`payment ${k} number`, (t) => { t.payments[0][k] = 5; }]);
    for (const k of Object.keys(st0.payments[0]).filter((k) => /^seq$|^ts$/.test(k))) cases.push([`payment ${k} string`, (t) => { t.payments[0][k] = 'x'; }]);
  }
  for (const [label, mut] of cases) {
    const x = JSON.parse(JSON.stringify(good)); mut(x.state);
    expect(`import: ${label}`, await c.req('POST', '/_test/import', { body: x }), 422, 'validation_failed');
  }
  ok('destination unchanged after invalid imports', (await balances(c, s.tok)).ada === 9997);
}

// §10 consequences of accepting a state: for every field of the first record of every
// collection in the export, substitute a wrong-typed value. Each import must either be
// rejected (422, destination unchanged) or leave a service that still behaves: no 5xx,
// integer non-negative amounts and balances, valid timestamps, and replays that still work.
{
  s = await seed(c);
  const k1 = newKey(), k2 = newKey(), k3 = newKey(), k4 = newKey();
  const p1 = await c.req('POST', '/payments', { token: s.tok.ada, key: k1, body: { to_handle: 'bob', amount: 4 } });
  const q1 = await c.req('POST', '/requests', { token: s.tok.bob, key: k2, body: { payer_handle: 'ada', amount: 6 } });
  const sp = await c.req('POST', '/splits', { token: s.tok.dan, key: k3, body: { amount: 9, participant_handles: ['dan', 'ada', 'cy'] } });
  const se = await c.req('POST', '/settlements', { token: s.tok.op, key: k4, body: { transfers: [{ from_handle: 'dan', to_handle: 'cy', amount: 2 }] } });
  const good = (await c.req('GET', '/_test/export')).body;
  const before = await balances(c, s.tok);
  const wrong = (v) => (typeof v === 'string' ? 42 : typeof v === 'number' ? 'x' : Array.isArray(v) ? { a: 1 } : v === null ? [] : typeof v === 'object' ? 'x' : null);
  let accepted = 0, rejected = 0;
  for (const [coll, arr] of Object.entries(good.state ?? {})) {
    if (!Array.isArray(arr) || !arr.length || typeof arr[0] !== 'object' || arr[0] === null) continue;
    for (const field of Object.keys(arr[0])) {
      const x = JSON.parse(JSON.stringify(good));
      x.state[coll][0][field] = wrong(arr[0][field]);
      const r = await c.req('POST', '/_test/import', { body: x });
      if (r.status !== 204) {
        rejected++;
        expect(`import ${coll}[0].${field} wrong type`, r, 422, 'validation_failed');
        continue;
      }
      accepted++;
      const vBefore = c.violations.length;
      for (const tok of Object.values(s.tok)) {
        await c.req('GET', '/me', { token: tok });
        await c.req('GET', '/activity?limit=200', { token: tok });
        await c.req('GET', '/requests?limit=200', { token: tok });
      }
      await c.req('POST', '/payments', { token: s.tok.ada, key: k1, body: { to_handle: 'bob', amount: 4 } });
      await c.req('POST', '/requests', { token: s.tok.bob, key: k2, body: { payer_handle: 'ada', amount: 6 } });
      await c.req('POST', '/splits', { token: s.tok.dan, key: k3, body: { amount: 9, participant_handles: ['dan', 'ada', 'cy'] } });
      await c.req('POST', '/settlements', { token: s.tok.op, key: k4, body: { transfers: [{ from_handle: 'dan', to_handle: 'cy', amount: 2 }] } });
      for (const q of [q1.body, ...(sp.body?.requests ?? [])]) if (q?.request_id) await c.req('POST', `/requests/${q.request_id}/pay`, { token: s.tok[q.payer_handle], key: newKey(), body: {} });
      await c.req('POST', '/payments', { token: s.tok.cy, key: newKey(), body: { to_handle: 'ada', amount: 1 } });
      const b = await balances(c, s.tok);
      const sum = Object.values(b).reduce((a, v) => a + (Number.isSafeInteger(v) ? v : NaN), 0);
      ok(`accepted ${coll}[0].${field}=${JSON.stringify(x.state[coll][0][field])}: balances still conserve (${JSON.stringify(b)})`, sum === 17500);
      ok(`accepted ${coll}[0].${field}=${JSON.stringify(x.state[coll][0][field])}: service still well-formed (${c.violations.slice(vBefore).join('; ').slice(0, 300)})`, c.violations.length === vBefore);
      c.violations.splice(vBefore);
      await c.req('POST', '/_test/import', { body: good });
    }
  }
  console.log(`  import consequence fuzz: ${accepted} accepted, ${rejected} rejected`);
  ok('destination restored', deepEqual(await balances(c, s.tok), before));
  void p1; void se;
}

// Boundary-valid records must be accepted by reset AND survive the service's own
// export -> import: 1- and 64-character ids, zero amounts (zero-share split payments),
// a one-character currency, omitted optional fixture parts.
{
  const id64 = 'x'.repeat(64);
  const fx = {
    currency: 'X', minor_units: 0,
    users: [
      { id: 'a', email: 'a1@example.com', password: PASSWORD, display_name: 'A', handle: 'a1', balance: 100 },
      { id: id64, email: 'b1@example.com', password: PASSWORD, display_name: 'B', handle: 'b1', balance: 0 },
      { id: 'c', email: 'c1@example.com', password: PASSWORD, display_name: 'C', handle: 'c1', balance: 0 },
    ],
    payments: [
      { id: 'p', from_user_id: 'a', to_user_id: id64, amount: 0, note: '' },
      { id: 'p'.repeat(64), from_user_id: id64, to_user_id: 'a', amount: 5, note: 'n', visibility: 'private' },
    ],
    requests: [
      { id: 'r', requester_id: 'a', payer_id: id64, amount: 0, note: '' },
      { id: 'r'.repeat(64), requester_id: id64, payer_id: 'a', amount: 7, note: '', status: 'pending' },
    ],
    settlement_operator_ids: ['c'],
  };
  expect('reset with 1/64-char ids, zero amounts, defaults omitted', await c.req('POST', '/_test/reset', { body: fx }), 204);
  const ta = (await c.req('POST', '/auth/login', { body: { email: 'a1@example.com', password: PASSWORD } })).body?.token;
  const tb = (await c.req('POST', '/auth/login', { body: { email: 'b1@example.com', password: PASSWORD } })).body?.token;
  const tc = (await c.req('POST', '/auth/login', { body: { email: 'c1@example.com', password: PASSWORD } })).body?.token;
  const feedB = (await c.req('GET', '/activity', { token: tb })).body?.payments ?? [];
  ok(`seeded payment without visibility is public (${JSON.stringify(feedB.map((p) => [p.payment_id.length, p.visibility]))})`, feedB.find((p) => p.payment_id === 'p')?.visibility === 'public');
  const rqA = (await c.req('GET', '/requests', { token: ta })).body?.requests ?? [];
  ok('seeded request without status is pending', rqA.find((r) => r.request_id === 'r')?.status === 'pending');
  const z = await c.req('POST', '/requests/r/pay', { token: tb, key: newKey(), body: {} });
  ok(`pay a zero-amount seeded request (${z.status})`, z.status === 201 && z.body?.amount === 0);
  const sp = await c.req('POST', '/splits', { token: ta, key: newKey(), body: { amount: 1, participant_handles: ['a1', 'b1', 'c1'] } });
  const zr = sp.body?.requests?.find((q) => q.amount === 0);
  const zp = zr && await c.req('POST', `/requests/${zr.request_id}/pay`, { token: zr.payer_handle === 'b1' ? tb : tc, key: newKey(), body: {} });
  ok('pay a zero-share split request', zp?.status === 201);
  const st = await c.req('POST', '/settlements', { token: tc, key: newKey(), body: { transfers: [{ from_handle: 'a1', to_handle: 'b1', amount: 1 }] } });
  ok('settle', st.status === 201);
  const exp = (await c.req('GET', '/_test/export')).body;
  await seed(c);
  expect('own export with boundary ids and zero amounts imports', await c.req('POST', '/_test/import', { body: exp }), 204);
  const me = await c.req('GET', '/me', { token: tb });
  ok(`boundary state restored (${me.body?.currency}, ${me.body?.user_id?.length})`, me.status === 200 && me.body?.currency === 'X' && me.body?.minor_units === 0 && me.body?.user_id === id64);
  const noParts = { currency: 'EUR', minor_units: 2, users: [{ id: 'u_solo', email: 'solo@example.com', password: PASSWORD, display_name: 'S', handle: 'solo', balance: 1 }] };
  expect('fixture without payments, requests or operators', await c.req('POST', '/_test/reset', { body: noParts }), 204);
  const x2 = JSON.parse(JSON.stringify(exp));
  const users = x2.state?.users;
  if (Array.isArray(users) && users.length > 1) {
    users.push({ ...users[0], email: 'zz@example.com', handle: 'zz' });
    expect('import: duplicate user id with distinct email and handle', await c.req('POST', '/_test/import', { body: x2 }), 422, 'validation_failed');
  }
}

// §6 a wrong password is never accepted, even against an imported hash whose derived key
// is empty (format-specific; the import may instead reject the state).
{
  s = await seed(c);
  const exp = (await c.req('GET', '/_test/export')).body;
  const hk = Object.keys(exp.state?.users?.[0] ?? {}).find((k) => /hash/.test(k));
  if (hk && String(exp.state.users[0][hk]).startsWith('scrypt$')) {
    const x = JSON.parse(JSON.stringify(exp));
    const parts = x.state.users[0][hk].split('$'); parts[5] = '='; x.state.users[0][hk] = parts.join('$');
    const r = await c.req('POST', '/_test/import', { body: x });
    if (r.status === 204) expect('wrong password against an empty derived key', await c.req('POST', '/auth/login', { body: { email: s.fx.users[0].email, password: 'nope-nope' } }), 401, 'unauthenticated');
    else expect('empty derived key rejected as invalid state', r, 422, 'validation_failed');
  }
}

// §8 newest first: items created right after a reset are newer than every seeded item,
// however many seeded requests there are.
{
  const reqs = Array.from({ length: 600 }, (_, i) => ({ id: `rq_s${i}`, requester_id: 'u_bob', payer_id: 'u_ada', amount: 1, note: '', status: 'pending' }));
  s = await seed(c, fixture({ payments: [], requests: reqs }));
  const q = await c.req('POST', '/requests', { token: s.tok.bob, key: newKey(), body: { payer_handle: 'ada', amount: 2 } });
  const top = (await c.req('GET', '/requests?limit=2', { token: s.tok.ada })).body?.requests ?? [];
  ok(`new request newest after a request-heavy reset (${top.map((r) => r.request_id)})`, top[0]?.request_id === q.body?.request_id && top[1]?.request_id === 'rq_s599');
  ok('seeded created_at not after the new request', reqs.length && Date.parse(top[1]?.created_at) <= Date.parse(top[0]?.created_at));
}

// §7 same JSON value: key order inside objects nested in arrays does not matter.
{
  s = await seed(c);
  const key = newKey();
  const a = await c.req('POST', '/settlements', { token: s.tok.op, key, raw: '{"transfers":[{"from_handle":"ada","to_handle":"bob","amount":3,"note":"x"}]}' });
  const b = await c.req('POST', '/settlements', { token: s.tok.op, key, raw: '{"transfers":[{"note":"x","amount":3,"to_handle":"bob","from_handle":"ada"}]}' });
  ok(`nested reorder is a replay (${a.status}, ${b.status})`, a.status === 201 && b.status === 200 && JSON.stringify(a.body) === JSON.stringify(b.body));
}

s = await seed(c);
console.log(c.violations.length ? `protocol violations: ${c.violations.join('; ')}` : 'protocol: clean');
if (c.violations.length) fails.push(...c.violations);
console.log(fails.length ? `survivors: ${fails.length} of ${n} failed\n  ${fails.join('\n  ')}` : `survivors: ${n}/${n} passed`);
process.exit(fails.length ? 1 : 0);
