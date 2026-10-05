'use strict';
// Pocketful stage 3 — stages 1 and 2 (payments, requests, splits, feed, settlements,
// authorizations, browser UI) plus a revisioned ledger: historical balances (as_of /
// known_at), statements with stable snapshots, and payment corrections.
//
// Single process, in-memory state. Every state read-modify-write runs in one
// synchronous section of the event loop (after the request body has been read and
// before any await), so balance checks, debits, credits and idempotency claims are
// atomic with respect to every other request. Only password hashing is async, and it
// never touches balances.

const http = require('node:http');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const MAX_AMOUNT = 1000000000;
const MAX_NOTE = 200;
const MAX_KEY = 255;
const MAX_TRANSFERS = 32;
const HANDLE_RE = /^[a-z0-9_]{1,20}$/;
const DIGITS_RE = /^[0-9]+$/;
const MAX_BODY = 64 * 1024 * 1024;
const BALANCE_LIMIT = 2 ** 53;
const STATUSES = new Set(['pending', 'paid', 'declined', 'cancelled']);
const VISIBILITIES = new Set(['public', 'private']);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const AUTH_STATUSES = new Set(['open', 'captured', 'voided', 'expired']);
const DEFAULT_TTL_SECONDS = 600;
const ui = require('./ui.js');

// ---------------------------------------------------------------------------
// Errors

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
const malformed = (m) => new HttpError(400, 'malformed_request', m);
const invalid = (m) => new HttpError(422, 'validation_failed', m);
const notFound = (m) => new HttpError(404, 'not_found', m || 'not found');
const forbidden = (m) => new HttpError(403, 'forbidden', m || 'forbidden');
const unauthenticated = () => new HttpError(401, 'unauthenticated', 'missing or unknown bearer token');

// ---------------------------------------------------------------------------
// Small helpers

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const codePoints = (s) => {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line no-unused-vars
  return n;
};
const isSafeInt = (v) => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= BALANCE_LIMIT;

function formatTs(ms) {
  return new Date(ms).toISOString().replace('Z', '+00:00');
}

// JSON value equality for idempotency bodies: key order and whitespace never
// matter; numbers compare by value (JSON.parse already maps 1e3 and 1000.0 to 1000).
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (isObject(v)) {
    return '{' + Object.keys(v).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  if (typeof v === 'number') {
    if (Number.isFinite(v)) return String(v);
    return v > 0 ? '"+Infinity"#' : '"-Infinity"#';
  }
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Passwords (scrypt; parameters stored with each hash)

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const HASH_RE = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;

function validHash(h) {
  const m = typeof h === 'string' && HASH_RE.exec(h);
  if (!m) return false;
  const N = Number(m[1]); const r = Number(m[2]); const p = Number(m[3]);
  return N >= 2 && N <= 1048576 && (N & (N - 1)) === 0 && r >= 1 && r <= 32 && p >= 1 && p <= 16;
}

async function verifyPassword(password, stored) {
  const m = HASH_RE.exec(stored);
  if (!m) return false;
  const N = Number(m[1]); const r = Number(m[2]); const p = Number(m[3]);
  const salt = Buffer.from(m[4], 'base64');
  const expected = Buffer.from(m[5], 'base64');
  if (expected.length === 0) return false;
  try {
    const key = await scrypt(password, salt, expected.length,
      { N, r, p, maxmem: 256 * 1024 * 1024 });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

let dummyHash = null; // used so unknown-email logins cost the same as wrong passwords

// ---------------------------------------------------------------------------
// State

function emptyState() {
  return {
    currency: 'EUR',
    minorUnits: 2,
    users: new Map(), // id -> {id, email, display_name, handle, balance, password_hash}
    byHandle: new Map(),
    byEmail: new Map(), // lowercased email -> user
    tokens: new Map(), // token -> user id
    operators: new Set(),
    payments: new Map(), // id -> payment record (insertion order)
    requests: new Map(),
    splits: new Map(),
    settlements: new Map(),
    authorizations: new Map(), // id -> authorization record (insertion order)
    openHolds: new Map(), // payer user id -> Set of open authorization records
    ttlSeconds: DEFAULT_TTL_SECONDS,
    snapshots: new Map(), // token -> frozen statement result
    idem: new Map(), // scope -> {user, method, path, key, body, response}
    counter: 0,
    seq: 0,
    lastTs: 0,
  };
}

let state = emptyState();

function now(st) {
  st.lastTs = Math.max(Date.now(), st.lastTs);
  return st.lastTs;
}

function newId(st, prefix, map) {
  let id;
  do {
    st.counter += 1;
    id = prefix + st.counter;
  } while (map.has(id));
  return id;
}

function addUser(st, u) {
  st.users.set(u.id, u);
  st.byHandle.set(u.handle, u);
  st.byEmail.set(u.email.toLowerCase(), u);
}

function issueToken(st, userId) {
  const token = crypto.randomBytes(24).toString('base64url');
  st.tokens.set(token, userId);
  return token;
}

// ---------------------------------------------------------------------------
// Rendering

function renderPayment(st, p) {
  const from = st.users.get(p.from);
  const to = st.users.get(p.to);
  return {
    payment_id: p.id,
    from_user_id: p.from,
    from_handle: from.handle,
    to_user_id: p.to,
    to_handle: to.handle,
    amount: p.amount,
    currency: st.currency,
    note: p.note,
    visibility: p.visibility,
    request_id: p.request_id,
    settlement_id: p.settlement_id,
    authorization_id: p.authorization_id,
    created_at: p.created_at,
  };
}

// ---- holds ----------------------------------------------------------------------
// An open authorization holds its remaining amount until it is captured, voided or
// reaches expires_at. Expiry is evaluated against the clock on every read and write,
// so nothing has to run at the deadline itself.

function expireIfDue(st, a, at = Date.now()) {
  if (a.status === 'open' && a.expires_ts <= at) {
    a.status = 'expired';
    a.remaining = 0;
    a.closed_ts = a.expires_ts;
    releaseHold(st, a);
  }
  return a;
}

function trackHold(st, a) {
  let set = st.openHolds.get(a.from);
  if (!set) st.openHolds.set(a.from, (set = new Set()));
  set.add(a);
}

function releaseHold(st, a) {
  const set = st.openHolds.get(a.from);
  if (set) set.delete(a);
}

function heldBy(st, userId, at = Date.now()) {
  const set = st.openHolds.get(userId);
  if (!set) return 0;
  let held = 0;
  for (const a of [...set]) {
    expireIfDue(st, a, at);
    if (a.status === 'open') held += a.remaining;
  }
  return held;
}

const availableOf = (st, user) => user.balance - heldBy(st, user.id);

function renderAuthorization(st, a) {
  expireIfDue(st, a);
  const from = st.users.get(a.from);
  const to = st.users.get(a.to);
  return {
    authorization_id: a.id,
    from_user_id: a.from,
    from_handle: from.handle,
    to_user_id: a.to,
    to_handle: to.handle,
    amount: a.amount,
    captured_amount: a.captured,
    remaining_amount: a.status === 'open' ? a.remaining : 0,
    currency: st.currency,
    note: a.note,
    visibility: a.visibility,
    status: a.status,
    expires_at: a.expires_at,
    closed_at: a.status === 'open' ? null : a.status === 'expired' ? a.expires_at : formatTs(a.closed_ts),
    payment_id: a.payment_ids.length ? a.payment_ids[a.payment_ids.length - 1] : null,
    payment_ids: [...a.payment_ids],
    created_at: a.created_at,
  };
}

function renderRequest(st, r) {
  const requester = st.users.get(r.requester);
  const payer = st.users.get(r.payer);
  return {
    request_id: r.id,
    requester_id: r.requester,
    requester_handle: requester.handle,
    payer_id: r.payer,
    payer_handle: payer.handle,
    amount: r.amount,
    currency: st.currency,
    note: r.note,
    status: r.status,
    payment_id: r.payment_id,
    created_at: r.created_at,
  };
}

const newestFirst = (a, b) => (b.ts - a.ts) || (b.seq - a.seq);

// ---------------------------------------------------------------------------
// Field validation

function parseAmount(v) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_AMOUNT) {
    throw invalid('amount must be an integer from 1 to 1000000000');
  }
  return v;
}

function parseNote(v) {
  if (v === undefined) return '';
  if (typeof v !== 'string') throw invalid('note must be a string');
  if (codePoints(v) > MAX_NOTE) throw invalid('note is longer than 200 characters');
  return v;
}

function parseVisibility(v) {
  if (v === undefined) return 'public';
  if (typeof v !== 'string' || !VISIBILITIES.has(v)) throw invalid('visibility must be public or private');
  return v;
}

// A required string field: wrong JSON type is 400, absence is 422.
function checkStringType(body, name) {
  const v = body[name];
  if (v !== undefined && typeof v !== 'string') throw malformed(`${name} must be a string`);
}
function requireString(body, name) {
  const v = body[name];
  if (v === undefined) throw invalid(`${name} is required`);
  return v;
}

function parsePaging(query) {
  const out = { limit: 50, offset: 0 };
  const limit = query.get('limit');
  if (limit !== null) {
    if (!DIGITS_RE.test(limit)) throw invalid('limit must be an integer from 1 to 200');
    const n = Number(limit);
    if (n < 1 || n > 200) throw invalid('limit must be an integer from 1 to 200');
    out.limit = n;
  }
  const offset = query.get('offset');
  if (offset !== null) {
    if (!DIGITS_RE.test(offset)) throw invalid('offset must be an integer of 0 or more');
    out.offset = Number(offset);
  }
  return out;
}

function page(items, { limit, offset }) {
  return { items: items.slice(offset, offset + limit), hasMore: offset + limit < items.length };
}

// ---------------------------------------------------------------------------
// Request context

function authenticate(ctx) {
  const header = ctx.req.headers.authorization;
  if (typeof header !== 'string') throw unauthenticated();
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  if (!m) throw unauthenticated();
  const userId = state.tokens.get(m[1]);
  const user = userId === undefined ? undefined : state.users.get(userId);
  if (!user) throw unauthenticated();
  return user;
}

// Parse the body as a JSON object. `emptyAs` substitutes for a zero-length body.
function jsonObject(ctx, emptyAs) {
  const raw = ctx.raw;
  if (raw.length === 0 && emptyAs !== undefined) return emptyAs;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw malformed('body is not valid UTF-8');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformed('body is not valid JSON');
  }
  if (!isObject(value)) throw malformed('body must be a JSON object');
  return value;
}

