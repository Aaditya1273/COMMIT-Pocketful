// Reference-model campaign for the stage-3 ledger (commit/campaign.ts module): payments,
// corrections with effective/recorded time, stale revisions, insufficient_funds (now) vs
// historical_overdraft (past boundaries, same-instant movements combined), replays, and
// as_of / known_at / statement reads compared against a small model. Written from
// pocketful/spec/stage-3.md; shares no code with the candidate.
import { client, code, deepEqual, PASSWORD } from './lib.mjs';

const H = ['ada', 'bob', 'cy', 'dan'];
const OPEN = 3000;
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const q = encodeURIComponent;
let c;

// Balance of h under a view: revisions selected by known (recorded <= K), applied at effective <= T.
function select(p, K) { let s = null; for (const r of p.revs) if (K === undefined || r.rec <= K) s = r; return s; }
function balanceAt(m, h, T, K) {
  let b = OPEN;
  for (const p of m.payments) { const r = select(p, K); if (!r || (T !== undefined && r.eff > T)) continue; if (p.from === h) b -= r.amount; if (p.to === h) b += r.amount; }
  return b;
}
// Every boundary (distinct effective instant) must leave every wallet nonnegative.
function historyOk(m, payments) {
  const instants = [...new Set(payments.map((p) => p.revs.at(-1).eff))].sort((a, b) => a - b);
  for (const T of instants) for (const h of H) {
    let b = OPEN;
    for (const p of payments) { const r = p.revs.at(-1); if (r.eff > T) continue; if (p.from === h) b -= r.amount; if (p.to === h) b += r.amount; }
    if (b < 0) return false;
  }
  return true;
}

