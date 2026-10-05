#!/usr/bin/env node
// Resource-limit probes from §2: reset of a large fixture within 10 s (distinct passwords,
// so no shared-hash shortcut applies), 50 concurrent logins within 5 s each, 50 concurrent
// mixed requests within 5 s each, and a large request body handled without a 5xx.
// usage: node limits.mjs URL [users]
import { client, code } from './lib.mjs';
const c = client(process.argv[2], { requestTimeoutMs: 5000, testTimeoutMs: 10000 });
const N = Number(process.argv[3] ?? 200);
const fails = [];
const users = Array.from({ length: N }, (_, i) => ({ id: `u_${i}`, email: `user${i}@example.com`, password: `distinct-password-${i}-${(i * 7919) % 1000}`, display_name: `U${i}`, handle: `user${i}`, balance: 1000 }));
const payments = Array.from({ length: 500 }, (_, i) => ({ id: `p_${i}`, from_user_id: `u_${i % N}`, to_user_id: `u_${(i + 1) % N}`, amount: 1, note: '', visibility: i % 2 ? 'public' : 'private' }));
const requests = Array.from({ length: 300 }, (_, i) => ({ id: `rq_${i}`, requester_id: `u_${i % N}`, payer_id: `u_${(i + 2) % N}`, amount: 5, note: 'x', status: ['pending', 'paid', 'declined', 'cancelled'][i % 4] === 'paid' ? 'pending' : ['pending', 'declined', 'cancelled'][i % 3] }));
let t0 = Date.now();
const r = await c.req('POST', '/_test/reset', { body: { currency: 'EUR', minor_units: 2, users, payments, requests, settlement_operator_ids: ['u_0'] } });
const resetMs = Date.now() - t0;
if (r.status !== 204) fails.push(`reset of ${N} users: ${r.status} ${r.text.slice(0, 200)}`);
console.log(`reset ${N} users with distinct passwords + 500 payments + 300 requests: ${r.status} in ${resetMs} ms`);
if (resetMs > 10000) fails.push(`reset took ${resetMs} ms > 10000`);
t0 = Date.now();
const logins = await Promise.all(Array.from({ length: 50 }, (_, i) => c.req('POST', '/auth/login', { body: { email: users[i].email, password: users[i].password } })));
const worst = Math.max(...logins.map((x) => x.ms ?? 99999));
console.log(`50 concurrent logins (distinct users): ${logins.filter((x) => x.status === 200).length} ok, slowest ${worst} ms, wall ${Date.now() - t0} ms`);
if (!logins.every((x) => x.status === 200) || worst > 5000) fails.push('50 concurrent logins not all 200 within 5 s');
const toks = logins.map((x) => x.body?.token);
t0 = Date.now();
const mixed = await Promise.all(Array.from({ length: 50 }, (_, i) => {
  const t = toks[i];
  switch (i % 5) {
    case 0: return c.req('POST', '/payments', { token: t, key: `l-${i}`, body: { to_handle: `user${(i + 7) % N}`, amount: 3 } });
    case 1: return c.req('GET', '/activity?limit=200', { token: t });
    case 2: return c.req('GET', '/requests?limit=200', { token: t });
    case 3: return c.req('POST', '/auth/signup', { body: { email: `fresh${i}@ex.com`, password: 'longenough', display_name: 'F' } });
    default: return c.req('GET', '/_test/export');
  }
}));
const worstMixed = Math.max(...mixed.map((x) => x.ms ?? 99999));
console.log(`50 concurrent mixed requests: statuses ${JSON.stringify(mixed.reduce((a, x) => ({ ...a, [x.status]: (a[x.status] ?? 0) + 1 }), {}))}, slowest ${worstMixed} ms`);
if (mixed.some((x) => x.status >= 500 || x.status === 0) || worstMixed > 5000) fails.push('mixed load had 5xx or > 5 s');
const big = await c.req('POST', '/payments', { token: toks[0], key: 'big', raw: JSON.stringify({ to_handle: 'user1', amount: 1, pad: 'x'.repeat(5 * 1024 * 1024) }) });
console.log(`5 MiB body: ${big.status} ${code(big) ?? ''}`);
if (big.status >= 500 || big.status === 0) fails.push(`5 MiB body: ${big.status}`);
const health = await c.req('GET', '/health');
if (health.status !== 200) fails.push('unhealthy after limits probe');
if (c.violations.length) fails.push(...c.violations);
console.log(fails.length ? `limits: FAIL\n  ${fails.join('\n  ')}` : 'limits: all within §2 budgets');
process.exit(fails.length ? 1 : 0);