function idempotencyKey(ctx) {
  const key = ctx.req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw new HttpError(400, 'missing_idempotency_key', 'Idempotency-Key header is required');
  }
  if (codePoints(key) > MAX_KEY) throw invalid('Idempotency-Key must be 1 to 255 characters');
  return key;
}

// The common front half of the five idempotent write paths: authenticate, parse,
// read the key, then resolve an already-claimed key before any field or resource
// check. `perform` runs synchronously; if it throws, nothing is recorded and the key
// stays unclaimed. Returns [status, body].
function idempotentWrite(ctx, { emptyAs, perform }) {
  const user = authenticate(ctx);
  const body = jsonObject(ctx, emptyAs);
  const key = idempotencyKey(ctx);
  const st = state;
  const scope = JSON.stringify([user.id, 'POST', ctx.path, key]);
  const bodyKey = canonical(body);
  const prior = st.idem.get(scope);
  if (prior) {
    if (prior.body !== bodyKey) {
      throw new HttpError(409, 'idempotency_key_reuse', 'key already used with a different body');
    }
    return [200, prior.response];
  }
  const response = perform(st, user, body);
  st.idem.set(scope, { user: user.id, method: 'POST', path: ctx.path, key, body: bodyKey, response });
  return [201, response];
}

// ---------------------------------------------------------------------------
// Money movement (synchronous; callers have already validated everything)

function createPayment(st, {
  from, to, amount, note, visibility, requestId = null, settlementId = null, authorizationId = null, ts,
}) {
  const p = {
    id: newId(st, 'pay_', st.payments),
    from: from.id,
    to: to.id,
    amount,
    note,
    visibility,
    request_id: requestId,
    settlement_id: settlementId,
    authorization_id: authorizationId,
    ts,
    created_at: formatTs(ts),
    seq: ++st.seq,
  };
  p.revisions = [firstRevision(p)];
  st.payments.set(p.id, p);
  return p;
}

// An immediate transfer may spend only available funds (total minus open holds).
function transfer(st, from, to, amount) {
  if (availableOf(st, from) < amount) {
    throw new HttpError(409, 'insufficient_funds', 'available balance is below amount');
  }
  from.balance -= amount;
  to.balance += amount;
}

function createRequest(st, { requester, payer, amount, note, ts, splitId = null }) {
  const r = {
    id: newId(st, 'req_', st.requests),
    requester: requester.id,
    payer: payer.id,
    amount,
    note,
    status: 'pending',
    payment_id: null,
    split_id: splitId,
    ts,
    created_at: formatTs(ts),
    seq: ++st.seq,
  };
  st.requests.set(r.id, r);
  return r;
}

function equalSplit(amount, n) {
  const base = Math.floor(amount / n);
  const remainder = amount - base * n;
  const shares = [];
  for (let i = 0; i < n; i++) shares.push(base + (i < remainder ? 1 : 0));
  return shares;
}

// ---------------------------------------------------------------------------
// Handlers

function health() {
  return [200, { status: 'ok' }];
}

function getMe(ctx) {
  const user = authenticate(ctx);
  const asOf = instantParam(ctx.query, 'as_of');
  const knownAt = instantParam(ctx.query, 'known_at');
  if (asOf || knownAt) {
    const st = state;
    // "Now" covers everything already recorded, even within the current millisecond.
    const start = Math.max(Date.now(), st.lastTs);
    const T = asOf ? asOf.ms : start;
    const K = knownAt ? knownAt.ms : start;
    const total = totalAt(st, user.id, T, K);
    const heldThen = heldAt(st, user.id, T, K);
    const body = {
      user_id: user.id,
      display_name: user.display_name,
      handle: user.handle,
      balance: total,
      total,
      available: total - heldThen,
      held: heldThen,
      currency: st.currency,
      minor_units: st.minorUnits,
    };
    if (asOf) body.as_of = asOf.raw;
    if (knownAt) body.known_at = knownAt.raw;
    return [200, body];
  }
  const held = heldBy(state, user.id);
  return [200, {
    user_id: user.id,
    display_name: user.display_name,
    handle: user.handle,
    balance: user.balance,
    total: user.balance,
    available: user.balance - held,
    held,
    currency: state.currency,
    minor_units: state.minorUnits,
  }];
}

function postPayment(ctx) {
  return idempotentWrite(ctx, {
    perform(st, me, body) {
      checkStringType(body, 'to_handle');
      const handle = requireString(body, 'to_handle');
      const amount = parseAmount(body.amount);
      const note = parseNote(body.note);
      const visibility = parseVisibility(body.visibility);
      const to = st.byHandle.get(handle);
      if (!to) throw notFound('no user has that handle');
      if (to.id === me.id) throw new HttpError(422, 'self_payment', 'cannot pay yourself');
      transfer(st, me, to, amount);
      const p = createPayment(st, { from: me, to, amount, note, visibility, ts: now(st) });
      return renderPayment(st, p);
    },
  });
}

function postRequest(ctx) {
  return idempotentWrite(ctx, {
    perform(st, me, body) {
      checkStringType(body, 'payer_handle');
      const handle = requireString(body, 'payer_handle');
      const amount = parseAmount(body.amount);
      const note = parseNote(body.note);
      const payer = st.byHandle.get(handle);
      if (!payer) throw notFound('no user has that handle');
      if (payer.id === me.id) throw new HttpError(422, 'self_request', 'cannot request from yourself');
      const r = createRequest(st, { requester: me, payer, amount, note, ts: now(st) });
      return renderRequest(st, r);
    },
  });
}

function payRequest(ctx, id) {
  return idempotentWrite(ctx, {
    emptyAs: {},
    perform(st, me, body) {
      const r = st.requests.get(id);
      if (!r) throw notFound('unknown request');
      if (r.payer !== me.id) throw forbidden('only the payer may pay this request');
      const visibility = parseVisibility(body.visibility);
      if (r.status !== 'pending') throw new HttpError(409, 'request_not_pending', `request is ${r.status}`);
      const to = st.users.get(r.requester);
      transfer(st, me, to, r.amount);
      const p = createPayment(st, {
        from: me, to, amount: r.amount, note: r.note, visibility, requestId: r.id, ts: now(st),
      });
      r.status = 'paid';
      r.payment_id = p.id;
      return renderPayment(st, p);
    },
  });
}

function resolveRequest(ctx, id, action) {
  const me = authenticate(ctx);
  const st = state;
  const r = st.requests.get(id);
  if (!r) throw notFound('unknown request');
  const target = action === 'decline' ? 'declined' : 'cancelled';
  const owner = action === 'decline' ? r.payer : r.requester;
  if (owner !== me.id) {
    throw forbidden(action === 'decline' ? 'only the payer may decline' : 'only the requester may cancel');
  }
  if (r.status === 'pending') {
    r.status = target;
  } else if (r.status !== target) {
    throw new HttpError(409, 'request_not_pending', `request is ${r.status}`);
  }
  return [200, renderRequest(st, r)];
}

