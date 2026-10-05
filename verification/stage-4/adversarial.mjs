#!/usr/bin/env node
// Adversarial campaigns: concurrent identical writes, concurrent conflicting writes,
// retries after lost responses, draining shared wallets, signup races, export under load.
// Each round is judged on the observable state afterwards, not on response codes alone.
//
// usage: node adversarial.mjs --base-url URL [--seeds 1,2,3] [--burst 50] [--only name] [--out report.json]
import { writeFileSync } from 'node:fs';
import { client, code, rng, deepEqual, PASSWORD } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : a), []));
const base = args['base-url'];
if (!base) { console.error('usage: adversarial.mjs --base-url URL'); process.exit(2); }
const seeds = String(args.seeds ?? '11,23,37,51,73').split(',').map(Number);
const BURST = Number(args.burst ?? 50);
const c = client(base);

async function world(r, n = 8, extra = {}) {
  const users = Array.from({ length: n }, (_, i) => ({ id: `u_w${i}`, email: `w${i}@example.com`, password: PASSWORD, display_name: `W${i}`, handle: `w${i}`, balance: extra.balance?.(i, r) ?? r.range(0, 5000) }));
  const fx = { currency: 'EUR', minor_units: 2, users, payments: [], requests: [], settlement_operator_ids: ['u_w0'] };
  const res = await c.req('POST', '/_test/reset', { body: fx });
  if (res.status !== 204) throw new Error(`reset ${res.status}`);
  const tok = {};
  await Promise.all(users.map(async (u) => { tok[u.handle] = (await c.req('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } })).body.token; }));
  return { fx, tok, total: users.reduce((s, u) => s + u.balance, 0), handles: users.map((u) => u.handle) };
}
async function balances(w) {
  const out = {};
  await Promise.all(w.handles.map(async (h) => { out[h] = (await c.req('GET', '/me', { token: w.tok[h] })).body?.balance; }));
  return out;
}
let stateChecks = 0;
async function conserve(w, fails, label = '') {
  const b = await balances(w);
  stateChecks += 1 + Object.keys(b).length;
  const sum = Object.values(b).reduce((s, x) => s + x, 0);
  if (sum !== w.total) fails.push(`${label}sum ${sum} != seeded ${w.total}`);
  for (const [h, x] of Object.entries(b)) if (!(Number.isInteger(x) && x >= 0)) fails.push(`${label}balance ${h}=${x}`);
  return b;
}
const tally = (rs) => rs.reduce((t, r) => { const k = `${r.status}${code(r) ? ' ' + code(r) : ''}`; t[k] = (t[k] ?? 0) + 1; return t; }, {});
const onlyStatuses = (rs, allowed) => rs.every((r) => allowed.includes(r.status));

// Watch balances while a burst runs: any negative balance observed is a §1.2 violation.
async function watching(w, fails, work) {
  let stop = false;
  const watcher = (async () => {
    let reads = 0;
    while (!stop) {
      const b = await balances(w); reads++;
      for (const [h, x] of Object.entries(b)) if (x < 0) fails.push(`transient negative balance ${h}=${x}`);
    }
    return reads;
  })();
  const out = await work();
  stop = true;
  await watcher;
  return out;
}

const campaigns = {
  // 50 identical POSTs with one unused key, on every idempotent path.
  async 'same-key-burst'(r, fails) {
    const w = await world(r, 6, { balance: () => 100000 });
    const q = (await c.req('POST', '/requests', { token: w.tok.w2, key: 'mk', body: { payer_handle: 'w1', amount: 77 } })).body;
    const cases = [
      ['/payments', 'w1', { to_handle: 'w2', amount: r.range(1, 900), note: 'burst' }],
      ['/requests', 'w1', { payer_handle: 'w3', amount: r.range(1, 900) }],
      ['/splits', 'w1', { amount: r.range(1, 900), participant_handles: ['w1', 'w3', 'w4'] }],
      [`/requests/${q.request_id}/pay`, 'w1', r.chance(0.5) ? {} : { visibility: 'private' }],
      ['/settlements', 'w0', { transfers: [{ from_handle: 'w1', to_handle: 'w5', amount: r.range(1, 900) }, { from_handle: 'w5', to_handle: 'w2', amount: 1 }] }],
    ];
    const before = await balances(w);
    let moved = { w1: 0, w2: 0, w5: 0 };
    for (const [path, who, body] of cases) {
      const key = `burst-${r.int(1e9)}`;
      const rs = await Promise.all(Array.from({ length: BURST }, () => c.req('POST', path, { token: w.tok[who], key, body })));
      const created = rs.filter((x) => x.status === 201), replays = rs.filter((x) => x.status === 200);
      if (created.length !== 1 || replays.length !== BURST - 1) fails.push(`${path}: expected 1×201 + ${BURST - 1}×200, got ${JSON.stringify(tally(rs))}`);
      if (created[0] && !replays.every((x) => deepEqual(x.body, created[0].body))) fails.push(`${path}: replay bodies differ from the 201 body`);
      if (path === '/payments') { moved.w1 -= body.amount; moved.w2 += body.amount; }
      if (path.endsWith('/pay')) { moved.w1 -= 77; moved.w2 += 77; }
      if (path === '/settlements') { moved.w1 -= body.transfers[0].amount; moved.w5 += body.transfers[0].amount - 1; moved.w2 += 1; }
    }
    const after = await conserve(w, fails);
    for (const h of Object.keys(moved)) if (after[h] - before[h] !== moved[h]) fails.push(`${h} moved ${after[h] - before[h]}, expected ${moved[h]} (operation applied more than once?)`);
    const rq = (await c.req('GET', '/requests?limit=200', { token: w.tok.w3 })).body.requests;
    if (rq.length !== 2) fails.push(`w3 has ${rq.length} requests, expected 2 (one /requests + one split)`);
  },

  // Many distinct payments from one wallet whose sum exceeds its balance.
  async 'overdraw'(r, fails) {
    const w = await world(r, 6);
    const bal = r.range(500, 3000);
    await c.req('POST', '/_test/reset', { body: { ...w.fx, users: w.fx.users.map((u, i) => (i === 1 ? { ...u, balance: bal } : u)) } });
    w.total = w.fx.users.reduce((s, u, i) => s + (i === 1 ? bal : u.balance), 0);
    await Promise.all(w.handles.map(async (h, i) => { w.tok[h] = (await c.req('POST', '/auth/login', { body: { email: `w${i}@example.com`, password: PASSWORD } })).body.token; }));
    const amounts = Array.from({ length: BURST }, () => r.range(1, Math.ceil(bal / 10)));
    const rs = await watching(w, fails, () => Promise.all(amounts.map((a, i) => c.req('POST', '/payments', { token: w.tok.w1, key: `od-${i}`, body: { to_handle: `w${2 + (i % 4)}`, amount: a } }))));
    if (!onlyStatuses(rs, [201, 409])) fails.push(`unexpected statuses ${JSON.stringify(tally(rs))}`);
    if (rs.some((x) => x.status === 409 && code(x) !== 'insufficient_funds')) fails.push('409 other than insufficient_funds');
    const spent = rs.reduce((s, x, i) => s + (x.status === 201 ? amounts[i] : 0), 0);
    const b = await conserve(w, fails);
    if (b.w1 !== bal - spent) fails.push(`w1=${b.w1}, expected ${bal} - ${spent}`);
    if (spent > bal) fails.push(`spent ${spent} > balance ${bal}`);
  },

  // Concurrent pay of one request with different keys; then pay vs decline vs cancel.
  async 'request-race'(r, fails) {
    const w = await world(r, 4, { balance: () => 10000 });
    const amt = r.range(1, 5000);
    const q = (await c.req('POST', '/requests', { token: w.tok.w2, key: 'q', body: { payer_handle: 'w1', amount: amt } })).body;
    const rs = await Promise.all(Array.from({ length: BURST }, (_, i) => c.req('POST', `/requests/${q.request_id}/pay`, { token: w.tok.w1, key: `pay-${i}`, body: {} })));
    const ok = rs.filter((x) => x.status === 201);
    if (ok.length !== 1 || rs.some((x) => x.status !== 201 && !(x.status === 409 && code(x) === 'request_not_pending'))) fails.push(`pay race: ${JSON.stringify(tally(rs))}`);
    const b = await conserve(w, fails);
    if (b.w1 !== 10000 - amt || b.w2 !== 10000 + amt) fails.push(`money moved ${10000 - b.w1} times amount ${amt}`);
    // pay vs decline vs cancel
    for (let round = 0; round < 5; round++) {
      const q2 = (await c.req('POST', '/requests', { token: w.tok.w3, key: `q2-${round}`, body: { payer_handle: 'w1', amount: 10 } })).body;
      const before = await balances(w);
      const ops = r.chance(0.5)
        ? [c.req('POST', `/requests/${q2.request_id}/pay`, { token: w.tok.w1, key: `p2-${round}`, body: {} }), c.req('POST', `/requests/${q2.request_id}/decline`, { token: w.tok.w1 }), c.req('POST', `/requests/${q2.request_id}/cancel`, { token: w.tok.w3 })]
        : [c.req('POST', `/requests/${q2.request_id}/cancel`, { token: w.tok.w3 }), c.req('POST', `/requests/${q2.request_id}/pay`, { token: w.tok.w1, key: `p2-${round}`, body: {} }), c.req('POST', `/requests/${q2.request_id}/decline`, { token: w.tok.w1 })];
      const res = await Promise.all(ops);
      const winners = res.filter((x) => x.status === 200 || x.status === 201);
      if (winners.length !== 1) fails.push(`pay/decline/cancel: ${winners.length} winners ${JSON.stringify(tally(res))}`);
      const final = (await c.req('GET', '/requests?limit=200', { token: w.tok.w3 })).body.requests.find((x) => x.request_id === q2.request_id);
      const after = await balances(w);
      const paid = after.w1 === before.w1 - 10;
      if (paid !== (final.status === 'paid')) fails.push(`status ${final.status} but money moved=${paid}`);
      if (final.status === 'pending') fails.push('request still pending after race');
    }
  },

  // Concurrent settlements competing for one wallet; each is affordable alone.
  async 'settlement-drain'(r, fails) {
    const w = await world(r, 8, { balance: (i) => (i === 1 ? 1000 : 300) });
    const rs = await watching(w, fails, () => Promise.all(Array.from({ length: 30 }, (_, i) => c.req('POST', '/settlements', { token: w.tok.w0, key: `s-${i}`, body: { transfers: [{ from_handle: 'w1', to_handle: `w${2 + (i % 6)}`, amount: 100 }, { from_handle: `w${2 + ((i + 1) % 6)}`, to_handle: 'w1', amount: r.range(0, 1) ? 50 : 1 }] } }))));
    if (!onlyStatuses(rs, [201, 409])) fails.push(`statuses ${JSON.stringify(tally(rs))}`);
    const ok = rs.filter((x) => x.status === 201).length;
    if (ok === 30) fails.push('every competing settlement committed although they are not jointly affordable');
    await conserve(w, fails);
    const feed = (await c.req('GET', '/activity?limit=200', { token: w.tok.w1 })).body.payments;
    if (feed.length !== ok * 2) fails.push(`feed has ${feed.length} members, expected ${ok * 2} (partial settlement?)`);
  },

  // Random concurrent transfers across a ring of wallets: conservation and no negatives.
  async 'ring-chaos'(r, fails) {
    const w = await world(r, 12);
    const ops = Array.from({ length: BURST * 2 }, (_, i) => {
      const a = r.int(12); let b = r.int(12); if (b === a) b = (a + 1) % 12;
      return r.chance(0.2)
        ? c.req('POST', '/settlements', { token: w.tok.w0, key: `rs-${i}`, body: { transfers: [{ from_handle: `w${a}`, to_handle: `w${b}`, amount: r.range(1, 3000) }, { from_handle: `w${b}`, to_handle: `w${(b + 1) % 12 === b ? 0 : (b + 1) % 12}`, amount: r.range(1, 3000) }] } })
        : c.req('POST', '/payments', { token: w.tok[`w${a}`], key: `rp-${i}`, body: { to_handle: `w${b}`, amount: r.range(1, 3000) } });
    });
    const rs = await watching(w, fails, () => Promise.all(ops));
    if (rs.some((x) => x.status >= 500 || x.status === 0)) fails.push(`5xx/timeout ${JSON.stringify(tally(rs))}`);
    await conserve(w, fails);
  },

  // A client gives up on its request (lost response) and retries with the same key.
  async 'lost-response-retry'(r, fails) {
    const w = await world(r, 4, { balance: () => 100000 });
    const before = await balances(w);
    let expected = 0;
    for (let i = 0; i < 25; i++) {
      const key = `lr-${i}`, amount = r.range(1, 100);
      const ac = new AbortController();
      const p = c.req('POST', '/payments', { token: w.tok.w1, key, body: { to_handle: 'w2', amount }, signal: ac.signal });
      setTimeout(() => ac.abort(), r.int(3));
      await p;
      const retries = await Promise.all(Array.from({ length: 3 }, () => c.req('POST', '/payments', { token: w.tok.w1, key, body: { to_handle: 'w2', amount } })));
      if (!retries.every((x) => x.status === 200 || x.status === 201)) fails.push(`retry ${i}: ${JSON.stringify(tally(retries))}`);
      if (retries.filter((x) => x.status === 201).length > 1) fails.push(`retry ${i}: more than one 201`);
      const bodies = retries.map((x) => x.body?.payment_id);
      if (new Set(bodies).size !== 1) fails.push(`retry ${i}: different payments ${bodies}`);
      expected += amount;
    }
    const after = await conserve(w, fails);
    if (before.w1 - after.w1 !== expected) fails.push(`w1 paid ${before.w1 - after.w1}, expected exactly ${expected}`);
  },

  // Same key, concurrent different bodies: at most one takes effect.
  async 'same-key-conflict'(r, fails) {
    const w = await world(r, 4, { balance: () => 100000 });
    const key = `cf-${r.int(1e9)}`;
    const amounts = Array.from({ length: BURST }, (_, i) => 100 + i);
    const rs = await Promise.all(amounts.map((a) => c.req('POST', '/payments', { token: w.tok.w1, key, body: { to_handle: 'w2', amount: a } })));
    const ok = rs.filter((x) => x.status === 201);
    if (ok.length !== 1) fails.push(`expected one 201, got ${JSON.stringify(tally(rs))}`);
    if (!rs.every((x) => x.status === 201 || (x.status === 409 && code(x) === 'idempotency_key_reuse') || (x.status === 200 && deepEqual(x.body, ok[0]?.body)))) fails.push(`unexpected ${JSON.stringify(tally(rs))}`);
    const b = await conserve(w, fails);
    if (100000 - b.w1 !== ok[0]?.body?.amount) fails.push(`w1 paid ${100000 - b.w1}`);
  },

  // Concurrent signups: same email, and different emails deriving the same handle.
  async 'signup-race'(r, fails) {
    await world(r, 2);
    const tag = r.int(1e6);
    const same = await Promise.all(Array.from({ length: 20 }, () => c.req('POST', '/auth/signup', { body: { email: `race${tag}@ex.com`, password: PASSWORD, display_name: 'R' } })));
    if (same.filter((x) => x.status === 201).length !== 1 || !same.every((x) => x.status === 201 || (x.status === 409 && code(x) === 'email_taken'))) fails.push(`same email: ${JSON.stringify(tally(same))}`);
    const handle = await Promise.all(Array.from({ length: 20 }, (_, i) => c.req('POST', '/auth/signup', { body: { email: `h.${tag}@d${i}.com`, password: PASSWORD, display_name: 'H' } })));
    if (handle.filter((x) => x.status === 201).length !== 1 || !handle.every((x) => x.status === 201 || (x.status === 409 && code(x) === 'handle_taken'))) fails.push(`same handle: ${JSON.stringify(tally(handle))}`);
    const t0 = Date.now();
    const logins = await Promise.all(Array.from({ length: 50 }, () => c.req('POST', '/auth/login', { body: { email: `race${tag}@ex.com`, password: PASSWORD } })));
    if (!logins.every((x) => x.status === 200)) fails.push(`50 concurrent logins: ${JSON.stringify(tally(logins))} in ${Date.now() - t0} ms`);
  },

  // Export while writes are in flight; the snapshot must import to a conserved, consistent state.
  async 'export-under-load'(r, fails) {
    const w = await world(r, 8);
    const writes = Array.from({ length: BURST }, (_, i) => c.req('POST', '/payments', { token: w.tok[`w${i % 8}`], key: `ex-${i}`, body: { to_handle: `w${(i + 3) % 8}`, amount: r.range(1, 700) } }));
    const exp = c.req('GET', '/_test/export');
    const [snap] = await Promise.all([exp, ...writes]);
    if (snap.status !== 200) { fails.push(`export ${snap.status}`); return; }
    const imp = await c.req('POST', '/_test/import', { body: snap.body });
    if (imp.status !== 204) { fails.push(`import of own export ${imp.status}`); return; }
    const b = await conserve(w, fails, 'after import: ');
    const feed = (await c.req('GET', '/activity?limit=200', { token: w.tok.w0 })).body.payments;
    const net = Object.fromEntries(w.handles.map((h) => [h, w.fx.users.find((u) => u.handle === h).balance]));
    for (const p of feed) { net[p.from_handle] -= p.amount; net[p.to_handle] += p.amount; }
    if (!deepEqual(net, b)) fails.push(`snapshot not atomic: balances ${JSON.stringify(b)} vs payments ${JSON.stringify(net)}`);
    // concurrent import + writes must not produce a 5xx or a broken sum
    const again = await Promise.all([c.req('POST', '/_test/import', { body: snap.body }), ...Array.from({ length: 20 }, (_, i) => c.req('POST', '/payments', { token: w.tok.w1, key: `ex2-${i}`, body: { to_handle: 'w2', amount: 1 } }))]);
    if (again.some((x) => x.status >= 500 || x.status === 0)) fails.push(`import under load: ${JSON.stringify(tally(again))}`);
    await conserve(w, fails, 'after import under load: ');
  },

  // Split shares under concurrency; paying every split request conserves money.
  async 'split-pay-all'(r, fails) {
    const w = await world(r, 6, { balance: () => 2000 });
    const splits = await Promise.all(Array.from({ length: 20 }, (_, i) => c.req('POST', '/splits', { token: w.tok.w0, key: `sp-${i}`, body: { amount: r.range(1, 300), participant_handles: ['w1', 'w2', 'w3', 'w0'].sort(() => r.next() - 0.5) } })));
    if (!splits.every((x) => x.status === 201)) { fails.push(`splits ${JSON.stringify(tally(splits))}`); return; }
    for (const s of splits) {
      const sum = s.body.shares.reduce((a, x) => a + x.amount, 0);
      const amts = s.body.shares.map((x) => x.amount);
      if (sum !== s.body.amount || Math.max(...amts) - Math.min(...amts) > 1 || amts.some((x, i) => i > 0 && x > amts[i - 1])) fails.push(`bad shares ${JSON.stringify(s.body.shares)} for ${s.body.amount}`);
    }
    const reqs = splits.flatMap((s) => s.body.requests);
    const pays = await Promise.all(reqs.map((q, i) => c.req('POST', `/requests/${q.request_id}/pay`, { token: w.tok[q.payer_handle], key: `spp-${i}`, body: {} })));
    if (!onlyStatuses(pays, [201, 409])) fails.push(`pays ${JSON.stringify(tally(pays))}`);
    await conserve(w, fails);
  },
};

const results = [];
for (const [name, fn] of Object.entries(campaigns)) {
  if (args.only && !name.includes(args.only)) continue;
  for (const seed of seeds) {
    const fails = [];
    const t0 = Date.now();
    try { await fn(rng(seed), fails); } catch (e) { fails.push(`exception: ${e?.stack ?? e}`); }
    if (c.violations.length) fails.push(...c.violations.splice(0).map((v) => `protocol: ${v}`));
    results.push({ campaign: name, seed, passed: fails.length === 0, failures: fails, ms: Date.now() - t0, reproduction: `node verification/stage-1/adversarial.mjs --base-url <url> --only ${name} --seeds ${seed}` });
    console.log(`${fails.length ? 'FAIL' : 'ok  '} ${name} seed=${seed} (${Date.now() - t0} ms)${fails.length ? '\n      ' + fails.slice(0, 8).join('\n      ') : ''}`);
  }
}
const failed = results.filter((x) => !x.passed);
const report = { kind: 'adversarial-campaign', base, workers: BURST, seeds, campaigns: results.length, rounds: results.length, checks: stateChecks, passed: results.length - failed.length, failed: failed.length, requests: c.count, results };
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
console.log(`\nadversarial: ${report.passed}/${report.rounds} rounds passed, ${report.failed} failed, ${c.count} requests`);
process.exit(failed.length ? 1 : 0);
