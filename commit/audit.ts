// Evidence consistency audit: does every rendering of a verification run agree with its
// machine-readable record, and has nothing been altered since?
//
//   node commit/audit.ts <evidence dir> [<evidence dir> ...] [--json]
//
// Checks, per run: the manifest's sha256 matches evidence.sha256; the manifest passes
// its schema; every log and report still has the sha256 recorded for it; verdict.md
// and scorecard.md state the manifest's verdict; scorecard mutation numbers equal the
// mutation report's; a cancelled or unfinished run has no verdict.
// Runs written before evidence schema 2 are audited for what they recorded and
// reported as "legacy". Exit: 0 all consistent, 1 a contradiction, 2 usage error.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EXIT, FACTORY_VERSION } from './lib/config.ts';
import { validateEvidence } from './lib/schema.ts';

const USAGE = 'usage: node commit/audit.ts <evidence dir> [...] [--json]\nexit: 0 consistent, 1 contradiction found, 2 usage error';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export interface AuditResult {
  dir: string;
  schema: 'v2' | 'legacy' | 'none';
  verdict: string | null;
  problems: string[];
}

export function auditRun(dir: string): AuditResult {
  const problems: string[] = [];
  const file = (name: string) => join(dir, name);
  const statePath = file('run-state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  if (!existsSync(file('evidence.json'))) {
    if (state && state.status !== 'COMPLETED') return { dir, schema: 'none', verdict: null, problems: [] }; // honest partial run
    return { dir, schema: 'none', verdict: null, problems: ['evidence.json is missing'] };
  }
  const raw = readFileSync(file('evidence.json'), 'utf8');
  let evidence: any;
  try {
    evidence = JSON.parse(raw);
  } catch {
    return { dir, schema: 'none', verdict: null, problems: ['evidence.json is not valid JSON'] };
  }
  const schema = evidence.schemaVersion === undefined ? 'legacy' : 'v2';
  if (schema === 'v2') problems.push(...validateEvidence(evidence).map((p) => `schema: ${p}`));
  if (state && state.status !== 'COMPLETED') problems.push(`run-state is ${state.status} but a verdict was written`);

  const recorded = existsSync(file('evidence.sha256')) ? readFileSync(file('evidence.sha256'), 'utf8').split(/\s+/)[0] : null;
  if (recorded !== sha256(raw)) problems.push('evidence.json does not match evidence.sha256: the manifest was altered after the run');

  for (const step of evidence.steps ?? []) {
    if (!existsSync(file(step.log))) problems.push(`step ${step.id}: log ${step.log} is missing`);
    else if (sha256(readFileSync(file(step.log))) !== step.logSha256) problems.push(`step ${step.id}: log ${step.log} changed since the run`);
  }
  for (const a of evidence.artifacts ?? []) {
    if (!existsSync(file(a.path))) problems.push(`artifact ${a.path} is missing`);
    else if (sha256(readFileSync(file(a.path))) !== a.sha256) problems.push(`artifact ${a.path} changed since the run`);
  }

  const verdict: string = evidence.verdict;
  const verdictMd = existsSync(file('verdict.md')) ? readFileSync(file('verdict.md'), 'utf8') : null;
  const verdictLine = verdictMd?.split('\n').find((l) => l.trim() && !l.startsWith('```'))?.trim();
  if (verdictLine !== verdict) problems.push(`verdict.md says ${verdictLine ?? '(missing)'} but evidence.json says ${verdict}`);
  const scorecard = existsSync(file('scorecard.md')) ? readFileSync(file('scorecard.md'), 'utf8') : null;
  const scoreVerdict = scorecard?.match(/^Final verdict:\s+(\S+)/m)?.[1];
  if (scoreVerdict !== verdict) problems.push(`scorecard.md says ${scoreVerdict ?? '(missing)'} but evidence.json says ${verdict}`);

  const mutation = Object.values(evidence.reports ?? {}).find((r: any) => r?.kind === 'mutation-campaign') as any;
  if (mutation && scorecard) {
    const field = (name: string) => scorecard.match(new RegExp(`^\\s+${name}:\\s+(\\S+)`, 'm'))?.[1];
    const want: Record<string, string> = {
      killed: String(mutation.tally.killed), survived: String(mutation.tally.survived),
      'valid mutants': String(mutation.valid), 'kill rate': typeof mutation.killRate === 'number' ? `${(mutation.killRate * 100).toFixed(1)}%` : 'n/a',
    };
    for (const [name, value] of Object.entries(want)) {
      if (field(name) !== value) problems.push(`scorecard.md ${name} is ${field(name)} but the mutation report says ${value}`);
    }
  }
  return { dir, schema, verdict, problems };
}

// Exact path comparison: a suffix test would also match self-audit.ts, which imports this.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean', default: false }, help: { type: 'boolean', default: false }, version: { type: 'boolean', default: false } } });
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    process.exit(EXIT.USAGE);
  }
  if (parsed.values.help) { console.log(USAGE); process.exit(EXIT.OK); }
  if (parsed.values.version) { console.log(FACTORY_VERSION); process.exit(EXIT.OK); }
  if (!parsed.positionals.length) { console.error(USAGE); process.exit(EXIT.USAGE); }
  const results = parsed.positionals.map(auditRun);
  if (parsed.values.json) console.log(JSON.stringify(results, null, 2));
  else {
    for (const r of results) {
      console.log(`${r.problems.length ? 'FAIL' : 'PASS'} ${r.dir} (${r.schema}${r.verdict ? `, ${r.verdict}` : ', no verdict'})`);
      for (const p of r.problems) console.log(`     - ${p}`);
    }
  }
  process.exit(results.some((r) => r.problems.length) ? EXIT.REJECT : EXIT.OK);
}
