#!/usr/bin/env node
// Builds equivalents.json from the survivors of the replay campaigns. Only mutants with no
// difference observable through the HTTP API within the specified limits are registered;
// mutants that change unspecified behaviour (body-size cap, crafted-hash bounds, crafted
// sub-records of an imported state, default port outside the per-mutant harness) are NOT
// registered and stay in the kill-rate denominator as survivors.
// usage: node build-equivalents.mjs <mutation-report.json> <server.js> > equivalents.json
import { readFileSync } from 'node:fs';
const [reportPath, srcPath] = process.argv.slice(2);
const r = JSON.parse(readFileSync(reportPath, 'utf8'));
const src = readFileSync(srcPath, 'utf8').split('\n');
const R = {
  26: 'scrypt cost/salt parameters for new hashes: the hash stays a valid scrypt hash verified with its own stored parameters; only timing and the opaque export string differ.',
  33: 'changes only the human-readable error message, whose wording the specification leaves free (§5 "any wording").',
  40: 'changes only the human-readable not_found message; §5 allows any wording.',
  41: 'changes only the human-readable forbidden message; §5 allows any wording.',
  462: 'changes only the human-readable forbidden message; §5 allows any wording.',
  69: 'sign test for an infinite number in the canonical body form: +Infinity and -Infinity stay distinct under v>0, v>=0 and v>1, so body equality is unchanged.',
  78: 'salt length for new hashes (16 vs 17 random bytes): no observable difference other than the opaque hash string.',
  80: 'scrypt maxmem for new hashes: N=16384, r=8 needs 16 MiB, below every mutated limit, so hashing behaves identically.',
  117: 'initial pre-reset state value; every reset and import overwrites it before any user (and so any authenticated request) exists.',
  128: 'initial pre-reset id counter; overwritten by reset/import, and ids are opaque strings, so an offset start is unobservable.',
  129: 'initial pre-reset sequence number; overwritten by reset/import and only used for relative ordering.',
  130: 'initial pre-reset clock floor; overwritten by reset/import, and Date.now() exceeds it either way.',
  144: 'id counter step 1 vs 2: ids are opaque strings (§3.4); skipping numbers is unobservable.',
  157: 'token length (24 vs 25 random bytes): tokens are opaque; both are unguessable bearer tokens.',
  202: 'tie-break between items with an identical timestamp: §8 leaves the order of same-second items unspecified.',
  264: 'a missing Authorization header still fails the Bearer regex (RegExp.exec coerces undefined to "undefined"), so the response is the same 401.',
  376: 'loop bound i<n vs i<=n in equalSplit: the extra (n+1)th share is never read, shares[0..n-1] are identical.',
  537: 'the split record map is never read by any endpoint; split replays come from idempotency records, and the export state is opaque.',
  646: 'the first of two identical conflict checks; the re-check after hashing returns the same 409 codes, only later.',
  670: 'dummy hash for unknown-email logins only equalises timing; the response is the same 401.',
  704: 'a non-object fixture user still fails the next typeof id check with the same 422.',
  727: 'a non-object seeded payment still fails the next typeof id check with the same 422.',
  788: 'shifts every seeded timestamp by 1 ms into the past; relative order and the RFC 3339 form are unchanged.',
  790: 'seeded timestamps spaced 0 or 2 ms instead of 1 ms (or all equal, ordered by sequence): fixture order and newest-first order are unchanged.',
  792: 'shifts seeded timestamps by 1-2 ms into the past; order unchanged.',
  800: 'clock floor after reset: now() takes max(Date.now(), floor) and Date.now() is already >= the reset time.',
  866: 'imported id counter not restored: newId() skips ids already present, so no collision and ids stay opaque.',
  867: 'imported sequence number not restored: sequence only breaks ties between identical timestamps, which §8 leaves unordered.',
  868: 'imported clock floor not restored: new timestamps come from Date.now(), which is later than any exported time.',
  1000: 'headersSent/destroyed guard: every handler sends exactly once, so the guard never changes behaviour.',
  1001: 'Node never writes a body on a 204 response, so the 204 special case is behaviourally identical to the JSON path.',
  1018: 'logging of an unexpected error to stderr; no HTTP-observable effect.',
  1019: 'the 500 fallback is unreachable: no handler throws a non-HttpError in any exercised path (no 5xx was ever observed).',
  1063: 'maxHeaderSize 64 KiB vs 65 KiB: no specified request comes near the header size limit.',
  1064: 'keep-alive timeout of 75 s vs 76 s: far beyond the 5 s per-request window.',
  1065: 'headers timeout of 76 s vs 77 s: far beyond the 5 s per-request window.',
  1066: 'requestTimeout 0 vs 1 ms / default: Node applies it only to slow uploads; every specified request body arrives within it.',
  1068: 'startup log line; no HTTP-observable effect.',
  1070: 'dummy hash for timing equalisation on unknown-email login; responses are unchanged.',
  1071: 'graceful shutdown timing on SIGTERM/SIGINT; state need not survive a restart (§2).',
  1072: 'SIGTERM handler; the container is stopped either way and state is ephemeral (§2).',
  1073: 'SIGINT handler; no HTTP-observable effect.',
  1079: 'module.exports for in-process tests; the service is started as a program and exports are unused.',
};
const out = {};
for (const x of r.results.filter((y) => y.outcome === 'survived')) {
  const reason = R[x.line];
  if (!reason) continue;
  if (x.line === 1066 && !/requestTimeout/.test(src[x.line - 1])) continue;
  out[x.id] = { classification: 'equivalent', location: `src/server.js:${x.line}:${x.column} ${x.operator} ${JSON.stringify(x.original).slice(0, 60)} -> ${JSON.stringify(x.replacement).slice(0, 40)}`, reason };
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
