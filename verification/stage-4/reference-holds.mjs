// Reference-model campaign for stage-2 holds (commit/campaign.ts module). A small model of
// totals, holds, authorizations, captures (final / non-final), voids, payments and
// settlements competing for `available`, plus idempotent replays of the new paths. Written
// from pocketful/spec/stage-2.md; shares no code with the candidate.
import { client, code, deepEqual, PASSWORD } from './lib.mjs';

const H = ['ada', 'bob', 'cy', 'dan', 'op'];
const COMPARE_EVERY = 4;
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
let c;

export default {
  name: 'pocketful-stage-2-holds-reference',
  async setup(baseUrl, r) {
    c = client(baseUrl);
    const users = H.map((h) => ({ id: `u_${h}`, email: `${h}@example.com`, password: PASSWORD, display_name: h, handle: h, balance: r.range(0, 4000) }));
    const fx = { currency: 'EUR', minor_units: 2, users, payments: [], requests: [], authorizations: [], settlement_operator_ids: ['u_op'] };
    const res = await c.req('POST', '/_test/reset', { body: fx });
    if (res.status !== 204) throw new Error(`reset ${res.status}`);
    const U = {};
    for (const u of users) { const l = await c.req('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } }); U[u.handle] = { token: l.body.token, total: u.balance }; }
    return { model: { U, total: users.reduce((s, u) => s + u.balance, 0), auths: [], payments: [], keys: new Map(), writes: [], seq: 0 }, initial: fx };
  },
  generate(m, r) {
    const h = () => r.pick(H);
    const two = () => { const a = h(); let b = h(); while (b === a) b = h(); return [a, b]; };
    const key = () => `k${++m.seq}`;
    const x = r.int(100);
    if (x < 8 && m.writes.length) {
      const w = r.pick(m.writes);
      const body = r.chance(0.7) ? w.body : (w.path.endsWith('/capture') ? (w.body.amount === undefined ? { amount: 1 } : {}) : { ...w.body, amount: w.body.amount + 1 });
      return { t: 'replay', w, body };
    }
    if (x < 30) { const [a, b] = two(); return { t: 'authorize', user: a, path: '/authorizations', key: key(), body: { to_handle: r.chance(0.04) ? a : b, amount: r.chance(0.05) ? 0 : r.range(1, 1500) } }; }
    if (x < 55 && m.auths.length) {
      const au = r.pick(m.auths);
      const user = r.chance(0.85) ? au.to : h();
      const body = {};
      if (r.chance(0.7)) body.amount = r.chance(0.15) ? au.amount + 1 : r.range(1, Math.max(1, au.amount));
      if (r.chance(0.6)) body.final = r.chance(0.5);
      return { t: 'capture', au, user, path: `/authorizations/${au.id}/capture`, key: key(), body };
    }
    if (x < 65 && m.auths.length) { const au = r.pick(m.auths); return { t: 'void', au, user: r.chance(0.85) ? au.from : h() }; }
    if (x < 85) { const [a, b] = two(); return { t: 'pay', user: a, path: '/payments', key: key(), body: { to_handle: b, amount: r.range(1, 2000) } }; }
    if (x < 95) { const [a, b] = two(); const [d, e] = two(); return { t: 'settle', user: 'op', path: '/settlements', key: key(), body: { transfers: [{ from_handle: a, to_handle: b, amount: r.range(1, 1500) }, { from_handle: d, to_handle: e, amount: r.range(1, 1500) }] } }; }
    return { t: 'read', user: h() };
  },
  step(m, op) {
    const res = this.tr(m, op);
    if (res.created) { Object.defineProperty(op, '_created', { value: res.created, enumerable: false }); delete res.created; }
    return res;
  },
  tr(m, op) {
    const E = (s, cd) => ({ status: s, code: cd });
    const U = m.U;
    const held = (h) => m.auths.filter((a) => a.from === h && a.status === 'open').reduce((s, a) => s + a.remaining, 0);
    const avail = (h) => U[h].total - held(h);
    if (op.t === 'read') return { status: 200 };
    if (op.t === 'replay') return canon(op.body) === op.w.canon ? { status: 200, sameAs: op.w.response } : E(409, 'idempotency_key_reuse');
    if (op.t === 'void') {
      const a = op.au;
      if (op.user !== a.from) return E(403, 'forbidden');
      if (a.status === 'voided') return { status: 200, auth: { status: 'voided', remaining_amount: 0, captured_amount: a.captured } };
      if (a.status !== 'open') return E(409, 'authorization_not_open');
      a.status = 'voided'; a.remaining = 0;
      return { status: 200, auth: { status: 'voided', remaining_amount: 0, captured_amount: a.captured } };
    }
    const claimed = m.keys.get(`${op.user}|${op.path}|${op.key}`);
    if (claimed) return claimed.canon === canon(op.body) ? { status: 200, sameAs: claimed.response } : E(409, 'idempotency_key_reuse');
    const okAmt = (v) => Number.isInteger(v) && v >= 1 && v <= 1000000000;
    if (op.t === 'authorize') {
      const b = op.body;
      if (!okAmt(b.amount)) return E(422, 'validation_failed');
      if (b.to_handle === op.user) return E(422, 'self_payment');
      if (avail(op.user) < b.amount) return E(409, 'insufficient_funds');
      const a = { id: null, from: op.user, to: b.to_handle, amount: b.amount, captured: 0, remaining: b.amount, status: 'open', payments: [] };
      m.auths.push(a);
      return { status: 201, auth: { from_handle: op.user, to_handle: b.to_handle, amount: b.amount, captured_amount: 0, remaining_amount: b.amount, status: 'open', payment_id: null, payment_ids: [] }, created: { auth: a } };
    }
    if (op.t === 'capture') {
      const a = op.au, b = op.body;
      if (op.user !== a.to) return E(403, 'forbidden');
      if (b.amount !== undefined && !okAmt(b.amount)) return E(422, 'validation_failed');
      if (a.status !== 'open') return E(409, 'authorization_not_open');
      const amt = b.amount ?? a.remaining;
      if (amt > a.remaining) return E(422, 'capture_exceeds_authorization');
      U[a.from].total -= amt; U[a.to].total += amt;
      a.captured += amt; a.remaining -= amt;
      if (b.final !== false || a.remaining === 0) { a.status = 'captured'; a.remaining = 0; }
      const p = { id: null, from: a.from, to: a.to, amount: amt };
      m.payments.push(p);
      return { status: 201, payment: { from_handle: a.from, to_handle: a.to, amount: amt, request_id: null, settlement_id: null }, created: { payment: p, auth: null, capturedOf: a } };
    }
    if (op.t === 'pay') {
      const b = op.body;
      if (avail(op.user) < b.amount) return E(409, 'insufficient_funds');
      U[op.user].total -= b.amount; U[b.to_handle].total += b.amount;
      const p = { id: null, from: op.user, to: b.to_handle, amount: b.amount };
      m.payments.push(p);
      return { status: 201, payment: { from_handle: op.user, to_handle: b.to_handle, amount: b.amount, authorization_id: null }, created: { payment: p } };
    }
    if (op.t === 'settle') {
      const net = Object.fromEntries(H.map((x) => [x, 0]));
      for (const e of op.body.transfers) { net[e.from_handle] -= e.amount; net[e.to_handle] += e.amount; }
      if (H.some((x) => avail(x) + net[x] < 0)) return E(409, 'insufficient_funds');
      for (const x of H) U[x].total += net[x];
      const ps = op.body.transfers.map((e) => ({ id: null, from: e.from_handle, to: e.to_handle, amount: e.amount }));
      m.payments.push(...ps);
      return { status: 201, created: { payments: ps } };
    }
    throw new Error(op.t);
  },
  async execute(op, m) {
    if (op.t === 'read') { const r = await c.req('GET', '/me', { token: m.U[op.user].token }); return { status: r.status, body: r.body }; }
    if (op.t === 'void') { const r = await c.req('POST', `/authorizations/${op.au.id}/void`, { token: m.U[op.user].token }); return { status: r.status, body: r.body }; }
    const w = op.t === 'replay' ? op.w : op;
    const r = await c.req('POST', w.path, { token: m.U[w.user].token, key: w.key, body: op.body });
    return { status: r.status, body: r.body };
  },
  mismatch(e, o) {
    if (o.status !== e.status) return `status: expected ${e.status} ${e.code ?? ''}, got ${o.status} ${JSON.stringify(o.body)?.slice(0, 200)}`;
    if (e.code && code(o) !== e.code) return `code: expected ${e.code}, got ${code(o)}`;
    if (e.sameAs !== undefined && !deepEqual(o.body, e.sameAs)) return 'replay body differs';
    for (const k of ['payment', 'auth']) if (e[k]) { const got = Object.fromEntries(Object.keys(e[k]).map((x) => [x, o.body?.[x]])); if (!deepEqual(got, e[k])) return `${k}: expected ${JSON.stringify(e[k])}, got ${JSON.stringify(got)}`; }
    return null;
  },
  bind(m, op, o) {
    if (o.status !== 201 || !op._created) return;
    const cr = op._created;
    if (cr.payment) cr.payment.id = o.body.payment_id;
    if (cr.auth) cr.auth.id = o.body.authorization_id;
    if (cr.capturedOf) cr.capturedOf.payments.push(o.body.payment_id);
    if (cr.payments) cr.payments.forEach((p, i) => { p.id = o.body.payments[i].payment_id; });
    m.keys.set(`${op.user}|${op.path}|${op.key}`, { canon: canon(op.body), response: o.body });
    m.writes.push({ user: op.user, path: op.path, key: op.key, body: op.body, canon: canon(op.body), response: o.body });
  },
  async compareState(m, i) {
    if (i % COMPARE_EVERY !== COMPARE_EVERY - 1) return null;
    const inv = []; const I = (ok, w) => inv.push(`${ok ? 'held' : 'VIOLATED'}: ${w}`);
    const expected = { me: {}, auths: {} }, observed = { me: {}, auths: {} };
    let sum = 0;
    for (const h of H) {
      const held = m.auths.filter((a) => a.from === h && a.status === 'open').reduce((s, a) => s + a.remaining, 0);
      expected.me[h] = [m.U[h].total, m.U[h].total - held, held];
      const me = (await c.req('GET', '/me', { token: m.U[h].token })).body;
      observed.me[h] = [me?.total, me?.available, me?.held];
      sum += me?.total;
      I(me?.balance === me?.total && me?.available >= 0 && me?.available === me?.total - me?.held, `/me of ${h} consistent (${JSON.stringify(me)})`);
      const mine = m.auths.filter((a) => a.from === h || a.to === h);
      expected.auths[h] = mine.map((a) => [a.id, a.status, a.captured, a.remaining, a.payments]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
      const got = (await c.req('GET', '/authorizations?limit=200', { token: m.U[h].token })).body?.authorizations ?? [];
      observed.auths[h] = got.map((a) => [a.authorization_id, a.status, a.captured_amount, a.remaining_amount, a.payment_ids]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
      I(mine.length <= 200, 'one page');
    }
    I(sum === m.total, `sum of totals ${sum} = ${m.total}`);
    const v = c.violations.splice(0);
    I(!v.length, `protocol ${v.join('; ')}`);
    return { expected, observed, invariants: inv };
  },
};
