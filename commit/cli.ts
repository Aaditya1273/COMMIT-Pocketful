// The one entry point: `node commit/cli.ts <command> [args]`. Each command is its own
// script; this dispatcher runs it as a child so its exit code passes through unchanged.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectEnvironment, EXIT, FACTORY_VERSION, loadConfig, nodeSupported } from './lib/config.ts';

const here = dirname(fileURLToPath(import.meta.url));

const COMMANDS: Record<string, string> = {
  verify: 'run a verification plan against one revision; write evidence and a verdict',
  mutate: 'mutation campaign: how much seeded bad work does a check kill?',
  campaign: 'seeded reference-model campaign against a running candidate',
  audit: 'check that evidence directories are internally consistent and unaltered',
  doctor: 'report what this machine can run (Node, git, Docker daemon, Python, kickoff package)',
  version: 'print the factory version',
};

const HELP = `COMMIT factory ${FACTORY_VERSION}

usage: node commit/cli.ts <command> [args]     (each command takes --help)

${Object.entries(COMMANDS).map(([c, d]) => `  ${c.padEnd(11)} ${d}`).join('\n')}

Exit codes (all commands): 0 ok/ACCEPT, 1 REJECT/contradiction, 2 usage, configuration
or broken campaign, 3 INCONCLUSIVE, 4 ERROR, 130 interrupted.
Bootstrap a result repository with: commit/bootstrap.sh --help`;

const [command, ...rest] = process.argv.slice(2);

if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log(HELP);
  process.exit(command ? EXIT.OK : EXIT.USAGE);
}
if (command === 'version' || command === '--version') {
  console.log(FACTORY_VERSION);
  process.exit(EXIT.OK);
}
if (command === 'doctor') {
  const env = await detectEnvironment();
  let configOk = true;
  let kickoff = '';
  try {
    kickoff = loadConfig().kickoffDir;
  } catch (error) {
    configOk = false;
    console.log(`config        FAIL  ${(error as Error).message}`);
  }
  const line = (name: string, ok: boolean | null, detail: string) => console.log(`${name.padEnd(13)} ${ok === null ? 'n/a ' : ok ? 'ok  ' : 'FAIL'}  ${detail}`);
  line('factory', true, FACTORY_VERSION);
  line('node', nodeSupported(env.node), `${env.node} (needs >= 22.18)`);
  line('git', !!env.git, env.git ?? 'not found');
  line('docker', env.docker.daemonReachable, env.docker.detail);
  line('python', env.python ? true : null, env.python ?? 'not found (only needed for pytest-based task checks)');
  line('kickoff', kickoff ? existsSync(join(kickoff, 'harness')) : null, kickoff ? `${kickoff}${existsSync(join(kickoff, 'harness')) ? '' : ' (not found; set COMMIT_KICKOFF if a plan uses {kickoff})'}` : 'n/a');
  line('platform', true, `${env.platform} ${env.release} ${env.arch}`);
  process.exit(configOk && nodeSupported(env.node) && env.git ? EXIT.OK : EXIT.USAGE);
}
if (!(command in COMMANDS)) {
  console.error(`unknown command: ${command}\n\n${HELP}`);
  process.exit(EXIT.USAGE);
}
if (!nodeSupported()) {
  console.error(`ENVIRONMENT_ERROR: Node ${process.version} is too old; COMMIT needs >= 22.18 (default-on type stripping)`);
  process.exit(EXIT.USAGE);
}
const r = spawnSync(process.execPath, ['--no-warnings', join(here, `${command}.ts`), ...rest], { stdio: 'inherit' });
process.exit(r.status ?? (r.signal === 'SIGINT' || r.signal === 'SIGTERM' ? EXIT.INTERRUPTED : EXIT.ERROR));
