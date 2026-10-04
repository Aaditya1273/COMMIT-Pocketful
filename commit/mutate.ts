// Mutation campaign: how much deliberately bad work does the verification suite kill?
//
//   node commit/mutate.ts --target <service dir> --start "<cmd>" --check "<cmd using {url}>" \
//        --out <new dir> [--files src] [--jobs 4] [--max N --seed S] [--only id,id] \
//        [--exclude equivalents.json]
//
// Every mutant runs in its own temporary copy of the target; the target itself is never
// written. The unmutated baseline must pass the check first, or the campaign aborts: a
// score computed over a broken suite would be a fabricated number.
// Exit: 0 campaign completed (whatever the score), 2 usage error or broken campaign,
// 130 interrupted.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT, FACTORY_VERSION, loadConfig } from './lib/config.ts';
import { redact, scrubHome, writeAtomic, writeJsonAtomic } from './lib/fsx.ts';
import { apply, discover, type Mutant } from './lib/mutants.ts';
import { onInterrupt, runShell, startService } from './lib/proc.ts';
import { rng } from './lib/rng.ts';
import { validateEquivalents } from './lib/schema.ts';

const USAGE = `usage: node commit/mutate.ts --target DIR --start CMD --check CMD --out NEW_DIR [options]

  --target DIR     candidate source tree (copied per mutant; never modified)
  --start CMD      shell command that starts the candidate; PORT is set in its environment
  --check CMD      shell command that checks a running candidate; {url} is its base URL.
                   Exit 0 = the mutant survived, non-zero = killed. Optional lines
                   "COMMIT-LAYER <name>=<pass|fail>" attribute kills to layers.
  --out DIR        report directory; must not exist or be empty
  --files LIST     comma-separated files or directories under the target (default: src)
  --jobs N         parallel mutants (default 4)
  --max N          run a seeded sample of N mutants; --seed S fixes the sample (default 1)
  --only ID,ID     run exactly these mutants (replay)
  --exclude FILE   equivalent-mutant register: { "<id>": { classification, location, reason } }
  --help, --version`;

type Outcome = 'killed' | 'survived' | 'timeout' | 'invalid' | 'error' | 'equivalent';

interface Result extends Mutant {
  outcome: Outcome;
  durationMs: number;
  reason?: string;
  evidence?: string;
  /** Per-layer verdicts, when the check prints `COMMIT-LAYER <name>=<pass|fail>` lines. */
  layers?: Record<string, string>;
}

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      target: { type: 'string' }, files: { type: 'string', default: 'src' }, start: { type: 'string' }, check: { type: 'string' },
      health: { type: 'string', default: '/health' }, jobs: { type: 'string', default: '4' }, max: { type: 'string' },
      seed: { type: 'string', default: '1' }, only: { type: 'string' }, timeout: { type: 'string' }, exclude: { type: 'string' },
      out: { type: 'string' }, help: { type: 'boolean', default: false }, version: { type: 'boolean', default: false },
    },
  }).values;
} catch (error) {
  fail(EXIT.USAGE, `${(error as Error).message}\n\n${USAGE}`);
}
const args = parsed;
if (args.help) fail(EXIT.OK, USAGE);
if (args.version) fail(EXIT.OK, FACTORY_VERSION);
if (!args.target || !args.start || !args.check || !args.out) fail(EXIT.USAGE, USAGE);
const positive = (name: string, raw: string | undefined) => {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) fail(EXIT.USAGE, `INPUT_ERROR: --${name} must be a positive integer, got ${raw}`);
  return Number(raw);
};
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  fail(EXIT.USAGE, `CONFIG_ERROR: ${(error as Error).message}`);
}
const target = resolve(args.target);
if (!existsSync(target) || !statSync(target).isDirectory()) fail(EXIT.USAGE, `INPUT_ERROR: --target ${args.target} is not a directory`);
const out = resolve(args.out);
if (existsSync(out) && readdirSync(out).length > 0) fail(EXIT.USAGE, `INPUT_ERROR: refusing to write into non-empty ${out}; one directory per campaign`);
const jobs = positive('jobs', args.jobs)!;
const max = positive('max', args.max);
const timeoutMs = positive('timeout', args.timeout) ?? config.mutantTimeoutMs;
if (!/^\d+$/.test(args.seed!)) fail(EXIT.USAGE, `INPUT_ERROR: --seed must be a non-negative integer, got ${args.seed}`);
const seed = Number(args.seed);
const startCmd = args.start;
const checkCmd = args.check;

