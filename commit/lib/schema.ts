// Runtime validation for every JSON artifact the toolkit reads or writes. Hand-written
// on purpose: a dozen checks need no schema framework. Each validator returns the list
// of problems; empty means valid.
export type Problems = string[];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

function need(p: Problems, where: string, ok: boolean, what: string) {
  if (!ok) p.push(`${where}: ${what}`);
}

export const EVIDENCE_SCHEMA_VERSION = 2;

// ---- verification plans ----

export interface Step {
  id: string;
  kind: string;
  cmd: string;
  blocking: boolean;
  requirements?: string[];
  environment?: string;
  report?: string;
  timeoutMs?: number;
  needsService?: boolean;
}

export interface Plan {
  stage: string;
  target: string;
  specification: string;
  service?: { start: string; health?: string };
  steps: Step[];
}

export function validatePlan(v: unknown): Problems {
  const p: Problems = [];
  if (!isObj(v)) return ['plan: must be a JSON object'];
  for (const f of ['stage', 'target', 'specification'] as const) need(p, `plan.${f}`, typeof v[f] === 'string' && v[f] !== '', 'non-empty string required');
  if (typeof v.target === 'string') need(p, 'plan.target', !v.target.split(/[\\/]/).includes('..') && !v.target.startsWith('/'), 'must be a path inside the repository (no "..", not absolute)');
  if (v.service !== undefined) {
    need(p, 'plan.service', isObj(v.service) && typeof v.service.start === 'string' && v.service.start !== '', '{ start: string, health?: string } required');
  }
  if (!Array.isArray(v.steps)) return [...p, 'plan.steps: array required'];
  const ids = new Set<string>();
  v.steps.forEach((s, i) => {
    const at = `plan.steps[${i}]`;
    if (!isObj(s)) { p.push(`${at}: object required`); return; }
    need(p, `${at}.id`, typeof s.id === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(s.id), 'lowercase id of [a-z0-9._-] required');
    need(p, `${at}.id`, !ids.has(s.id as string), `duplicate id ${String(s.id)}`);
    ids.add(s.id as string);
    need(p, `${at}.kind`, typeof s.kind === 'string' && s.kind !== '', 'string required');
    need(p, `${at}.cmd`, typeof s.cmd === 'string' && s.cmd !== '', 'string required');
    need(p, `${at}.blocking`, typeof s.blocking === 'boolean', 'boolean required');
    need(p, `${at}.timeoutMs`, s.timeoutMs === undefined || (isInt(s.timeoutMs) && (s.timeoutMs as number) >= 1000), 'integer >= 1000 when present');
    need(p, `${at}.report`, s.report === undefined || (typeof s.report === 'string' && !s.report.split('/').includes('..') && !s.report.startsWith('/')), 'relative path inside the evidence directory when present');
    need(p, `${at}.requirements`, s.requirements === undefined || (Array.isArray(s.requirements) && s.requirements.every((r) => typeof r === 'string')), 'array of strings when present');
    need(p, `${at}.needsService`, s.needsService === undefined || typeof s.needsService === 'boolean', 'boolean when present');
    need(p, `${at}.environment`, s.environment === undefined || typeof s.environment === 'string', 'string when present');
  });
  return p;
}

// ---- reports written by verification steps ----

/**
 * A step's report must be well-formed, and must agree with the step's exit code: a
 * report that says "failed" behind exit 0 -- or "passed" behind a failure -- is a
 * contradiction, and the step is treated as failed either way.
 */