function listRequests(ctx) {
  const me = authenticate(ctx);
  const q = ctx.query;
  const direction = q.get('direction');
  if (direction !== null && direction !== 'incoming' && direction !== 'outgoing') {
    throw invalid('direction must be incoming or outgoing');
  }
  const status = q.get('status');
  if (status !== null && !STATUSES.has(status)) throw invalid('unknown status');
  const paging = parsePaging(q);
  const st = state;
  const mine = [];
  for (const r of st.requests.values()) {
    const incoming = r.payer === me.id;
    const outgoing = r.requester === me.id;
    if (!incoming && !outgoing) continue;
    if (direction === 'incoming' && !incoming) continue;
    if (direction === 'outgoing' && !outgoing) continue;
    if (status !== null && r.status !== status) continue;
    mine.push(r);
  }
  mine.sort(newestFirst);
  const { items, hasMore } = page(mine, paging);
  return [200, { requests: items.map((r) => renderRequest(st, r)), has_more: hasMore }];
}

function postSplit(ctx) {
  return idempotentWrite(ctx, {
    perform(st, me, body) {
      const handles = body.participant_handles;
      if (handles !== undefined) {
        if (!Array.isArray(handles)) throw malformed('participant_handles must be an array');
        for (const h of handles) {
          if (typeof h !== 'string') throw malformed('participant_handles must contain strings');
        }
      }
      const amount = parseAmount(body.amount);
      if (handles === undefined) throw invalid('participant_handles is required');
      if (handles.length === 0) throw invalid('participant_handles must not be empty');
      if (new Set(handles).size !== handles.length) throw invalid('participant_handles contains a duplicate');
      const note = parseNote(body.note);
      const participants = handles.map((h) => {
        const u = st.byHandle.get(h);
        if (!u) throw notFound(`no user has handle ${h}`);
        return u;
      });
      const shares = equalSplit(amount, participants.length);
      const ts = now(st);
      const splitId = newId(st, 'spl_', st.splits);
      const requests = [];
      participants.forEach((u, i) => {
        if (u.id === me.id) return;
        requests.push(createRequest(st, { requester: me, payer: u, amount: shares[i], note, ts, splitId }));
      });
      const split = {
        id: splitId,
        requester: me.id,
        amount,
        note,
        shares: participants.map((u, i) => ({ handle: u.handle, amount: shares[i] })),
        request_ids: requests.map((r) => r.id),
        ts,
        created_at: formatTs(ts),
        seq: ++st.seq,
      };
      st.splits.set(splitId, split);
      return {
        split_id: split.id,
        amount,
        currency: st.currency,
        note,
        shares: split.shares.map((s) => ({ handle: s.handle, amount: s.amount })),
        requests: requests.map((r) => renderRequest(st, r)),
        created_at: split.created_at,
      };
    },
  });
}

function listActivity(ctx) {
  const me = authenticate(ctx);
  const paging = parsePaging(ctx.query);
  const st = state;
  const visible = [];
  for (const p of st.payments.values()) {
    if (p.visibility === 'public' || p.from === me.id || p.to === me.id) visible.push(p);
  }
  visible.sort(newestFirst);
  const { items, hasMore } = page(visible, paging);
  return [200, { payments: items.map((p) => renderPayment(st, p)), has_more: hasMore }];
}

function postSettlement(ctx) {
  return idempotentWrite(ctx, {
    perform(st, me, body) {
      if (!st.operators.has(me.id)) throw forbidden('only a settlement operator may settle');
      const transfers = body.transfers;
      if (!Array.isArray(transfers)) throw invalid('transfers must be an array');
      if (transfers.length < 1 || transfers.length > MAX_TRANSFERS) {
        throw invalid('transfers must contain 1 to 32 entries');
      }
      // Entry errors in input order, each entry fully checked before the next.
      const entries = transfers.map((t, i) => {
        if (!isObject(t)) throw invalid(`transfers[${i}] must be an object`);
        if (typeof t.from_handle !== 'string') throw invalid(`transfers[${i}].from_handle must be a string`);
        if (typeof t.to_handle !== 'string') throw invalid(`transfers[${i}].to_handle must be a string`);
        const amount = parseAmount(t.amount);
        const note = parseNote(t.note);
        const visibility = parseVisibility(t.visibility);
        const from = st.byHandle.get(t.from_handle);
        if (!from) throw notFound(`transfers[${i}]: no user has handle ${t.from_handle}`);
        const to = st.byHandle.get(t.to_handle);
        if (!to) throw notFound(`transfers[${i}]: no user has handle ${t.to_handle}`);
        if (from.id === to.id) throw new HttpError(422, 'self_payment', `transfers[${i}] pays itself`);
        return { from, to, amount, note, visibility };
      });
      const net = new Map();
      for (const e of entries) {
        net.set(e.from, (net.get(e.from) || 0) - e.amount);
        net.set(e.to, (net.get(e.to) || 0) + e.amount);
      }
      for (const [user, delta] of net) {
        if (availableOf(st, user) + delta < 0) {
          throw new HttpError(409, 'insufficient_funds', `settlement leaves ${user.handle} negative`);
        }
      }
      for (const [user, delta] of net) user.balance += delta;
      const ts = now(st);
      const settlementId = newId(st, 'stl_', st.settlements);
      const payments = entries.map((e) => createPayment(st, { ...e, settlementId, ts }));
      st.settlements.set(settlementId, {
        id: settlementId,
        operator: me.id,
        payment_ids: payments.map((p) => p.id),
        ts,
        committed_at: formatTs(ts),
      });
      return {
        settlement_id: settlementId,
        committed_at: formatTs(ts),
        payments: payments.map((p) => renderPayment(st, p)),
      };
    },
  });
}

// ---- authorizations -----------------------------------------------------------

function postAuthorization(ctx) {
  return idempotentWrite(ctx, {
    perform(st, me, body) {
      checkStringType(body, 'to_handle');
      const handle = requireString(body, 'to_handle');
      const amount = parseAmount(body.amount);
      const note = parseNote(body.note);
      const visibility = parseVisibility(body.visibility);
      const to = st.byHandle.get(handle);
      if (!to) throw notFound('no user has that handle');
      if (to.id === me.id) throw new HttpError(422, 'self_payment', 'cannot authorize a payment to yourself');
      if (availableOf(st, me) < amount) {
        throw new HttpError(409, 'insufficient_funds', 'available balance is below amount');
      }
      const ts = now(st);
      const expiresTs = ts + st.ttlSeconds * 1000;
      const a = {
        id: newId(st, 'auth_', st.authorizations),
        from: me.id,
        to: to.id,
        amount,
        captured: 0,
        remaining: amount,
        note,
        visibility,
        status: 'open',
        expires_ts: expiresTs,
        expires_at: formatTs(expiresTs),
        payment_ids: [],
        ts,
        created_at: formatTs(ts),
        seq: ++st.seq,
      };
      st.authorizations.set(a.id, a);
      trackHold(st, a);
      return renderAuthorization(st, a);
    },
  });
}

function captureAuthorization(ctx, id) {
  return idempotentWrite(ctx, {
    emptyAs: {},
    perform(st, me, body) {
      const a = st.authorizations.get(id);
      if (!a) throw notFound('unknown authorization');
      if (a.to !== me.id) throw forbidden('only the receiver may capture this authorization');
      if (body.final !== undefined && typeof body.final !== 'boolean') throw malformed('final must be a boolean');
      let amount;
      if (body.amount !== undefined) {
        const v = body.amount;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
          throw invalid('amount must be a positive integer');
        }
        amount = v;
      }
      expireIfDue(st, a);
      if (a.status === 'expired') throw new HttpError(409, 'authorization_expired', 'authorization has expired');
      if (a.status !== 'open') throw new HttpError(409, 'authorization_not_open', `authorization is ${a.status}`);
      if (amount === undefined) amount = a.remaining;
      if (amount > a.remaining) {
        throw new HttpError(422, 'capture_exceeds_authorization', 'amount exceeds the remaining authorized amount');
      }
      const payer = st.users.get(a.from);
      // The hold guarantees payer.balance >= remaining >= amount.
      payer.balance -= amount;
      me.balance += amount;
      const p = createPayment(st, {
        from: payer, to: me, amount, note: a.note, visibility: a.visibility, authorizationId: a.id, ts: now(st),
      });
      a.captured += amount;
      a.remaining -= amount;
      a.payment_ids.push(p.id);
      if (body.final !== false || a.remaining === 0) {
        a.status = 'captured';
        a.remaining = 0;
        a.closed_ts = p.ts;
        releaseHold(st, a);
      }
      return renderPayment(st, p);
    },
  });
}

