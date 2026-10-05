#!/usr/bin/env node
// Judge an official harness run from its report.json and per-suite counts.
// Stage 1 must pass completely; the stage-2 overshoot suite must have run and failed.
import { readFileSync, writeFileSync } from 'node:fs';
const dir = process.argv[2];
const read = (f) => { try { return JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')); } catch { return null; } };
const report = read('report.json');
const s1 = report?.checks?.['1'] ?? read('stage-1.counts.json');
const s2 = read('stage-2.counts.json');
const problems = [];
if (!report) problems.push('report.json missing or unreadable');
if (report && report.state !== 'completed') problems.push(`harness state ${report?.state}`);
if (!s1) problems.push('stage-1 counts missing');
else {
  if (!(s1.collected > 0)) problems.push(`stage 1 collected ${s1.collected}`);
  if (s1.failed !== 0 || s1.errors !== 0) problems.push(`stage 1 failed ${s1.failed}, errors ${s1.errors}`);
  if (s1.passed !== s1.collected) problems.push(`stage 1 passed ${s1.passed} of ${s1.collected}`);
}
if (!s2) problems.push('stage-2 overshoot counts missing (probe did not run)');
else if (!(s2.failed > 0 || s2.errors > 0) || s2.passed === s2.collected) problems.push(`overshoot: the stage-1 folder passed stage 2 (${JSON.stringify(s2)})`);
const out = { kind: 'official-harness', revision: report?.revision, mode: report?.mode, stage1: s1 && { collected: s1.collected, passed: s1.passed, failed: s1.failed, errors: s1.errors }, stage2Overshoot: s2 && { collected: s2.collected, passed: s2.passed, failed: s2.failed, errors: s2.errors }, problems, failed: problems.length };
writeFileSync(`${dir}/judgement.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(problems.length ? 1 : 0);