export function validateReport(v: unknown, exitCode: number | null): Problems {
  const p: Problems = [];
  if (!isObj(v)) return ['report: must be a JSON object'];
  if (typeof v.kind !== 'string' || v.kind === '') return ['report.kind: string required'];
  const passed = exitCode === 0;
  switch (v.kind) {
    case 'mutation-campaign': {
      const s = v.summary;
      if (!isObj(s) || !isObj(s.tally)) return ['mutation report: summary.tally required'];
      const t = s.tally as Obj;
      for (const k of ['killed', 'survived', 'timeout', 'invalid', 'error', 'equivalent']) need(p, `summary.tally.${k}`, isInt(t[k]), 'non-negative integer required');
      if (p.length) return p;
      const valid = (t.killed as number) + (t.survived as number) + (t.timeout as number);
      need(p, 'summary.valid', s.valid === valid, `must equal killed + survived + timeout (${valid})`);
      need(p, 'summary.killRate', valid === 0 ? s.killRate === null : Math.abs((s.killRate as number) - (t.killed as number) / valid) < 1e-9, 'must equal killed / valid');
      need(p, 'results', Array.isArray(v.results) && v.results.length === s.executed, 'one result per executed mutant required');
      need(p, 'summary.campaignBroken', s.campaignBroken === ((t.error as number) > 0), 'must be true exactly when a mutant errored');
      need(p, 'exit code', passed === !s.campaignBroken, 'a broken campaign must exit non-zero, and only a broken one');
      break;
    }
    case 'reference-campaign':
      need(p, 'result', v.result === 'agree' || v.result === 'diverged', '"agree" or "diverged" required');
      need(p, 'seed', Number.isInteger(v.seed), 'integer seed required');
      need(p, 'operationsExecuted', isInt(v.operationsExecuted) && (v.operationsExecuted as number) > 0, 'positive integer required: a campaign that ran nothing proves nothing');
      need(p, 'firstDivergence', (v.result === 'diverged') === (v.firstDivergence !== null && v.firstDivergence !== undefined), 'present exactly when the result is "diverged"');
      need(p, 'exit code', passed === (v.result === 'agree'), 'must be 0 exactly when the result is "agree"');
      break;
    default:
      // Any other report: if it states pass/fail counts, they must agree with the exit code.
      if ('failed' in v) {
        need(p, 'failed', isInt(v.failed), 'non-negative integer required');
        need(p, 'exit code', passed === (v.failed === 0), 'must be 0 exactly when failed is 0');
      }
      for (const k of ['total', 'campaigns', 'checks']) {
        if (k in v) need(p, k, isInt(v[k]) && (v[k] as number) > 0, 'positive integer required: an empty run proves nothing');
      }
  }
  return p;
}

// ---- the equivalent-mutant register ----

export function validateEquivalents(v: unknown): Problems {
  const p: Problems = [];
  if (!isObj(v)) return ['equivalents: must be a JSON object keyed by mutant id'];
  for (const [id, entry] of Object.entries(v)) {
    need(p, id, /^m-[0-9a-f]{10}$/.test(id), 'mutant id of the form m-<10 hex> required');
    if (!isObj(entry)) { p.push(`${id}: { classification, location, reason } required`); continue; }
    need(p, `${id}.classification`, entry.classification === 'equivalent', '"equivalent" required');
    need(p, `${id}.location`, typeof entry.location === 'string' && entry.location !== '', 'string required');
    need(p, `${id}.reason`, typeof entry.reason === 'string' && entry.reason.length >= 30, 'a reason of at least 30 characters required');
  }
  return p;
}

// ---- the evidence manifest ----

export const STEP_STATUSES = ['PASSED', 'FAILED', 'TIMEOUT', 'ERROR', 'BLOCKED', 'SKIPPED'] as const;
export const VERDICTS = ['ACCEPT', 'REJECT', 'INCONCLUSIVE', 'ERROR'] as const;

export function validateEvidence(v: unknown): Problems {
  const p: Problems = [];
  if (!isObj(v)) return ['evidence: must be a JSON object'];
  need(p, 'schemaVersion', v.schemaVersion === EVIDENCE_SCHEMA_VERSION, `must be ${EVIDENCE_SCHEMA_VERSION}`);
  need(p, 'kind', v.kind === 'commit-evidence', '"commit-evidence" required');
  for (const f of ['runId', 'factoryVersion', 'stage', 'startedAt', 'finishedAt']) need(p, f, typeof v[f] === 'string' && v[f] !== '', 'string required');
  need(p, 'verdict', (VERDICTS as readonly unknown[]).includes(v.verdict), `one of ${VERDICTS.join(', ')}`);
  need(p, 'verdictReasons', Array.isArray(v.verdictReasons), 'array required');
  const r = v.revision;
  if (!isObj(r)) p.push('revision: object required');
  else {
    need(p, 'revision.commit', r.commit === null || (typeof r.commit === 'string' && /^[0-9a-f]{40}$/.test(r.commit)), '40-hex commit or null');
    need(p, 'revision.targetDigest', typeof r.targetDigest === 'string' && /^[0-9a-f]{64}$/.test(r.targetDigest), 'sha256 hex required');
    need(p, 'revision.targetDirty', typeof r.targetDirty === 'boolean', 'boolean required');
  }
  if (!Array.isArray(v.steps)) p.push('steps: array required');
  else {
    v.steps.forEach((s, i) => {
      if (!isObj(s)) { p.push(`steps[${i}]: object required`); return; }
      need(p, `steps[${i}].status`, (STEP_STATUSES as readonly unknown[]).includes(s.status), `one of ${STEP_STATUSES.join(', ')}`);
      need(p, `steps[${i}].log`, typeof s.log === 'string', 'log path required');
      need(p, `steps[${i}].logSha256`, typeof s.logSha256 === 'string' && /^[0-9a-f]{64}$/.test(s.logSha256), 'sha256 hex required');
    });
  }
  return p;
}