function voidAuthorization(ctx, id) {
  const me = authenticate(ctx);
  const st = state;
  const a = st.authorizations.get(id);
  if (!a) throw notFound('unknown authorization');
  if (a.from !== me.id) throw forbidden('only the payer may void this authorization');
  expireIfDue(st, a);
  if (a.status === 'open') {
    a.status = 'voided';
    a.remaining = 0;
    a.closed_ts = now(st);
    releaseHold(st, a);
  } else if (a.status !== 'voided') {
    throw new HttpError(409, 'authorization_not_open', `authorization is ${a.status}`);
  }
  return [200, renderAuthorization(st, a)];
}

function listAuthorizations(ctx) {
  const me = authenticate(ctx);
  const q = ctx.query;
  const direction = q.get('direction');
  if (direction !== null && direction !== 'incoming' && direction !== 'outgoing') {
    throw invalid('direction must be incoming or outgoing');
  }
  const status = q.get('status');
  if (status !== null && !AUTH_STATUSES.has(status)) throw invalid('unknown status');
  const paging = parsePaging(q);
  const st = state;
  const at = Date.now();
  const mine = [];
  for (const a of st.authorizations.values()) {
    const outgoing = a.from === me.id;
    const incoming = a.to === me.id;
    if (!incoming && !outgoing) continue;
    if (direction === 'incoming' && !incoming) continue;
    if (direction === 'outgoing' && !outgoing) continue;
    expireIfDue(st, a, at);
    if (status !== null && a.status !== status) continue;
    mine.push(a);
  }
  mine.sort(newestFirst);
  const { items, hasMore } = page(mine, paging);
  return [200, { authorizations: items.map((a) => renderAuthorization(st, a)), has_more: hasMore }];
}

// ---- ledger: revisions, historical views, statements, corrections ----------------
// Every payment has an append-only revision list. A historical view (T = as_of, K =
// known_at) selects, per payment, the latest revision recorded at or before K and
// applies it at its effective time if that is at or before T.

const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/;

// An RFC 3339 instant with an explicit offset -> epoch ms, or null.
function parseInstant(text) {
  if (typeof text !== 'string') return null;
  const m = RFC3339_RE.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return null;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > dim) return null;
  if (m[9] && (Number(m[10]) > 23 || Number(m[11]) > 59)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

function instantParam(query, name) {
  const raw = query.get(name);
  if (raw === null) return null;
  const ms = parseInstant(raw);
  if (ms === null) throw invalid(`${name} must be an RFC 3339 instant with an offset`);
  return { raw, ms };
}

function firstRevision(p) {
  return {
    revision: 1, amount: p.amount, effective_ts: p.ts, effective_at: p.created_at,
    recorded_ts: p.ts, recorded_at: p.created_at, reason: '',
  };
}

// Opening balance = current balance minus the net effect of every payment's latest revision.
function computeOpenings(st, onlyMissing = false) {
  const net = new Map();
  for (const p of st.payments.values()) {
    const amt = p.revisions[p.revisions.length - 1].amount;
    net.set(p.from, (net.get(p.from) || 0) - amt);
    net.set(p.to, (net.get(p.to) || 0) + amt);
  }
  for (const u of st.users.values()) {
    if (onlyMissing && u.opening !== null && u.opening !== undefined) continue;
    u.opening = u.balance - (net.get(u.id) || 0);
  }
}

function selectRevision(p, K) {
  for (let i = p.revisions.length - 1; i >= 0; i--) {
    if (p.revisions[i].recorded_ts <= K) return p.revisions[i];
  }
  return null;
}

function paymentsOf(st, userId) {
  const out = [];
  for (const p of st.payments.values()) if (p.from === userId || p.to === userId) out.push(p);
  return out;
}

const signedFor = (p, userId, amount) => (p.from === userId ? -amount : amount);

function totalAt(st, userId, T, K) {
  let total = st.users.get(userId).opening;
  for (const p of paymentsOf(st, userId)) {
    const r = selectRevision(p, K);
    if (r && r.effective_ts <= T) total += signedFor(p, userId, r.amount);
  }
  return total;
}

// What one hold reserves at instant T, as known at K. Creation, captures, void and final
// capture are known at their own event time; expiry is known once creation is.
function holdAt(st, a, T, K) {
  if (a.no_history) return 0;
  if (a.ts > T || a.ts > K) return 0;
  if (a.expires_ts <= T) return 0;
  if (a.closed_ts !== null && a.closed_ts !== undefined && a.closed_ts <= T && a.closed_ts <= K) return 0;
  let captured = 0;
  for (const id of a.payment_ids) {
    const p = st.payments.get(id);
    if (p && p.ts <= T && p.ts <= K) captured += p.amount;
  }
  return Math.max(0, a.amount - captured);
}

function heldAt(st, userId, T, K) {
  let held = 0;
  for (const a of st.authorizations.values()) if (a.from === userId) held += holdAt(st, a, T, K);
  return held;
}

function compareEntries(a, b) {
  if (a.rev.effective_ts !== b.rev.effective_ts) return a.rev.effective_ts - b.rev.effective_ts;
  return a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0;
}

function getStatement(ctx) {
  const me = authenticate(ctx);
  const q = ctx.query;
  const st = state;
  const token = q.get('snapshot');
  if (token !== null) {
    if (q.has('from') || q.has('to') || q.has('known_at')) {
      throw invalid('from, to and known_at cannot accompany a snapshot');
    }
    const paging = parsePaging(q);
    const snap = st.snapshots.get(token);
    if (!snap || snap.user !== me.id) throw notFound('unknown snapshot');
    return [200, statementPage(snap, token, paging)];
  }
  const from = instantParam(q, 'from');
  const to = instantParam(q, 'to');
  const knownAt = instantParam(q, 'known_at');
  const paging = parsePaging(q);
  if (from && to && from.ms > to.ms) throw invalid('from must not be after to');
  const start = Math.max(Date.now(), st.lastTs);
  const K = knownAt ? knownAt.ms : start;
  // The default `to` is now; it includes everything recorded up to this instant.
  const toMs = to ? to.ms : start + 1;
  const fromMs = from ? from.ms : -Infinity;
  const selected = [];
  for (const p of paymentsOf(st, me.id)) {
    const rev = selectRevision(p, K);
    if (rev) selected.push({ p, rev });
  }
  selected.sort(compareEntries);
  let running = me.opening;
  let i = 0;
  while (i < selected.length && selected[i].rev.effective_ts < fromMs) {
    running += signedFor(selected[i].p, me.id, selected[i].rev.amount);
    i++;
  }
  const opening = running;
  const entries = [];
  for (; i < selected.length && selected[i].rev.effective_ts < toMs; i++) {
    const { p, rev } = selected[i];
    const delta = signedFor(p, me.id, rev.amount);
    running += delta;
    entries.push({
      payment: { ...renderPayment(st, p), amount: rev.amount },
      delta,
      balance_after: running,
      revision: rev.revision,
      effective_at: rev.effective_at,
      recorded_at: rev.recorded_at,
    });
  }
  const snap = {
    user: me.id,
    opening_balance: opening,
    closing_balance: running,
    entries,
    from: from ? from.raw : null,
    to: to ? to.raw : formatTs(start),
    known_at: knownAt ? knownAt.raw : null,
  };
  const newToken = crypto.randomBytes(18).toString('base64url');
  st.snapshots.set(newToken, snap);
  return [200, statementPage(snap, newToken, paging)];
}

function statementPage(snap, token, { limit, offset }) {
  const body = {
    opening_balance: snap.opening_balance,
    entries: snap.entries.slice(offset, offset + limit),
    closing_balance: snap.closing_balance,
    has_more: offset + limit < snap.entries.length,
    snapshot: token,
    from: snap.from,
    to: snap.to,
  };
  if (snap.known_at !== null) body.known_at = snap.known_at;
  return body;
}

function renderRevision(p, r) {
  return {
    payment_id: p.id, revision: r.revision, amount: r.amount,
    effective_at: r.effective_at, recorded_at: r.recorded_at, reason: r.reason,
  };
}

function listRevisions(ctx, id) {
  const me = authenticate(ctx);
  const p = state.payments.get(id);
  if (!p || (p.from !== me.id && p.to !== me.id)) throw notFound('unknown payment');
  return [200, { revisions: p.revisions.map((r) => renderRevision(p, r)) }];
}

// Would this user's total or available go negative at any effective/event boundary
// under the latest revisions (with `override` substituted for one payment)?
function historicalOverdraft(st, userId, override) {
  const moves = [];
  const times = new Set();
  for (const p of paymentsOf(st, userId)) {
    const rev = override && override.p === p ? override.rev : p.revisions[p.revisions.length - 1];
    moves.push({ t: rev.effective_ts, d: signedFor(p, userId, rev.amount) });
    times.add(rev.effective_ts);
  }
  const holds = [];
  for (const a of st.authorizations.values()) {
    if (a.from !== userId || a.no_history) continue;
    holds.push(a);
    times.add(a.ts);
    times.add(a.expires_ts);
    if (a.closed_ts !== null && a.closed_ts !== undefined) times.add(a.closed_ts);
    for (const pid of a.payment_ids) { const cp = st.payments.get(pid); if (cp) times.add(cp.ts); }
  }
  moves.sort((x, y) => x.t - y.t);
  let total = st.users.get(userId).opening;
  if (total < 0) return true;
  let j = 0;
  for (const t of [...times].sort((x, y) => x - y)) {
    while (j < moves.length && moves[j].t <= t) total += moves[j++].d;
    let held = 0;
    for (const a of holds) held += holdAt(st, a, t, Infinity);
    if (total < 0 || total - held < 0) return true;
  }
  return false;
}

function postCorrection(ctx, id) {
  return idempotentWrite(ctx, {
    perform(st, me, body) {
      const p = st.payments.get(id);
      if (!p) throw notFound('unknown payment');
      if (p.from !== me.id) throw forbidden('only the original sender may correct this payment');
      const er = body.expected_revision;
      if (typeof er !== 'number' || !Number.isInteger(er) || er < 1) throw invalid('expected_revision must be a positive integer');
      const amount = body.amount;
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > MAX_AMOUNT) {
        throw invalid('amount must be an integer from 0 to 1000000000');
      }
      const effMs = parseInstant(body.effective_at);
      const at = Date.now();
      if (effMs === null) throw invalid('effective_at must be an RFC 3339 instant with an offset');
      if (effMs > at) throw invalid('effective_at must not be later than now');
      const reason = body.reason;
      if (typeof reason !== 'string' || codePoints(reason) < 1 || codePoints(reason) > 200) {
        throw invalid('reason must be 1 to 200 characters');
      }
      if (p.settlement_id !== null || p.authorization_id !== null) {
        throw new HttpError(422, 'linked_payment_immutable', 'settlement members and captures cannot be corrected');
      }
      const latest = p.revisions[p.revisions.length - 1];
      if (er !== latest.revision) throw new HttpError(409, 'stale_revision', `current revision is ${latest.revision}`);
      const diff = amount - latest.amount;
      const sender = st.users.get(p.from);
      const receiver = st.users.get(p.to);
      if (diff > 0 && availableOf(st, sender) < diff) {
        throw new HttpError(409, 'insufficient_funds', 'the sender cannot currently afford the increase');
      }
      if (diff < 0 && availableOf(st, receiver) < -diff) {
        throw new HttpError(409, 'insufficient_funds', 'the receiver cannot currently afford the decrease');
      }
      let recordedTs = now(st);
      if (recordedTs <= latest.recorded_ts) recordedTs = latest.recorded_ts + 1;
      st.lastTs = Math.max(st.lastTs, recordedTs);
      const rev = {
        revision: latest.revision + 1,
        amount,
        effective_ts: effMs,
        effective_at: body.effective_at,
        recorded_ts: recordedTs,
        recorded_at: formatTs(recordedTs),
        reason,
      };
      const override = { p, rev };
      if (historicalOverdraft(st, sender.id, override) || historicalOverdraft(st, receiver.id, override)) {
        throw new HttpError(409, 'historical_overdraft', 'the correction would overdraw a wallet in the past');
      }
      p.revisions.push(rev);
      sender.balance -= diff;
      receiver.balance += diff;
      return renderRevision(p, rev);
    },
  });
}

