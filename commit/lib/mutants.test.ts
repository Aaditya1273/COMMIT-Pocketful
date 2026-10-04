// pnpm test:commit -- self-checks for the parts of the toolkit that are easy to get
// subtly wrong: the code mask, operator matching, offsets and seeded determinism.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, codeMask, discover } from './mutants.ts';
import { rng } from './rng.ts';
import { redact, scrubHome, shQuote } from './fsx.ts';

const masked = (src: string) => [...src].filter((_, i) => codeMask(src)[i]).join('');

test('strings, comments, template text and regex literals are not code', () => {
  const src = `a < b; "x < y"; 'p - q'; // c > d\n/* e === f */ g(\`t + \${h - i} + u\`); const r = /[a-z]+-x/g; k / 2;`;
  const code = masked(src);
  assert.ok(!code.includes('x < y') && !code.includes('p - q') && !code.includes('c > d') && !code.includes('e === f'));
  assert.ok(!code.includes('t +') && !code.includes('+ u') && !code.includes('[a-z]'));
  assert.ok(code.includes('a < b') && code.includes('h - i') && code.includes('k / 2'));
});

test('type syntax is never mutated', () => {
  const ops = discover('x.ts', 'function f(a: Array<number>): Promise<Map<string, number>> { return a.length > 0 ? null! : null; }\n');
  assert.deepEqual(ops.filter((m) => m.operator === 'boundary').map((m) => m.original), ['>']);
});

test('binary arithmetic only, and a hyphen is not a character range', () => {
  const ops = discover('x.js', 'let y = a-1; y = -2; y++; y += 3; y = b - c;\n').filter((m) => m.operator === 'arithmetic');
  assert.deepEqual(ops.map((m) => m.original), ['-', '-']);
});

test('apply rewrites exactly the reported span', () => {
  const src = 'if (balance < amount) throw new Error("no");\nfrom.balance -= amount;\n';
  const byOp = Object.fromEntries(discover('x.js', src).map((m) => [m.operator, m]));
  assert.equal(apply(src, byOp['guard-bypass']), 'if (false) throw new Error("no");\nfrom.balance -= amount;\n');
  assert.equal(apply(src, byOp['statement-deletion']), 'if (balance < amount) throw new Error("no");\n;\n');
  assert.equal(apply(src, byOp['compound-assignment']), src.replace('-=', '+='));
});

test('mutant ids are stable across runs', () => {
  const src = 'const ok = a === b && c;\n';
  assert.deepEqual(discover('x.js', src).map((m) => m.id), discover('x.js', src).map((m) => m.id));
});

test('a seed fixes the whole random sequence', () => {
  const seq = (s: number) => Array.from({ length: 5 }, ((r) => () => r.int(1000))(rng(s)));
  assert.deepEqual(seq(42), seq(42));
  assert.notDeepEqual(seq(42), seq(43));
});

test('public-evidence hygiene: home paths scrubbed, credentials redacted, quoting is one word', () => {
  assert.equal(scrubHome('at /home/alice/x and /home/alice/y', '/home/alice'), 'at ~/x and ~/y');
  assert.equal(redact('plain text').redactions, 0);
  // Assembled so this file never contains the credential shape it tests for.
  assert.ok(redact(['DB_PASS', 'WORD', '=', 'hunter2'].join('')).redactions === 1);
  assert.equal(shQuote(`a'b; rm -rf ~`), `'a'\\''b; rm -rf ~'`);
});
