#!/usr/bin/env node
// Stage-2 adversarial campaigns on holds: competing writers for `available`, concurrent
// captures over a remainder, same-key bursts on the new paths, capture vs void, capture
// racing expiry. Judged on observable state with watchers reading /me during each burst.
// usage: node adversarial-holds.mjs --base-url URL [--seeds 1,2] [--burst 50] [--out f]
import { writeFileSync } from 'node:fs';
import { client, code, rng, deepEqual, PASSWORD } from './lib.mjs';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : a), []));
const c = client(args['base-url']);
const seeds = String(args.seeds ?? '11,23,37,51,73').split(',').map(Number);
const BURST = Number(args.burst ?? 50);
let stateChecks = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = (rs) => rs.reduce((t, r) => { const k = `${r.status}${code(r) ? ' ' + code(r) : ''}`; t[k] = (t[k] ?? 0) + 1; return t; }, {});

async function world(r, n, bal, ttl) {
  const users = Array.from({ length: n }, (_, i) => ({ id: `u_h${i}`, email: `h${i}@example.com`, password: PASSWORD, display_name: `H${i}`, handle: `h${i}`, balance: bal(i) }));
  const fx = { currency: 'EUR', minor_units: 2, users, payments: [], requests: [], settlement_operator_ids: ['u_h0'] };
  if (ttl) fx.authorization_ttl_seconds = ttl;
  const res = await c.req('POST', '/_test/reset', { body: fx });
  if (res.status !== 204) throw new Error(`reset ${res.status} ${res.text}`);
  const tok = {};
  await Promise.all(users.map(async (u) => { tok[u.handle] = (await c.req('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } })).body.token; }));
  return { tok, total: users.reduce((s, u) => s + u.balance, 0), handles: users.map((u) => u.handle) };
}
async function snapshot(w) {
  const out = {};
  await Promise.all(w.handles.map(async (h) => { out[h] = (await c.req('GET', '/me', { token: w.tok[h] })).body; }));
  return out;
}
function judge(w, snap, fails, label = '') {
  stateChecks++;
  let sum = 0;
  for (const [h, m] of Object.entries(snap)) {
    sum += m?.total;
    if (!(m && m.balance === m.total && m.available === m.total - m.held && m.available >= 0 && m.held >= 0)) fails.push(`${label}${h}: ${JSON.stringify(m)}`);
  }
  if (sum !== w.total) fails.push(`${label}sum of totals ${sum} != ${w.total}`);
}
async function watching(w, fails, work) {
  let stop = false;
  const watcher = (async () => { while (!stop) judge(w, await snapshot(w), fails, 'during burst: '); })();
  const out = await work();
  stop = true; await watcher;
  return out;
}

const campaigns = {
  async 'compete-for-available'(r, fails) {
    const w = await world(r, 6, (i) => (i === 1 ? r.range(1000, 3000) : 1000));
    const ops = Array.from({ length: BURST }, (_, i) => {
      const amt = r.range(1, 300), to = `h${2 + (i % 4)}`;
      switch (r.int(4)) {
        case 0: return c.req('POST', '/payments', { token: w.tok.h1, key: `p${i}`, body: { to_handle: to, amount: amt } });
        case 1: return c.req('POST', '/authorizations', { token: w.tok.h1, key: `a${i}`, body: { to_handle: to, amount: amt } });
        case 2: return c.req('POST', '/settlements', { token: w.tok.h0, key: `s${i}`, body: { transfers: [{ from_handle: 'h1', to_handle: to, amount: amt }] } });
        default: return c.req('POST', '/requests', { token: w.tok[to], key: `q${i}`, body: { payer_handle: 'h1', amount: amt } }).then((q) => q.status === 201 ? c.req('POST', `/requests/${q.body.request_id}/pay`, { token: w.tok.h1, key: `qp${i}`, body: {} }) : q);
      }
    });
    const rs = await watching(w, fails, () => Promise.all(ops));
    if (rs.some((x) => ![200, 201, 409].includes(x.status) || (x.status === 409 && code(x) !== 'insufficient_funds'))) fails.push(`statuses ${JSON.stringify(tally(rs))}`);
    judge(w, await snapshot(w), fails, 'after: ');
  },
  async 'concurrent-captures-over-remainder'(r, fails) {
    const w = await world(r, 3, () => 100000);
    const amount = r.range(1000, 5000);
    const a = (await c.req('POST', '/authorizations', { token: w.tok.h1, key: 'auth', body: { to_handle: 'h2', amount } })).body;
    const parts = Array.from({ length: BURST }, () => r.range(1, Math.ceil(amount / 10)));
    const rs = await watching(w, fails, () => Promise.all(parts.map((p, i) => c.req('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.tok.h2, key: `c${i}`, body: { amount: p, final: false } }))));
    const captured = rs.reduce((s, x, i) => s + (x.status === 201 ? parts[i] : 0), 0);
    if (rs.some((x) => x.status !== 201 && !(x.status === 422 && code(x) === 'capture_exceeds_authorization') && !(x.status === 409 && code(x) === 'authorization_not_open'))) fails.push(`statuses ${JSON.stringify(tally(rs))}`);
    if (captured > amount) fails.push(`over-captured ${captured} > ${amount}`);
    const x = ((await c.req('GET', '/authorizations', { token: w.tok.h2 })).body.authorizations).find((y) => y.authorization_id === a.authorization_id);
    if (x.captured_amount !== captured || x.remaining_amount !== amount - captured || x.payment_ids.length !== rs.filter((y) => y.status === 201).length) fails.push(`auth record ${JSON.stringify(x)} vs captured ${captured}`);
    const snap = await snapshot(w);
    judge(w, snap, fails, 'after: ');
    if (snap.h2.total !== 100000 + captured || snap.h1.held !== amount - captured) fails.push(`money ${JSON.stringify(snap)} vs captured ${captured}`);
  },
  async 'same-key-new-paths'(r, fails) {
    const w = await world(r, 3, () => 100000);
    const amount = r.range(100, 900);
    const ra = await Promise.all(Array.from({ length: BURST }, () => c.req('POST', '/authorizations', { token: w.tok.h1, key: 'k-auth', body: { to_handle: 'h2', amount } })));
    if (ra.filter((x) => x.status === 201).length !== 1 || ra.filter((x) => x.status === 200).length !== BURST - 1 || !ra.every((x) => deepEqual(x.body, ra.find((y) => y.status === 201)?.body))) fails.push(`authorize burst ${JSON.stringify(tally(ra))}`);
    const id = ra.find((x) => x.status === 201)?.body?.authorization_id;
    const body = r.chance(0.5) ? {} : { amount: amount - 1 };
    const rc = await Promise.all(Array.from({ length: BURST }, () => c.req('POST', `/authorizations/${id}/capture`, { token: w.tok.h2, key: 'k-cap', body })));
    if (rc.filter((x) => x.status === 201).length !== 1 || rc.filter((x) => x.status === 200).length !== BURST - 1 || !rc.every((x) => deepEqual(x.body, rc.find((y) => y.status === 201)?.body))) fails.push(`capture burst ${JSON.stringify(tally(rc))}`);
    const snap = await snapshot(w);
    judge(w, snap, fails);
    const got = body.amount ?? amount;
    if (snap.h2.total !== 100000 + got || snap.h1.held !== 0) fails.push(`moved ${snap.h2.total - 100000}, expected ${got}; held ${snap.h1.held}`);
  },
  async 'capture-vs-void'(r, fails) {
    const w = await world(r, 3, () => 100000);
    for (let round = 0; round < 10; round++) {
      const amount = r.range(10, 500);
      const a = (await c.req('POST', '/authorizations', { token: w.tok.h1, key: `a${round}`, body: { to_handle: 'h2', amount } })).body;
      const before = await snapshot(w);
      const [cp, vd] = await Promise.all([
        c.req('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.tok.h2, key: `c${round}`, body: {} }),
        c.req('POST', `/authorizations/${a.authorization_id}/void`, { token: w.tok.h1 }),
      ]);
      const after = await snapshot(w);
      judge(w, after, fails);
      const st = ((await c.req('GET', '/authorizations', { token: w.tok.h1 })).body.authorizations).find((y) => y.authorization_id === a.authorization_id).status;
      const moved = after.h2.total - before.h2.total;
      if (cp.status === 201 && !(vd.status === 409 && st === 'captured' && moved === amount)) fails.push(`capture won but void ${vd.status}, status ${st}, moved ${moved}`);
      if (cp.status !== 201 && !(vd.status === 200 && st === 'voided' && moved === 0 && code(cp) === 'authorization_not_open')) fails.push(`void won but capture ${cp.status} ${code(cp)}, status ${st}, moved ${moved}`);
      if (after.h1.held !== 0) fails.push(`hold left after race: ${after.h1.held}`);
    }
  },
  async 'capture-racing-expiry'(r, fails) {
    const w = await world(r, 3, () => 100000, 1);
    const auths = [];
    for (let i = 0; i < 6; i++) auths.push((await c.req('POST', '/authorizations', { token: w.tok.h1, key: `e${i}`, body: { to_handle: 'h2', amount: 100 } })).body);
    await sleep(Math.max(0, Date.parse(auths[0].expires_at) - Date.now() - 40));
    const rs = await Promise.all(auths.map((a, i) => c.req('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.tok.h2, key: `ec${i}`, body: {} })));
    if (rs.some((x) => x.status !== 201 && !(x.status === 409 && code(x) === 'authorization_expired'))) fails.push(`statuses ${JSON.stringify(tally(rs))}`);
    await sleep(1100);
    const snap = await snapshot(w);
    judge(w, snap, fails);
    const ok = rs.filter((x) => x.status === 201).length;
    if (snap.h2.total !== 100000 + ok * 100 || snap.h1.held !== 0) fails.push(`expiry race: ${ok} captured, h2 ${snap.h2.total}, held ${snap.h1.held}`);
    const list = (await c.req('GET', '/authorizations?limit=200', { token: w.tok.h1 })).body.authorizations;
    if (list.filter((a) => a.status === 'captured').length !== ok || list.filter((a) => a.status === 'expired').length !== 6 - ok) fails.push(`statuses ${list.map((a) => a.status)}`);
  },
};

const results = [];
for (const [name, fn] of Object.entries(campaigns)) {
  if (args.only && !name.includes(args.only)) continue;
  for (const seed of seeds) {
    const fails = [];
    try { await fn(rng(seed), fails); } catch (e) { fails.push(`exception: ${e?.stack ?? e}`); }
    if (c.violations.length) fails.push(...c.violations.splice(0).map((v) => `protocol: ${v}`));
    results.push({ campaign: name, seed, passed: !fails.length, failures: fails.slice(0, 20) });
    console.log(`${fails.length ? 'FAIL' : 'ok  '} ${name} seed=${seed}${fails.length ? '\n      ' + fails.slice(0, 6).join('\n      ') : ''}`);
  }
}
const failed = results.filter((x) => !x.passed);
const report = { kind: 'adversarial-campaign', workers: BURST, seeds, campaigns: results.length, checks: stateChecks, passed: results.length - failed.length, failed: failed.length, requests: c.count, results };
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
console.log(`\nadversarial-holds: ${report.passed}/${report.campaigns} rounds passed, ${report.failed} failed, ${stateChecks} state checks`);
process.exit(failed.length ? 1 : 0);
