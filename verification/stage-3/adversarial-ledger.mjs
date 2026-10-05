#!/usr/bin/env node
// Stage-3 adversarial campaigns: concurrent corrections on the same expected revision,
// corrections racing payments with snapshots held open, and conservation in historical
// views under concurrent corrections. usage: node adversarial-ledger.mjs --base-url URL [--seeds ..]
import { writeFileSync } from 'node:fs';
import { client, code, rng, deepEqual, PASSWORD } from './lib.mjs';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : a), []));
const c = client(args['base-url']);
const seeds = String(args.seeds ?? '11,23,37,51,73').split(',').map(Number);
const BURST = Number(args.burst ?? 30);
let checks = 0;
const q = encodeURIComponent;
const tally = (rs) => rs.reduce((t, r) => { const k = `${r.status}${code(r) ? ' ' + code(r) : ''}`; t[k] = (t[k] ?? 0) + 1; return t; }, {});
async function world(n) {
  const users = Array.from({ length: n }, (_, i) => ({ id: `u_l${i}`, email: `l${i}@example.com`, password: PASSWORD, display_name: `L${i}`, handle: `l${i}`, balance: 100000 }));
  const r = await c.req('POST', '/_test/reset', { body: { currency: 'EUR', minor_units: 2, users, payments: [], requests: [], settlement_operator_ids: ['u_l0'] } });
  if (r.status !== 204) throw new Error(`reset ${r.status}`);
  const tok = {};
  await Promise.all(users.map(async (u) => { tok[u.handle] = (await c.req('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } })).body.token; }));
  return { tok, handles: users.map((u) => u.handle), total: n * 100000 };
}
async function sumAt(w, query, fails, label) {
  checks++;
  let sum = 0;
  for (const h of w.handles) { const m = (await c.req('GET', '/me' + query, { token: w.tok[h] })).body; sum += m?.balance; if (!(m?.balance >= 0)) fails.push(`${label}: negative ${h} ${m?.balance}`); }
  if (sum !== w.total) fails.push(`${label}: sum ${sum} != ${w.total}`);
}
const campaigns = {
  async 'same-expected-revision'(r, fails) {
    const w = await world(3);
    const p = (await c.req('POST', '/payments', { token: w.tok.l1, key: 'p', body: { to_handle: 'l2', amount: 5000 } })).body;
    const rs = await Promise.all(Array.from({ length: BURST }, (_, i) => c.req('POST', `/payments/${p.payment_id}/corrections`, { token: w.tok.l1, key: `c${i}`, body: { expected_revision: 1, amount: r.range(0, 9000), effective_at: p.created_at, reason: `r${i}` } })));
    const ok = rs.filter((x) => x.status === 201);
    if (ok.length !== 1 || rs.some((x) => x.status !== 201 && !(x.status === 409 && code(x) === 'stale_revision'))) fails.push(`expected exactly one 201, rest stale: ${JSON.stringify(tally(rs))}`);
    const rv = (await c.req('GET', `/payments/${p.payment_id}/revisions`, { token: w.tok.l1 })).body.revisions;
    if (rv.length !== 2 || rv[1].amount !== ok[0]?.body?.amount) fails.push(`revisions ${JSON.stringify(rv)}`);
    const m = (await c.req('GET', '/me', { token: w.tok.l2 })).body.balance;
    if (m !== 100000 + ok[0]?.body?.amount) fails.push(`receiver ${m} vs corrected amount ${ok[0]?.body?.amount}`);
    await sumAt(w, '', fails, 'now');
  },
  async 'same-key-correction-burst'(r, fails) {
    const w = await world(3);
    const p = (await c.req('POST', '/payments', { token: w.tok.l1, key: 'p', body: { to_handle: 'l2', amount: 5000 } })).body;
    const body = { expected_revision: 1, amount: r.range(0, 9000), effective_at: p.created_at, reason: 'burst' };
    const rs = await Promise.all(Array.from({ length: BURST }, () => c.req('POST', `/payments/${p.payment_id}/corrections`, { token: w.tok.l1, key: 'same', body })));
    const ok = rs.filter((x) => x.status === 201);
    if (ok.length !== 1 || rs.filter((x) => x.status === 200).length !== BURST - 1 || !rs.every((x) => deepEqual(x.body, ok[0]?.body))) fails.push(`same-key burst ${JSON.stringify(tally(rs))}`);
    await sumAt(w, '', fails, 'now');
  },
  async 'snapshots-under-concurrent-writes'(r, fails) {
    const w = await world(4);
    const pays = [];
    for (let i = 0; i < 6; i++) pays.push((await c.req('POST', '/payments', { token: w.tok.l1, key: `s${i}`, body: { to_handle: `l${2 + (i % 2)}`, amount: r.range(1, 3000) } })).body);
    const first = await c.req('GET', '/statement?limit=2', { token: w.tok.l1 });
    const snap = first.body.snapshot;
    const frozen = (await c.req('GET', `/statement?snapshot=${q(snap)}&limit=200`, { token: w.tok.l1 })).body;
    const writes = [];
    for (let i = 0; i < BURST; i++) {
      if (r.chance(0.5)) writes.push(c.req('POST', '/payments', { token: w.tok.l1, key: `w${i}`, body: { to_handle: 'l2', amount: r.range(1, 500) } }));
      else { const p = r.pick(pays); writes.push(c.req('POST', `/payments/${p.payment_id}/corrections`, { token: w.tok.l1, key: `k${i}`, body: { expected_revision: 1, amount: r.range(0, 4000), effective_at: p.created_at, reason: 'race' } })); }
      writes.push(c.req('GET', `/statement?snapshot=${q(snap)}&limit=${r.range(1, 4)}&offset=${r.range(0, 6)}`, { token: w.tok.l1 }).then((x) => ({ snapRead: x })));
    }
    const rs = await Promise.all(writes);
    for (const x of rs) {
      if (x.snapRead) {
        const b = x.snapRead.body;
        if (x.snapRead.status !== 200 || b.opening_balance !== frozen.opening_balance || b.closing_balance !== frozen.closing_balance) fails.push(`snapshot moved: ${x.snapRead.status} ${b?.opening_balance}/${b?.closing_balance}`);
        for (const e of b.entries ?? []) { const f = frozen.entries.find((y) => y.payment.payment_id === e.payment.payment_id); if (!deepEqual(e, f)) fails.push(`snapshot entry changed ${e.payment.payment_id}`); }
      } else if (x.status >= 500 || x.status === 0) fails.push(`write ${x.status}`);
    }
    const after = (await c.req('GET', `/statement?snapshot=${q(snap)}&limit=200`, { token: w.tok.l1 })).body;
    if (!deepEqual([after.entries, after.opening_balance, after.closing_balance], [frozen.entries, frozen.opening_balance, frozen.closing_balance])) fails.push('snapshot differs after the burst');
    const live = (await c.req('GET', '/statement?limit=200', { token: w.tok.l1 })).body;
    checks++;
    if (live.opening_balance + live.entries.reduce((s, e) => s + e.delta, 0) !== live.closing_balance) fails.push('live statement: opening + deltas != closing');
    if (live.closing_balance !== (await c.req('GET', '/me', { token: w.tok.l1 })).body.balance) fails.push('live closing != current balance');
    await sumAt(w, '', fails, 'now');
  },
  async 'historical-conservation'(r, fails) {
    const w = await world(5);
    const marks = [];
    const ps = [];
    for (let i = 0; i < 15; i++) {
      const a = r.int(5); let b = r.int(5); if (b === a) b = (a + 1) % 5;
      const p = (await c.req('POST', '/payments', { token: w.tok[`l${a}`], key: `h${i}`, body: { to_handle: `l${b}`, amount: r.range(1, 20000) } })).body;
      if (p?.payment_id) { ps.push({ p, from: `l${a}` }); marks.push(p.created_at); }
    }
    const rs = await Promise.all(ps.map(({ p, from }, i) => c.req('POST', `/payments/${p.payment_id}/corrections`, { token: w.tok[from], key: `hc${i}`, body: { expected_revision: 1, amount: r.range(0, 30000), effective_at: r.pick(marks.filter((m) => Date.parse(m) <= Date.parse(p.created_at)).concat([p.created_at])), reason: 'hist' } })));
    if (rs.some((x) => ![201, 409].includes(x.status) || (x.status === 409 && !['insufficient_funds', 'historical_overdraft'].includes(code(x))))) fails.push(`corrections ${JSON.stringify(tally(rs))}`);
    const nowIso = new Date().toISOString();
    for (const m of [...marks.slice(0, 5), nowIso]) await sumAt(w, `?as_of=${q(m)}`, fails, `as_of ${m}`);
    for (const m of marks.slice(0, 3)) await sumAt(w, `?as_of=${q(nowIso)}&known_at=${q(m)}`, fails, `known_at ${m}`);
    for (const h of w.handles) {
      checks++;
      const st = (await c.req('GET', '/statement?limit=200', { token: w.tok[h] })).body;
      if (st.opening_balance !== 100000) fails.push(`${h} opening changed: ${st.opening_balance}`);
      let bal = st.opening_balance;
      for (const e of st.entries) { bal += e.delta; if (e.balance_after !== bal || bal < 0) fails.push(`${h} running balance ${e.balance_after} vs ${bal}`); }
      if (bal !== st.closing_balance) fails.push(`${h} closing`);
    }
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
const report = { kind: 'adversarial-campaign', workers: BURST, seeds, campaigns: results.length, checks, passed: results.length - failed.length, failed: failed.length, results };
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
console.log(`\nadversarial-ledger: ${report.passed}/${report.campaigns} rounds passed, ${report.failed} failed, ${checks} state checks`);
process.exit(failed.length ? 1 : 0);
