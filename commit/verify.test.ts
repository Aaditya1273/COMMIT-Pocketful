// Meta-verification: the release gate must never turn bad, missing or contradictory
// evidence into ACCEPT. Each test builds a throwaway git repository with a tiny
// candidate service and runs commit/verify.ts against it as a real subprocess.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditRun } from './audit.ts';

const VERIFY = join(dirname(fileURLToPath(import.meta.url)), 'verify.ts');
const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const SERVER = `require('node:http').createServer((q, s) => { s.writeHead(q.url === '/health' ? 200 : 404).end('ok'); }).listen(Number(process.env.PORT), '127.0.0.1');\n`;
const HEALTHY = `node -e "fetch(process.argv[1] + '/health').then((r) => process.exit(r.status === 200 ? 0 : 1))" {url}`;

/** A git repo holding svc/server.cjs, committed and clean. */
function repo(opts: { git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'commit-test-'));
  roots.push(root);
  mkdirSync(join(root, 'svc'));
  writeFileSync(join(root, 'svc', 'server.cjs'), SERVER);
  if (opts.git !== false) {
    const g = (...a: string[]) => spawnSync('git', a, { cwd: root, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'candidate');
  }
  return root;
}

function plan(root: string, steps: unknown[], extra: Record<string, unknown> = {}): string {
  const path = join(root, 'plan.json');
  writeFileSync(path, JSON.stringify({ stage: 'test', target: 'svc', specification: 'test spec', service: { start: 'node server.cjs', health: '/health' }, steps, ...extra }));
  return path;
}

const step = (id: string, cmd: string, more: Record<string, unknown> = {}) => ({ id, kind: 'required', blocking: true, cmd, ...more });

function verify(root: string, planPath: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', VERIFY, '--plan', planPath, '--out', 'ev', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
  const evidencePath = join(root, 'ev', 'evidence.json');
  return { code: r.status, out: r.stdout + r.stderr, evidence: existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null };
}