export default {
  name: 'pocketful-stage-3-ledger-reference',
  async setup(baseUrl) {
    c = client(baseUrl);
    const users = H.map((h) => ({ id: `u_${h}`, email: `${h}@example.com`, password: PASSWORD, display_name: h, handle: h, balance: OPEN }));
    const r = await c.req('POST', '/_test/reset', { body: { currency: 'EUR', minor_units: 2, users, payments: [], requests: [] } });
    if (r.status !== 204) throw new Error(`reset ${r.status}`);
    const U = {};
    for (const u of users) U[u.handle] = (await c.req('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } })).body.token;
    return { model: { U, payments: [], writes: [], keys: new Map(), seq: 0 }, initial: { users } };
  },
  generate(m, r) {
    const two = () => { const a = r.pick(H); let b = r.pick(H); while (b === a) b = r.pick(H); return [a, b]; };
    const x = r.int(100);
    if (x < 8 && m.writes.length) { const w = r.pick(m.writes); return { t: 'replay', w, body: r.chance(0.7) ? w.body : { ...w.body, reason: w.body.reason + '!' } }; }
    if (x < 40 || !m.payments.length) { const [a, b] = two(); return { t: 'pay', user: a, key: `p${++m.seq}`, body: { to_handle: b, amount: r.range(1, 1500) } }; }
    if (x < 75) {
      const p = r.pick(m.payments);
      const effChoices = m.payments.map((y) => y.created).filter((e) => e <= p.created);
      const eff = r.pick(effChoices);
      return { t: 'correct', p, user: r.chance(0.92) ? p.from : p.to, key: `c${++m.seq}`, body: { expected_revision: r.chance(0.85) ? p.revs.length : Math.max(1, p.revs.length - 1), amount: r.range(0, 2500), effective_at: new Date(eff).toISOString().replace('Z', '+00:00'), reason: `r${m.seq}` } };
    }
    if (x < 90) { const p = r.pick(m.payments); const T = r.chance(0.5) ? p.created : p.revs.at(-1).eff; const K = r.chance(0.4) ? r.pick(p.revs).rec : undefined; return { t: 'asof', user: r.pick(H), T, K }; }
    return { t: 'revisions', p: r.pick(m.payments), user: r.pick(H) };
  },
  step(m, op) {
    const E = (s, cd) => ({ status: s, code: cd });
    if (op.t === 'asof') return { status: 200, balance: balanceAt(m, op.user, op.T, op.K) };
    if (op.t === 'revisions') {
      if (op.user !== op.p.from && op.user !== op.p.to) return E(404, 'not_found');
      return { status: 200, revs: op.p.revs.map((rv, i) => [i + 1, rv.amount]) };
    }
    if (op.t === 'replay') return canon(op.body) === op.w.canon ? { status: 200, sameAs: op.w.response } : E(409, 'idempotency_key_reuse');
    if (op.t === 'pay') {
      if (balanceAt(m, op.user) < op.body.amount) return E(409, 'insufficient_funds');
      return { status: 201, pay: { from: op.user, to: op.body.to_handle, amount: op.body.amount } };
    }
    if (op.t === 'correct') {
      const p = op.p, b = op.body;
      if (op.user !== p.from) return E(403, 'forbidden');
      if (b.expected_revision !== p.revs.length) return E(409, 'stale_revision');
      const prev = p.revs.at(-1).amount, diff = b.amount - prev;
      if (diff > 0 && balanceAt(m, p.from) < diff) return E(409, 'insufficient_funds');
      if (diff < 0 && balanceAt(m, p.to) < -diff) return E(409, 'insufficient_funds');
      const trial = m.payments.map((y) => (y === p ? { ...y, revs: [...y.revs, { amount: b.amount, eff: Date.parse(b.effective_at), rec: Infinity }] } : y));
      if (!historyOk(m, trial)) return E(409, 'historical_overdraft');
      return { status: 201, corr: { revision: p.revs.length + 1, amount: b.amount, effective_at: b.effective_at, reason: b.reason } };
    }
    throw new Error(op.t);
  },
  async execute(op, m) {
    const tok = m.U[op.user ?? op.w?.user];
    if (op.t === 'asof') {
      const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
      const r = await c.req('GET', `/me?as_of=${q(iso(op.T))}${op.K !== undefined ? `&known_at=${q(iso(op.K))}` : ''}`, { token: tok });
      return { status: r.status, body: r.body };
    }
    if (op.t === 'revisions') { const r = await c.req('GET', `/payments/${op.p.id}/revisions`, { token: tok }); return { status: r.status, body: r.body }; }
    if (op.t === 'pay') { const r = await c.req('POST', '/payments', { token: tok, key: op.key, body: op.body }); return { status: r.status, body: r.body }; }
    if (op.t === 'correct') { const r = await c.req('POST', `/payments/${op.p.id}/corrections`, { token: tok, key: op.key, body: op.body }); return { status: r.status, body: r.body }; }
    const w = op.w;
    const r = await c.req('POST', `/payments/${w.pid}/corrections`, { token: m.U[w.user], key: w.key, body: op.body });
    return { status: r.status, body: r.body };
  },
  mismatch(e, o) {
    if (o.status !== e.status) return `status: expected ${e.status} ${e.code ?? ''}, got ${o.status} ${JSON.stringify(o.body)?.slice(0, 200)}`;
    if (e.code && code(o) !== e.code) return `code: expected ${e.code}, got ${code(o)}`;
    if (e.sameAs !== undefined && !deepEqual(o.body, e.sameAs)) return 'replay body differs';
    if (e.balance !== undefined && o.body?.balance !== e.balance) return `as_of balance: expected ${e.balance}, got ${o.body?.balance}`;
    if (e.balance !== undefined && !(o.body?.total === o.body?.balance && o.body?.available === o.body?.total - o.body?.held)) return `view fields inconsistent ${JSON.stringify(o.body)}`;
    if (e.revs && !deepEqual(o.body?.revisions?.map((r) => [r.revision, r.amount]), e.revs)) return `revisions: expected ${JSON.stringify(e.revs)}, got ${JSON.stringify(o.body?.revisions)}`;
    if (e.corr) { const got = Object.fromEntries(Object.keys(e.corr).map((k) => [k, o.body?.[k]])); if (got.effective_at && Date.parse(got.effective_at) === Date.parse(e.corr.effective_at)) got.effective_at = e.corr.effective_at; if (!deepEqual(got, e.corr)) return `correction: expected ${JSON.stringify(e.corr)}, got ${JSON.stringify(got)}`; }
    if (e.pay && (o.body?.amount !== e.pay.amount || o.body?.from_handle !== e.pay.from || o.body?.to_handle !== e.pay.to)) return 'payment body';
    return null;
  },
  bind(m, op, o) {
    if (o.status !== 201) return;
    if (op.t === 'pay') {
      const t = Date.parse(o.body.created_at);
      m.payments.push({ id: o.body.payment_id, from: op.user, to: op.body.to_handle, created: t, revs: [{ amount: op.body.amount, eff: t, rec: t }] });
    }
    if (op.t === 'correct') {
      op.p.revs.push({ amount: op.body.amount, eff: Date.parse(o.body.effective_at), rec: Date.parse(o.body.recorded_at) });
      m.writes.push({ user: op.user, pid: op.p.id, key: op.key, body: op.body, canon: canon(op.body), response: o.body });
    }
  },
  async compareState(m, i) {
    if (i % 5 !== 4) return null;
    const inv = []; const I = (ok, w) => inv.push(`${ok ? 'held' : 'VIOLATED'}: ${w}`);
    const expected = { now: {}, stmt: {} }, observed = { now: {}, stmt: {} };
    let sum = 0;
    for (const h of H) {
      expected.now[h] = balanceAt(m, h);
      const me = (await c.req('GET', '/me', { token: m.U[h] })).body;
      observed.now[h] = me?.balance; sum += me?.balance;
      const st = (await c.req('GET', '/statement?limit=200', { token: m.U[h] })).body;
      const mine = m.payments.filter((p) => p.from === h || p.to === h).map((p) => ({ p, r: p.revs.at(-1) }))
        .sort((a, b) => a.r.eff - b.r.eff || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0));
      let bal = OPEN;
      expected.stmt[h] = { opening: OPEN, entries: mine.map(({ p, r }) => { const d = p.from === h ? -r.amount : r.amount; bal += d; return [p.id, d, bal, p.revs.length]; }), closing: bal };
      observed.stmt[h] = { opening: st?.opening_balance, entries: (st?.entries ?? []).map((e) => [e.payment.payment_id, e.delta, e.balance_after, e.revision]), closing: st?.closing_balance };
      // Boundaries combine all movements at one instant (spec): only the last entry of each
      // distinct effective instant is a boundary balance; mid-instant balance_after may dip.
      const es = st?.entries ?? [];
      I(es.every((e, j) => j + 1 < es.length && Date.parse(es[j + 1].effective_at) === Date.parse(e.effective_at) ? true : e.balance_after >= 0), `statement of ${h} nonnegative at every boundary`);
    }
    I(sum === H.length * OPEN, `sum ${sum} = seeded total`);
    const v = c.violations.splice(0);
    I(!v.length, `protocol ${v.join('; ')}`);
    return { expected, observed, invariants: inv };
  },
};