// ---- auth -------------------------------------------------------------------

function deriveHandle(email) {
  const local = email.slice(0, email.lastIndexOf('@')).toLowerCase();
  let out = '';
  for (const ch of local) out += /^[a-z0-9_]$/.test(ch) ? ch : '_';
  return Array.from(out).slice(0, 20).join('');
}

function validEmail(email) {
  const at = email.indexOf('@');
  return at > 0 && at === email.lastIndexOf('@') && at < email.length - 1 && !/\s/.test(email);
}

async function signup(ctx) {
  const body = jsonObject(ctx);
  for (const f of ['email', 'password', 'display_name']) checkStringType(body, f);
  const email = requireString(body, 'email');
  const password = requireString(body, 'password');
  const displayName = requireString(body, 'display_name');
  if (!validEmail(email)) throw invalid('email must be of the form local@domain');
  if (codePoints(password) < 8) throw invalid('password must be at least 8 characters');
  const handle = deriveHandle(email);
  const st = state;
  const conflicts = () => {
    if (st.byEmail.has(email.toLowerCase())) throw new HttpError(409, 'email_taken', 'email already registered');
    if (st.byHandle.has(handle)) throw new HttpError(409, 'handle_taken', 'derived handle already taken');
  };
  conflicts();
  const hash = await hashPassword(password);
  conflicts(); // re-check: a concurrent signup may have claimed it while hashing
  const user = {
    id: newId(st, 'usr_', st.users),
    email,
    display_name: displayName,
    handle,
    balance: 0,
    opening: 0,
    password_hash: hash,
  };
  addUser(st, user);
  const token = issueToken(st, user.id);
  return [201, { user_id: user.id, display_name: user.display_name, token }];
}

async function login(ctx) {
  const body = jsonObject(ctx);
  for (const f of ['email', 'password']) checkStringType(body, f);
  const email = requireString(body, 'email');
  const password = requireString(body, 'password');
  const st = state;
  const user = st.byEmail.get(email.toLowerCase());
  if (!user) {
    if (dummyHash) await verifyPassword(password, dummyHash);
    throw unauthenticated();
  }
  if (!(await verifyPassword(password, user.password_hash))) throw unauthenticated();
  const token = issueToken(st, user.id);
  return [200, { user_id: user.id, display_name: user.display_name, token }];
}

// ---- reset / export / import ------------------------------------------------

function fixtureError(m) {
  return invalid(`invalid fixture: ${m}`);
}

function optionalString(v, fallback, what) {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string') throw fixtureError(`${what} must be a string`);
  return v;
}

function parseFixtureTs(v, what) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw fixtureError(`${what} must be a timestamp`);
  return Date.parse(v);
}

