// Independent verification run: executes a verification plan against one exact
// candidate revision and writes the evidence and the verdict.
//
//   node commit/verify.ts --plan <plan.json> --out <new dir>
//        [--revision <sha>] [--skip id,id] [--allow-dirty] [--factory run.json]
//
// The verifier never edits the candidate: it starts the service from a throwaway copy
// and digests the candidate tree before and after; if the digest moved the verdict is
// ERROR whatever the checks said.
//
// Verdict precedence: ERROR > REJECT > INCONCLUSIVE > ACCEPT.
//   ACCEPT        every blocking step ran and passed, on a clean, identified revision
//   REJECT        a blocking step failed or timed out, or the candidate did not start
//   INCONCLUSIVE  nothing failed, but required evidence is missing: a blocking step was
//                 blocked by the environment or skipped, no blocking step ran, or the
//                 revision is unidentified or has uncommitted changes
//   ERROR         the verification itself is untrustworthy: the candidate changed during
//                 the run, a step could not be executed, or a declared report is missing
//                 or malformed
// Exit codes: ACCEPT 0, REJECT 1, usage/config 2, INCONCLUSIVE 3, ERROR 4, interrupted 130.
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { detectEnvironment, EXIT, FACTORY_VERSION, loadConfig } from './lib/config.ts';
import { redact, scrubHome, shQuote, writeAtomic, writeJsonAtomic } from './lib/fsx.ts';
import { onInterrupt, run, runShell, startService, type Service } from './lib/proc.ts';
import { EVIDENCE_SCHEMA_VERSION, validateEvidence, validatePlan, validateReport, type Plan, type Step } from './lib/schema.ts';

const USAGE = `usage: node commit/verify.ts --plan PLAN.json --out NEW_DIR [options]

  --plan PATH        verification plan (JSON; see docs/factory/verification.md)
  --out DIR          evidence directory; must not exist or be empty
  --revision SHA     refuse to run unless HEAD is this commit
  --skip ID,ID       record these steps as SKIPPED (a skipped blocking step prevents ACCEPT)
  --allow-dirty      allow uncommitted changes in the candidate (the verdict still cannot be ACCEPT)
  --factory PATH     factory-run facts (dispatches, cycles, tokens) to include in the scorecard
  --help, --version

exit: 0 ACCEPT, 1 REJECT, 2 usage/config error, 3 INCONCLUSIVE, 4 ERROR, 130 interrupted`;

type StepStatus = 'PASSED' | 'FAILED' | 'TIMEOUT' | 'ERROR' | 'BLOCKED' | 'SKIPPED';
type Verdict = 'ACCEPT' | 'REJECT' | 'INCONCLUSIVE' | 'ERROR';

interface StepResult {
  id: string;
  kind: string;
  blocking: boolean;
  requirements: string[];
  command: string;
  status: StepStatus;
  reason: string | null;
  exitCode: number | null;
  durationMs: number;
  outputBytes: number;
  outputTruncated: boolean;
  redactions: number;
  log: string;
  logSha256: string;
  report: string | null;
}

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

function parse() {
  try {
    return parseArgs({
      options: {
        plan: { type: 'string' }, out: { type: 'string' }, revision: { type: 'string' },
        skip: { type: 'string', default: '' }, 'allow-dirty': { type: 'boolean', default: false },
        factory: { type: 'string' }, help: { type: 'boolean', default: false }, version: { type: 'boolean', default: false },
      },
    }).values;
  } catch (error) {
    return fail(EXIT.USAGE, `${(error as Error).message}\n\n${USAGE}`);
  }
}

const args = parse();
if (args.help) fail(EXIT.OK, USAGE);
if (args.version) fail(EXIT.OK, FACTORY_VERSION);
if (!args.plan || !args.out) fail(EXIT.USAGE, USAGE);

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  fail(EXIT.USAGE, `CONFIG_ERROR: ${(error as Error).message}`);
}

