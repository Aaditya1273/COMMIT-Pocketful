// Self-tests for the mutation engine, the campaign runner and the bootstrap script,
// against tiny throwaway targets. Each failure mode must stay a failure.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { discover } from './lib/mutants.ts';
import { startService } from './lib/proc.ts';
import { validateReport } from './lib/schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const temp = (prefix = 'commit-tools-') => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d; };
const node = (args: string[], cwd: string) => spawnSync(process.execPath, ['--no-warnings', ...args], { cwd, encoding: 'utf8' });

// A target with one meaningful computation, and a check that pins it.
const SERVER = `const add = (a, b) => a + b;
require('node:http').createServer((q, s) => {
  if (q.url === '/health') return s.writeHead(200).end('ok');
  s.writeHead(200).end(String(add(2, 3)));
}).listen(Number(process.env.PORT), '127.0.0.1');
`;
const CHECK = `node -e "fetch(process.argv[1] + '/sum').then((r) => r.text()).then((t) => process.exit(t === '5' ? 0 : 1))" {url}`;

function target(): string {
  const root = temp();
  mkdirSync(join(root, 'svc', 'src'), { recursive: true });
  writeFileSync(join(root, 'svc', 'src', 'server.js'), SERVER);
  return root;
}

const mutate = (root: string, extra: string[]) =>
  node([join(here, 'mutate.ts'), '--target', 'svc', '--start', 'node src/server.js', '--check', CHECK, '--jobs', '2', ...extra], root);