// Validate a reset fixture completely before anything changes; returns a plan
// that buildFromFixture turns into a fresh state.
function validateFixture(f) {
  if (typeof f.currency !== 'string' || f.currency.length === 0) throw fixtureError('currency');
  if (![0, 2, 3].includes(f.minor_units)) throw fixtureError('minor_units must be 0, 2 or 3');
  if (!Array.isArray(f.users)) throw fixtureError('users must be an array');
  const ids = new Set(); const handles = new Set(); const emails = new Set();
  const users = f.users.map((u, i) => {
    if (!isObject(u)) throw fixtureError(`users[${i}]`);
    if (typeof u.id !== 'string' || u.id.length === 0 || u.id.length > 64 || ids.has(u.id)) {
      throw fixtureError(`users[${i}].id`);
    }
    if (typeof u.email !== 'string' || u.email.length === 0 || emails.has(u.email.toLowerCase())) {
      throw fixtureError(`users[${i}].email`);
    }
    if (typeof u.password !== 'string') throw fixtureError(`users[${i}].password`);
    if (typeof u.handle !== 'string' || !HANDLE_RE.test(u.handle) || handles.has(u.handle)) {
      throw fixtureError(`users[${i}].handle`);
    }
    if (!isSafeInt(u.balance) || u.balance < 0) throw fixtureError(`users[${i}].balance`);
    const displayName = optionalString(u.display_name, u.handle, `users[${i}].display_name`);
    ids.add(u.id); handles.add(u.handle); emails.add(u.email.toLowerCase());
    return { id: u.id, email: u.email, password: u.password, display_name: displayName, handle: u.handle, balance: u.balance };
  });
  const payments = f.payments === undefined || f.payments === null ? [] : f.payments;
  const requests = f.requests === undefined || f.requests === null ? [] : f.requests;
  if (!Array.isArray(payments)) throw fixtureError('payments must be an array');
  if (!Array.isArray(requests)) throw fixtureError('requests must be an array');
  const paymentIds = new Set();
  const seededPayments = payments.map((p, i) => {
    const w = `payments[${i}]`;
    if (!isObject(p)) throw fixtureError(w);
    if (typeof p.id !== 'string' || p.id.length === 0 || p.id.length > 64 || paymentIds.has(p.id)) throw fixtureError(`${w}.id`);
    if (!ids.has(p.from_user_id) || !ids.has(p.to_user_id)) throw fixtureError(`${w} references an unknown user`);
    if (!isSafeInt(p.amount) || p.amount < 0) throw fixtureError(`${w}.amount`);
    const visibility = p.visibility === undefined || p.visibility === null ? 'public' : p.visibility;
    if (!VISIBILITIES.has(visibility)) throw fixtureError(`${w}.visibility`);
    paymentIds.add(p.id);
    const seededTs = parseFixtureTs(p.created_at, `${w}.created_at`);
    if (seededTs !== null && seededTs > Date.now()) throw fixtureError(`${w}.created_at is in the future`);
    return {
      id: p.id, from: p.from_user_id, to: p.to_user_id, amount: p.amount,
      note: optionalString(p.note, '', `${w}.note`), visibility,
      request_id: optionalString(p.request_id, null, `${w}.request_id`),
      settlement_id: optionalString(p.settlement_id, null, `${w}.settlement_id`),
      authorization_id: optionalString(p.authorization_id, null, `${w}.authorization_id`),
      ts: parseFixtureTs(p.created_at, `${w}.created_at`),
      created_at: typeof p.created_at === 'string' ? p.created_at : null,
    };
  });
  const requestIds = new Set();
  const seededRequests = requests.map((r, i) => {
    const w = `requests[${i}]`;
    if (!isObject(r)) throw fixtureError(w);
    if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 64 || requestIds.has(r.id)) throw fixtureError(`${w}.id`);
    if (!ids.has(r.requester_id) || !ids.has(r.payer_id)) throw fixtureError(`${w} references an unknown user`);
    if (!isSafeInt(r.amount) || r.amount < 0) throw fixtureError(`${w}.amount`);
    const status = r.status === undefined || r.status === null ? 'pending' : r.status;
    if (!STATUSES.has(status)) throw fixtureError(`${w}.status`);
    requestIds.add(r.id);
    return {
      id: r.id, requester: r.requester_id, payer: r.payer_id, amount: r.amount,
      note: optionalString(r.note, '', `${w}.note`), status,
      payment_id: optionalString(r.payment_id, null, `${w}.payment_id`),
      ts: parseFixtureTs(r.created_at, `${w}.created_at`),
      created_at: typeof r.created_at === 'string' ? r.created_at : null,
    };
  });
  let operators = f.settlement_operator_ids;
  if (operators === undefined || operators === null) operators = [];
  if (!Array.isArray(operators) || operators.some((id) => typeof id !== 'string' || !ids.has(id))) {
    throw fixtureError('settlement_operator_ids must list known user ids');
  }
  let ttlSeconds = DEFAULT_TTL_SECONDS;
  if (f.authorization_ttl_seconds !== undefined) {
    const t = f.authorization_ttl_seconds;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > 1e12) {
      throw fixtureError('authorization_ttl_seconds must be a positive integer');
    }
    ttlSeconds = t;
  }
  const authorizations = f.authorizations === undefined || f.authorizations === null ? [] : f.authorizations;
  if (!Array.isArray(authorizations)) throw fixtureError('authorizations must be an array');
  const authIds = new Set();
  const at = Date.now();
  const heldByUser = new Map();
  const seededAuthorizations = authorizations.map((a, i) => {
    const w = `authorizations[${i}]`;
    if (!isObject(a)) throw fixtureError(w);
    if (typeof a.id !== 'string' || a.id.length === 0 || a.id.length > 64 || authIds.has(a.id)) throw fixtureError(`${w}.id`);
    if (!ids.has(a.from_user_id) || !ids.has(a.to_user_id)) throw fixtureError(`${w} references an unknown user`);
    if (!isSafeInt(a.amount) || a.amount < 0) throw fixtureError(`${w}.amount`);
    const status = a.status === undefined || a.status === null ? 'open' : a.status;
    if (!AUTH_STATUSES.has(status)) throw fixtureError(`${w}.status`);
    const visibility = a.visibility === undefined || a.visibility === null ? 'public' : a.visibility;
    if (!VISIBILITIES.has(visibility)) throw fixtureError(`${w}.visibility`);
    let captured = 0;
    if (a.captured_amount !== undefined && a.captured_amount !== null) {
      if (!isSafeInt(a.captured_amount) || a.captured_amount < 0 || a.captured_amount > a.amount) {
        throw fixtureError(`${w}.captured_amount`);
      }
      captured = a.captured_amount;
    }
    let paymentIds = [];
    if (Array.isArray(a.payment_ids)) {
      if (!a.payment_ids.every((x) => typeof x === 'string')) throw fixtureError(`${w}.payment_ids`);
      paymentIds = [...a.payment_ids];
    } else if (typeof a.payment_id === 'string') {
      paymentIds = [a.payment_id];
    }
    let expiresTs = parseFixtureTs(a.expires_at, `${w}.expires_at`);
    if (expiresTs === null && status === 'open') throw fixtureError(`${w}.expires_at is required`);
    const expiresAt = expiresTs === null ? formatTs(at) : a.expires_at;
    if (expiresTs === null) expiresTs = at;
    const open = status === 'open' && expiresTs > at;
    const remaining = open ? a.amount - captured : 0;
    if (open) heldByUser.set(a.from_user_id, (heldByUser.get(a.from_user_id) || 0) + remaining);
    authIds.add(a.id);
    return {
      id: a.id, from: a.from_user_id, to: a.to_user_id, amount: a.amount, captured, remaining,
      note: optionalString(a.note, '', `${w}.note`), visibility,
      status: status === 'open' && !open ? 'expired' : status,
      expires_ts: expiresTs, expires_at: expiresAt, payment_ids: paymentIds,
      ts: parseFixtureTs(a.created_at, `${w}.created_at`),
      created_at: typeof a.created_at === 'string' ? a.created_at : null,
    };
  });
  for (const u of users) {
    if ((heldByUser.get(u.id) || 0) > u.balance) {
      throw fixtureError(`seeded open holds exceed the balance of ${u.id}`);
    }
  }
  return {
    currency: f.currency, minorUnits: f.minor_units, users, seededPayments, seededRequests, operators,
    ttlSeconds, seededAuthorizations,
  };
}

async function buildFromFixture(plan) {
  // One salted scrypt hash per distinct seeded password keeps large resets well
  // inside the 10 s budget; every signup still gets its own salt.
  const distinct = [...new Set(plan.users.map((u) => u.password))];
  const hashes = new Map(await Promise.all(distinct.map(async (pw) => [pw, await hashPassword(pw)])));
  const st = emptyState();
  st.currency = plan.currency;
  st.minorUnits = plan.minorUnits;
  for (const u of plan.users) {
    addUser(st, {
      id: u.id, email: u.email, display_name: u.display_name, handle: u.handle,
      balance: u.balance, password_hash: hashes.get(u.password),
    });
  }
  for (const id of plan.operators) st.operators.add(id);
  st.ttlSeconds = plan.ttlSeconds;
  // Seeded items without created_at take the reset time (1 ms before any later API
  // write); fixture order breaks ties (later = newer).
  const base = Date.now() - 1;
  const stamp = (item) => {
    if (item.ts === null) {
      item.ts = base;
      item.created_at = formatTs(item.ts);
    }
    item.seq = ++st.seq;
    return item;
  };
  for (const p of plan.seededPayments) {
    const rec = stamp({ ...p });
    rec.revisions = [firstRevision(rec)];
    st.payments.set(rec.id, rec);
  }
  computeOpenings(st);
  for (const r of plan.seededRequests) st.requests.set(r.id, stamp({ ...r, split_id: null }));
  for (const a of plan.seededAuthorizations) {
    const rec = stamp({ ...a });
    // Seeded closed holds carry no reconstructed lifecycle: they never held anything.
    rec.no_history = rec.status === 'captured' || rec.status === 'voided';
    rec.closed_ts = rec.status === 'expired' ? rec.expires_ts : rec.status === 'open' ? null : base;
    st.authorizations.set(rec.id, rec);
    if (rec.status === 'open') trackHold(st, rec);
  }
  st.lastTs = Math.max(st.lastTs, base + 1);
  return st;
}

async function reset(ctx) {
  const body = jsonObject(ctx);
  const plan = validateFixture(body);
  state = await buildFromFixture(plan);
  return [204, null];
}

function exportState() {
  const st = state;
  return [200, {
    track: 'pocketful',
    format_version: 1,
    state: {
      currency: st.currency,
      minor_units: st.minorUnits,
      counter: st.counter,
      seq: st.seq,
      last_ts: st.lastTs,
      users: [...st.users.values()].map((u) => ({
        id: u.id, email: u.email, display_name: u.display_name, handle: u.handle,
        balance: u.balance, opening: u.opening, password_hash: u.password_hash,
      })),
      tokens: [...st.tokens].map(([token, userId]) => ({ token, user_id: userId })),
      settlement_operator_ids: [...st.operators],
      payments: [...st.payments.values()].map((p) => ({ ...p, revisions: p.revisions.map((r) => ({ ...r })) })),
      requests: [...st.requests.values()].map((r) => ({ ...r })),
      splits: [...st.splits.values()].map((s) => ({
        ...s, shares: s.shares.map((x) => ({ ...x })), request_ids: [...s.request_ids],
      })),
      settlements: [...st.settlements.values()].map((s) => ({ ...s, payment_ids: [...s.payment_ids] })),
      authorization_ttl_seconds: st.ttlSeconds,
      authorizations: [...st.authorizations.values()].map((a) => ({ ...a, payment_ids: [...a.payment_ids] })),
      snapshots: [...st.snapshots.entries()].map(([token, s]) => ({ token, ...s })),
      idempotency: [...st.idem.values()].map((r) => ({ ...r })),
    },
  }];
}

