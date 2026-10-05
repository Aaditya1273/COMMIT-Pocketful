#!/usr/bin/env node
// Stage-3 contract checks: payment timestamps, as_of, statements, revisions, corrections,
// known_at, snapshots, linked payments, historical holds. Written from
// pocketful/spec/stage-3.md (planner decisions tagged plan:A3-nn).
// usage: node ledger-contract.mjs --base-url URL [--out report.json] [--only substr]
import { writeFileSync } from 'node:fs';
import { client, code, fixture, seed, newKey, deepEqual } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : a), []));
const c = client(args['base-url']);
const results = [];
async function t(id, reqs, fn) {
  if (args.only && !id.includes(args.only)) return;
  const fails = [];
  const A = {
    eq(a, e, l) { if (!deepEqual(a, e)) fails.push(`${l}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)?.slice(0, 400)}`); },
    ok(cond, l) { if (!cond) fails.push(l); },
    err(r, s, cd, l) { if (r.status !== s || code(r) !== cd) fails.push(`${l}: expected ${s} ${cd}, got ${r.status} ${r.text?.slice(0, 200)}`); },
    st(r, s, l) { if (r.status !== s) fails.push(`${l}: expected ${s}, got ${r.status} ${r.text?.slice(0, 200)}`); },
  };
  try { await fn(A); } catch (e) { fails.push(`exception: ${e?.stack ?? e}`); }
  results.push({ id, requirements: reqs, passed: !fails.length, failures: fails });
  console.log(`${fails.length ? 'FAIL' : 'ok  '} ${id}${fails.length ? '\n      ' + fails.join('\n      ') : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoAt = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const q = (v) => encodeURIComponent(v);
const HOUR = 3600e3, DAY = 24 * HOUR;
const T0 = Date.now();
const me = async (s, h, query = '') => c.req('GET', '/me' + query, { token: s.tok[h] });
const stmt = async (s, h, query = '') => c.req('GET', '/statement' + query, { token: s.tok[h] });
const pay = (s, f, to, amount, extra = {}) => c.req('POST', '/payments', { token: s.tok[f], key: newKey(), body: { to_handle: to, amount, ...extra } });
const correct = (s, who, pid, body, key = newKey('corr')) => c.req('POST', `/payments/${pid}/corrections`, { token: s.tok[who], key, body });
const revs = (s, who, pid) => c.req('GET', `/payments/${pid}/revisions`, { token: s.tok[who] });
const allEntries = async (s, h, query = '') => {
  const first = await stmt(s, h, query + (query ? '&' : '?') + 'limit=200');
  return first.body;
};

// Fixture with seeded payments at known past instants. Ending balances are post-payment.
// ada opening 10000: p_a1 ada->bob 1000 at T0-3d, p_a2 bob->ada 300 at T0-2d, p_a3 ada->cy 200 at T0-1d.
// ada end = 10000 - 1000 + 300 - 200 = 9100; bob opening 2000 -> 2000 + 1000 - 300 = 2700; cy opening 0 -> 200.
const D3 = isoAt(T0 - 3 * DAY), D2 = isoAt(T0 - 2 * DAY), D1 = isoAt(T0 - DAY);
function ledgerFixture() {
  return fixture({
    users: [
      { id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada', handle: 'ada', balance: 9100 },
      { id: 'u_bob', email: 'bob@example.com', password: 'correct horse', display_name: 'Bob', handle: 'bob', balance: 2700 },
      { id: 'u_cy', email: 'cy@example.com', password: 'correct horse', display_name: 'Cy', handle: 'cy', balance: 200 },
      { id: 'u_dan', email: 'dan@example.com', password: 'correct horse', display_name: 'Dan', handle: 'dan', balance: 5000 },
      { id: 'u_op', email: 'op@example.com', password: 'correct horse', display_name: 'Op', handle: 'op', balance: 0 },
    ],
    payments: [
      { id: 'p_a1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1000, note: 'rent', visibility: 'public', created_at: D3 },
      { id: 'p_a2', from_user_id: 'u_bob', to_user_id: 'u_ada', amount: 300, note: '', visibility: 'private', created_at: D2 },
      { id: 'p_a3', from_user_id: 'u_ada', to_user_id: 'u_cy', amount: 200, note: '', visibility: 'public', created_at: D1 },
    ],
    requests: [],
  });
}

await t('seeded-timestamps-and-future-422', ['R3-01', 'R3-02'], async (A) => {
  const s = await seed(c, ledgerFixture());
  A.eq((await me(s, 'ada')).body?.balance, 9100, 'loading seeded payments keeps the seeded balance');
  const f = (await c.req('GET', '/activity?limit=200', { token: s.tok.ada })).body?.payments ?? [];
  A.eq(Date.parse(f.find((p) => p.payment_id === 'p_a1')?.created_at), Date.parse(D3), 'seeded created_at kept');
  A.eq(f.map((p) => p.payment_id), ['p_a3', 'p_a2', 'p_a1'], 'activity ordered by created_at');
  const bad = ledgerFixture(); bad.payments[0].created_at = isoAt(Date.now() + HOUR);
  A.err(await c.req('POST', '/_test/reset', { body: bad }), 422, 'validation_failed', 'future seeded created_at');
  A.eq((await me(s, 'ada')).body?.balance, 9100, 'state unchanged');
  const omit = ledgerFixture(); delete omit.payments[2].created_at;
  const s2 = await seed(c, omit);
  const p = await pay(s2, 'ada', 'dan', 1);
  const f2 = (await c.req('GET', '/activity?limit=200', { token: s2.tok.ada })).body.payments;
  const seeded = f2.find((x) => x.payment_id === 'p_a3');
  A.ok(Date.parse(seeded.created_at) <= Date.parse(p.body.created_at) && Math.abs(Date.parse(seeded.created_at) - Date.now()) < 60e3, 'omitted created_at = reset time, before later API payments');
});

await t('me-as-of', ['R3-03', 'plan:edge-1', 'plan:edge-7'], async (A) => {
  const s = await seed(c, ledgerFixture());
  const cases = [[T0 - 4 * DAY, 10000], [T0 - 3 * DAY, 9000], [T0 - 3 * DAY - 1, 10000], [T0 - 2 * DAY, 9300], [T0 - DAY + 1, 9100], [T0 + DAY, 9100]];
  for (const [ms, want] of cases) {
    const r = await me(s, 'ada', `?as_of=${q(isoAt(ms))}`);
    A.eq([r.status, r.body?.balance, r.body?.total], [200, want, want], `as_of ${isoAt(ms)}`);
  }
  const raw = '2026-01-01T05:30:00.000+05:30';
  const r1 = await me(s, 'ada', `?as_of=${q(raw)}`);
  A.eq(r1.body?.as_of, raw, 'as_of echoed exactly');
  const rz = await me(s, 'ada', `?as_of=${q(isoAt(T0).replace('+00:00', 'Z'))}`);
  A.eq([rz.status, rz.body?.as_of], [200, isoAt(T0).replace('+00:00', 'Z')], 'Z accepted and echoed');
  const plus = await me(s, 'bob', `?as_of=${isoAt(T0 - 2 * DAY).replace('+00:00', '%2B00:00')}`);
  A.eq(plus.body?.balance, 2700, 'bob at D2 inclusive: 2000 + 1000 - 300');
  const bobOpen = await me(s, 'bob', `?as_of=${q(isoAt(T0 - 5 * DAY))}`);
  A.eq(bobOpen.body?.balance, 2000, 'bob opening balance');
  for (const bad of ['', '2026-09-24', '2026-09-24T10:00:00', '2026-02-30T10:00:00+00:00', 'yesterday', '2026-09-24T25:00:00Z']) {
    A.err(await me(s, 'ada', `?as_of=${q(bad)}`), 422, 'validation_failed', `as_of ${JSON.stringify(bad)}`);
  }
  for (const good of ['2024-02-29T12:00:00+00:00', '2026-01-01T00:00:00+23:59', '2026-01-01T00:00:00-23:59', '2026-01-01T00:00:00.123456Z']) {
    const r = await me(s, 'ada', `?as_of=${q(good)}`);
    A.eq([r.status, r.body?.as_of], [200, good], `valid RFC 3339 instant ${good}`);
  }
  for (const bad of ['2025-02-29T12:00:00+00:00', '2026-01-01T00:00:00+24:00', '2026-01-01T00:00:00+05:60']) A.err(await me(s, 'ada', `?as_of=${q(bad)}`), 422, 'validation_failed', `invalid instant ${bad}`);
  const plain = (await me(s, 'ada')).body;
  A.ok(!('as_of' in plain) || plain.as_of === undefined, 'no temporal params: no as_of field required');
  A.eq([plain.balance, plain.total, plain.available, plain.held], [9100, 9100, 9100, 0], 'plain /me unchanged');
});

await t('statement-window-order-balances-paging', ['R3-04', 'plan:A3-04', 'plan:A3-09'], async (A) => {
  const s = await seed(c, ledgerFixture());
  const full = await allEntries(s, 'ada');
  A.eq(full?.entries?.map((e) => e.payment.payment_id), ['p_a1', 'p_a2', 'p_a3'], 'oldest first, caller payments only');
  A.eq([full?.opening_balance, full?.closing_balance], [10000, 9100], 'opening and closing');
  A.eq(full?.entries?.map((e) => [e.delta, e.balance_after]), [[-1000, 9000], [300, 9300], [-200, 9100]], 'deltas and balance_after');
  const e0 = full?.entries?.[0];
  A.ok(e0 && e0.revision === 1 && Date.parse(e0.effective_at) === Date.parse(D3) && Date.parse(e0.recorded_at) === Date.parse(D3), 'revision fields');
  A.ok(typeof full?.snapshot === 'string' && full.snapshot.length > 0, 'snapshot token');
  const w = await stmt(s, 'ada', `?from=${q(D2)}&to=${q(D1)}`);
  A.eq([w.body?.opening_balance, w.body?.entries?.map((e) => e.payment.payment_id), w.body?.closing_balance], [9000, ['p_a2'], 9300], 'half-open [from, to): from included, to excluded');
  const empty = await stmt(s, 'ada', `?from=${q(D2)}&to=${q(D2)}`);
  A.eq([empty.status, empty.body?.entries, empty.body?.opening_balance, empty.body?.closing_balance], [200, [], 9000, 9000], 'from == to empty');
  A.err(await stmt(s, 'ada', `?from=${q(D1)}&to=${q(D2)}`), 422, 'validation_failed', 'from > to (plan:A3-04)');
  A.err(await stmt(s, 'ada', `?from=${q('2026-09-24')}`), 422, 'validation_failed', 'bare date from');
  A.err(await stmt(s, 'ada', '?to='), 422, 'validation_failed', 'empty to');
  A.err(await stmt(s, 'ada', '?limit=0'), 422, 'validation_failed', 'limit 0');
  A.err(await stmt(s, 'ada', '?offset=-1'), 422, 'validation_failed', 'offset -1');
  A.err(await c.req('GET', '/statement'), 401, 'unauthenticated', 'no token');
  // pagination
  for (let i = 0; i < 5; i++) await pay(s, 'ada', 'dan', 10 + i);
  const pg1 = await stmt(s, 'ada', '?limit=3');
  const pg2 = await stmt(s, 'ada', '?limit=3&offset=3');
  const pg3 = await stmt(s, 'ada', '?limit=3&offset=6');
  const pg4 = await stmt(s, 'ada', '?limit=3&offset=30');
  const all = await allEntries(s, 'ada');
  A.eq([pg1.body?.has_more, pg2.body?.has_more, pg3.body?.has_more, pg4.body?.has_more, pg4.body?.entries?.length], [true, true, false, false, 0], 'has_more incl. partial last page and beyond end');
  A.eq([...pg1.body.entries, ...pg2.body.entries, ...pg3.body.entries].map((e) => [e.payment.payment_id, e.balance_after]), all.entries.map((e) => [e.payment.payment_id, e.balance_after]), 'pages keep balance_after');
  A.ok([pg1, pg2, pg3, pg4].every((p) => p.body.opening_balance === all.opening_balance && p.body.closing_balance === all.closing_balance), 'pages keep opening/closing');
  A.eq(all.opening_balance + all.entries.reduce((x, e) => x + e.delta, 0), all.closing_balance, 'opening + deltas = closing');
  A.eq(all.closing_balance, (await me(s, 'ada')).body.balance, 'default to = now: closing = current balance');
  // other people's public payments are excluded
  await pay(s, 'dan', 'bob', 5);
  A.ok(!(await allEntries(s, 'ada')).entries.some((e) => e.payment.from_handle === 'dan' && e.payment.to_handle === 'bob'), 'public payment between others not in statement');
});

await t('statement-same-instant-tie-by-id', ['R3-04', 'plan:A3-09'], async (A) => {
  const s = await seed(c, ledgerFixture());
  const st = await c.req('POST', '/settlements', { token: s.tok.op, key: newKey(), body: { transfers: [{ from_handle: 'dan', to_handle: 'ada', amount: 7 }, { from_handle: 'dan', to_handle: 'ada', amount: 9 }, { from_handle: 'ada', to_handle: 'cy', amount: 3 }] } });
  A.st(st, 201, 'settlement');
  const ids = st.body.payments.map((p) => p.payment_id);
  const es = (await allEntries(s, 'ada')).entries.filter((e) => ids.includes(e.payment.payment_id));
  A.eq(es.map((e) => e.payment.payment_id), [...ids].sort(), 'equal effective times ordered by payment id ascending');
  A.ok(es.every((e) => e.effective_at === es[0].effective_at && Date.parse(e.effective_at) === Date.parse(st.body.committed_at)), 'members use committed_at');
});

await t('corrections-shape-money-revisions', ['R3-05', 'R3-06', 'R3-07', 'R3-08'], async (A) => {
  const s = await seed(c, ledgerFixture());
  const p = (await pay(s, 'ada', 'bob', 500, { note: 'orig', visibility: 'private' })).body;
  const key = newKey();
  const body = { expected_revision: 1, amount: 400, effective_at: p.created_at, reason: 'corrected amount' };
  const r = await correct(s, 'ada', p.payment_id, body, key);
  A.st(r, 201, 'correction');
  A.eq(Object.keys(r.body ?? {}).sort(), ['amount', 'effective_at', 'payment_id', 'reason', 'recorded_at', 'revision'].sort(), 'correction fields');
  A.eq([r.body?.payment_id, r.body?.revision, r.body?.amount, r.body?.reason], [p.payment_id, 2, 400, 'corrected amount'], 'values');
  A.ok(Date.parse(r.body?.recorded_at) > Date.parse(p.created_at), 'recorded_at after revision 1');
  A.eq([(await me(s, 'ada')).body.balance, (await me(s, 'bob')).body.balance], [8700, 3100], 'decrease credits the sender back (9100-500+100, 2700+500-100)');
  const up = await correct(s, 'ada', p.payment_id, { expected_revision: 2, amount: 900, effective_at: p.created_at, reason: 'up' });
  A.st(up, 201, 'increase');
  A.eq([(await me(s, 'ada')).body.balance, (await me(s, 'bob')).body.balance], [8200, 3600], 'increase debits the sender');
  const rep = await correct(s, 'ada', p.payment_id, body, key);
  A.eq([rep.status, rep.body], [200, r.body], 'replay returns the original revision after newer ones');
  A.err(await correct(s, 'ada', p.payment_id, { ...body, reason: 'other' }, key), 409, 'idempotency_key_reuse', 'different body same key');
  A.err(await correct(s, 'ada', p.payment_id, { expected_revision: 1, amount: 1, effective_at: p.created_at, reason: 'stale' }), 409, 'stale_revision', 'stale');
  const rv = await revs(s, 'bob', p.payment_id);
  A.eq(rv.body?.revisions?.map((x) => [x.revision, x.amount, x.reason]), [[1, 500, ''], [2, 400, 'corrected amount'], [3, 900, 'up']], 'revision list incl. revision 1');
  const rts = rv.body.revisions.map((x) => Date.parse(x.recorded_at));
  A.ok(rts.every((x, i) => i === 0 || x > rts[i - 1]), 'recorded_at strictly increasing');
  A.eq([Date.parse(rv.body.revisions[0].effective_at), Date.parse(rv.body.revisions[0].recorded_at)], [Date.parse(p.created_at), Date.parse(p.created_at)], 'revision 1 = created_at');
  A.err(await revs(s, 'cy', p.payment_id), 404, 'not_found', 'third party 404');
  A.err(await revs(s, 'cy', 'p_a1'), 404, 'not_found', 'third party 404 even for public');
  A.err(await c.req('GET', `/payments/${p.payment_id}/revisions`), 401, 'unauthenticated', 'no token 401');
  A.err(await revs(s, 'ada', 'nope'), 404, 'not_found', 'unknown');
  const feed = (await c.req('GET', '/activity?limit=200', { token: s.tok.bob })).body.payments;
  A.eq(feed.find((x) => x.payment_id === p.payment_id), p, 'feed shows the original payment unchanged');
  A.eq(feed.length, 4, 'corrections are not feed payments');
  const e = (await allEntries(s, 'ada')).entries.find((x) => x.payment.payment_id === p.payment_id);
  A.eq([e?.payment?.amount, e?.delta, e?.revision], [900, -900, 3], 'statement uses the selected (latest) amount once');
  const zero = await correct(s, 'ada', p.payment_id, { expected_revision: 3, amount: 0, effective_at: p.created_at, reason: 'reverse' });
  A.st(zero, 201, 'amount 0 reverses');
  const ez = (await allEntries(s, 'ada')).entries.find((x) => x.payment.payment_id === p.payment_id);
  A.eq([ez?.delta, ez?.payment?.amount], [0, 0], 'zero-amount revision stays as a zero delta');
  A.eq([(await me(s, 'ada')).body.balance, (await me(s, 'bob')).body.balance], [9100, 2700], 'fully reversed');
  let sum = 0; for (const h of Object.keys(s.tok)) sum += (await me(s, h)).body.balance;
  A.eq(sum, 17000, 'conservation');
});

await t('correction-validation-precedence', ['R3-06', 'R3-12', 'plan:A3-02', 'plan:A3-03'], async (A) => {
  const s = await seed(c, ledgerFixture());
  const p = (await pay(s, 'ada', 'bob', 500)).body;
  const ok = { expected_revision: 1, amount: 400, effective_at: p.created_at, reason: 'r' };
  A.err(await correct(s, 'bob', p.payment_id, ok), 403, 'forbidden', 'receiver');
  A.err(await correct(s, 'cy', p.payment_id, ok), 403, 'forbidden', 'third party');
  A.err(await correct(s, 'ada', 'p_nope', ok), 404, 'not_found', 'unknown payment');
  A.err(await c.req('POST', `/payments/${p.payment_id}/corrections`, { token: s.tok.ada, body: ok }), 400, 'missing_idempotency_key', 'key required');
  A.err(await c.req('POST', `/payments/${p.payment_id}/corrections`, { key: newKey(), body: ok }), 401, 'unauthenticated', 'token required');
  const bads = {
    'missing expected_revision': { amount: 1, effective_at: p.created_at, reason: 'r' },
    'revision 0': { ...ok, expected_revision: 0 }, 'revision 1.5': { ...ok, expected_revision: 1.5 }, 'revision "1"': { ...ok, expected_revision: '1' },
    'missing amount': { expected_revision: 1, effective_at: p.created_at, reason: 'r' },
    'amount -1': { ...ok, amount: -1 }, 'amount 1000000001': { ...ok, amount: 1000000001 }, 'amount 1.5': { ...ok, amount: 1.5 }, 'amount "4"': { ...ok, amount: '4' },
    'missing reason': { expected_revision: 1, amount: 1, effective_at: p.created_at }, 'empty reason': { ...ok, reason: '' }, 'reason 201': { ...ok, reason: 'x'.repeat(201) },
    'missing effective_at': { expected_revision: 1, amount: 1, reason: 'r' }, 'future effective_at': { ...ok, effective_at: isoAt(Date.now() + HOUR) },
    'naive effective_at': { ...ok, effective_at: '2026-09-20T12:00:00' }, 'bare date': { ...ok, effective_at: '2026-09-20' },
  };
  for (const [l, b] of Object.entries(bads)) A.err(await correct(s, 'ada', p.payment_id, b), 422, 'validation_failed', l);
  A.st(await correct(s, 'ada', p.payment_id, { ...ok, reason: 'x'.repeat(200), amount: 1000000000 > 9100 ? 500 : 500 }), 201, '200-char reason, same amount');
  const st = await c.req('POST', '/settlements', { token: s.tok.op, key: newKey(), body: { transfers: [{ from_handle: 'dan', to_handle: 'cy', amount: 5 }] } });
  A.err(await correct(s, 'dan', st.body.payments[0].payment_id, { ...ok, expected_revision: 1, amount: 4 }), 422, 'linked_payment_immutable', 'settlement member');
  A.err(await correct(s, 'dan', st.body.payments[0].payment_id, { ...ok, expected_revision: 9, amount: 4 }), 422, 'linked_payment_immutable', 'linked before stale (plan:A3-02)');
  const au = (await c.req('POST', '/authorizations', { token: s.tok.dan, key: newKey(), body: { to_handle: 'cy', amount: 50 } })).body;
  const cap = (await c.req('POST', `/authorizations/${au.authorization_id}/capture`, { token: s.tok.cy, key: newKey(), body: {} })).body;
  A.err(await correct(s, 'dan', cap.payment_id, { ...ok, amount: 10 }), 422, 'linked_payment_immutable', 'capture');
  const rq = (await c.req('POST', '/requests', { token: s.tok.cy, key: newKey(), body: { payer_handle: 'dan', amount: 20 } })).body;
  const rp = (await c.req('POST', `/requests/${rq.request_id}/pay`, { token: s.tok.dan, key: newKey(), body: {} })).body;
  A.st(await correct(s, 'dan', rp.payment_id, { expected_revision: 1, amount: 15, effective_at: rp.created_at, reason: 'r' }), 201, 'request-paid payment correctable (plan:A3-03)');
  const k = newKey();
  A.err(await correct(s, 'ada', p.payment_id, { ...ok, expected_revision: 2, amount: 999999 }, k), 409, 'insufficient_funds', 'unaffordable increase');
  A.st(await correct(s, 'ada', p.payment_id, { ...ok, expected_revision: 2, amount: 600 }, k), 201, 'failed key reusable');
});

await t('historical-overdraft-and-insufficient', ['R3-07', 'plan:edge-5', 'plan:edge-6'], async (A) => {
  const s = await seed(c, ledgerFixture());
  // cy: 200 now. ada pays cy 100, then cy pays dan 300 (cy at 0). Decreasing ada->cy to 0 now
  // is unaffordable for cy (debit 100 > available 0) -> insufficient_funds.
  const p = (await pay(s, 'ada', 'cy', 100)).body;
  await sleep(5);
  A.st(await pay(s, 'cy', 'dan', 300), 201, 'cy spends everything');
  A.err(await correct(s, 'ada', p.payment_id, { expected_revision: 1, amount: 0, effective_at: p.created_at, reason: 'r' }), 409, 'insufficient_funds', 'receiver short now');
  await pay(s, 'dan', 'cy', 100);
  // Now cy has 100 again, but at the instant after cy->dan 300 cy was at 0: removing 100
  // effective at p.created_at would make cy -100 at that past boundary.
  const before = [(await me(s, 'cy')).body.balance, (await me(s, 'ada')).body.balance];
  const k = newKey();
  A.err(await correct(s, 'ada', p.payment_id, { expected_revision: 1, amount: 0, effective_at: p.created_at, reason: 'r' }, k), 409, 'historical_overdraft', 'affordable now, negative in the past');
  A.eq([(await me(s, 'cy')).body.balance, (await me(s, 'ada')).body.balance], before, 'nothing changed');
  A.eq((await revs(s, 'ada', p.payment_id)).body.revisions.length, 1, 'no revision appended');
  // (Moving the effective time to now would also drop the original credit from cy's past and dip cy below zero.)
  A.st(await correct(s, 'ada', p.payment_id, { expected_revision: 1, amount: 100, effective_at: p.created_at, reason: 'no-op' }, k), 201, 'same key after a failure is a first use');
  // increase backdated before the sender had the money -> historical overdraft
  const s2 = await seed(c, ledgerFixture());
  const pp = (await pay(s2, 'cy', 'bob', 200)).body; // cy -> 0
  await sleep(5);
  await pay(s2, 'dan', 'cy', 1000);
  A.err(await correct(s2, 'cy', pp.payment_id, { expected_revision: 1, amount: 500, effective_at: pp.created_at, reason: 'r' }), 409, 'historical_overdraft', 'backdated increase overdraws the sender in the past');
  A.err(await correct(s2, 'cy', 'p_a3', { expected_revision: 1, amount: 1, effective_at: D1, reason: 'r' }), 403, 'forbidden', 'cy is not the sender of p_a3');
  // same-instant boundary: bob receives and sends at the same committed_at; combined effect counts
  const s3 = await seed(c, ledgerFixture());
  const st = await c.req('POST', '/settlements', { token: s3.tok.op, key: newKey(), body: { transfers: [{ from_handle: 'dan', to_handle: 'cy', amount: 500 }, { from_handle: 'cy', to_handle: 'bob', amount: 700 }] } });
  A.st(st, 201, 'net-affordable at one instant');
  const pc = (await pay(s3, 'ada', 'cy', 50)).body;
  A.st(await correct(s3, 'ada', pc.payment_id, { expected_revision: 1, amount: 50, effective_at: st.body.committed_at, reason: 'move to the settlement instant' }), 201, 'boundary combines same-instant movements');
  let sum = 0; for (const h of Object.keys(s3.tok)) sum += (await me(s3, h)).body.balance;
  A.eq(sum, 17000, 'conservation');
});

await t('backdated-correction-moves-window-and-as-of', ['R3-07', 'R3-09', 'plan:edge-2'], async (A) => {
  const s = await seed(c, ledgerFixture());
  const p = (await pay(s, 'ada', 'dan', 400)).body;
  const tBefore = isoAt(Date.now());
  const r = await correct(s, 'ada', p.payment_id, { expected_revision: 1, amount: 400, effective_at: isoAt(T0 - 2.5 * DAY), reason: 'it was earlier' });
  A.st(r, 201, 'backdate');
  const w = await stmt(s, 'ada', `?from=${q(D3)}&to=${q(D2)}`);
  A.ok(w.body.entries.some((e) => e.payment.payment_id === p.payment_id && e.revision === 2), 'moved into the earlier window');
  A.eq(w.body.entries.map((e) => e.payment.payment_id), ['p_a1', p.payment_id], 'ordered by selected effective_at');
  A.eq((await me(s, 'ada', `?as_of=${q(isoAt(T0 - 2.4 * DAY))}`)).body.balance, 10000 - 1000 - 400, 'as_of follows effective time');
  A.eq((await me(s, 'ada', `?as_of=${q(isoAt(T0 - 2.4 * DAY))}&known_at=${q(tBefore)}`)).body.balance, 9000, 'known before the correction: the payment was not yet effective then');
  A.eq((await me(s, 'ada', `?known_at=${q(D2)}`)).body.balance, 9300, 'known_at D2: later payments not yet recorded contribute nothing');
  A.eq((await me(s, 'ada', `?known_at=${q(isoAt(T0 - 10 * DAY))}`)).body.balance, 10000, 'known_at before everything: opening balance');
  const kat = isoAt(Date.now() + DAY);
  A.eq((await me(s, 'ada', `?known_at=${q(kat)}`)).body.known_at, kat, 'known_at echoed; future allowed');
  A.err(await me(s, 'ada', '?known_at='), 422, 'validation_failed', 'empty known_at');
  A.err(await stmt(s, 'ada', `?known_at=${q('2026-09-24T10:00:00')}`), 422, 'validation_failed', 'naive known_at');
  const ks = await stmt(s, 'ada', `?known_at=${q(tBefore)}&limit=200`);
  const ke = ks.body.entries.find((e) => e.payment.payment_id === p.payment_id);
  A.eq([ke?.revision, Date.parse(ke?.effective_at)], [1, Date.parse(p.created_at)], 'known_at selects the older revision');
  A.eq(ks.body.known_at, tBefore, 'statement echoes known_at');
  let sum = 0;
  for (const h of Object.keys(s.tok)) sum += (await me(s, h, `?as_of=${q(isoAt(T0 - 2.4 * DAY))}&known_at=${q(tBefore)}`)).body.balance;
  A.eq(sum, 17000, 'sum = seeded total in a historical view');
});

await t('snapshots', ['R3-10', 'plan:edge-9'], async (A) => {
  const s = await seed(c, ledgerFixture());
  const p = (await pay(s, 'ada', 'bob', 100)).body;
  const first = await stmt(s, 'ada', '?limit=2');
  const snap = first.body.snapshot;
  const frozen = (await stmt(s, 'ada', `?snapshot=${q(snap)}&limit=200`)).body;
  await pay(s, 'ada', 'cy', 50);
  await correct(s, 'ada', p.payment_id, { expected_revision: 1, amount: 10, effective_at: p.created_at, reason: 'r' });
  await c.req('POST', '/authorizations', { token: s.tok.ada, key: newKey(), body: { to_handle: 'bob', amount: 10 } });
  const again = (await stmt(s, 'ada', `?snapshot=${q(snap)}&limit=200`)).body;
  A.eq([again.entries, again.opening_balance, again.closing_balance], [frozen.entries, frozen.opening_balance, frozen.closing_balance], 'snapshot frozen across payment, correction and hold');
  A.eq(frozen.entries.length, 4, 'frozen result has the 4 entries of the first read');
  const pg = await stmt(s, 'ada', `?snapshot=${q(snap)}&limit=3&offset=3`);
  A.eq([pg.body.entries.length, pg.body.has_more, pg.body.entries[0]?.balance_after], [1, false, frozen.entries[3].balance_after], 'snapshot paging');
  A.eq((await stmt(s, 'ada', `?snapshot=${q(snap)}&offset=99`)).body.has_more, false, 'beyond end');
  for (const extra of [`from=${q(D3)}`, `to=${q(D1)}`, `known_at=${q(D1)}`]) A.err(await stmt(s, 'ada', `?snapshot=${q(snap)}&${extra}`), 422, 'validation_failed', `snapshot + ${extra.split('=')[0]}`);
  A.st(await stmt(s, 'ada', `?snapshot=${q(snap)}&bogus=1`), 200, 'unknown params still ignored');
  A.err(await stmt(s, 'bob', `?snapshot=${q(snap)}`), 404, 'not_found', 'another user\'s snapshot');
  A.err(await stmt(s, 'ada', '?snapshot=nope'), 404, 'not_found', 'unknown snapshot');
  const live = (await allEntries(s, 'ada'));
  A.ok(live.entries.length === 5 && live.closing_balance !== frozen.closing_balance, 'a fresh read sees the new state');
  await seed(c, ledgerFixture());
  const s2 = await seed(c, ledgerFixture());
  A.err(await stmt(s2, 'ada', `?snapshot=${q(snap)}`), 404, 'not_found', 'snapshot from before reset');
});

await t('historical-holds', ['R3-14', 'R3-15'], async (A) => {
  const s = await seed(c, { ...ledgerFixture(), authorization_ttl_seconds: 3 });
  const tA = Date.now();
  const a = (await c.req('POST', '/authorizations', { token: s.tok.ada, key: newKey(), body: { to_handle: 'bob', amount: 3000 } })).body;
  A.eq(a.closed_at, null, 'closed_at null while open');
  await sleep(20);
  const cap = (await c.req('POST', `/authorizations/${a.authorization_id}/capture`, { token: s.tok.bob, key: newKey(), body: { amount: 1000, final: false } })).body;
  const tCap = Date.parse(cap.created_at);
  const v = (k, extra = '') => me(s, 'ada', `?as_of=${q(isoAt(k))}${extra}`);
  const view = async (ms, extra = '') => { const b = (await v(ms, extra)).body; return [b.balance, b.total, b.available, b.held]; };
  A.eq(await view(tA - 1000), [9100, 9100, 9100, 0], 'before the hold');
  A.eq(await view(Date.parse(a.created_at)), [9100, 9100, 6100, 3000], 'at creation the hold counts');
  A.eq(await view(tCap), [8100, 8100, 6100, 2000], 'at the non-final capture: total down, held reduced');
  A.eq(await view(tCap, `&known_at=${q(isoAt(tCap - 1))}`), [9100, 9100, 6100, 3000], 'capture not yet known');
  A.eq(await view(Date.parse(a.expires_at) + 1000), [8100, 8100, 8100, 0], 'future as_of beyond the deadline: expired');
  A.eq(await view(Date.parse(a.expires_at) - 1), [8100, 8100, 6100, 2000], 'just before the deadline');
  await sleep(Math.max(0, Date.parse(a.expires_at) - Date.now() + 100));
  const x = ((await c.req('GET', '/authorizations', { token: s.tok.ada })).body.authorizations).find((y) => y.authorization_id === a.authorization_id);
  A.eq([x.status, Date.parse(x.closed_at)], ['expired', Date.parse(a.expires_at)], 'expired closes at expires_at');
  A.eq(await view(Date.parse(a.expires_at)), [8100, 8100, 8100, 0], 'at the deadline the hold is released');
  const b = (await c.req('POST', '/authorizations', { token: s.tok.ada, key: newKey(), body: { to_handle: 'cy', amount: 100 } })).body;
  const vd = (await c.req('POST', `/authorizations/${b.authorization_id}/void`, { token: s.tok.ada })).body;
  A.ok(vd.closed_at && Date.parse(vd.closed_at) >= Date.parse(b.created_at), 'void sets closed_at');
  A.eq(await view(Date.parse(vd.closed_at) - 1), [8100, 8100, 8000, 100], 'held until the void');
  A.eq(await view(Date.parse(vd.closed_at)), [8100, 8100, 8100, 0], 'released at the void');
  const es = (await allEntries(s, 'ada')).entries;
  A.eq(es.filter((e) => e.payment.payment_id === cap.payment_id).length, 1, 'capture appears exactly once in the statement');
  A.eq(es.find((e) => e.payment.payment_id === cap.payment_id)?.payment?.authorization_id, a.authorization_id, 'capture keeps its link');
  A.eq(es.length, 4, 'authorizations, releases and expiry are not entries');
  const plain = (await me(s, 'ada')).body;
  A.eq([plain.total, plain.available, plain.held], [8100, 8100, 0], 'current view');
});

await t('correction-guards-available-with-holds', ['R3-07'], async (A) => {
  const s = await seed(c, ledgerFixture());
  const p = (await pay(s, 'ada', 'bob', 500)).body;
  await c.req('POST', '/authorizations', { token: s.tok.bob, key: newKey(), body: { to_handle: 'cy', amount: 3200 } });
  A.eq((await me(s, 'bob')).body.available, 0, 'bob has nothing available');
  A.err(await correct(s, 'ada', p.payment_id, { expected_revision: 1, amount: 400, effective_at: p.created_at, reason: 'r' }), 409, 'insufficient_funds', 'decrease debits receiver available (held funds not usable)');
});

await t('protocol-violations', ['R-05', 'R-06'], async (A) => { A.eq(c.violations, [], 'no 5xx, envelope, timestamp or amount violations'); });

const failed = results.filter((r) => !r.passed);
const report = { kind: 'contract-checks', checks: results.length, passed: results.length - failed.length, failed: failed.length, requests: c.count, results };
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
console.log(`\nledger-contract: ${report.passed}/${report.checks} checks passed, ${report.failed} failed, ${c.count} requests`);
process.exit(failed.length ? 1 : 0);
