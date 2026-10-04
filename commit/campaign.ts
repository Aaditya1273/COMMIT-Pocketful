// Seeded reference-model campaign.
//
//   node commit/campaign.ts --module <campaign module> --base-url URL \
//        --seed S --operations N --out <report dir>
//
// A campaign module (written by the verifier, from the specification, without reading
// the implementation) supplies a deliberately small reference model and an operation
// generator. This runner owns everything generic: the seeded RNG, stepping model and
// implementation in lockstep, comparing after every step, stopping at the first
// divergence, and writing a report whose seed and command reproduce the run exactly.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { EXIT, FACTORY_VERSION } from './lib/config.ts';
import { writeAtomic, writeJsonAtomic } from './lib/fsx.ts';
import { rng, type Rng } from './lib/rng.ts';

export interface CampaignModule<Model, Op, Expected, Observed> {
  name: string;
  /** Build the initial state; load it into the implementation; return the model of it. */
  setup(baseUrl: string, rng: Rng): Promise<{ model: Model; initial: unknown }>;
  generate(model: Model, rng: Rng, history: Op[]): Op;
  /** Pure reference transition. Returns what the implementation must answer. */
  step(model: Model, op: Op, index: number): Expected;
  execute(op: Op, model: Model): Promise<Observed>;
  /** null when the observation satisfies the expectation, else why not. */
  mismatch(expected: Expected, observed: Observed, index: number): string | null;
  /** Bind identifiers the implementation chose (ids, tokens) back into the model. */
  bind?(model: Model, op: Op, observed: Observed, index: number): void;
  /** Whole-state comparison: the model's projection against what the implementation shows. */
  compareState(model: Model, index: number): Promise<{ expected: unknown; observed: unknown; invariants: string[] } | null>;
}

export interface CampaignReport {
  kind: 'reference-campaign';
  runId: string;
  factoryVersion: string;
  campaign: string;
  /** sha256 of the campaign module: the seed reproduces the run only with the same generator. */
  moduleSha256: string | null;
  seed: number;
  operationsRequested: number;
  operationsExecuted: number;
  stateComparisons: number;
  invariantChecks: number;
  /** How often each expected outcome occurred: shows whether the generator exercised the system or only its refusals. */
  outcomes: Record<string, number>;
  durationMs: number;
  result: 'agree' | 'diverged';
  initial: unknown;
  firstDivergence: null | { index: number; op: unknown; detail: string; expected: unknown; observed: unknown };
  reproduction: string;
  operations: unknown[];
}

export async function runCampaign<M, O, E, X>(mod: CampaignModule<M, O, E, X>, opts: { baseUrl: string; seed: number; operations: number; command: string; moduleSha256?: string }): Promise<CampaignReport> {
  const started = Date.now();
  const random = rng(opts.seed);
  const { model, initial } = await mod.setup(opts.baseUrl, random);
  const history: O[] = [];
  let stateComparisons = 0;
  let invariantChecks = 0;
  const outcomes: Record<string, number> = {};
  let firstDivergence: CampaignReport['firstDivergence'] = null;

  for (let i = 0; i < opts.operations && !firstDivergence; i++) {
    const op = mod.generate(model, random, history);
    history.push(op);
    const expected = mod.step(model, op, i);
    const e = expected as { status?: unknown; code?: unknown; sameAs?: unknown };
    const label = [e.status, e.code ?? (e.sameAs !== undefined ? 'replay' : '')].filter((x) => x !== undefined && x !== '').join(' ') || 'n/a';
    outcomes[label] = (outcomes[label] ?? 0) + 1;
    const observed = await mod.execute(op, model);
    const why = mod.mismatch(expected, observed, i);
    if (why) {
      firstDivergence = { index: i, op, detail: why, expected, observed };
      break;
    }
    mod.bind?.(model, op, observed, i);
    const state = await mod.compareState(model, i);
    if (state) {
      stateComparisons++;
      invariantChecks += state.invariants.length;
      const broken = state.invariants.find((inv) => inv.startsWith('VIOLATED'));
      if (broken || !isDeepStrictEqual(state.expected, state.observed)) {
        firstDivergence = { index: i, op, detail: broken ?? 'observable state differs from the reference model', expected: state.expected, observed: state.observed };
      }
    }
  }

  return {
    kind: 'reference-campaign',
    runId: `${new Date(started).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(3).toString('hex')}`,
    factoryVersion: FACTORY_VERSION,
    campaign: mod.name,
    moduleSha256: opts.moduleSha256 ?? null,
    seed: opts.seed,
    operationsRequested: opts.operations,
    operationsExecuted: history.length,
    stateComparisons,
    invariantChecks,
    outcomes,
    durationMs: Date.now() - started,
    result: firstDivergence ? 'diverged' : 'agree',
    initial,
    firstDivergence,
    reproduction: opts.command,
    operations: history,
  };
}