function stateError(m) {
  return invalid(`invalid state: ${m}`);
}

const isNullableString = (v) => v === null || typeof v === 'string';
const isTsString = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;

function arrayField(s, name) {
  if (!Array.isArray(s[name])) throw stateError(`${name} must be an array`);
  return s[name];
}

// Rebuild a state from an export, validating every structure; throws before any
// change is made.
function stateFromExport(doc) {
  if (doc.track !== 'pocketful') throw invalid('track must be "pocketful"');
  if (doc.format_version !== 1) throw invalid('format_version must be 1');
  const s = doc.state;
  if (!isObject(s)) throw stateError('state must be an object');
  if (typeof s.currency !== 'string' || s.currency.length === 0) throw stateError('currency');
  if (![0, 2, 3].includes(s.minor_units)) throw stateError('minor_units');
  if (!isCount(s.counter) || !isCount(s.seq) || !isCount(s.last_ts)) throw stateError('counters');
  const st = emptyState();
  st.currency = s.currency;
  st.minorUnits = s.minor_units;
  st.counter = s.counter;
  st.seq = s.seq;
  st.lastTs = s.last_ts;

  for (const u of arrayField(s, 'users')) {
    if (!isObject(u) || !isId(u.id) || st.users.has(u.id)) throw stateError('user id');
    if (typeof u.email !== 'string' || st.byEmail.has(u.email.toLowerCase())) throw stateError('user email');
    if (typeof u.handle !== 'string' || !HANDLE_RE.test(u.handle) || st.byHandle.has(u.handle)) throw stateError('user handle');
    if (typeof u.display_name !== 'string') throw stateError('user display_name');
    if (!isSafeInt(u.balance) || u.balance < 0) throw stateError('user balance');
    if (!validHash(u.password_hash)) throw stateError('user password_hash');
    if (u.opening !== undefined && !isSafeInt(u.opening)) throw stateError('user opening');
    addUser(st, {
      id: u.id, email: u.email, display_name: u.display_name, handle: u.handle,
      balance: u.balance, opening: u.opening, password_hash: u.password_hash,
    });
  }
  for (const t of arrayField(s, 'tokens')) {
    if (!isObject(t) || typeof t.token !== 'string' || t.token.length === 0 || !st.users.has(t.user_id)) {
      throw stateError('token');
    }
    st.tokens.set(t.token, t.user_id);
  }
  for (const id of arrayField(s, 'settlement_operator_ids')) {
    if (!st.users.has(id)) throw stateError('settlement operator');
    st.operators.add(id);
  }
  for (const p of arrayField(s, 'payments')) {
    if (!isObject(p) || !isId(p.id) || st.payments.has(p.id)) throw stateError('payment id');
    if (!st.users.has(p.from) || !st.users.has(p.to)) throw stateError('payment parties');
    if (!isSafeInt(p.amount) || p.amount < 0) throw stateError('payment amount');
    if (typeof p.note !== 'string' || !VISIBILITIES.has(p.visibility)) throw stateError('payment note/visibility');
    if (p.authorization_id === undefined) p.authorization_id = null; // stage-1 export layout
    if (!isNullableString(p.request_id) || !isNullableString(p.settlement_id) || !isNullableString(p.authorization_id)) {
      throw stateError('payment links');
    }
    if (typeof p.ts !== 'number' || !Number.isFinite(p.ts) || !isTsString(p.created_at) || !isCount(p.seq)) {
      throw stateError('payment time');
    }
    const rec = {
      id: p.id, from: p.from, to: p.to, amount: p.amount, note: p.note, visibility: p.visibility,
      request_id: p.request_id, settlement_id: p.settlement_id, authorization_id: p.authorization_id,
      ts: p.ts, created_at: p.created_at, seq: p.seq,
    };
    // Stage-1 and stage-2 exports have no revision history: revision 1 is the payment itself.
    if (p.revisions === undefined) {
      rec.revisions = [firstRevision(rec)];
    } else {
      if (!Array.isArray(p.revisions) || p.revisions.length === 0) throw stateError('payment revisions');
      rec.revisions = p.revisions.map((r, i) => {
        if (!isObject(r) || r.revision !== i + 1 || !isSafeInt(r.amount) || r.amount < 0
          || typeof r.effective_ts !== 'number' || !isTsString(r.effective_at)
          || typeof r.recorded_ts !== 'number' || !isTsString(r.recorded_at) || typeof r.reason !== 'string') {
          throw stateError('payment revision');
        }
        return {
          revision: r.revision, amount: r.amount, effective_ts: r.effective_ts, effective_at: r.effective_at,
          recorded_ts: r.recorded_ts, recorded_at: r.recorded_at, reason: r.reason,
        };
      });
    }
    st.payments.set(p.id, rec);
  }
  for (const u of st.users.values()) {
    if (u.opening === undefined) u.opening = null;
  }
  computeOpenings(st, true);
  for (const r of arrayField(s, 'requests')) {
    if (!isObject(r) || !isId(r.id) || st.requests.has(r.id)) throw stateError('request id');
    if (!st.users.has(r.requester) || !st.users.has(r.payer)) throw stateError('request parties');
    if (!isSafeInt(r.amount) || r.amount < 0) throw stateError('request amount');
    if (typeof r.note !== 'string' || !STATUSES.has(r.status)) throw stateError('request note/status');
    if (!isNullableString(r.payment_id) || !isNullableString(r.split_id)) throw stateError('request links');
    if (typeof r.ts !== 'number' || !Number.isFinite(r.ts) || !isTsString(r.created_at) || !isCount(r.seq)) {
      throw stateError('request time');
    }
    st.requests.set(r.id, {
      id: r.id, requester: r.requester, payer: r.payer, amount: r.amount, note: r.note, status: r.status,
      payment_id: r.payment_id, split_id: r.split_id, ts: r.ts, created_at: r.created_at, seq: r.seq,
    });
  }
  for (const sp of arrayField(s, 'splits')) {
    if (!isObject(sp) || !isId(sp.id) || st.splits.has(sp.id) || !st.users.has(sp.requester)) throw stateError('split');
    if (!isSafeInt(sp.amount) || typeof sp.note !== 'string' || !isTsString(sp.created_at)) throw stateError('split fields');
    if (!Array.isArray(sp.shares) || !sp.shares.every((x) => isObject(x) && typeof x.handle === 'string' && isSafeInt(x.amount))) {
      throw stateError('split shares');
    }
    if (!Array.isArray(sp.request_ids) || !sp.request_ids.every((id) => st.requests.has(id))) throw stateError('split requests');
    st.splits.set(sp.id, {
      id: sp.id, requester: sp.requester, amount: sp.amount, note: sp.note,
      shares: sp.shares.map((x) => ({ handle: x.handle, amount: x.amount })),
      request_ids: [...sp.request_ids], ts: sp.ts, created_at: sp.created_at, seq: sp.seq,
    });
  }
  for (const se of arrayField(s, 'settlements')) {
    if (!isObject(se) || !isId(se.id) || st.settlements.has(se.id)) throw stateError('settlement');
    if (!Array.isArray(se.payment_ids) || !se.payment_ids.every((id) => st.payments.has(id))) throw stateError('settlement payments');
    if (!isTsString(se.committed_at)) throw stateError('settlement time');
    st.settlements.set(se.id, {
      id: se.id, operator: se.operator, payment_ids: [...se.payment_ids], ts: se.ts, committed_at: se.committed_at,
    });
  }
  // Stage-1 exports carry neither of these; they default to no authorizations and 600 s.
  if (s.authorization_ttl_seconds !== undefined) {
    const t = s.authorization_ttl_seconds;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > 1e12) throw stateError('authorization_ttl_seconds');
    st.ttlSeconds = t;
  }
  for (const a of s.authorizations === undefined ? [] : arrayField(s, 'authorizations')) {
    if (!isObject(a) || !isId(a.id) || st.authorizations.has(a.id)) throw stateError('authorization id');
    if (!st.users.has(a.from) || !st.users.has(a.to)) throw stateError('authorization parties');
    if (!isSafeInt(a.amount) || a.amount < 0 || !isSafeInt(a.captured) || a.captured < 0
      || !isSafeInt(a.remaining) || a.remaining < 0 || a.captured + a.remaining > a.amount) {
      throw stateError('authorization amounts');
    }
    if (typeof a.note !== 'string' || !VISIBILITIES.has(a.visibility) || !AUTH_STATUSES.has(a.status)) {
      throw stateError('authorization note/visibility/status');
    }
    if (typeof a.expires_ts !== 'number' || !Number.isFinite(a.expires_ts) || !isTsString(a.expires_at)
      || typeof a.ts !== 'number' || !Number.isFinite(a.ts) || !isTsString(a.created_at) || !isCount(a.seq)) {
      throw stateError('authorization time');
    }
    if (!Array.isArray(a.payment_ids) || !a.payment_ids.every((id) => typeof id === 'string')) {
      throw stateError('authorization payments');
    }
    const rec = {
      id: a.id, from: a.from, to: a.to, amount: a.amount, captured: a.captured,
      remaining: a.status === 'open' ? a.remaining : 0, note: a.note, visibility: a.visibility, status: a.status,
      expires_ts: a.expires_ts, expires_at: a.expires_at, payment_ids: [...a.payment_ids],
      ts: a.ts, created_at: a.created_at, seq: a.seq, no_history: a.no_history === true,
    };
    if (!rec.payment_ids.every((id) => st.payments.has(id))) throw stateError('authorization capture payments');
    if (a.closed_ts !== undefined) {
      if (a.closed_ts !== null && (typeof a.closed_ts !== 'number' || !Number.isFinite(a.closed_ts))) throw stateError('authorization closed_ts');
      rec.closed_ts = a.closed_ts;
    } else {
      // A stage-2 export records no close time: an expiry closed at its deadline; a capture
      // at its last capture; a void at its latest known event (creation or last capture).
      const capTimes = rec.payment_ids.map((id) => st.payments.get(id).ts);
      const lastEvent = Math.max(rec.ts, ...capTimes);
      rec.closed_ts = rec.status === 'open' ? null : rec.status === 'expired' ? rec.expires_ts : lastEvent;
    }
    st.authorizations.set(rec.id, rec);
    if (rec.status === 'open') trackHold(st, rec);
  }
  for (const u of st.users.values()) {
    if (heldBy(st, u.id) > u.balance) throw stateError(`open holds exceed the balance of ${u.id}`);
  }
  for (const snap of s.snapshots === undefined ? [] : arrayField(s, 'snapshots')) {
    if (!isObject(snap) || typeof snap.token !== 'string' || !st.users.has(snap.user) || !isSafeInt(snap.opening_balance)
      || !isSafeInt(snap.closing_balance) || !Array.isArray(snap.entries)) {
      throw stateError('snapshot');
    }
    const { token, ...rest } = snap;
    st.snapshots.set(token, rest);
  }
  for (const r of arrayField(s, 'idempotency')) {
    if (!isObject(r) || !st.users.has(r.user) || r.method !== 'POST' || typeof r.path !== 'string'
      || typeof r.key !== 'string' || r.key.length === 0 || typeof r.body !== 'string' || !isObject(r.response)) {
      throw stateError('idempotency record');
    }
    st.idem.set(JSON.stringify([r.user, r.method, r.path, r.key]), {
      user: r.user, method: r.method, path: r.path, key: r.key, body: r.body, response: r.response,
    });
  }
  return st;
}

