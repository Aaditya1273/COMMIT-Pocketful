// Factory version, validated configuration and environment detection. Every tunable
// the toolkit reads from the environment is declared here, with its default and its
// bounds; nothing else in commit/ reads process.env for configuration.
import { readFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './proc.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** The factory's own version: not the version of anything the factory builds. */
export const FACTORY_VERSION = readFileSync(join(here, '..', 'VERSION'), 'utf8').trim();

/** Exit codes shared by every commit/ command. */
export const EXIT = {
  OK: 0, // command succeeded / verdict ACCEPT
  REJECT: 1, // verdict REJECT: the candidate failed a blocking check
  USAGE: 2, // invalid arguments, configuration or input; or a broken campaign
  INCONCLUSIVE: 3, // nothing failed, but required evidence could not be produced
  ERROR: 4, // the verification itself is untrustworthy (candidate changed, internal error)
  INTERRUPTED: 130, // SIGINT / SIGTERM
} as const;

export class FactoryError extends Error {
  readonly kind: 'CONFIG_ERROR' | 'INPUT_ERROR' | 'REPOSITORY_ERROR' | 'ARTIFACT_ERROR' | 'ENVIRONMENT_ERROR';
  constructor(kind: FactoryError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new FactoryError('CONFIG_ERROR', `${name} must be a whole number, got ${JSON.stringify(raw)}`);
  const value = Number(raw);
  if (value < min || value > max) throw new FactoryError('CONFIG_ERROR', `${name} must be between ${min} and ${max}, got ${value}`);
  return value;
}

const MINUTE = 60_000;

/** Read once per process; an invalid value fails fast with CONFIG_ERROR. */
export function loadConfig() {
  return {
    /** Default budget for one verification step; a step may declare its own. */
    stepTimeoutMs: intFromEnv('COMMIT_STEP_TIMEOUT_MS', 10 * MINUTE, 1_000, 24 * 60 * MINUTE),
    /** How long a candidate service may take to answer its health check. */
    serviceStartTimeoutMs: intFromEnv('COMMIT_SERVICE_START_TIMEOUT_MS', 60_000, 1_000, 10 * MINUTE),
    /** Budget for one mutant's check. */
    mutantTimeoutMs: intFromEnv('COMMIT_MUTANT_TIMEOUT_MS', 3 * MINUTE, 1_000, 60 * MINUTE),
    /** Bytes of one command's output kept on disk; the rest is counted, not stored. */
    maxLogBytes: intFromEnv('COMMIT_MAX_LOG_BYTES', 32 * 1024 * 1024, 64 * 1024, 1024 * 1024 * 1024),
    /** Grace between SIGTERM and SIGKILL when stopping a process group. */
    killGraceMs: intFromEnv('COMMIT_KILL_GRACE_MS', 2_000, 0, MINUTE),
    /** Where the official event kickoff package is checked out, if the plan uses it. */
    kickoffDir: process.env.COMMIT_KICKOFF ?? '../dark-factory-wearedevs',
  };
}

export type Config = ReturnType<typeof loadConfig>;

export interface Environment {
  factoryVersion: string;
  node: string;
  platform: string;
  release: string;
  arch: string;
  git: string | null;
  python: string | null;
  docker: { installed: boolean; daemonReachable: boolean; detail: string };
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';

/** What this machine can and cannot do. Docker installed is not Docker usable. */
export async function detectEnvironment(): Promise<Environment> {
  const probe = async (file: string, args: string[]) => {
    const r = await run(file, args, { timeoutMs: 15_000 });
    return r.status === 'exited' && r.exitCode === 0 ? firstLine(r.tail) : null;
  };
  const dockerVersion = await probe('docker', ['--version']);
  const daemon = dockerVersion ? await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15_000 }) : null;
  const daemonReachable = !!daemon && daemon.status === 'exited' && daemon.exitCode === 0;
  return {
    factoryVersion: FACTORY_VERSION,
    node: process.version,
    platform: platform(),
    release: release(),
    arch: arch(),
    git: await probe('git', ['--version']),
    python: (await probe('python3', ['--version'])) ?? (await probe('python', ['--version'])),
    docker: {
      installed: !!dockerVersion,
      daemonReachable,
      detail: !dockerVersion ? 'docker binary not found'
        : daemonReachable ? `daemon ${firstLine(daemon!.tail)}`
          : `binary present (${dockerVersion}), daemon unreachable: ${firstLine(daemon?.tail ?? '')}`,
    },
  };
}

/** The toolkit needs Node's default-on type stripping (22.18+) and stripTypeScriptTypes (22.13+). */
export function nodeSupported(version = process.version): boolean {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 18);
}