test('a clean revision whose blocking steps pass is ACCEPTED, and its evidence audits clean', () => {
  const root = repo();
  const r = verify(root, plan(root, [step('health', HEALTHY, { needsService: true })]));
  assert.equal(r.code, 0, r.out);
  assert.equal(r.evidence.verdict, 'ACCEPT');
  assert.match(r.evidence.revision.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(auditRun(join(root, 'ev')).problems, []);
});

test('an empty plan proves nothing: INCONCLUSIVE, never ACCEPT', () => {
  const root = repo();
  const r = verify(root, plan(root, []));
  assert.equal(r.code, 3, r.out);
  assert.equal(r.evidence.verdict, 'INCONCLUSIVE');
});

test('a failing blocking step is a REJECT with its reproduction', () => {
  const root = repo();
  const r = verify(root, plan(root, [step('broken', 'echo boom; exit 3')]));
  assert.equal(r.code, 1);
  assert.equal(r.evidence.verdict, 'REJECT');
  const md = readFileSync(join(root, 'ev', 'verdict.md'), 'utf8');
  assert.match(md, /^REJECT$/m);
  assert.match(md, /echo boom; exit 3/);
});

test('a hung step is stopped at its budget and is never success', () => {
  const root = repo();
  const started = Date.now();
  const r = verify(root, plan(root, [step('hang', 'sleep 30', { timeoutMs: 1000 })]), [], { COMMIT_KILL_GRACE_MS: '100' });
  assert.ok(Date.now() - started < 15_000, 'the timeout was enforced');
  assert.equal(r.evidence.steps[0].status, 'TIMEOUT');
  assert.equal(r.evidence.verdict, 'REJECT');
  assert.match(readFileSync(join(root, 'ev', 'logs', 'hang.log'), 'utf8'), /COMMAND TIMEOUT/);
});

test('a declared report that was never written is an ERROR, not a pass', () => {
  const root = repo();
  const r = verify(root, plan(root, [step('quiet', 'true', { report: 'r/report.json' })]));
  assert.equal(r.code, 4);
  assert.equal(r.evidence.verdict, 'ERROR');
});

test('a report claiming failures behind exit 0 is a contradiction: REJECT', () => {
  const root = repo();
  const r = verify(root, plan(root, [step('liar', `mkdir -p {out}/r && echo '{"kind":"x","total":5,"failed":2}' > {out}/r/report.json`, { report: 'r/report.json' })]));
  assert.equal(r.evidence.steps[0].status, 'FAILED');
  assert.equal(r.evidence.verdict, 'REJECT');
});

test('a malformed report is an ERROR', () => {
  const root = repo();
  const r = verify(root, plan(root, [step('garbled', `mkdir -p {out}/r && echo 'not json' > {out}/r/report.json`, { report: 'r/report.json' })]));
  assert.equal(r.evidence.verdict, 'ERROR');
});

test('a step that writes into the candidate voids the run: ERROR', () => {
  const root = repo();
  const r = verify(root, plan(root, [step('tamper', 'echo patched >> svc/server.cjs')]));
  assert.equal(r.code, 4);
  assert.equal(r.evidence.productionModificationByVerifier, 'DETECTED');
});

test('uncommitted changes in the candidate can never be ACCEPTED', () => {
  const root = repo();
  writeFileSync(join(root, 'svc', 'extra.txt'), 'uncommitted');
  const r = verify(root, plan(root, [step('ok', 'true')]), ['--allow-dirty']);
  assert.equal(r.evidence.revision.targetDirty, true);
  assert.equal(r.evidence.verdict, 'INCONCLUSIVE');
});

test('an unidentified revision (not a git checkout) can never be ACCEPTED', () => {
  const root = repo({ git: false });
  const r = verify(root, plan(root, [step('ok', 'true')]));
  assert.equal(r.evidence.revision.commit, null);
  assert.equal(r.evidence.verdict, 'INCONCLUSIVE');
});

test('--revision must match HEAD', () => {
  const root = repo();
  const r = verify(root, plan(root, [step('ok', 'true')]), ['--revision', 'deadbeef']);
  assert.equal(r.code, 2);
  assert.match(r.out, /REPOSITORY_ERROR/);
});

test('a candidate that does not start is REJECTED and its dependent steps are BLOCKED', () => {
  const root = repo();
  const p = plan(root, [step('health', HEALTHY, { needsService: true })], { service: { start: 'exit 1', health: '/health' } });
  const r = verify(root, p, [], { COMMIT_SERVICE_START_TIMEOUT_MS: '3000' });
  assert.equal(r.evidence.verdict, 'REJECT');
  assert.equal(r.evidence.steps.find((s: any) => s.id === 'service-start').status, 'FAILED');
  assert.equal(r.evidence.steps.find((s: any) => s.id === 'health').status, 'BLOCKED');
});

test('an unmet environment precondition is BLOCKED: INCONCLUSIVE, not REJECT', () => {
  const root = repo();
  const r = verify(root, plan(root, [step('ok', 'true'), step('needs-tool', 'true', { environment: 'command -v no-such-tool-xyz' })]));
  assert.equal(r.evidence.verdict, 'INCONCLUSIVE');
});

test('shell metacharacters in --out cannot inject commands', () => {
  const root = repo();
  const p = plan(root, [step('ls', 'ls {out} > /dev/null')]);
  const r = spawnSync(process.execPath, ['--no-warnings', VERIFY, '--plan', p, '--out', 'ev; touch PWNED $(touch PWNED2)'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!existsSync(join(root, 'PWNED')) && !existsSync(join(root, 'PWNED2')), 'nothing outside the quoted argument ran');
});

test('huge output is bounded on disk and the truncation is recorded', () => {
  const root = repo();
  const r = verify(root, plan(root, [step('noisy', `node -e "process.stdout.write('x'.repeat(300000))"`)]), [], { COMMIT_MAX_LOG_BYTES: '65536' });
  const s = r.evidence.steps[0];
  assert.equal(s.outputBytes, 300000);
  assert.equal(s.outputTruncated, true);
  assert.match(readFileSync(join(root, 'ev', s.log), 'utf8'), /OUTPUT TRUNCATED/);
  assert.ok(readFileSync(join(root, 'ev', s.log)).length < 70_000);
});

test('credentials in step output are redacted before they become evidence', () => {
  const root = repo();
  // Assembled at run time so this source file itself never holds a credential shape
  // (it is installed into result repositories, which a credential scanner checks).
  const token = ['abcdefghij', '1234567890', 'XYZ'].join('');
  const r = verify(root, plan(root, [step('leaky', `echo "Authorization: ${'Bear' + 'er'} ${token}"; echo "${'API' + '_KEY'}=supersecretvalue"`)]));
  const log = readFileSync(join(root, 'ev', r.evidence.steps[0].log), 'utf8');
  assert.ok(!log.includes(token) && !log.includes('supersecretvalue'), log);
  assert.ok(r.evidence.steps[0].redactions >= 2);
});

test('invalid input fails fast with a usage error and no evidence', () => {
  const root = repo();
  writeFileSync(join(root, 'bad.json'), JSON.stringify({ stage: 'x', target: '../escape', specification: 's', steps: [{ id: 'A B', cmd: '', blocking: 'yes' }] }));
  const bad = verify(root, join(root, 'bad.json'));
  assert.equal(bad.code, 2);
  assert.match(bad.out, /INPUT_ERROR/);
  mkdirSync(join(root, 'ev'), { recursive: true });
  writeFileSync(join(root, 'ev', 'old.txt'), 'previous run');
  const reused = verify(root, plan(root, [step('ok', 'true')]));
  assert.equal(reused.code, 2);
  assert.match(reused.out, /non-empty/);
});

test('an interrupted run stops its children, says CANCELLED and writes no verdict', async () => {
  const root = repo();
  const p = plan(root, [step('long', 'sleep 37.25')]);
  const child = spawn(process.execPath, ['--no-warnings', VERIFY, '--plan', p, '--out', 'ev'], { cwd: root, stdio: 'ignore' });
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(root, 'ev', 'run-state.json')) || !readFileSync(join(root, 'ev', 'run-state.json'), 'utf8').includes('STEP long')) {
    assert.ok(Date.now() < deadline, 'run never reached the step');
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 300));
  child.kill('SIGINT');
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 130);
  assert.equal(JSON.parse(readFileSync(join(root, 'ev', 'run-state.json'), 'utf8')).status, 'CANCELLED');
  assert.ok(!existsSync(join(root, 'ev', 'evidence.json')) && !existsSync(join(root, 'ev', 'verdict.md')));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(spawnSync('pgrep', ['-f', 'sleep 37.25']).status, 1, 'the child process was stopped');
  assert.deepEqual(auditRun(join(root, 'ev')).problems, [], 'an honest partial run audits clean');
});

test('the auditor catches altered evidence', () => {
  const root = repo();
  verify(root, plan(root, [step('ok', 'echo fine')]));
  const ev = join(root, 'ev');
  writeFileSync(join(ev, 'verdict.md'), readFileSync(join(ev, 'verdict.md'), 'utf8').replace(/^ACCEPT$/m, 'REJECT'));
  writeFileSync(join(ev, 'logs', 'ok.log'), 'rewritten');
  const problems = auditRun(ev).problems.join('\n');
  assert.match(problems, /verdict\.md says REJECT/);
  assert.match(problems, /changed since the run/);
  assert.ok(readdirSync(ev).includes('evidence.sha256'));
});

test('files a step writes into the evidence directory are scrubbed of the home directory', () => {
  const root = repo();
  const home = process.env.HOME!;
  const r = verify(root, plan(root, [step('tool', `mkdir -p {out}/tool && echo "report at ${home}/somewhere" > {out}/tool/out.txt`)]));
  assert.equal(r.code, 0, r.out);
  const written = readFileSync(join(root, 'ev', 'tool', 'out.txt'), 'utf8');
  assert.ok(!written.includes(home) && written.includes('~/somewhere'), written);
});
