// Reference-model campaign for commit/campaign.ts. A deliberately small model of the
// stage-1 behaviour (balances, requests, payments, splits, settlements, idempotency keys,
// feed visibility), written from the specification and sharing no code with the candidate.
// Every operation's reply is compared, and every few operations the whole observable state
// (balances, each user's requests and feed) is compared and the §1 invariants are checked.
import { client, code, deepEqual, shares, PASSWORD } from './lib.mjs';

const HANDLES = ['ada', 'bob', 'cy', 'dan', 'op'];
const OPERATOR = 'op';
const MAX = 1000000000;
const COMPARE_EVERY = Number(process.env.REF_COMPARE_EVERY ?? 4);
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

let c;

function initial(r) {
  return {
    currency: 'EUR', minor_units: 2,
    users: HANDLES.map((h) => ({ id: `u_${h}`, email: `${h}@example.com`, password: PASSWORD, display_name: h.toUpperCase(), handle: h, balance: h === 'op' ? r.range(0, 50) : r.range(0, 3000) })),
    payments: [{ id: 'p_1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 5, note: 'seed', visibility: 'private' }],
    requests: [{ id: 'rq_1', requester_id: 'u_bob', payer_id: 'u_cy', amount: 40, note: 'seed', status: 'pending' }],
    settlement_operator_ids: ['u_op'],
  };
}

export default {
  name: 'pocketful-stage-1-reference',

  async setup(baseUrl, r) {
    c = client(baseUrl);
    const fx = initial(r);
    const res = await c.req('POST', '/_test/reset', { body: fx });
    if (res.status !== 204) throw new Error(`reset ${res.status}`);
    const users = {};
    for (const u of fx.users) {
      const l = await c.req('POST', '/auth/login', { body: { email: u.email, password: u.password } });
      users[u.handle] = { id: l.body.user_id, token: l.body.token, balance: u.balance };
    }
    const model = {
      total: fx.users.reduce((s, u) => s + u.balance, 0),
      users,
      payments: [{ id: 'p_1', from: 'ada', to: 'bob', amount: 5, visibility: 'private' }],
      requests: [{ id: 'rq_1', requester: 'bob', payer: 'cy', amount: 40, status: 'pending', payment_id: null }],
      keys: new Map(), // `${user}|${path}|${key}` -> { body: canon, response }
      writes: [], // successful idempotent writes, for replays
      failedKeys: [], // { user, path, key }
      seq: 0,
    };
    return { model, initial: fx };
  },

  generate(m, r) {
    const h = () => r.pick(HANDLES);
    const two = () => { const a = h(); let b = h(); while (b === a) b = h(); return [a, b]; };
    const amount = () => {
      const x = r.int(20);
      if (x === 0) return r.pick([0, -1, MAX + 1, 2.5, '10', true, null]);
      if (x < 3) return r.range(1, 6000);
      return r.range(1, 400);
    };
    const key = (user, path) => {
      const failed = m.failedKeys.filter((f) => f.user === user && f.path === path);
      if (failed.length && r.chance(0.3)) return r.pick(failed).key;
      return `key-${++m.seq}`;
    };
    const vis = () => r.pick([undefined, undefined, 'public', 'private', ...(r.chance(0.05) ? ['secret'] : [])]);
    const x = r.int(100);
    if (x < 10 && m.writes.length) {
      const w = r.pick(m.writes);
      if (r.chance(0.7)) return { t: 'replay', w, body: w.body };
      const body = w.path.endsWith('/pay') ? (w.body.visibility === 'private' ? { visibility: 'public' } : { visibility: 'private' }) : { ...w.body, amount: typeof w.body.amount === 'number' ? w.body.amount + 1 : 1, transfers: w.body.transfers ? [...w.body.transfers, w.body.transfers[0]].slice(0, 32) : undefined };
      if (!w.body.transfers) delete body.transfers;
      return { t: 'replay', w, body };
    }
    if (x < 38) {
      const [from, to] = two();
      const target = r.chance(0.05) ? 'ghost' : r.chance(0.04) ? from : to;
      const body = { to_handle: target, amount: amount() };
      const v = vis(); if (v !== undefined) body.visibility = v;
      if (r.chance(0.1)) body.note = r.chance(0.2) ? 'n'.repeat(201) : 'note ✓';
      return { t: 'pay', user: from, path: '/payments', key: key(from, '/payments'), body };
    }
    if (x < 52) {
      const [req, payer] = two();
      const target = r.chance(0.05) ? 'ghost' : r.chance(0.04) ? req : payer;
      return { t: 'ask', user: req, path: '/requests', key: key(req, '/requests'), body: { payer_handle: target, amount: amount() } };
    }
    if (x < 68 && m.requests.length) {
      const q = r.pick(m.requests);
      const user = r.chance(0.85) ? q.payer : h();
      const path = `/requests/${q.id}/pay`;
      const body = {}; const v = vis(); if (v !== undefined) body.visibility = v;
      return { t: 'payreq', q, user, path, key: key(user, path), body };
    }
    if (x < 76 && m.requests.length) {
      const q = r.pick(m.requests);
      const decline = r.chance(0.5);
      const user = r.chance(0.8) ? (decline ? q.payer : q.requester) : h();
      return { t: decline ? 'decline' : 'cancel', q, user };
    }
    if (x < 86) {
      const user = h();
      const n = r.range(1, 4);
      const ps = [...HANDLES].sort(() => r.next() - 0.5).slice(0, n);
      if (r.chance(0.05)) ps.push(ps[0]);
      if (r.chance(0.03)) ps.push('ghost');
      return { t: 'split', user, path: '/splits', key: key(user, '/splits'), body: { amount: r.chance(0.1) ? amount() : r.range(1, 100), participant_handles: ps } };
    }
    if (x < 96) {
      const user = r.chance(0.9) ? OPERATOR : h();
      const n = r.chance(0.03) ? 33 : r.range(1, 4);
      const transfers = Array.from({ length: n }, () => {
        const [a, b] = two();
        const e = { from_handle: a, to_handle: r.chance(0.04) ? a : r.chance(0.03) ? 'ghost' : b, amount: r.chance(0.05) ? r.pick([0, 1.5, '3']) : r.range(1, 1500) };
        const v = vis(); if (v !== undefined) e.visibility = v;
        return e;
      });
      return { t: 'settle', user, path: '/settlements', key: key(user, '/settlements'), body: { transfers } };
    }
    return { t: 'read', user: h() };
  },

  // Reference transition. The model objects a successful write creates are remembered on
  // the operation so bind() can attach the identifiers the candidate chose.
  step(m, op) {
    const res = this.transition(m, op);
    if (res.created) { Object.defineProperty(op, '_created', { value: res.created, enumerable: false }); delete res.created; }
    return res;
  },

  transition(m, op) {
    const err = (status, errCode) => ({ status, code: errCode });
    if (op.t === 'read') return { status: 200 };
    if (op.t === 'replay') {
      const { w, body } = op;
      if (canon(body) === w.canonBody) return { status: 200, sameAs: w.response };
      return err(409, 'idempotency_key_reuse');
    }
    if (op.t === 'decline' || op.t === 'cancel') {
      const q = op.q;
      const allowed = op.t === 'decline' ? q.payer : q.requester;
      if (op.user !== allowed) return err(403, 'forbidden');
      const target = op.t === 'decline' ? 'declined' : 'cancelled';
      if (q.status === target) return { status: 200, request: { status: target } };
      if (q.status !== 'pending') return err(409, 'request_not_pending');
      q.status = target;
      return { status: 200, request: { status: target } };
    }
    const slot = `${op.user}|${op.path}|${op.key}`;
    const claimed = m.keys.get(slot);
    if (claimed) return claimed.body === canon(op.body) ? { status: 200, sameAs: claimed.response } : err(409, 'idempotency_key_reuse');
    const validAmount = (a) => typeof a === 'number' && Number.isInteger(a) && a >= 1 && a <= MAX;
    const validVis = (b) => b.visibility === undefined || b.visibility === 'public' || b.visibility === 'private';
    const validNote = (b) => b.note === undefined || (typeof b.note === 'string' && [...b.note].length <= 200);
    const fail = (e) => { m.failedKeys.push({ user: op.user, path: op.path, key: op.key }); return e; };
    const U = m.users;
    if (op.t === 'pay') {
      const b = op.body;
      if (!validAmount(b.amount) || !validVis(b) || !validNote(b)) return fail(err(422, 'validation_failed'));
      if (!U[b.to_handle]) return fail(err(404, 'not_found'));
      if (b.to_handle === op.user) return fail(err(422, 'self_payment'));
      if (U[op.user].balance < b.amount) return fail(err(409, 'insufficient_funds'));
      U[op.user].balance -= b.amount; U[b.to_handle].balance += b.amount;
      const p = { id: null, from: op.user, to: b.to_handle, amount: b.amount, visibility: b.visibility ?? 'public' };
      m.payments.push(p);
      return { status: 201, payment: { from_handle: op.user, to_handle: b.to_handle, amount: b.amount, visibility: p.visibility, note: b.note ?? '', request_id: null, settlement_id: null }, created: { payment: p } };
    }
    if (op.t === 'ask') {
      const b = op.body;
      if (!validAmount(b.amount)) return fail(err(422, 'validation_failed'));
      if (!U[b.payer_handle]) return fail(err(404, 'not_found'));
      if (b.payer_handle === op.user) return fail(err(422, 'self_request'));
      const q = { id: null, requester: op.user, payer: b.payer_handle, amount: b.amount, status: 'pending', payment_id: null };
      m.requests.push(q);
      return { status: 201, request: { requester_handle: op.user, payer_handle: b.payer_handle, amount: b.amount, status: 'pending', payment_id: null }, created: { request: q } };
    }
    if (op.t === 'payreq') {
      const q = op.q;
      // plan A-01: permission (403) before field validation, then state (409).
      if (op.user !== q.payer) return fail(err(403, 'forbidden'));
      if (!validVis(op.body)) return fail(err(422, 'validation_failed'));
      if (q.status !== 'pending') return fail(err(409, 'request_not_pending'));
      if (U[q.payer].balance < q.amount) return fail(err(409, 'insufficient_funds'));
      U[q.payer].balance -= q.amount; U[q.requester].balance += q.amount;
      const p = { id: null, from: q.payer, to: q.requester, amount: q.amount, visibility: op.body.visibility ?? 'public' };
      m.payments.push(p);
      q.status = 'paid';
      return { status: 201, payment: { from_handle: q.payer, to_handle: q.requester, amount: q.amount, visibility: p.visibility, request_id: q.id, settlement_id: null }, created: { payment: p, paidRequest: q } };
    }
    if (op.t === 'split') {
      const b = op.body;
      if (!validAmount(b.amount)) return fail(err(422, 'validation_failed'));
      if (new Set(b.participant_handles).size !== b.participant_handles.length) return fail(err(422, 'validation_failed'));
      if (b.participant_handles.some((x) => !U[x])) return fail(err(404, 'not_found'));
      const sh = shares(b.amount, b.participant_handles.length);
      const reqs = [];
      b.participant_handles.forEach((x, i) => {
        if (x === op.user) return;
        const q = { id: null, requester: op.user, payer: x, amount: sh[i], status: 'pending', payment_id: null };
        m.requests.push(q); reqs.push(q);
      });
      return { status: 201, split: { shares: b.participant_handles.map((x, i) => ({ handle: x, amount: sh[i] })), requests: reqs.map((q) => [q.payer, q.amount]) }, created: { requests: reqs } };
    }
    if (op.t === 'settle') {
      if (op.user !== OPERATOR) return err(403, 'forbidden'); // claims nothing either way
      const ts = op.body.transfers;
      if (ts.length < 1 || ts.length > 32) return fail(err(422, 'validation_failed'));
      for (const e of ts) {
        if (!validAmount(e.amount) || !validVis(e) || !validNote(e)) return fail(err(422, 'validation_failed'));
        if (!U[e.from_handle] || !U[e.to_handle]) return fail(err(404, 'not_found'));
        if (e.from_handle === e.to_handle) return fail(err(422, 'self_payment'));
      }
      const net = Object.fromEntries(HANDLES.map((x) => [x, U[x].balance]));
      for (const e of ts) { net[e.from_handle] -= e.amount; net[e.to_handle] += e.amount; }
      if (Object.values(net).some((v) => v < 0)) return fail(err(409, 'insufficient_funds'));
      for (const x of HANDLES) U[x].balance = net[x];
      const ps = ts.map((e) => ({ id: null, from: e.from_handle, to: e.to_handle, amount: e.amount, visibility: e.visibility ?? 'public' }));
      m.payments.push(...ps);
      return { status: 201, settlement: ts.map((e) => [e.from_handle, e.to_handle, e.amount, e.visibility ?? 'public']), created: { payments: ps } };
    }
    throw new Error(`unknown op ${op.t}`);
  },

  async execute(op, m) {
    if (op.t === 'read') {
      const r = await c.req('GET', '/me', { token: m.users[op.user].token });
      return { status: r.status, body: r.body };
    }
    if (op.t === 'decline' || op.t === 'cancel') {
      const r = await c.req('POST', `/requests/${op.q.id}/${op.t}`, { token: m.users[op.user].token });
      return { status: r.status, body: r.body };
    }
    const w = op.t === 'replay' ? op.w : op;
    const r = await c.req('POST', w.path, { token: m.users[w.user].token, key: w.key, body: op.body });
    return { status: r.status, body: r.body };
  },

  mismatch(e, o) {
    if (o.status !== e.status) return `status: expected ${e.status}${e.code ? ' ' + e.code : ''}, got ${o.status} ${JSON.stringify(o.body)?.slice(0, 200)}`;
    if (e.code && code(o) !== e.code) return `code: expected ${e.code}, got ${code(o)}`;
    if (e.sameAs !== undefined && !deepEqual(o.body, e.sameAs)) return 'replay body differs from the original response';
    const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj?.[k]]));
    if (e.payment) {
      const got = pick(o.body, Object.keys(e.payment));
      if (!deepEqual(got, e.payment)) return `payment: expected ${JSON.stringify(e.payment)}, got ${JSON.stringify(got)}`;
    }
    if (e.request) {
      const got = pick(o.body, Object.keys(e.request));
      if (!deepEqual(got, e.request)) return `request: expected ${JSON.stringify(e.request)}, got ${JSON.stringify(got)}`;
    }
    if (e.split) {
      const got = { shares: o.body?.shares, requests: (o.body?.requests ?? []).map((q) => [q.payer_handle, q.amount]) };
      if (!deepEqual(got, e.split)) return `split: expected ${JSON.stringify(e.split)}, got ${JSON.stringify(got)}`;
    }
    if (e.settlement) {
      const got = (o.body?.payments ?? []).map((p) => [p.from_handle, p.to_handle, p.amount, p.visibility]);
      if (!deepEqual(got, e.settlement)) return `settlement members: expected ${JSON.stringify(e.settlement)}, got ${JSON.stringify(got)}`;
      if (!(o.body?.payments ?? []).every((p) => p.settlement_id === o.body.settlement_id && p.created_at === o.body.committed_at && p.request_id === null)) return 'settlement members not linked / not sharing committed_at';
    }
    return null;
  },

  bind(m, op, o) {
    if (o.status !== 201) return;
    const cr = op._created;
    if (!cr) return;
    if (cr.payment) cr.payment.id = o.body.payment_id;
    if (cr.paidRequest) cr.paidRequest.payment_id = o.body.payment_id;
    if (cr.request) cr.request.id = o.body.request_id;
    if (cr.requests) cr.requests.forEach((q, i) => { q.id = o.body.requests[i].request_id; });
    if (cr.payments) cr.payments.forEach((p, i) => { p.id = o.body.payments[i].payment_id; });
    const slot = `${op.user}|${op.path}|${op.key}`;
    m.keys.set(slot, { body: canon(op.body), response: o.body });
    m.writes.push({ user: op.user, path: op.path, key: op.key, body: op.body, canonBody: canon(op.body), response: o.body });
  },

  async compareState(m, index) {
    const fdIds = (h, id) => typeof id === 'string' && m.payments.some((p) => p.id === id);
    if (index % COMPARE_EVERY !== COMPARE_EVERY - 1) return null;
    // commit/campaign.ts treats an invariant as broken only when it starts with "VIOLATED".
    const invariants = [];
    const inv = (ok, what) => invariants.push(`${ok ? 'held' : 'VIOLATED'}: ${what}`);
    const expected = { balances: {}, requests: {}, feeds: {} };
    const observed = { balances: {}, requests: {}, feeds: {} };
    let sum = 0;
    for (const h of HANDLES) {
      const tok = m.users[h].token;
      expected.balances[h] = m.users[h].balance;
      const me = await c.req('GET', '/me', { token: tok });
      observed.balances[h] = me.body?.balance;
      sum += me.body?.balance ?? NaN;
      inv(Number.isInteger(me.body?.balance) && me.body.balance >= 0, `balance of ${h} is a non-negative integer (${me.body?.balance})`);
      const rq = (await c.req('GET', '/requests?limit=200', { token: tok })).body?.requests ?? [];
      const mine = m.requests.filter((q) => q.requester === h || q.payer === h);
      expected.requests[h] = mine.map((q) => [q.id, q.status, q.amount, q.payment_id]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      observed.requests[h] = rq.map((q) => [q.request_id, q.status, q.amount, q.payment_id]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      inv(mine.length <= 200, `requests of ${h} fit one page`);
      inv(rq.every((q, i) => i === 0 || Date.parse(rq[i - 1].created_at) >= Date.parse(q.created_at)), `requests of ${h} newest first`);
      inv(rq.every((q) => q.status !== 'paid' || fdIds(h, q.payment_id)), `paid requests of ${h} carry a payment id`);
      const fd = (await c.req('GET', '/activity?limit=200', { token: tok })).body?.payments ?? [];
      const visible = m.payments.filter((p) => p.visibility === 'public' || p.from === h || p.to === h);
      expected.feeds[h] = visible.slice(-200).map((p) => p.id).sort();
      observed.feeds[h] = fd.map((p) => p.payment_id).sort();
      if (visible.length > 200) { expected.feeds[h] = expected.feeds[h].length; observed.feeds[h] = fd.length; }
      inv(fd.every((p, i) => i === 0 || Date.parse(fd[i - 1].created_at) >= Date.parse(p.created_at)), `feed of ${h} newest first`);
      inv(fd.every((p) => p.visibility === 'public' || p.from_handle === h || p.to_handle === h), `feed of ${h} obeys the visibility rule`);
    }
    inv(sum === m.total, `sum of balances ${sum} equals seeded total ${m.total}`);
    const v = c.violations.splice(0);
    inv(v.length === 0, `protocol (no 5xx, content type, envelope, timestamps, id length)${v.length ? ': ' + v.join('; ') : ''}`);
    return { expected, observed, invariants };
  },
};
