import { client, code, fixture, seed, balances, newKey } from './lib.mjs';
const base = process.argv[2] ?? 'http://127.0.0.1:18101';
const c = client(base);
// Field names below were read from this candidate's own export output (black-box observation of
// an opaque, implementation-defined format), not from its source. Advisory cases are the ones
// whose rejection the specification cannot pin down for an opaque format.
const ADVISORY = new Set(['payment from == to', 'request requester == payer', 'request pending with payment', 'request paid refs unknown payment', 'payment amount 0', 'payment refs unknown request', 'payment refs unknown settlement', 'request paid without payment']);
let blockingFailures = 0;
const s = await seed(c);
const k = newKey();
await c.req('POST','/payments',{token:s.tok.ada,key:k,body:{to_handle:'bob',amount:3}});
const q = await c.req('POST','/requests',{token:s.tok.bob,key:newKey(),body:{payer_handle:'ada',amount:4}});
await c.req('POST',`/requests/${q.body.request_id}/pay`,{token:s.tok.ada,key:newKey(),body:{}});
const good = (await c.req('GET','/_test/export')).body;
const cases = {
  'negative balance': st => { st.users[0].balance = -5; },
  'fractional balance': st => { st.users[0].balance = 1.5; },
  'string balance': st => { st.users[0].balance = '5'; },
  'huge balance > 2^53': st => { st.users[0].balance = 2**60; },
  'duplicate payment': st => { st.payments.push(st.payments[0]); },
  'duplicate request': st => { st.requests.push(st.requests[0]); },
  'duplicate user': st => { st.users.push(st.users[0]); },
  'duplicate handle': st => { st.users[1].handle = st.users[0].handle; },
  'invalid handle': st => { st.users[1].handle = 'BAD HANDLE'; },
  'user missing id': st => { delete st.users[0].id; },
  'user missing password hash': st => { for (const k of Object.keys(st.users[0])) if (/pass|hash/.test(k)) delete st.users[0][k]; },
  'plaintext-looking hash': st => { for (const k of Object.keys(st.users[0])) if (/pass|hash/.test(k)) st.users[0][k] = 'correct horse'; },
  'payment from unknown user': st => { st.payments[0].from = 'u_ghost'; },
  'payment to unknown user': st => { st.payments[0].to = 'u_ghost'; },
  'payment from == to': st => { st.payments[0].to = st.payments[0].from; },
  'payment missing created_at': st => { delete st.payments[0].created_at; },
  'payment created_at garbage': st => { st.payments[0].created_at = 'yesterday'; },
  'request requester == payer': st => { st.requests[0].payer = st.requests[0].requester; },
  'request pending with payment': st => { st.requests[0].payment_id = st.payments[0].id; },
  'request paid refs unknown payment': st => { st.requests.at(-1).payment_id = 'pay_ghost'; },
  'payment amount 0': st => { st.payments[0].amount = 0; },
  'payment amount string': st => { st.payments[0].amount = 'x'; },
  'payment bad visibility': st => { st.payments[0].visibility = 'friends'; },
  'payment refs unknown request': st => { st.payments.at(-1).request_id = 'rq_ghost'; },
  'payment refs unknown settlement': st => { st.payments[0].settlement_id = 'st_ghost'; },
  'request bad status': st => { st.requests[0].status = 'bogus'; },
  'request paid without payment': st => { const r = st.requests.at(-1); r.payment_id = null; },
  'request payer unknown': st => { st.requests[0].payer = 'u_ghost'; },
  'token for unknown user': st => { st.tokens.push({ ...st.tokens[0], user_id: 'u_ghost' }); for (const t of st.tokens) if (t.user_id === undefined) t[Object.keys(t).find(k=>/user/.test(k))] = 'u_ghost'; },
  'operator unknown user': st => { st.settlement_operator_ids.push('u_ghost'); },
  'minor_units 5': st => { st.minor_units = 5; },
  'currency missing': st => { delete st.currency; },
  'users not array': st => { st.users = {}; },
  'idempotency not array': st => { st.idempotency = 'x'; },
  'idempotency record unknown user': st => { const r = st.idempotency[0]; for (const k of Object.keys(r)) if (/user/.test(k)) r[k] = 'u_ghost'; },
};
for (const [name, f] of Object.entries(cases)) {
  const copy = JSON.parse(JSON.stringify(good)); f(copy.state);
  const r = await c.req('POST','/_test/import',{body:copy});
  let note = '';
  if (r.status === 204) {
    const b = await balances(c, s.tok);
    const sum = Object.values(b).reduce((a,x)=>a+(typeof x==='number'?x:0),0);
    note = ` balances=${JSON.stringify(b)} sum=${sum}`;
    await c.req('POST','/_test/import',{body:good});
  }
  const cls = ADVISORY.has(name) ? 'advisory' : (r.status === 422 && code(r) === 'validation_failed' ? 'ok' : 'FAIL');
  if (cls === 'FAIL') blockingFailures++;
  console.log(`${cls.padEnd(8)} ${r.status} ${code(r) ?? ''}  ${name}${note}`);
}
console.log('violations', c.violations);
console.log(`import-semantic: ${blockingFailures} blocking failures`);
process.exit(blockingFailures || c.violations.length ? 1 : 0);