const root = process.cwd();
let plan: Plan;
try {
  plan = JSON.parse(readFileSync(args.plan, 'utf8'));
} catch (error) {
  fail(EXIT.USAGE, `INPUT_ERROR: cannot read plan ${args.plan}: ${(error as Error).message}`);
}
const planProblems = validatePlan(plan);
if (planProblems.length) fail(EXIT.USAGE, `INPUT_ERROR: invalid plan ${args.plan}:\n  ${planProblems.join('\n  ')}`);
const target = resolve(root, plan.target);
if (!existsSync(target) || !statSync(target).isDirectory()) fail(EXIT.USAGE, `INPUT_ERROR: plan target ${plan.target} is not a directory`);
const skip = new Set(args.skip!.split(',').map((s) => s.trim()).filter(Boolean));
const unknownSkips = [...skip].filter((id) => !plan.steps.some((s) => s.id === id));
if (unknownSkips.length) fail(EXIT.USAGE, `INPUT_ERROR: --skip names unknown steps: ${unknownSkips.join(', ')}`);

const out = resolve(root, args.out);
if (existsSync(out) && readdirSync(out).length > 0) fail(EXIT.USAGE, `INPUT_ERROR: refusing to write into non-empty ${out}; one directory per run`);
mkdirSync(join(out, 'logs'), { recursive: true });

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Content digest of the candidate tree: relative paths and bytes, in a fixed order. */
function treeDigest(dir: string): string {
  const files = (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((f) => !f.split(/[\\/]/).some((p) => p === 'node_modules' || p === '.git') && statSync(join(dir, f)).isFile())
    .sort();
  const h = createHash('sha256');
  for (const f of files) h.update(f + '\0').update(readFileSync(join(dir, f))).update('\0');
  return h.digest('hex');
}

async function git(...gitArgs: string[]): Promise<string | null> {
  const r = await run('git', gitArgs, { cwd: root, timeoutMs: 30_000 });
  return r.status === 'exited' && r.exitCode === 0 ? r.tail.trim() : null;
}

const startedAt = new Date();
const runId = `${startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(3).toString('hex')}`;
const statePath = join(out, 'run-state.json');
const state = { runId, factoryVersion: FACTORY_VERSION, status: 'RUNNING', phase: 'STARTED', completedSteps: [] as string[], updatedAt: startedAt.toISOString() };
const saveState = (patch: Partial<typeof state>) => writeJsonAtomic(statePath, Object.assign(state, patch, { updatedAt: new Date().toISOString() }));
saveState({});

let service: Service | null = null;
let sandbox = '';
onInterrupt((signal) => {
  service?.stop();
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  // Interrupted runs keep their logs and say so; they never write a verdict.
  saveState({ status: 'CANCELLED', phase: `interrupted by ${signal}` });
  console.error(`\nCANCELLED by ${signal}; partial evidence kept in ${relative(root, out)} (no verdict written)`);
});

const relTarget = relative(root, target) || '.';
const digestBefore = treeDigest(target);
const head = await git('rev-parse', 'HEAD');
const revision = {
  commit: head && /^[0-9a-f]{40}$/.test(head) ? head : null,
  branch: await git('rev-parse', '--abbrev-ref', 'HEAD'),
  targetDirty: head ? (await git('status', '--porcelain', '--', relTarget)) !== '' : true,
  targetDigest: digestBefore,
};
if (args.revision !== undefined && (!/^[0-9a-f]{7,40}$/.test(args.revision) || !(revision.commit ?? '').startsWith(args.revision))) {
  fail(EXIT.USAGE, `REPOSITORY_ERROR: --revision ${args.revision} requested, but HEAD is ${revision.commit ?? '(not a git checkout)'}`);
}
const environment = await detectEnvironment();

// The service runs from a copy, so no step can write into the candidate through it.
let serviceLog = '';
if (plan.service) {
  saveState({ phase: 'SERVICE_START' });
  sandbox = mkdtempSync(join(tmpdir(), 'commit-verify-'));
  cpSync(target, sandbox, { recursive: true, filter: (p) => !p.split(/[\\/]/).some((part) => part === 'node_modules' || part === '.git') });
  const started = await startService(plan.service.start, { cwd: sandbox, healthPath: plan.service.health, timeoutMs: config.serviceStartTimeoutMs, killGraceMs: config.killGraceMs });
  service = started.service;
  serviceLog = started.log();
}

const relOut = relative(root, out);

/**
 * Tools a step runs may write their own files into the evidence directory (an external
 * harness's logs and reports). Scrub the home directory from all of them before anything
 * is validated or hashed, as for step logs.
 */
function scrubEvidenceTree(): void {
  for (const f of readdirSync(out, { recursive: true, encoding: 'utf8' }) as string[]) {
    const path = join(out, f);
    if (f === 'run-state.json' || !statSync(path).isFile() || statSync(path).size > 64 * 1024 * 1024) continue;
    const raw = readFileSync(path);
    if (raw.includes(0)) continue; // binary
    const text = raw.toString('utf8');
    const clean = scrubHome(text);
    if (clean !== text) writeAtomic(path, clean);
  }
}
const results: StepResult[] = [];

function record(step: Step, status: StepStatus, reason: string | null, output: string, extra: Partial<StepResult> = {}): StepResult {
  const log = join('logs', `${step.id}.log`);
  writeAtomic(join(out, log), output);
  return {
    id: step.id, kind: step.kind, blocking: step.blocking, requirements: step.requirements ?? [], command: extra.command ?? step.cmd,
    status, reason, exitCode: null, durationMs: 0, outputBytes: Buffer.byteLength(output), outputTruncated: false, redactions: 0,
    log, logSha256: sha256(output), report: step.report ?? null, ...extra,
  };
}

if (plan.service && !service) {
  // A candidate that does not start is the candidate's failure, not the environment's.
  const startStep: Step = { id: 'service-start', kind: 'startup', cmd: plan.service.start, blocking: true };
  results.push(record(startStep, 'FAILED', `the candidate did not answer ${plan.service.health ?? '/health'} with 200 within ${config.serviceStartTimeoutMs} ms`, serviceLog));
}

for (const step of plan.steps) {
  saveState({ phase: `STEP ${step.id}` });
  const substituted = (step.needsService ? step.cmd.replaceAll('{url}', shQuote(service?.url ?? '')) : step.cmd)
    .replaceAll('{out}', shQuote(relOut)).replaceAll('{kickoff}', shQuote(config.kickoffDir));
  let result: StepResult;
  if (skip.has(step.id)) {
    result = record(step, 'SKIPPED', 'skipped by --skip for this run; a skipped blocking step can never yield ACCEPT', '', { command: substituted });
  } else if (step.needsService && !service) {
    result = record(step, 'BLOCKED', 'needs the candidate service, which did not start', serviceLog, { command: substituted });
  } else {
    const precondition = step.environment?.replaceAll('{kickoff}', shQuote(config.kickoffDir));
    const env = precondition ? await runShell(precondition, { cwd: root, timeoutMs: 30_000 }) : null;
    if (env && !(env.status === 'exited' && env.exitCode === 0)) {
      result = record(step, 'BLOCKED', `environment precondition not met: ${precondition}`, `environment precondition failed: ${precondition}\n${env.tail}`, { command: substituted });
    } else {
      const logRel = join('logs', `${step.id}.log`);
      const r = await runShell(substituted, { cwd: root, timeoutMs: step.timeoutMs ?? config.stepTimeoutMs, logPath: join(out, logRel), maxLogBytes: config.maxLogBytes, killGraceMs: config.killGraceMs });
      // Redact credentials before the log can become public evidence.
      const raw = readFileSync(join(out, logRel), 'utf8');
      const scrubbed = scrubHome(raw);
      const { text, redactions } = redact(scrubbed);
      const note = r.truncated ? `\n[commit] OUTPUT TRUNCATED: ${r.bytes} bytes written, first ${config.maxLogBytes} kept\n` : '';
      const final = text + note + (r.status === 'timeout' ? `\n[commit] COMMAND TIMEOUT after ${r.durationMs} ms; process group terminated (SIGTERM, then SIGKILL)\n` : '');
      if (redactions || scrubbed !== raw || note || r.status === 'timeout') writeAtomic(join(out, logRel), final);
      let status: StepStatus = r.status === 'timeout' ? 'TIMEOUT' : r.status !== 'exited' ? 'ERROR' : r.exitCode === 0 ? 'PASSED' : 'FAILED';
      let reason: string | null = r.status === 'timeout' ? `timed out after ${r.durationMs} ms`
        : r.status === 'spawn-error' ? 'the command could not be started'
          : r.status === 'signaled' ? `killed by ${r.signal}` : r.exitCode === 0 ? null : `exit status ${r.exitCode}`;
      scrubEvidenceTree();
      if (step.report && (status === 'PASSED' || status === 'FAILED')) {
        const reportPath = join(out, step.report);
        if (!existsSync(reportPath)) {
          status = 'ERROR';
          reason = `declared report ${step.report} was not written`;
        } else {
          let report: unknown;
          try {
            report = JSON.parse(readFileSync(reportPath, 'utf8'));
          } catch {
            report = undefined;
          }
          const problems = report === undefined ? ['report is not valid JSON'] : validateReport(report, r.exitCode);
          const contradiction = problems.some((x) => x.startsWith('exit code'));
          if (contradiction) {
            status = 'FAILED';
            reason = `report contradicts the exit status: ${problems.join('; ')}`;
          } else if (problems.length) {
            status = 'ERROR';
            reason = `malformed report ${step.report}: ${problems.join('; ')}`;
          }
        }
      }
      result = {
        id: step.id, kind: step.kind, blocking: step.blocking, requirements: step.requirements ?? [], command: substituted,
        status, reason, exitCode: r.exitCode, durationMs: r.durationMs, outputBytes: r.bytes, outputTruncated: r.truncated,
        redactions, log: logRel, logSha256: sha256(readFileSync(join(out, logRel))), report: step.report ?? null,
      };
    }
  }
  results.push(result);
  saveState({ completedSteps: [...state.completedSteps, step.id] });
  console.log(`${result.status.padEnd(8)} ${step.id} (${(result.durationMs / 1000).toFixed(1)} s)${result.reason ? ` -- ${result.reason}` : ''}`);
}
service?.stop();
if (sandbox) rmSync(sandbox, { recursive: true, force: true });
saveState({ phase: 'VERDICT' });

// ---- the verdict ----
const digestAfter = treeDigest(target);
const candidateChanged = digestAfter !== digestBefore;
const blocking = results.filter((r) => r.blocking);
const reasons: string[] = [];
if (candidateChanged) reasons.push('ERROR: the candidate tree changed during verification');
for (const r of blocking.filter((x) => x.status === 'ERROR')) reasons.push(`ERROR: ${r.id}: ${r.reason}`);
for (const r of blocking.filter((x) => x.status === 'FAILED' || x.status === 'TIMEOUT')) reasons.push(`REJECT: ${r.id}: ${r.reason}`);
for (const r of blocking.filter((x) => x.status === 'BLOCKED' || x.status === 'SKIPPED')) reasons.push(`INCONCLUSIVE: ${r.id}: ${r.reason}`);
if (!blocking.some((x) => x.status === 'PASSED')) reasons.push('INCONCLUSIVE: no blocking step ran and passed; an empty verification proves nothing');
if (!revision.commit) reasons.push('INCONCLUSIVE: the candidate is not an identified git revision');
if (revision.targetDirty && revision.commit) reasons.push(`INCONCLUSIVE: the candidate has uncommitted changes${args['allow-dirty'] ? ' (allowed by --allow-dirty, but the commit does not describe what was tested)' : ''}`);
const verdict: Verdict = reasons.some((r) => r.startsWith('ERROR')) ? 'ERROR'
  : reasons.some((r) => r.startsWith('REJECT')) ? 'REJECT'
    : reasons.length ? 'INCONCLUSIVE' : 'ACCEPT';

const reports: Record<string, unknown> = {};
for (const r of results) {
  if (r.report && existsSync(join(out, r.report))) {
    try {
      const data = JSON.parse(readFileSync(join(out, r.report), 'utf8'));
      reports[r.id] = data.summary ?? (({ operations: _o, results: _r, initial: _i, cases: _c, ...rest }) => rest)(data);
    } catch {
      // Already classified ERROR above.
    }
  }
}

const artifacts = results.flatMap((r) => [
  { path: r.log, type: 'log', producer: r.id, sha256: r.logSha256 },
  ...(r.report && existsSync(join(out, r.report)) ? [{ path: r.report, type: 'report', producer: r.id, sha256: sha256(readFileSync(join(out, r.report))) }] : []),
]);

const evidence = {
  schemaVersion: EVIDENCE_SCHEMA_VERSION,
  kind: 'commit-evidence',
  runId,
  factoryVersion: FACTORY_VERSION,
  stage: plan.stage,
  specification: plan.specification,
  plan: relative(root, resolve(root, args.plan)),
  revision: { ...revision, targetDigestAfter: digestAfter, candidateChanged },
  environment,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  service: plan.service ? { start: plan.service.start, healthy: service !== null } : null,
  steps: results,
  reports,
  artifacts,
  verdict,
  verdictReasons: reasons,
  productionModificationByVerifier: candidateChanged ? 'DETECTED' : 'NONE',
};
const evidenceProblems = validateEvidence(evidence);
if (evidenceProblems.length) {
  saveState({ status: 'ERROR', phase: 'evidence failed its own schema' });
  fail(EXIT.ERROR, `INTERNAL_ERROR: evidence failed its own schema:\n  ${evidenceProblems.join('\n  ')}`);
}
const manifest = JSON.stringify(evidence, null, 2) + '\n';
writeAtomic(join(out, 'evidence.json'), manifest);
// An integrity identifier for this record, not a proof of anything about the software.
const manifestId = sha256(manifest);
writeAtomic(join(out, 'evidence.sha256'), `${manifestId}  evidence.json\n`);

writeAtomic(join(out, 'reproduction.sh'), `#!/bin/sh
# Re-run this verification (run ${runId}) against the same revision.
set -eu
git checkout ${revision.commit ?? '<no commit recorded>'}
node commit/verify.ts --plan ${shQuote(evidence.plan)} --out "\${1:-evidence/rerun-$(date -u +%Y%m%dT%H%M%SZ)}"
`);

// ---- human-readable renderings: generated from the evidence above, never edited by hand ----
const portable = (cmd: string) => (service ? cmd.replaceAll(shQuote(service.url), '{url}') : cmd);
const lines: string[] = [verdict, ''];
lines.push('Run:', `    ${runId} (factory ${FACTORY_VERSION})`, 'Revision:',
  `    ${revision.commit ?? '(not a git checkout)'}${revision.branch ? ` on ${revision.branch}` : ''}${revision.targetDirty ? ' + UNCOMMITTED CHANGES in the candidate' : ''}`,
  `    candidate digest ${digestBefore}`, '', 'Why:', ...reasons.map((r) => `    ${r}`), ...(reasons.length ? [] : ['    every blocking step ran and passed']), '');
if (verdict === 'REJECT' || verdict === 'ERROR') {
  for (const f of blocking.filter((x) => x.status === 'FAILED' || x.status === 'TIMEOUT' || x.status === 'ERROR')) {
    const tailLines = readFileSync(join(out, f.log), 'utf8').trim().split('\n').slice(-12);
    lines.push(`Failure (${f.status}):`, `    step ${f.id} -- ${f.kind}`, 'Requirement:', `    ${f.requirements.join(', ') || '(not mapped)'}`,
      'Observed:', `    ${f.reason}`, ...tailLines.map((l) => `    | ${l}`), 'Expected:', `    exit status 0 and a consistent report from ${f.id}`,
      'Reproduction:', `    ${portable(f.command)}`, ...(service && f.command.includes(shQuote(service.url)) ? [`    where {url} is the candidate started with: ${plan.service!.start}`] : []),
      'Evidence:', `    ${f.log} (sha256 ${f.logSha256.slice(0, 16)}…)`, '');
  }
  lines.push('Production modification by verifier:', `    ${evidence.productionModificationByVerifier}`, '', 'Next action:',
    verdict === 'REJECT' ? '    Builder repairs and resubmits a new revision.' : '    Fix the verification problem above and re-run; nothing is accepted from this run.');
} else if (verdict === 'INCONCLUSIVE') {
  lines.push('Production modification by verifier:', '    NONE', '', 'Next action:', '    Provide the missing evidence (environment, clean commit, skipped steps) and re-run.');
} else {
  lines.push('Checks independently executed:', ...results.map((r) => `    ${r.id}: ${r.status}`), '', 'Production modification by verifier:', '    NONE', '',
    'Accepted revision is frozen: any change is a new revision and needs a new verification.');
}
const table = ['| Step | Kind | Blocking | Status | Duration | Requirements |', '|---|---|---|---|---|---|',
  ...results.map((r) => `| ${r.id} | ${r.kind} | ${r.blocking ? 'yes' : 'no'} | ${r.status} | ${(r.durationMs / 1000).toFixed(1)} s | ${r.requirements.join(' ')} |`)];
writeAtomic(join(out, 'verdict.md'), ['```text', ...lines, '```', '', ...table, '', `Evidence manifest: \`evidence.json\`, sha256 \`${manifestId}\``, ''].join('\n'));

const factory = args.factory && existsSync(args.factory) ? JSON.parse(readFileSync(args.factory, 'utf8')) : null;
const m = Object.values(reports).find((x: any) => x?.kind === 'mutation-campaign') as any;
const ref = Object.values(reports).filter((x: any) => x?.kind === 'reference-campaign') as any[];
const adv = Object.values(reports).find((x: any) => x?.kind === 'adversarial-campaign') as any;
const nm = 'not measured in this run';
const pct = (x: unknown) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : 'n/a');
const stepStatus = (kind: string) => {
  const s = results.filter((r) => r.kind === kind);
  return s.length ? s.map((r) => r.status).join(', ') : nm;
};
writeAtomic(join(out, 'scorecard.md'), `# COMMIT — ${plan.stage} factory result

Generated from \`evidence.json\` (run ${runId}); do not edit by hand.

\`\`\`text
Human dispatches:            ${factory?.humanDispatches ?? nm}
Post-dispatch human input:   ${factory?.postDispatchHumanInput ?? nm}

Planner:
    requirements identified: ${factory?.planner?.requirements ?? nm}
    acceptance conditions:   ${factory?.planner?.acceptanceConditions ?? nm}
    ambiguities recorded:    ${factory?.planner?.ambiguities ?? nm}

Verifier (this run):
    revision:                ${revision.commit ?? 'n/a'}${revision.targetDirty ? ' (dirty)' : ''}
    independent checks:      ${results.length} steps, ${results.filter((r) => r.status === 'PASSED').length} passed
    adversarial checks:      ${adv ? `${adv.passed}/${adv.campaigns} campaign rounds, ${adv.checks} state checks, ${adv.workers} concurrent` : nm}
    reference-model runs:    ${ref.length ? ref.map((r) => `${r.result} (seed ${r.seed}, ${r.operationsExecuted} ops, ${r.invariantChecks} invariant checks)`).join('; ') : nm}
    clean rebuild:           ${stepStatus('build')}
    clean startup:           ${stepStatus('startup')}
    offline execution:       ${stepStatus('offline')}

Mutation campaign:
    seeded mutants:          ${m ? `${m.executed} of ${m.discovered} discovered` : nm}
    equivalent excluded:     ${m?.tally.equivalent ?? nm}
    invalid (never started): ${m?.tally.invalid ?? nm}
    valid mutants:           ${m?.valid ?? nm}
    killed:                  ${m?.tally.killed ?? nm}
    survived:                ${m?.tally.survived ?? nm}
    timeout:                 ${m?.tally.timeout ?? nm}
    kill rate:               ${m ? pct(m.killRate) : nm}

Defect handling:
    rejected revisions:      ${factory?.rejectedRevisions ?? nm}
    repair cycles:           ${factory?.repairCycles ?? nm}
    false accepts:           ${factory?.falseAccepts ?? nm}

Resource usage:
    verification time:       ${((Date.now() - startedAt.getTime()) / 1000).toFixed(0)} s
    model/token usage:       ${factory?.tokens ?? nm}

Final verdict:               ${verdict}
Evidence manifest:           sha256 ${manifestId}
\`\`\`
`);

saveState({ status: 'COMPLETED', phase: `VERDICT ${verdict}` });
console.log(`\n${verdict} -- run ${runId}, evidence in ${relOut} (manifest sha256 ${manifestId.slice(0, 16)}…)`);
process.exit({ ACCEPT: EXIT.OK, REJECT: EXIT.REJECT, INCONCLUSIVE: EXIT.INCONCLUSIVE, ERROR: EXIT.ERROR }[verdict]);
