// Every child process the toolkit starts goes through here, so every one has a timeout,
// bounded memory, a recorded outcome and a way to be stopped.
//
// - `run` takes an argument vector and never involves a shell. `runShell` is the one
//   deliberate exception: verification plans are shell commands by design (they are
//   code the verifier writes), and the only values the toolkit substitutes into them
//   are shell-quoted (see fsx.shQuote).
// - Output streams to a log file up to a byte limit; beyond it bytes are counted and the
//   result says `truncated`, never silently dropped. Only a short tail stays in memory.
// - Children run in their own process group and are tracked, so a timeout or an
//   interrupt stops the whole tree: SIGTERM, then SIGKILL after a grace period.
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';

export type RunStatus = 'exited' | 'timeout' | 'signaled' | 'spawn-error';

export interface RunResult {
  command: string;
  status: RunStatus;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  /** Total bytes the command wrote to stdout + stderr. */
  bytes: number;
  /** True when more than maxLogBytes were written; the log holds the first maxLogBytes. */
  truncated: boolean;
  /** The last TAIL_BYTES of output, for summaries. */
  tail: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Stream full output here (up to maxLogBytes). */
  logPath?: string;
  maxLogBytes?: number;
  killGraceMs?: number;
}

const TAIL_BYTES = 64 * 1024;
const live = new Set<ChildProcess>();

/** Stop a child's whole process group: SIGTERM now, SIGKILL after the grace period. */
export function stopTree(child: ChildProcess, graceMs = 2_000): void {
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      // Group already gone.
    }
  };
  signal('SIGTERM');
  if (graceMs === 0) signal('SIGKILL');
  else setTimeout(() => signal('SIGKILL'), graceMs).unref();
}

/** Stop every child this process started. Used on interrupt and on fatal errors. */
export function stopAll(graceMs = 0): void {
  for (const child of live) stopTree(child, graceMs);
}

/**
 * Run `cleanup` once on SIGINT/SIGTERM, stop all children, then exit with `code`.
 * The cleanup records that the run was interrupted; it must not claim a result.
 */
export function onInterrupt(cleanup: (signal: string) => void, code = 130): void {
  let handled = false;
  const handler = (signal: NodeJS.Signals) => {
    if (handled) return;
    handled = true;
    stopAll(0);
    try {
      cleanup(signal);
    } finally {
      process.exit(code);
    }
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}

export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const command = [file, ...args].join(' ');
  const started = Date.now();
  const maxLog = opts.maxLogBytes ?? 32 * 1024 * 1024;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ command, status: 'spawn-error', exitCode: null, signal: null, durationMs: 0, bytes: 0, truncated: false, tail: String(error) });
      return;
    }
    live.add(child);
    const fd = opts.logPath ? openSync(opts.logPath, 'w', 0o644) : null;
    let bytes = 0;
    let tail = Buffer.alloc(0);
    let timedOut = false;
    let spawnError: Error | null = null;
    const onData = (chunk: Buffer) => {
      if (fd !== null && bytes < maxLog) writeSync(fd, chunk, 0, Math.min(chunk.length, maxLog - bytes));
      bytes += chunk.length;
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; stopTree(child, opts.killGraceMs); }, opts.timeoutMs) : undefined;
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      live.delete(child);
      if (fd !== null) closeSync(fd);
      const status: RunStatus = spawnError ? 'spawn-error' : timedOut ? 'timeout' : signal ? 'signaled' : 'exited';
      resolve({
        command, status, exitCode: status === 'exited' ? exitCode : null, signal: signal ?? null,
        durationMs: Date.now() - started, bytes, truncated: bytes > maxLog,
        tail: spawnError ? String(spawnError) : tail.toString('utf8'),
      });
    });
  });
}

/** A plan command: shell syntax is the point. Callers quote anything they substitute. */
export const runShell = (command: string, opts: RunOptions = {}) =>
  run('/bin/sh', ['-c', command], opts).then((r) => ({ ...r, command }));

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export interface Service {
  url: string;
  stop: () => void;
}

/**
 * Start a candidate service (a shell command, with PORT set) and wait until
 * `healthPath` answers 200. `service` is null when it exits or never becomes healthy;
 * the caller decides whether that is an environment failure or an invalid candidate,
 * and gets the log either way.
 */
export async function startService(command: string, opts: { cwd: string; healthPath?: string; timeoutMs?: number; killGraceMs?: number }): Promise<{ service: Service | null; log: () => string }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn('/bin/sh', ['-c', command], { cwd: opts.cwd, env: { ...process.env, PORT: String(port) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(child);
  let log = '';
  const keep = (d: Buffer) => { log = (log + d.toString('utf8')).slice(-TAIL_BYTES); };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  let exited = false;
  child.on('error', (e) => { exited = true; log += String(e); });
  child.on('exit', () => { exited = true; live.delete(child); });
  const service = { url, stop: () => stopTree(child, opts.killGraceMs) };
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline && !exited) {
    try {
      const res = await fetch(url + (opts.healthPath ?? '/health'), { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) return { service, log: () => log };
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  service.stop();
  return { service: null, log: () => log };
}