function markdown(r: CampaignReport): string {
  const d = r.firstDivergence;
  return `# Reference-model campaign: ${r.campaign}

| | |
|---|---|
| Result | **${r.result.toUpperCase()}** (${r.firstDivergence ? '1 divergence' : '0 divergences'} -- agreement is not proof of correctness) |
| Run | ${r.runId} (factory ${r.factoryVersion}) |
| Seed | ${r.seed} |
| Campaign module sha256 | \`${r.moduleSha256 ?? 'n/a'}\` |
| Operations executed / requested | ${r.operationsExecuted} / ${r.operationsRequested} |
| Whole-state comparisons | ${r.stateComparisons} |
| Invariant checks | ${r.invariantChecks} |
| Expected outcomes | ${Object.entries(r.outcomes).sort(([, a], [, b]) => b - a).map(([k, n]) => `${k}: ${n}`).join(', ')} |
| Duration | ${(r.durationMs / 1000).toFixed(1)} s |

Reproduce: \`${r.reproduction}\`
${d ? `
## First divergence — operation #${d.index}

${d.detail}

Operation:
\`\`\`json
${JSON.stringify(d.op, null, 2)}
\`\`\`

Expected (reference model):
\`\`\`json
${JSON.stringify(d.expected, null, 2)}
\`\`\`

Observed (implementation):
\`\`\`json
${JSON.stringify(d.observed, null, 2)}
\`\`\`
` : ''}
The full operation sequence is in \`reference-report.json\`.
`;
}

const USAGE = `usage: node commit/campaign.ts --module FILE --base-url URL --seed S [--operations N] [--out NEW_DIR]

  --module FILE      campaign module (default export implements CampaignModule)
  --base-url URL     the running candidate, http(s)://...
  --seed S           non-negative integer; the seed plus the module reproduce the run exactly
  --operations N     operations to generate (default 500)
  --out DIR          write reference-report.json/.md here; must not exist or be empty
  --help, --version

exit: 0 agree, 1 diverged, 2 usage error`;

function usage(code: number, message?: string): never {
  console.error(message ? `${message}\n\n${USAGE}` : USAGE);
  process.exit(code);
}

// Run as a CLI only when executed directly (portable to Node 22; `import.meta.main` is newer).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs({
      options: {
        module: { type: 'string' }, 'base-url': { type: 'string' }, seed: { type: 'string' }, operations: { type: 'string', default: '500' },
        out: { type: 'string' }, help: { type: 'boolean', default: false }, version: { type: 'boolean', default: false },
      },
    }).values;
  } catch (error) {
    usage(EXIT.USAGE, (error as Error).message);
  }
  if (args.help) usage(EXIT.OK);
  if (args.version) { console.log(FACTORY_VERSION); process.exit(EXIT.OK); }
  // No hidden default seed: a campaign without a recorded seed cannot be replayed.
  if (!args.module || !args['base-url'] || args.seed === undefined) usage(EXIT.USAGE, 'INPUT_ERROR: --module, --base-url and --seed are required');
  if (!/^\d+$/.test(args.seed)) usage(EXIT.USAGE, `INPUT_ERROR: --seed must be a non-negative integer, got ${args.seed}`);
  if (!/^\d+$/.test(args.operations!) || Number(args.operations) < 1) usage(EXIT.USAGE, `INPUT_ERROR: --operations must be a positive integer, got ${args.operations}`);
  if (!/^https?:\/\/[^\s]+$/.test(args['base-url'])) usage(EXIT.USAGE, `INPUT_ERROR: --base-url must be an http(s) URL, got ${args['base-url']}`);
  const modulePath = resolve(args.module);
  if (!existsSync(modulePath)) usage(EXIT.USAGE, `INPUT_ERROR: --module ${args.module} does not exist`);
  if (args.out && existsSync(args.out) && readdirSync(args.out).length > 0) usage(EXIT.USAGE, `INPUT_ERROR: refusing to write into non-empty ${args.out}`);
  const mod = (await import(modulePath)).default as CampaignModule<unknown, unknown, unknown, unknown>;
  const seed = Number(args.seed);
  const command = `node commit/campaign.ts --module ${args.module} --base-url <url> --seed ${seed} --operations ${args.operations}`;
  const moduleSha256 = createHash('sha256').update(readFileSync(modulePath)).digest('hex');
  const report = await runCampaign(mod, { baseUrl: args['base-url'], seed, operations: Number(args.operations), command, moduleSha256 });
  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    writeJsonAtomic(join(args.out, 'reference-report.json'), report);
    writeAtomic(join(args.out, 'reference-report.md'), markdown(report));
  }
  const { operations: _ops, initial: _init, ...brief } = report;
  console.log(JSON.stringify(brief, null, 2));
  process.exit(report.result === 'agree' ? EXIT.OK : EXIT.REJECT);
}
