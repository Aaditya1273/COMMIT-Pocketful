// Shared helpers for the stage-1 verification suite. Written from the specification
// (pocketful/spec/stage-1.md) only; shares no code with the candidate.

export const PASSWORD = 'correct horse';
export const TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?([+-]\d\d:\d\d|Z)$/;

// mulberry32, identical to commit/lib/rng.ts so seeds mean the same thing everywhere.
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  return { seed, next, int, range: (lo, hi) => lo + int(hi - lo + 1), pick: (xs) => xs[int(xs.length)], chance: (p) => next() < p };
}

// HTTP client that records every protocol-level violation it sees on the way:
// 5xx, missing/incorrect content type, non-envelope errors, bad timestamps, long ids.
export function client(base, { requestTimeoutMs = 5000, testTimeoutMs = 10000 } = {}) {
  const violations = [];
  let count = 0;
  let noResponse = 0;
  const scan = (v, where) => {
    if (Array.isArray(v)) { v.forEach((x, i) => scan(x, `${where}[${i}]`)); return; }
    if (v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k.endsWith('_at') && x !== null && (typeof x !== 'string' || !TS_RE.test(x))) violations.push(`timestamp ${where}.${k}=${JSON.stringify(x)}`);
      if ((k === 'id' || k.endsWith('_id')) && typeof x === 'string' && x.length > 64) violations.push(`id longer than 64 at ${where}.${k}`);
      if ((k === 'amount' || k === 'balance') && !(Number.isInteger(x) && x >= 0 && x <= 2 ** 53)) violations.push(`${k} not a non-negative integer at ${where}: ${JSON.stringify(x)}`);
      scan(x, `${where}.${k}`);
    }
  };
  async function req(method, path, o = {}) {
    const headers = { ...(o.headers ?? {}) };
    let body;
    if (o.raw !== undefined) { body = o.raw; headers['content-type'] ??= 'application/json'; }
    else if (o.body !== undefined) { body = JSON.stringify(o.body); headers['content-type'] = 'application/json'; }
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.key !== undefined) headers['idempotency-key'] = o.key;
    const timeout = o.timeout ?? (path.startsWith('/_test/') ? testTimeoutMs : requestTimeoutMs);
    count++;
    let res;
    const t0 = Date.now();
    try {
      res = await fetch(base + path, { method, headers, body, signal: o.signal ?? AbortSignal.timeout(timeout) });
    } catch (e) {
      if (o.signal) return { status: 0, aborted: true, body: null, text: '' };
      violations.push(`${method} ${path}: no response within ${timeout} ms (${e?.cause?.code ?? e?.name ?? e})`);
      // A service that stops answering is a failure; do not spend minutes timing out on it.
      if (++noResponse >= 3) { console.error(`FAIL: ${noResponse} requests without a response; last: ${method} ${path}`); process.exit(1); }
      return { status: 0, body: null, text: '', error: String(e) };
    }
    let text;
    try { text = await res.text(); } catch (e) {
      if (o.signal) return { status: 0, aborted: true, body: null, text: '' };
      throw e;
    }
    const ms = Date.now() - t0;
    let json = null;
    let parsed = false;
    if (text !== '') { try { json = JSON.parse(text); parsed = true; } catch { /* recorded below */ } }
    const ct = res.headers.get('content-type') ?? '';
    const tag = `${method} ${path} -> ${res.status}`;
    if (res.status >= 500) violations.push(`5xx: ${tag} ${text.slice(0, 200)}`);
    if (res.status === 204 && text !== '') violations.push(`204 with a body on ${tag}: ${text.slice(0, 80)}`);
    if (res.status !== 204) {
      if (!/^application\/json;\s*charset=utf-8$/i.test(ct.trim())) violations.push(`content-type "${ct}" on ${tag}`);
      if (!parsed) violations.push(`non-JSON body on ${tag}: ${text.slice(0, 80)}`);
    }
    if (res.status >= 400) {
      const e = json?.error;
      if (!e || typeof e.code !== 'string' || typeof e.message !== 'string') violations.push(`error envelope missing on ${tag}: ${text.slice(0, 120)}`);
    }
    // The export state is opaque and implementation-defined (§10): only the envelope is scanned.
    if (parsed) scan(path === '/_test/export' && json && typeof json === 'object' ? { ...json, state: null } : json, tag);
    return { status: res.status, body: json, text, ms, ct };
  }
  return { base, req, violations, get count() { return count; } };
}

export const code = (r) => r?.body?.error?.code;

// A small canonical fixture. Handles and ids follow the specification's example style,
// so generated ids colliding with fixture ids would be caught.
export function fixture(over = {}) {
  const users = over.users ?? [
    { id: 'u_ada', email: 'ada@example.com', password: PASSWORD, display_name: 'Ada', handle: 'ada', balance: 10000 },
    { id: 'u_bob', email: 'bob@example.com', password: PASSWORD, display_name: 'Bob', handle: 'bob', balance: 2500 },
    { id: 'u_cy', email: 'cy@example.com', password: PASSWORD, display_name: 'Cy', handle: 'cy', balance: 0 },
    { id: 'u_dan', email: 'dan@example.com', password: PASSWORD, display_name: 'Dan', handle: 'dan', balance: 5000 },
    { id: 'u_op', email: 'op@example.com', password: PASSWORD, display_name: 'Operator', handle: 'op', balance: 0 },
  ];
  const fx = {
    currency: over.currency ?? 'EUR',
    minor_units: over.minor_units ?? 2,
    users,
    payments: over.payments ?? [
      { id: 'p_1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 500, note: 'coffee', visibility: 'public' },
      { id: 'p_2', from_user_id: 'u_bob', to_user_id: 'u_dan', amount: 100, note: 'secret', visibility: 'private' },
    ],
    requests: over.requests ?? [
      { id: 'rq_1', requester_id: 'u_bob', payer_id: 'u_ada', amount: 1200, note: 'taxi', status: 'pending' },
    ],
  };
  if (over.settlement_operator_ids !== undefined) fx.settlement_operator_ids = over.settlement_operator_ids;
  else fx.settlement_operator_ids = ['u_op'];
  return fx;
}

export const total = (fx) => fx.users.reduce((s, u) => s + u.balance, 0);

/** Reset to the fixture and log every user in. Returns tokens and ids by handle. */
export async function seed(c, fx = fixture()) {
  const r = await c.req('POST', '/_test/reset', { body: fx });
  if (r.status !== 204) throw new Error(`reset returned ${r.status} ${r.text.slice(0, 200)}`);
  const tok = {}, id = {};
  await Promise.all(fx.users.map(async (u) => {
    const l = await c.req('POST', '/auth/login', { body: { email: u.email, password: u.password } });
    if (l.status !== 200) throw new Error(`login ${u.email} returned ${l.status}`);
    tok[u.handle] = l.body.token;
    id[u.handle] = l.body.user_id;
  }));
  return { fx, tok, id };
}

export async function balances(c, tok) {
  const out = {};
  await Promise.all(Object.entries(tok).map(async ([h, t]) => {
    const r = await c.req('GET', '/me', { token: t });
    out[h] = r.status === 200 ? r.body.balance : `status ${r.status}`;
  }));
  return out;
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return deepEqual(ka, kb) && ka.every((k) => deepEqual(a[k], b[k]));
}

/** §9: whole units, sum = amount, differ by ≤1, larger shares first. */
export function shares(amount, n) {
  const base = Math.floor(amount / n), extra = amount - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

let keySeq = 0;
export const newKey = (p = 'k') => `${p}-${process.pid}-${Date.now().toString(36)}-${++keySeq}`;
