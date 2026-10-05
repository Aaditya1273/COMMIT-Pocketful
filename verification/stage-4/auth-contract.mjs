#!/usr/bin/env node
// Stage-2 contract checks for holds, authorizations, captures, voids and expiry, written
// from pocketful/spec/stage-2.md (plus the planner's A2-nn decisions, tagged).
// usage: node auth-contract.mjs --base-url URL [--out report.json] [--only substr]
import { writeFileSync } from 'node:fs';
import { client, code, fixture, seed, newKey, deepEqual, PASSWORD, TS_RE } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : a), []));
const c = client(args['base-url']);
const results = [];
async function t(id, reqs, fn) {
  if (args.only && !id.includes(args.only)) return;
  const fails = [];
  const A = {
    eq(a, e, l) { if (!deepEqual(a, e)) fails.push(`${l}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)?.slice(0, 300)}`); },
    ok(cond, l) { if (!cond) fails.push(l); },
    err(r, s, cd, l) { if (r.status !== s || code(r) !== cd) fails.push(`${l}: expected ${s} ${cd}, got ${r.status} ${r.text?.slice(0, 200)}`); },
    st(r, s, l) { if (r.status !== s) fails.push(`${l}: expected ${s}, got ${r.status} ${r.text?.slice(0, 200)}`); },
  };
  try { await fn(A); } catch (e) { fails.push(`exception: ${e?.stack ?? e}`); }
  results.push({ id, requirements: reqs, passed: !fails.length, failures: fails });
  console.log(`${fails.length ? 'FAIL' : 'ok  '} ${id}${fails.length ? '\n      ' + fails.join('\n      ') : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString().replace('Z', '+00:00');
const HOUR = 3600 * 1000;
const AUTH_KEYS = ['authorization_id', 'from_user_id', 'from_handle', 'to_user_id', 'to_handle', 'amount', 'captured_amount', 'remaining_amount', 'currency', 'note', 'visibility', 'status', 'expires_at', 'payment_id', 'payment_ids', 'created_at'];
const PAYMENT_KEYS = ['payment_id', 'authorization_id', 'refund_of', 'from_user_id', 'from_handle', 'to_user_id', 'to_handle', 'amount', 'currency', 'note', 'visibility', 'request_id', 'settlement_id', 'created_at'].sort();
const me = async (s, h) => (await c.req('GET', '/me', { token: s.tok[h] })).body;
const money = async (s, h) => { const m = await me(s, h); return [m?.total, m?.available, m?.held, m?.balance]; };
const auth = (s, from, to, amount, extra = {}, key = newKey('au')) => c.req('POST', '/authorizations', { token: s.tok[from], key, body: { to_handle: to, amount, ...extra } });
const capture = (s, who, id, body = {}, key = newKey('cp')) => c.req('POST', `/authorizations/${id}/capture`, { token: s.tok[who], key, body });
const voidA = (s, who, id) => c.req('POST', `/authorizations/${id}/void`, { token: s.tok[who] });
const list = async (s, h, q = '?limit=200') => (await c.req('GET', '/authorizations' + q, { token: s.tok[h] })).body?.authorizations ?? [];
const find = async (s, h, id) => (await list(s, h)).find((a) => a.authorization_id === id);
const sumTotals = async (s) => { let n = 0; for (const h of Object.keys(s.tok)) n += (await me(s, h)).total; return n; };

function fx2(over = {}) {
  const f = fixture(over);
  if (over.ttl !== undefined) f.authorization_ttl_seconds = over.ttl;
  if (over.authorizations !== undefined) f.authorizations = over.authorizations;
  return f;
}

await t('me-fields-no-holds', ['R2-05', 'R2-01'], async (A) => {
  const s = await seed(c, fx2());
  const m = await me(s, 'ada');
  A.eq([m.balance, m.total, m.available, m.held], [10000, 10000, 10000, 0], 'balance = total = available, held 0');
});

await t('seeded-holds', ['R2-07', 'R2-05'], async (A) => {
  const s = await seed(c, fx2({ authorizations: [
    { id: 'a_1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 2000, note: 'deposit', visibility: 'public', status: 'open', expires_at: iso(2 * HOUR) },
    { id: 'a_2', from_user_id: 'u_ada', to_user_id: 'u_cy', amount: 500, note: '', visibility: 'private', status: 'open', expires_at: iso(-2 * HOUR) },
    { id: 'a_3', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 700, note: '', visibility: 'public', status: 'voided', expires_at: iso(2 * HOUR) },
    { id: 'a_4', from_user_id: 'u_dan', to_user_id: 'u_bob', amount: 300, note: '', visibility: 'public', status: 'captured', expires_at: iso(2 * HOUR) },
    { id: 'a_5', from_user_id: 'u_dan', to_user_id: 'u_bob', amount: 4000, note: '', visibility: 'public', status: 'expired', expires_at: iso(-2 * HOUR) },
  ] }));
  A.eq(await money(s, 'ada'), [10000, 8000, 2000, 10000], 'ada: one open unexpired hold of 2000');
  A.eq(await money(s, 'dan'), [5000, 5000, 0, 5000], 'dan: captured/expired hold nothing');
  const la = await list(s, 'ada');
  A.eq(la.map((a) => [a.authorization_id, a.status]).sort(), [['a_1', 'open'], ['a_2', 'expired'], ['a_3', 'voided']], 'ada sees her three; past-expiry seeded open is expired');
  const a1 = la.find((a) => a.authorization_id === 'a_1');
  A.ok(a1 && AUTH_KEYS.every((k) => k in a1), `authorization fields ${a1 && AUTH_KEYS.filter((k) => !(k in a1))}`);
  A.eq([a1?.amount, a1?.captured_amount, a1?.remaining_amount, a1?.from_handle, a1?.to_handle, a1?.note, a1?.payment_id], [2000, 0, 2000, 'ada', 'bob', 'deposit', null], 'a_1 values');
  A.eq(la.find((a) => a.authorization_id === 'a_2')?.remaining_amount, 0, 'expired remaining 0 (plan:A2-07)');
  A.eq((await list(s, 'bob')).map((x) => x.authorization_id).sort(), ['a_1', 'a_3', 'a_4', 'a_5'], 'bob sees incoming');
  A.eq(await list(s, 'op'), [], 'third party sees none');
  A.eq((await c.req('GET', '/activity?limit=200', { token: s.tok.cy })).body?.payments?.map((p) => p.payment_id), ['p_1'], 'holds are not feed items');
  A.err(await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), body: { to_handle: 'cy', amount: 8001 } }), 409, 'insufficient_funds', 'held funds cannot fund a payment');
  A.st(await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), body: { to_handle: 'cy', amount: 8000 } }), 201, 'available can be spent exactly');
  A.eq(await money(s, 'ada'), [2000, 0, 2000, 2000], 'available 0, still held');
});

await t('seeded-hold-reset-errors', ['R2-07'], async (A) => {
  const s = await seed(c, fx2());
  const bad = {
    'holds exceed balance': fx2({ authorizations: [{ id: 'a_1', from_user_id: 'u_bob', to_user_id: 'u_ada', amount: 2000, note: '', visibility: 'public', status: 'open', expires_at: iso(HOUR * 2) }, { id: 'a_2', from_user_id: 'u_bob', to_user_id: 'u_cy', amount: 501, note: '', visibility: 'public', status: 'open', expires_at: iso(HOUR * 2) }] }),
    'ttl 0': fx2({ ttl: 0 }), 'ttl -1': fx2({ ttl: -1 }), 'ttl 1.5': fx2({ ttl: 1.5 }), 'ttl "600"': fx2({ ttl: '600' }),
    'duplicate authorization id': fx2({ authorizations: [{ id: 'a_1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, note: '', visibility: 'public', status: 'open', expires_at: iso(HOUR * 2) }, { id: 'a_1', from_user_id: 'u_ada', to_user_id: 'u_cy', amount: 1, note: '', visibility: 'public', status: 'open', expires_at: iso(HOUR * 2) }] }),
    'empty authorization id': fx2({ authorizations: [{ id: '', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, note: '', visibility: 'public', status: 'open', expires_at: iso(HOUR * 2) }] }),
    'authorization id over 64': fx2({ authorizations: [{ id: 'a'.repeat(65), from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, note: '', visibility: 'public', status: 'open', expires_at: iso(HOUR * 2) }] }),
    'authorization id number': fx2({ authorizations: [{ id: 9, from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, note: '', visibility: 'public', status: 'open', expires_at: iso(HOUR * 2) }] }),
    'authorization unknown user': fx2({ authorizations: [{ id: 'a_1', from_user_id: 'u_ghost', to_user_id: 'u_bob', amount: 1, note: '', visibility: 'public', status: 'open', expires_at: iso(HOUR * 2) }] }),
    'bad status': fx2({ authorizations: [{ id: 'a_1', from_user_id: 'u_bob', to_user_id: 'u_ada', amount: 1, note: '', visibility: 'public', status: 'pending', expires_at: iso(HOUR * 2) }] }),
  };
  for (const [l, f] of Object.entries(bad)) A.err(await c.req('POST', '/_test/reset', { body: f }), 422, 'validation_failed', l);
  A.eq(await money(s, 'bob'), [2500, 2500, 0, 2500], 'state unchanged');
  const ok = fx2({ authorizations: [{ id: 'a_1', from_user_id: 'u_bob', to_user_id: 'u_ada', amount: 2500, note: '', visibility: 'public', status: 'open', expires_at: iso(HOUR * 2) }, { id: 'a_2', from_user_id: 'u_bob', to_user_id: 'u_cy', amount: 9999, note: '', visibility: 'public', status: 'open', expires_at: iso(-HOUR * 2) }] });
  A.st(await c.req('POST', '/_test/reset', { body: ok }), 204, 'holds = balance ok; expired open hold does not count');
});

await t('authorize-201-and-errors', ['R2-09', 'R2-14'], async (A) => {
  const s = await seed(c, fx2({ ttl: 900 }));
  const r = await auth(s, 'ada', 'bob', 2000, { note: 'deposit', visibility: 'private' });
  A.st(r, 201, 'authorize');
  const b = r.body ?? {};
  A.ok(AUTH_KEYS.every((k) => k in b), `fields missing ${AUTH_KEYS.filter((k) => !(k in b))}`);
  A.eq([b.from_user_id, b.from_handle, b.to_user_id, b.to_handle, b.amount, b.captured_amount, b.remaining_amount, b.currency, b.note, b.visibility, b.status, b.payment_id, b.payment_ids], [s.id.ada, 'ada', s.id.bob, 'bob', 2000, 0, 2000, 'EUR', 'deposit', 'private', 'open', null, []], 'values');
  A.ok(TS_RE.test(b.expires_at ?? '') && TS_RE.test(b.created_at ?? ''), 'timestamps');
  A.eq(Date.parse(b.expires_at) - Date.parse(b.created_at), 900000, 'expires_at = created_at + ttl');
  A.eq(await money(s, 'ada'), [10000, 8000, 2000, 10000], 'hold placed, no money moved');
  A.eq(await money(s, 'bob'), [2500, 2500, 0, 2500], 'receiver unchanged');
  const d = await auth(s, 'dan', 'cy', 10);
  A.eq([d.body?.note, d.body?.visibility], ['', 'public'], 'defaults');
  A.eq(Date.parse(d.body?.expires_at) - Date.parse(d.body?.created_at), 900000, 'ttl applies to every API authorization');
  A.err(await auth(s, 'ada', 'bob', 8001), 409, 'insufficient_funds', 'above available');
  A.st(await auth(s, 'ada', 'bob', 8000), 201, 'exactly available');
  A.err(await auth(s, 'ada', 'ada', 1), 422, 'self_payment', 'self');
  A.err(await auth(s, 'bob', 'ghost', 1), 404, 'not_found', 'unknown');
  for (const raw of ['0', '-1', '1.5', '"5"', 'true', 'null', '1000000001']) A.err(await c.req('POST', '/authorizations', { token: s.tok.bob, key: newKey(), raw: `{"to_handle":"ada","amount":${raw}}` }), 422, 'validation_failed', `amount ${raw}`);
  A.err(await auth(s, 'bob', 'ada', 1, { note: 'n'.repeat(201) }), 422, 'validation_failed', 'note 201');
  A.err(await auth(s, 'bob', 'ada', 1, { visibility: 'friends' }), 422, 'validation_failed', 'visibility');
  A.err(await c.req('POST', '/authorizations', { token: s.tok.bob, body: { to_handle: 'ada', amount: 1 } }), 400, 'missing_idempotency_key', 'key required');
  A.err(await c.req('POST', '/authorizations', { key: newKey(), body: { to_handle: 'ada', amount: 1 } }), 401, 'unauthenticated', 'auth required');
  A.st(await c.req('POST', '/authorizations', { token: s.tok.bob, key: newKey(), raw: '{"to_handle":"ada","amount":1e2}' }), 201, '1e2 amount');
  const key = newKey();
  const first = await auth(s, 'bob', 'cy', 5, {}, key);
  const rep = await auth(s, 'bob', 'cy', 5, {}, key);
  A.eq([rep.status, rep.body], [200, first.body], 'replay');
  A.err(await auth(s, 'bob', 'cy', 6, {}, key), 409, 'idempotency_key_reuse', 'reuse');
  A.err(await c.req('POST', '/authorizations', { token: s.tok.bob, key, body: { to_handle: 'cy', amount: 'x' } }), 409, 'idempotency_key_reuse', 'claimed key before validation');
  A.eq((await money(s, 'bob'))[2], 105, 'bob held 100 + 5 (replay held once)');
  A.eq((await c.req('GET', '/activity?limit=200', { token: s.tok.bob })).body?.payments?.length, 2, 'authorizations not in feed');
});

await t('capture-final-default', ['R2-10', 'R2-13', 'R2-04'], async (A) => {
  const s = await seed(c, fx2());
  const a = (await auth(s, 'ada', 'bob', 2000, { note: 'n1', visibility: 'private' })).body;
  const r = await capture(s, 'bob', a.authorization_id, { amount: 1500 });
  A.st(r, 201, 'capture 1500');
  A.eq(Object.keys(r.body ?? {}).sort(), PAYMENT_KEYS, 'payment shape');
  A.eq([r.body?.amount, r.body?.from_handle, r.body?.to_handle, r.body?.note, r.body?.visibility, r.body?.authorization_id, r.body?.request_id, r.body?.settlement_id], [1500, 'ada', 'bob', 'n1', 'private', a.authorization_id, null, null], 'payment values');
  A.eq(await money(s, 'ada'), [8500, 8500, 0, 8500], 'remainder released in the same step');
  A.eq(await money(s, 'bob'), [4000, 4000, 0, 4000], 'receiver credited');
  const x = await find(s, 'ada', a.authorization_id);
  A.eq([x?.status, x?.captured_amount, x?.remaining_amount, x?.payment_id, x?.payment_ids], ['captured', 1500, 0, r.body?.payment_id, [r.body?.payment_id]], 'authorization after final capture');
  A.err(await capture(s, 'bob', a.authorization_id, { amount: 1 }), 409, 'authorization_not_open', 'second capture after final');
  A.ok((await c.req('GET', '/activity?limit=200', { token: s.tok.bob })).body?.payments?.some((p) => p.payment_id === r.body?.payment_id && p.authorization_id === a.authorization_id), 'capture in receiver feed');
  A.ok(!(await c.req('GET', '/activity?limit=200', { token: s.tok.cy })).body?.payments?.some((p) => p.payment_id === r.body?.payment_id), 'private capture hidden from third party');
  const plain = await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), body: { to_handle: 'cy', amount: 1 } });
  A.eq(plain.body?.authorization_id, null, 'ordinary payment authorization_id null');
  const b = (await auth(s, 'ada', 'cy', 300)).body;
  const full = await capture(s, 'cy', b.authorization_id, {});
  A.eq([full.status, full.body?.amount], [201, 300], 'omitted amount = remainder');
  A.eq(await sumTotals(s), 17500, 'totals conserve');
});

await t('capture-partial-extended', ['R2-10', 'plan:edge-3', 'plan:edge-4'], async (A) => {
  const s = await seed(c, fx2());
  const a = (await auth(s, 'ada', 'bob', 2000)).body;
  const c1 = await capture(s, 'bob', a.authorization_id, { amount: 700, final: false });
  A.st(c1, 201, 'partial 700');
  let x = await find(s, 'bob', a.authorization_id);
  A.eq([x?.status, x?.captured_amount, x?.remaining_amount, x?.payment_ids?.length], ['open', 700, 1300, 1], 'stays open');
  A.eq(await money(s, 'ada'), [9300, 8000, 1300, 9300], 'remainder still held');
  A.err(await capture(s, 'bob', a.authorization_id, { amount: 1301, final: false }), 422, 'capture_exceeds_authorization', 'over remainder');
  const c2 = await capture(s, 'bob', a.authorization_id, { amount: 1300, final: false });
  A.st(c2, 201, 'capture exactly the remainder with final:false');
  x = await find(s, 'bob', a.authorization_id);
  A.eq([x?.status, x?.captured_amount, x?.remaining_amount, x?.payment_id, x?.payment_ids], ['captured', 2000, 0, c2.body?.payment_id, [c1.body?.payment_id, c2.body?.payment_id]], 'closes as captured');
  const b = (await auth(s, 'ada', 'cy', 1000)).body;
  await capture(s, 'cy', b.authorization_id, { amount: 400, final: false });
  const v = await voidA(s, 'ada', b.authorization_id);
  A.eq([v.status, v.body?.status, v.body?.captured_amount, v.body?.remaining_amount], [200, 'voided', 400, 0], 'void after partial keeps captures');
  A.eq(await money(s, 'ada'), [7600, 7600, 0, 7600], 'only remainder released');
  const d = (await auth(s, 'ada', 'cy', 1000)).body;
  await capture(s, 'cy', d.authorization_id, { amount: 100, final: false });
  const fin = await capture(s, 'cy', d.authorization_id, { amount: 100 });
  A.st(fin, 201, 'final capture after partial');
  x = await find(s, 'cy', d.authorization_id);
  A.eq([x?.status, x?.captured_amount, x?.remaining_amount], ['captured', 200, 0], 'final releases rest');
  A.eq((await money(s, 'ada'))[2], 0, 'nothing held');
  const e = (await auth(s, 'ada', 'cy', 500)).body;
  await capture(s, 'cy', e.authorization_id, { amount: 100, final: false });
  const rest = await capture(s, 'cy', e.authorization_id, { final: false });
  A.eq([rest.status, rest.body?.amount], [201, 400], 'omitted amount with final:false = remainder, closes');
  A.eq((await find(s, 'cy', e.authorization_id))?.status, 'captured', 'closed');
  A.eq(await sumTotals(s), 17500, 'conservation');
});

await t('capture-errors-precedence', ['R2-10', 'plan:A2-01', 'plan:A2-02', 'plan:edge-9'], async (A) => {
  const s = await seed(c, fx2());
  const a = (await auth(s, 'ada', 'bob', 1000)).body;
  const id = a.authorization_id;
  A.err(await capture(s, 'ada', id, {}), 403, 'forbidden', 'payer cannot capture');
  A.err(await capture(s, 'cy', id, {}), 403, 'forbidden', 'third party cannot capture');
  A.err(await capture(s, 'bob', 'a_ghost', {}), 404, 'not_found', 'unknown');
  for (const raw of ['0', '-1', '1.5', '"5"', 'true', 'null']) A.err(await c.req('POST', `/authorizations/${id}/capture`, { token: s.tok.bob, key: newKey(), raw: `{"amount":${raw}}` }), 422, 'validation_failed', `amount ${raw}`);
  A.err(await capture(s, 'bob', id, { amount: 1001 }), 422, 'capture_exceeds_authorization', 'over amount');
  A.err(await capture(s, 'bob', id, { amount: 10, final: 'no' }), 400, 'malformed_request', 'final string');
  A.err(await capture(s, 'bob', id, { amount: 10, final: 1 }), 400, 'malformed_request', 'final number');
  A.err(await c.req('POST', `/authorizations/${id}/capture`, { token: s.tok.bob, body: {} }), 400, 'missing_idempotency_key', 'key required');
  A.err(await c.req('POST', `/authorizations/${id}/capture`, { token: s.tok.bob, key: newKey(), raw: '[]' }), 400, 'malformed_request', 'array body');
  A.eq(await money(s, 'bob'), [2500, 2500, 0, 2500], 'nothing captured');
  const key = newKey();
  const first = await capture(s, 'bob', id, {}, key);
  A.st(first, 201, 'capture {}');
  const rep = await capture(s, 'bob', id, {}, key);
  A.eq([rep.status, rep.body], [200, first.body], 'replay after closed: 200 original');
  A.err(await capture(s, 'bob', id, { amount: 1000 }, key), 409, 'idempotency_key_reuse', '{} vs {"amount":N}');
  A.err(await capture(s, 'bob', id, { amount: 1 }), 409, 'authorization_not_open', 'closed');
  A.err(await voidA(s, 'ada', id), 409, 'authorization_not_open', 'void captured');
  A.eq((await money(s, 'bob'))[0], 3500, 'moved once');
  const v = (await auth(s, 'ada', 'cy', 100)).body;
  A.st(await voidA(s, 'ada', v.authorization_id), 200, 'void');
  A.err(await capture(s, 'cy', v.authorization_id, {}), 409, 'authorization_not_open', 'capture voided');
  const k2 = newKey();
  const f1 = await capture(s, 'cy', v.authorization_id, { amount: 5 }, k2);
  A.ok(f1.status === 409, 'failed capture');
  const w = (await auth(s, 'ada', 'cy', 50)).body;
  A.st(await capture(s, 'cy', w.authorization_id, { amount: 5 }, k2), 201, 'key of a failed capture is reusable (different path here)');
});

await t('void-rules', ['R2-11'], async (A) => {
  const s = await seed(c, fx2());
  const a = (await auth(s, 'ada', 'bob', 1000)).body;
  A.err(await voidA(s, 'bob', a.authorization_id), 403, 'forbidden', 'receiver cannot void');
  A.err(await voidA(s, 'cy', a.authorization_id), 403, 'forbidden', 'third party cannot void');
  A.err(await voidA(s, 'ada', 'nope'), 404, 'not_found', 'unknown');
  const v = await voidA(s, 'ada', a.authorization_id);
  A.eq([v.status, v.body?.status, v.body?.remaining_amount, v.body?.authorization_id], [200, 'voided', 0, a.authorization_id], 'void');
  A.ok(AUTH_KEYS.every((k) => k in (v.body ?? {})), 'void returns the authorization');
  const v2 = await voidA(s, 'ada', a.authorization_id);
  A.eq([v2.status, v2.body?.status], [200, 'voided'], 'void twice');
  A.eq(await money(s, 'ada'), [10000, 10000, 0, 10000], 'released');
  A.err(await voidA(s, 'ada', 'a_seed_x'), 404, 'not_found', 'unknown 2');
});

await t('expiry-by-clock', ['R2-08', 'plan:edge-1', 'plan:edge-2', 'plan:A2-01'], async (A) => {
  const s = await seed(c, fx2({ ttl: 2 }));
  const a = (await auth(s, 'ada', 'bob', 3000)).body;
  const b = (await auth(s, 'ada', 'bob', 1000)).body;
  await capture(s, 'bob', b.authorization_id, { amount: 400, final: false });
  A.eq(await money(s, 'ada'), [9600, 6000, 3600, 9600], 'held before expiry (3000 + remainder 600)');
  const wait = Date.parse(a.expires_at) - Date.now() + 150;
  await sleep(Math.max(wait, 0));
  A.eq(await money(s, 'ada'), [9600, 9600, 0, 9600], 'expired with no request at the deadline: available restored');
  const x = await find(s, 'ada', a.authorization_id);
  A.eq([x?.status, x?.remaining_amount, x?.captured_amount], ['expired', 0, 0], 'expired in list');
  const y = await find(s, 'bob', b.authorization_id);
  A.eq([y?.status, y?.captured_amount, y?.payment_ids?.length], ['expired', 400, 1], 'partial captures preserved on expiry');
  A.err(await capture(s, 'bob', a.authorization_id, {}), 409, 'authorization_expired', 'capture after expiry');
  A.err(await voidA(s, 'ada', a.authorization_id), 409, 'authorization_not_open', 'void after expiry');
  A.eq((await list(s, 'ada', '?status=open')).length, 0, 'clock-expired never matches open');
  A.eq((await list(s, 'ada', '?status=expired')).length, 2, 'matches expired');
  A.eq((await money(s, 'bob'))[0], 2900, 'no money moved by failed capture');
  A.st(await c.req('POST', '/payments', { token: s.tok.ada, key: newKey(), body: { to_handle: 'cy', amount: 9600 } }), 201, 'released funds spendable');
});

await t('get-authorizations-filters-paging', ['R2-12'], async (A) => {
  const s = await seed(c, fx2());
  const ids = [];
  for (let i = 0; i < 4; i++) { ids.push((await auth(s, 'ada', 'bob', 10 + i)).body.authorization_id); await sleep(5); }
  const inc = (await auth(s, 'bob', 'ada', 5)).body.authorization_id;
  await voidA(s, 'ada', ids[0]);
  const all = await list(s, 'ada');
  A.eq(all.length, 5, 'payer or receiver');
  A.ok(all.every((x, i) => i === 0 || Date.parse(all[i - 1].created_at) >= Date.parse(x.created_at)), 'newest first');
  A.eq(all[0]?.authorization_id, inc, 'newest is the last created');
  A.eq((await list(s, 'ada', '?direction=outgoing')).map((x) => x.authorization_id).sort(), [...ids].sort(), 'outgoing = payer');
  A.eq((await list(s, 'ada', '?direction=incoming')).map((x) => x.authorization_id), [inc], 'incoming = receiver');
  A.eq((await list(s, 'ada', '?status=voided')).map((x) => x.authorization_id), [ids[0]], 'status filter');
  A.eq((await list(s, 'ada', '?status=open&direction=outgoing')).length, 3, 'combined');
  const p1 = await c.req('GET', '/authorizations?limit=2', { token: s.tok.ada });
  const p3 = await c.req('GET', '/authorizations?limit=2&offset=4', { token: s.tok.ada });
  A.eq([p1.body?.has_more, p1.body?.authorizations?.length, p3.body?.has_more, p3.body?.authorizations?.length], [true, 2, false, 1], 'paging');
  A.eq(Object.keys(p1.body ?? {}).sort(), ['authorizations', 'has_more'], 'envelope');
  for (const q of ['direction=both', 'status=pending', 'limit=0', 'limit=201', 'limit=1e1', 'offset=-1', 'limit=+3']) A.err(await c.req('GET', `/authorizations?${q}`, { token: s.tok.ada }), 422, 'validation_failed', q);
  A.err(await c.req('GET', '/authorizations'), 401, 'unauthenticated', 'API without token');
  A.eq(await list(s, 'cy'), [], 'third party');
});

await t('available-governs-payments-requests-settlements', ['R2-06', 'R2-04'], async (A) => {
  const s = await seed(c, fx2());
  await auth(s, 'bob', 'ada', 2000);
  A.eq(await money(s, 'bob'), [2500, 500, 2000, 2500], 'bob 500 available');
  A.err(await c.req('POST', '/payments', { token: s.tok.bob, key: newKey(), body: { to_handle: 'cy', amount: 501 } }), 409, 'insufficient_funds', 'payment vs available');
  const q = (await c.req('POST', '/requests', { token: s.tok.cy, key: newKey(), body: { payer_handle: 'bob', amount: 600 } })).body;
  A.err(await c.req('POST', `/requests/${q.request_id}/pay`, { token: s.tok.bob, key: newKey(), body: {} }), 409, 'insufficient_funds', 'request pay vs available');
  A.err(await c.req('POST', '/settlements', { token: s.tok.op, key: newKey(), body: { transfers: [{ from_handle: 'bob', to_handle: 'cy', amount: 501 }] } }), 409, 'insufficient_funds', 'settlement net debit vs available');
  A.st(await c.req('POST', '/settlements', { token: s.tok.op, key: newKey(), body: { transfers: [{ from_handle: 'bob', to_handle: 'cy', amount: 600 }, { from_handle: 'dan', to_handle: 'bob', amount: 100 }] } }), 201, 'net debit 500 = available');
  A.err(await auth(s, 'bob', 'cy', 1), 409, 'insufficient_funds', 'authorization vs available');
  A.eq(await money(s, 'bob'), [2000, 0, 2000, 2000], 'held intact');
  const cap = (await list(s, 'ada', '?direction=incoming'))[0];
  A.st(await capture(s, 'ada', cap.authorization_id, {}), 201, 'capture may spend the reserved money');
  A.eq(await money(s, 'bob'), [0, 0, 0, 0], 'bob spent');
  A.eq(await sumTotals(s), 17500, 'conservation');
});

await t('content-negotiation', ['R2-03', 'plan:A2-08'], async (A) => {
  const s = await seed(c, fx2());
  for (const p of ['/requests', '/authorizations']) {
    const h = await fetch(c.base + p, { headers: { accept: 'text/html,application/xhtml+xml' } });
    const body = await h.text();
    A.ok(h.status === 200 && /text\/html/.test(h.headers.get('content-type') ?? '') && /<html|<!doctype/i.test(body), `${p} with Accept text/html serves the UI (${h.status})`);
    const j = await c.req('GET', p, { token: s.tok.ada });
    A.ok(j.status === 200 && typeof j.body === 'object', `${p} JSON without the header`);
  }
  for (const p of ['/', '/split', '/signup', '/login']) {
    const h = await fetch(c.base + p, { headers: { accept: 'text/html' } });
    A.ok(h.status === 200 && /text\/html/.test(h.headers.get('content-type') ?? ''), `${p} serves HTML`);
  }
});

await t('export-import-holds', ['R2-16', 'R2-14'], async (A) => {
  const s = await seed(c, fx2({ ttl: 1200 }));
  const k = newKey();
  const a = (await auth(s, 'ada', 'bob', 2000, {}, k)).body;
  const kc = newKey();
  const p = await capture(s, 'bob', a.authorization_id, { amount: 500, final: false }, kc);
  const exp = (await c.req('GET', '/_test/export')).body;
  await seed(c, fx2());
  A.st(await c.req('POST', '/_test/import', { body: exp }), 204, 'import');
  A.eq(await money(s, 'ada'), [9500, 8000, 1500, 9500], 'holds survive');
  A.eq((await auth(s, 'ada', 'bob', 2000, {}, k)).body, a, 'authorize replay after import');
  const pr = await capture(s, 'bob', a.authorization_id, { amount: 500, final: false }, kc);
  A.eq([pr.status, pr.body], [200, p.body], 'capture replay after import');
  const n = await auth(s, 'dan', 'cy', 1);
  A.eq(Date.parse(n.body?.expires_at) - Date.parse(n.body?.created_at), 1200000, 'ttl survives import');
  A.ok(n.body?.authorization_id !== a.authorization_id, 'no id collision');
  A.st(await capture(s, 'bob', a.authorization_id, {}), 201, 'capture remainder after import');
  A.eq(await sumTotals(s), 17500, 'conservation');
});

await t('protocol-violations', ['R-05', 'R-06'], async (A) => { A.eq(c.violations, [], 'no 5xx, bad envelope, timestamps, ids or amounts'); });

const failed = results.filter((r) => !r.passed);
const report = { kind: 'contract-checks', checks: results.length, passed: results.length - failed.length, failed: failed.length, requests: c.count, results };
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
console.log(`\nauth-contract: ${report.passed}/${report.checks} checks passed, ${report.failed} failed, ${c.count} requests`);
process.exit(failed.length ? 1 : 0);
