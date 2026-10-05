#!/usr/bin/env node
// Judge an official harness run for stage N from report.json / per-suite counts:
// suites 1..N must pass completely; the overshoot suite N+1 must have run and failed.
import { readFileSync, writeFileSync } from 'node:fs';
const [dir, stageArg] = process.argv.slice(2);
const N = Number(stageArg ?? 1);
const read = (f) => { try { return JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')); } catch { return null; } };
const report = read('report.json');
const problems = [];
if (!report) problems.push('report.json missing or unreadable');
if (report && report.state !== 'completed') problems.push(`harness state ${report?.state}`);
const suites = {};
for (let k = 1; k <= N; k++) {
  const s = report?.checks?.[String(k)] ?? read(`stage-${k}.counts.json`);
  suites[k] = s && { collected: s.collected, passed: s.passed, failed: s.failed, errors: s.errors };
  if (!s) problems.push(`stage ${k} counts missing`);
  else if (!(s.collected > 0) || s.failed !== 0 || s.errors !== 0 || s.passed !== s.collected) problems.push(`stage ${k}: ${JSON.stringify(suites[k])}`);
}
const LAST_STAGE = 4; // the track has four stages; no overshoot suite exists above the last one
const over = N >= LAST_STAGE ? null : read(`stage-${N + 1}.counts.json`);
if (N < LAST_STAGE && !over) problems.push(`overshoot suite ${N + 1} did not run`);
else if (over && (!(over.failed > 0 || over.errors > 0) || over.passed === over.collected)) problems.push(`overshoot: passed stage ${N + 1} (${JSON.stringify(over)})`);
const out = { kind: 'official-harness', stage: N, revision: report?.revision, mode: report?.mode, suites, overshoot: over && { collected: over.collected, passed: over.passed, failed: over.failed, errors: over.errors }, problems, failed: problems.length };
writeFileSync(`${dir}/judgement.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(problems.length ? 1 : 0);