test('mutation campaign: kills the defect it should, reports a consistent, valid summary', () => {
  const root = target();
  const r = mutate(root, ['--out', 'm', '--timeout', '4000']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(readFileSync(join(root, 'm', 'mutation-report.json'), 'utf8'));
  assert.deepEqual(validateReport(report, 0), []);
  // Deleting the response leaves the request hanging: the budget stops it, and a hang
  // is reported as a timeout -- never as a kill, never as a pass.
  const hang = report.results.find((x: any) => x.operator === 'statement-deletion' && x.original.includes('s.writeHead(200).end(String'));
  assert.equal(hang?.outcome, 'timeout');
  const arithmetic = report.results.find((x: any) => x.operator === 'arithmetic' && x.original === '+');
  assert.equal(arithmetic.outcome, 'killed', 'a + b -> a - b changes 5, so the check must kill it');
  const t = report.summary.tally;
  assert.equal(t.killed + t.survived + t.timeout + t.invalid + t.error + t.equivalent, report.summary.executed);
  assert.equal(readFileSync(join(root, 'svc', 'src', 'server.js'), 'utf8'), SERVER, 'the target itself was never modified');
});

test('mutation campaign: a failing baseline means no score at all', () => {
  const root = target();
  const r = node([join(here, 'mutate.ts'), '--target', 'svc', '--start', 'node src/server.js', '--check', 'exit 1', '--out', 'm'], root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /CAMPAIGN BROKEN/);
  assert.ok(!existsSync(join(root, 'm', 'mutation-report.json')));
});

test('mutation campaign: a check that cannot run is an error, never a kill', () => {
  const root = target();
  const r = node([join(here, 'mutate.ts'), '--target', 'svc', '--start', 'node src/server.js', '--check', 'no-such-command-xyz {url}', '--out', 'm'], root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /CAMPAIGN BROKEN/);
});

test('mutation campaign: a stale or malformed equivalents register is rejected', () => {
  const root = target();
  writeFileSync(join(root, 'stale.json'), JSON.stringify({ 'm-0000000000': { classification: 'equivalent', location: 'x', reason: 'a reason that is long enough to count' } }));
  assert.match(mutate(root, ['--out', 'a', '--exclude', 'stale.json']).stderr, /stale/);
  writeFileSync(join(root, 'bad.json'), JSON.stringify({ 'm-0000000000': 'just a string' }));
  assert.match(mutate(root, ['--out', 'b', '--exclude', 'bad.json']).stderr, /invalid equivalent-mutant register/);
});

test('mutation campaign: --only replays exactly the named mutant', () => {
  const root = target();
  const id = discover('src/server.js', SERVER).find((m) => m.operator === 'arithmetic')!.id;
  const r = mutate(root, ['--out', 'm', '--only', id]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(readFileSync(join(root, 'm', 'mutation-report.json'), 'utf8'));
  assert.deepEqual(report.results.map((x: any) => x.id), [id]);
  assert.equal(report.summary.selection, 'only');
});

// A counter service and a model of it, for the campaign runner.
const COUNTER = (bug: boolean) => `let n = 0;
require('node:http').createServer((q, s) => {
  if (q.url === '/health') return s.writeHead(200).end('ok');
  if (q.url === '/inc') n += ${bug ? '(n === 7 ? 2 : 1)' : '1'};
  s.writeHead(200).end(String(n));
}).listen(Number(process.env.PORT), '127.0.0.1');
`;
const MODULE = `export default {
  name: 'counter',
  async setup() { return { model: { n: 0, base: '' }, initial: 0 }; },
  generate(m, r) { return r.chance(0.7) ? 'inc' : 'read'; },
  step(m, op) { if (op === 'inc') m.n++; return m.n; },
  async execute(op, m) { return Number(await (await fetch(m.base + '/' + op)).text()); },
  mismatch(e, o) { return e === o ? null : 'counter is ' + o + ', model says ' + e; },
  async compareState() { return null; },
};
`;

async function runCounter(bug: boolean, seed: string) {
  const root = temp();
  writeFileSync(join(root, 'server.cjs'), COUNTER(bug));
  writeFileSync(join(root, 'counter.campaign.mjs'), MODULE.replace("base: ''", 'base: process.env.BASE'));
  const { service } = await startService('node server.cjs', { cwd: root, timeoutMs: 10_000 });
  assert.ok(service);
  try {
    const r = spawnSync(process.execPath, ['--no-warnings', join(here, 'campaign.ts'), '--module', 'counter.campaign.mjs', '--base-url', service.url, '--seed', seed, '--operations', '40', '--out', 'rep'], { cwd: root, encoding: 'utf8', env: { ...process.env, BASE: service.url } });
    return { code: r.status, report: JSON.parse(readFileSync(join(root, 'rep', 'reference-report.json'), 'utf8')), err: r.stderr };
  } finally {
    service.stop();
  }
}

test('reference campaign: the same seed replays the same operation sequence', async () => {
  const a = await runCounter(false, '42');
  const b = await runCounter(false, '42');
  assert.equal(a.code, 0, a.err);
  assert.deepEqual(a.report.operations, b.report.operations);
  assert.match(a.report.moduleSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(validateReport(a.report, 0), []);
});

test('reference campaign: a divergence is found and reported with its seed and step', async () => {
  const r = await runCounter(true, '42');
  assert.equal(r.code, 1);
  assert.equal(r.report.result, 'diverged');
  assert.equal(r.report.seed, 42);
  assert.match(r.report.firstDivergence.detail, /counter is 9, model says 8/);
  assert.deepEqual(validateReport(r.report, 1), []);
});

test('reference campaign: no seed, no run -- an unrecorded seed cannot be replayed', () => {
  const r = node([join(here, 'campaign.ts'), '--module', 'x.mjs', '--base-url', 'http://127.0.0.1:1'], temp());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--seed/);
});

const BOOTSTRAP = join(here, 'bootstrap.sh');
const sh = (args: string[]) => spawnSync('sh', [BOOTSTRAP, ...args], { encoding: 'utf8' });

test('bootstrap: installs into a fresh directory (spaces in the path) and is idempotent', () => {
  const dest = join(temp(), 'result repo with spaces');
  const first = sh([dest]);
  assert.equal(first.status, 0, first.stderr);
  for (const f of ['mandates/planner.md', 'mandates/builder.md', 'mandates/verifier.md', 'commit/verify.ts', 'commit/lib/proc.ts', 'commit/VERSION', 'FACTORY.md', '.commit-factory', '.gitignore', '.git']) {
    assert.ok(existsSync(join(dest, f)), `${f} installed`);
  }
  assert.ok(!readdirSync(dest).some((f) => /^stage-/.test(f)), 'no stage folders are created');
  assert.match(readFileSync(join(dest, '.gitignore'), 'utf8'), /^!evidence\/\*\*\/\*\.log$/m, 'evidence logs are committed, not ignored');
  const second = sh([dest]);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /already installed/);
});

test('bootstrap: never silently overwrites a changed file; --force backs it up first', () => {
  const dest = temp();
  sh([dest]);
  const edited = '# my own planner\nHarness: X\nModel: y\n';
  writeFileSync(join(dest, 'mandates', 'planner.md'), edited);
  const refused = sh([dest]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /CONFLICT[\s\S]*mandates\/planner\.md/);
  assert.equal(readFileSync(join(dest, 'mandates', 'planner.md'), 'utf8'), edited, 'nothing was written');
  const forced = sh(['--force', dest]);
  assert.equal(forced.status, 0, forced.stderr);
  const backup = readdirSync(dest).find((f) => f.startsWith('.commit-backup-'))!;
  assert.equal(readFileSync(join(dest, backup, 'mandates', 'planner.md'), 'utf8'), edited);
  assert.notEqual(readFileSync(join(dest, 'mandates', 'planner.md'), 'utf8'), edited);
});

test('bootstrap: refuses unsafe destinations and bad arguments', () => {
  assert.equal(sh([dirname(here)]).status, 2, 'not into the factory itself');
  assert.equal(sh([join(dirname(here), 'commit')]).status, 2, 'not inside the factory either');
  assert.equal(sh(['/']).status, 2);
  assert.equal(sh(['--bogus', temp()]).status, 2);
  assert.equal(sh([]).status, 2);
  assert.equal(sh(['--help']).status, 0);
});

test('bootstrap: --check runs the installed toolkit in the new repository', () => {
  const dest = temp();
  const r = sh(['--check', dest]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /self-test: PASS/);
});
