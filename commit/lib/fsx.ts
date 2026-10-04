// Small, safety-critical helpers: atomic artifact writes, shell quoting for the few
// values the toolkit substitutes into plan commands, and secret redaction for anything
// that ends up in public evidence.
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * Write a file so that readers see either the old content or the complete new content,
 * never a torn file: write a temporary sibling, fsync it, rename it over the target.
 */
export function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
}

export const writeJsonAtomic = (path: string, value: unknown) => writeAtomic(path, JSON.stringify(value, null, 2) + '\n');

/** POSIX single-quote a value for `sh -c`: the result is always exactly one word. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Credential shapes that must not reach public evidence. Deliberately aligned with the
// event's own credential scanner, plus private-key blocks.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED private key]'],
  [/(\bbearer\s+)(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{20,}=*/gi, '$1[REDACTED]'],
  [/\bsk-[A-Za-z0-9._-]{16,}/g, '[REDACTED api key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED aws key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED github token]'],
  [/(\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)\S+/g, '$1[REDACTED]'],
  [/(:\/\/[^/\s:@"'\\]+:)[^/\s@"'\\]+(?=@)/g, '$1[REDACTED]'],
];

/** The home directory names the local user, and evidence is public: replace it with "~". */
export function scrubHome(text: string, home = process.env.HOME): string {
  return home && home.length > 1 ? text.split(home).join('~') : text;
}

/** Credentials only (see SECRET_PATTERNS); combine with scrubHome for public logs. */
export function redact(text: string): { text: string; redactions: number } {
  let count = 0;
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, (...m) => {
      count++;
      return replacement.replace('$1', String(m[1] ?? ''));
    });
  }
  return { text: out, redactions: count };
}