function sourceFiles(root: string, spec: string): string[] {
  return spec.split(',').flatMap((entry) => {
    const path = resolve(root, entry.trim());
    if (relative(root, path).startsWith('..')) fail(EXIT.USAGE, `INPUT_ERROR: --files entry ${entry} is outside the target`);
    if (!existsSync(path)) fail(EXIT.USAGE, `INPUT_ERROR: --files entry ${entry} does not exist under the target`);
    if (statSync(path).isFile()) return [relative(root, path)];
    return (readdirSync(path, { recursive: true, encoding: 'utf8' }) as string[])
      .filter((f) => /\.(ts|js|mjs)$/.test(f) && !/(^|[\\/])node_modules([\\/]|$)/.test(f) && !/\.test\.(ts|js|mjs)$/.test(f))
      .map((f) => relative(root, join(path, f)));
  }).sort();
}

const workspaces = new Set<string>();
const stops = new Set<() => void>();
onInterrupt((signal) => {
  for (const stop of stops) stop();
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
  writeJsonAtomic(join(out, 'campaign-state.json'), { status: 'CANCELLED', signal, at: new Date().toISOString() });
  console.error(`\nCANCELLED by ${signal}; mutant workspaces removed; no score reported`);
});

/** Run the check against one candidate tree. `null` mutant means the baseline. */
async function evaluate(mutant: Mutant | null): Promise<Omit<Result, keyof Mutant>> {
  const dir = mkdtempSync(join(tmpdir(), 'commit-mutant-'));
  workspaces.add(dir);
  const started = Date.now();
  try {
    cpSync(target, dir, { recursive: true, filter: (src) => !src.split(/[\\/]/).some((p) => p === 'node_modules' || p === '.git') });
    if (mutant) {
      const file = join(dir, mutant.file);
      writeFileSync(file, apply(readFileSync(file, 'utf8'), mutant));
    }
    const { service, log } = await startService(startCmd, { cwd: dir, healthPath: args.health, timeoutMs: 20_000, killGraceMs: config.killGraceMs });
    if (!service) return { outcome: 'invalid', durationMs: Date.now() - started, reason: 'candidate never became healthy', evidence: redact(scrubHome(log().slice(-600))).text };
    stops.add(service.stop);
    try {
      // The URL is generated here (127.0.0.1 and a free port), never user input.
      const r = await runShell(checkCmd.replaceAll('{url}', service.url), { timeoutMs, killGraceMs: config.killGraceMs });
      const evidence = redact(scrubHome(r.tail.slice(-1200))).text;
      const layers = Object.fromEntries([...r.tail.matchAll(/^COMMIT-LAYER (\S+)=(\S+)$/gm)].map((m) => [m[1], m[2]]));
      if (r.status === 'timeout') return { outcome: 'timeout', durationMs: r.durationMs, evidence, layers };
      // The check itself could not run: a broken campaign, never a kill.
      if (r.status !== 'exited' || r.exitCode === 126 || r.exitCode === 127) {
        return { outcome: 'error', durationMs: r.durationMs, reason: `check could not run (${r.status}${r.exitCode !== null ? `, exit ${r.exitCode}` : ''})`, evidence, layers };
      }
      return { outcome: r.exitCode === 0 ? 'survived' : 'killed', durationMs: r.durationMs, evidence, layers };
    } finally {
      service.stop();
      stops.delete(service.stop);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    workspaces.delete(dir);
  }
}

function loadExclusions(all: Mutant[]): Record<string, { location: string; reason: string }> {
  if (!args.exclude) return {};
  let register: unknown;
  try {
    register = JSON.parse(readFileSync(args.exclude, 'utf8'));
  } catch (error) {
    fail(EXIT.USAGE, `INPUT_ERROR: cannot read --exclude ${args.exclude}: ${(error as Error).message}`);
  }
  const problems = validateEquivalents(register);
  if (problems.length) fail(EXIT.USAGE, `INPUT_ERROR: invalid equivalent-mutant register ${args.exclude}:\n  ${problems.join('\n  ')}`);
  // A register entry that no longer names a discovered mutant is stale: the source moved
  // under it, and silently ignoring it would let a reviewer's old judgement float free.
  const known = new Set(all.map((m) => m.id));
  const stale = Object.keys(register as object).filter((id) => !known.has(id));
  if (stale.length) fail(EXIT.USAGE, `INPUT_ERROR: ${stale.length} register entries name no mutant in the current source (stale): ${stale.join(', ')}`);
  return register as Record<string, { location: string; reason: string }>;
}

async function main() {
  const startedAt = new Date();
  mkdirSync(out, { recursive: true });
  const files = sourceFiles(target, args.files!);
  const all = files.flatMap((f) => discover(f, readFileSync(join(target, f), 'utf8')));
  const exclusions = loadExclusions(all);
  let mutants = all;
  if (args.only) {
    const wanted = new Set(args.only.split(',').map((s) => s.trim()).filter(Boolean));
    const missing = [...wanted].filter((id) => !all.some((m) => m.id === id));
    if (missing.length) fail(EXIT.USAGE, `INPUT_ERROR: --only names unknown mutants: ${missing.join(', ')}`);
    mutants = all.filter((m) => wanted.has(m.id));
  } else if (max !== undefined && max < all.length) {
    const r = rng(seed);
    const shuffled = [...all];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = r.int(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const chosen = new Set(shuffled.slice(0, max).map((m) => m.id));
    mutants = all.filter((m) => chosen.has(m.id));
  }
  console.log(`discovered ${all.length} mutants in ${files.length} files; running ${mutants.length}`);

  const baseline = await evaluate(null);
  if (baseline.outcome !== 'survived') {
    writeAtomic(join(out, 'baseline-failure.txt'), `${baseline.outcome}\n${baseline.reason ?? ''}\n${baseline.evidence ?? ''}`);
    fail(EXIT.USAGE, `CAMPAIGN BROKEN: the unmutated baseline did not pass the check (${baseline.outcome}). No score is reported.\n${baseline.evidence ?? ''}`);
  }
  console.log(`baseline passes the check in ${baseline.durationMs} ms`);

  const results: Result[] = [];
  const queue = [...mutants];
  const workers = Array.from({ length: jobs }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const excluded = exclusions[m.id];
      const result: Result = excluded
        ? { ...m, outcome: 'equivalent', durationMs: 0, reason: excluded.reason }
        : { ...m, ...(await evaluate(m)) };
      results.push(result);
      console.log(`[${results.length}/${mutants.length}] ${result.outcome.padEnd(10)} ${m.id} ${m.file}:${m.line} ${m.operator} ${JSON.stringify(m.original).slice(0, 80)} -> ${JSON.stringify(m.replacement)}`);
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start || a.id.localeCompare(b.id));

  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  const tally = Object.fromEntries((['killed', 'survived', 'timeout', 'invalid', 'error', 'equivalent'] as const).map((o) => [o, count(o)]));
  const valid = count('killed') + count('survived') + count('timeout');
  // Which layer caught what: a kill attributed to one layer alone is a defect every
  // other layer would have accepted.
  const killed = results.filter((r) => r.outcome === 'killed' && r.layers && Object.keys(r.layers).length);
  const layerNames = [...new Set(killed.flatMap((r) => Object.keys(r.layers!)))].sort();
  const layers = Object.fromEntries(layerNames.map((name) => [name, {
    killed: killed.filter((r) => r.layers![name] === 'fail').length,
    onlyThisLayer: killed.filter((r) => r.layers![name] === 'fail' && Object.entries(r.layers!).every(([n, v]) => n === name || v === 'pass')).length,
  }]));
  const summary = {
    kind: 'mutation-campaign',
    factoryVersion: FACTORY_VERSION,
    target: relative(process.cwd(), target) || '.',
    files,
    start: startCmd,
    check: checkCmd,
    seed,
    selection: args.only ? 'only' : max !== undefined && max < all.length ? 'seeded-sample' : 'all',
    discovered: all.length,
    executed: mutants.length,
    tally,
    layers,
    valid,
    killRate: valid ? count('killed') / valid : null,
    detectionRate: valid ? (count('killed') + count('timeout')) / valid : null,
    formula: 'killRate = killed / (killed + survived + timeout); detectionRate counts timeouts as detected; invalid, error and equivalent are excluded from both and listed',
    campaignBroken: count('error') > 0,
    jobs,
    mutantTimeoutMs: timeoutMs,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    replay: `node commit/mutate.ts --target ${args.target} --start '${startCmd}' --check '${checkCmd}' --only <id> --out <new dir>`,
  };
  writeJsonAtomic(join(out, 'mutation-report.json'), { kind: 'mutation-campaign', summary, results });
  writeAtomic(join(out, 'mutation-report.md'), markdown(summary, results));
  console.log(JSON.stringify(summary, null, 2));
  if (summary.campaignBroken) fail(EXIT.USAGE, 'CAMPAIGN BROKEN: at least one mutant could not be checked; see the error rows.');
}

function markdown(summary: Record<string, unknown> & { tally: Record<string, number> }, results: Result[]): string {
  const pct = (x: unknown) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : 'n/a');
  const row = (r: Result) => `| \`${r.id}\` | ${r.file}:${r.line} | ${r.operator} | \`${r.original.replaceAll('|', '\\|')}\` → \`${r.replacement.replaceAll('|', '\\|')}\` | ${(r.reason ?? '').replaceAll('|', '\\|')} |`;
  const section = (title: string, rows: Result[]) =>
    rows.length ? `\n## ${title} (${rows.length})\n\n| id | location | operator | change | note |\n|---|---|---|---|---|\n${rows.map(row).join('\n')}\n` : '';
  return `# Mutation campaign report

Generated from \`mutation-report.json\`; do not edit by hand.

| | |
|---|---|
| Target | \`${summary.target}\` |
| Check | \`${summary.check}\` |
| Seed / selection | ${summary.seed} / ${summary.selection} |
| Discovered / executed | ${summary.discovered} / ${summary.executed} |
| Killed | ${summary.tally.killed} |
| Survived | ${summary.tally.survived} |
| Timeout | ${summary.tally.timeout} |
| Invalid (never started) | ${summary.tally.invalid} |
| Error (check could not run) | ${summary.tally.error} |
| Equivalent (excluded, justified) | ${summary.tally.equivalent} |
| **Kill rate** | **${pct(summary.killRate)}** |
| Detection rate (timeouts count) | ${pct(summary.detectionRate)} |

${summary.formula}.

Replay one mutant: \`${summary.replay}\`
${Object.keys(summary.layers as object).length ? `
## Kills by verification layer

| Layer | Killed | Killed by this layer alone |
|---|---|---|
${Object.entries(summary.layers as Record<string, { killed: number; onlyThisLayer: number }>).map(([n, l]) => `| ${n} | ${l.killed} | ${l.onlyThisLayer} |`).join('\n')}
` : ''}
${section('Survived — bad work the suite accepted', results.filter((r) => r.outcome === 'survived'))}${section('Timeout', results.filter((r) => r.outcome === 'timeout'))}${section('Equivalent — excluded with justification', results.filter((r) => r.outcome === 'equivalent'))}${section('Error', results.filter((r) => r.outcome === 'error'))}`;
}

await main();