function importState(ctx) {
  const doc = jsonObject(ctx);
  state = stateFromExport(doc);
  return [204, null];
}

// ---------------------------------------------------------------------------
// Routing

const routes = [
  ['GET', /^\/health$/, health],
  ['POST', /^\/_test\/reset$/, reset],
  ['GET', /^\/_test\/export$/, exportState],
  ['POST', /^\/_test\/import$/, importState],
  ['POST', /^\/auth\/signup$/, signup],
  ['POST', /^\/auth\/login$/, login],
  ['GET', /^\/me$/, getMe],
  ['POST', /^\/payments$/, postPayment],
  ['POST', /^\/requests$/, postRequest],
  ['GET', /^\/requests$/, listRequests],
  ['POST', /^\/requests\/([^/]+)\/pay$/, payRequest],
  ['POST', /^\/requests\/([^/]+)\/decline$/, (ctx, id) => resolveRequest(ctx, id, 'decline')],
  ['POST', /^\/requests\/([^/]+)\/cancel$/, (ctx, id) => resolveRequest(ctx, id, 'cancel')],
  ['POST', /^\/splits$/, postSplit],
  ['GET', /^\/activity$/, listActivity],
  ['POST', /^\/settlements$/, postSettlement],
  ['POST', /^\/authorizations$/, postAuthorization],
  ['GET', /^\/authorizations$/, listAuthorizations],
  ['POST', /^\/authorizations\/([^/]+)\/capture$/, captureAuthorization],
  ['POST', /^\/authorizations\/([^/]+)\/void$/, voidAuthorization],
  ['GET', /^\/statement$/, getStatement],
  ['POST', /^\/payments\/([^/]+)\/corrections$/, postCorrection],
  ['GET', /^\/payments\/([^/]+)\/revisions$/, listRevisions],
];

// Browser routes. /requests and /authorizations are shared with the API and serve the
// page only for Accept: text/html; the other screens are always pages.
const PAGE_ROUTES = new Set(['/', '/split', '/signup', '/login']);
const SHARED_ROUTES = new Set(['/requests', '/authorizations']);

function wantsHtml(req) {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.toLowerCase().includes('text/html');
}

function route(method, path) {
  for (const [m, re, handler] of routes) {
    if (m !== method) continue;
    const match = re.exec(path);
    if (!match) continue;
    const params = [];
    for (const p of match.slice(1)) {
      try {
        params.push(decodeURIComponent(p));
      } catch {
        return null;
      }
    }
    return { handler, params };
  }
  return null;
}

// Query values are percent-decoded without turning '+' into a space; the first
// occurrence of a parameter wins.
function parseQuery(search) {
  const values = new Map();
  const text = search.startsWith('?') ? search.slice(1) : search;
  if (text) {
    for (const part of text.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const rawKey = eq < 0 ? part : part.slice(0, eq);
      const rawVal = eq < 0 ? '' : part.slice(eq + 1);
      let key; let val;
      try { key = decodeURIComponent(rawKey); } catch { key = rawKey; }
      try { val = decodeURIComponent(rawVal); } catch { val = rawVal; }
      if (!values.has(key)) values.set(key, val);
    }
  }
  return { get: (k) => (values.has(k) ? values.get(k) : null), has: (k) => values.has(k) };
}

function send(res, status, body) {
  if (res.headersSent || res.destroyed) return;
  if (status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendAsset(res, method, { type, body, cache }) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': cache || 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(method === 'HEAD' ? undefined : body);
}

function sendError(res, e) {
  if (e instanceof HttpError) {
    send(res, e.status, { error: { code: e.code, message: e.message } });
  } else {
    console.error(e);
    send(res, 500, { error: { code: 'internal_error', message: 'internal error' } });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'payload_too_large', 'request body is too large'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  try {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      throw notFound();
    }
    const raw = await readBody(req);
    if (req.method === 'GET' || req.method === 'HEAD') {
      const p = url.pathname;
      if (PAGE_ROUTES.has(p) || (SHARED_ROUTES.has(p) && wantsHtml(req))) {
        sendAsset(res, req.method, ui.page());
        return;
      }
      const asset = ui.asset(p);
      if (asset) {
        sendAsset(res, req.method, asset);
        return;
      }
    }
    const found = route(req.method, url.pathname);
    if (!found) throw notFound('no such route');
    const ctx = { req, raw, path: url.pathname, query: parseQuery(url.search) };
    const [status, body] = await found.handler(ctx, ...found.params);
    send(res, status, body);
  } catch (e) {
    sendError(res, e);
  }
}

function start() {
  const envPort = process.env.PORT;
  const port = envPort !== undefined && /^\d+$/.test(envPort) ? Number(envPort) : 8080;
  const server = http.createServer({ maxHeaderSize: 64 * 1024 }, handle);
  server.keepAliveTimeout = 75 * 1000;
  server.headersTimeout = 76 * 1000;
  server.requestTimeout = 0;
  server.listen(port, '0.0.0.0', () => {
    console.log(`pocketful stage 3 listening on 0.0.0.0:${port}`);
  });
  hashPassword(crypto.randomBytes(12).toString('hex')).then((h) => { dummyHash = h; });
  const stop = () => server.close(() => process.exit(0)) && setTimeout(() => process.exit(0), 500).unref();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

if (require.main === module) start();

module.exports = { start, equalSplit, deriveHandle, canonical };
