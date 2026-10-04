// Mutant discovery for JavaScript/TypeScript source. Language-generic within that
// family; nothing here knows what the program under test does.
//
// A mutant is one small, realistic defect: a boundary off by one, a guard bypassed,
// a condition inverted, a state update dropped. Each is applied only to *code*
// characters -- never inside strings, comments, template text or regex literals --
// which is what the lexer below is for.
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

export interface Mutant {
  id: string;
  file: string;
  line: number;
  column: number;
  operator: string;
  original: string;
  replacement: string;
  /** Character offset of the replaced span in the original file. */
  start: number;
  end: number;
}

/** true for every character that is executable code (not string/comment/regex/template text). */
export function codeMask(src: string): boolean[] {
  const mask = new Array<boolean>(src.length).fill(false);
  // Stack of brace depths for `${ ... }` holes inside template literals.
  const holes: number[] = [];
  let depth = 0;
  let i = 0;
  let lastSignificant = '';
  const regexCanStart = () => lastSignificant === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSignificant)
    || /\b(return|typeof|case|in|of|throw|delete|void|yield|await)$/.test(src.slice(Math.max(0, i - 8), i).trimEnd());

  const skipString = (quote: string) => {
    i++;
    while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
    i++;
  };
  const skipTemplateText = () => {
    // From just after ` or } until the closing ` or the next ${ hole.
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { i++; return; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; holes.push(depth); depth++; return; }
      i++;
    }
  };

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? src.length : i + 2; continue; }
    if (c === '"' || c === "'") { skipString(c); lastSignificant = 'x'; continue; }
    if (c === '`') { i++; skipTemplateText(); lastSignificant = 'x'; continue; }
    if (c === '/' && regexCanStart()) {
      i++;
      let inClass = false;
      while (i < src.length && (inClass || src[i] !== '/') && src[i] !== '\n') {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        i++;
      }
      i++;
      while (/[a-z]/.test(src[i] ?? '')) i++;
      lastSignificant = 'x';
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (holes.length && holes[holes.length - 1] === depth) {
        holes.pop();
        i++;
        skipTemplateText();
        lastSignificant = 'x';
        continue;
      }
    }
    mask[i] = true;
    if (!/\s/.test(c)) lastSignificant = /[\w$)\]]/.test(c) ? 'x' : c;
    i++;
  }
  return mask;
}

interface Rule {
  operator: string;
  pattern: RegExp;
  replace: (match: RegExpExecArray, src: string) => string | null;
}

const isIdentChar = (c: string | undefined) => !!c && /[\w$]/.test(c);

/** The previous non-space character, used to tell binary from unary operators. */
function before(src: string, index: number): string {
  let j = index - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  return src[j] ?? '';
}

const RULES: Rule[] = [
  // Boundary shifts: the classic off-by-one in a limit or a funds check.
  { operator: 'boundary', pattern: /<=|>=|<(?![<=])|>(?![>=])/g, replace: (m, src) => {
    if (/[=<>]/.test(src[m.index - 1] ?? '')) return null; // =>, <<, >>
    return { '<=': '<', '>=': '>', '<': '<=', '>': '>=' }[m[0]] ?? null;
  } },
  { operator: 'equality-negation', pattern: /===|!==/g, replace: (m) => (m[0] === '===' ? '!==' : '===') },
  { operator: 'logical', pattern: /&&|\|\|/g, replace: (m) => (m[0] === '&&' ? '||' : '&&') },
  // Binary arithmetic only: an operand must precede it.
  { operator: 'arithmetic', pattern: /(?<![+-])[+-](?![+=-])/g, replace: (m, src) =>
    (isIdentChar(before(src, m.index)) || /[)\]]/.test(before(src, m.index)) ? (m[0] === '+' ? '-' : '+') : null) },
  { operator: 'compound-assignment', pattern: /\+=|-=/g, replace: (m) => (m[0] === '+=' ? '-=' : '+=') },
  { operator: 'boolean-literal', pattern: /\b(true|false)\b/g, replace: (m) => (m[0] === 'true' ? 'false' : 'true') },
  { operator: 'negation-removal', pattern: /!(?!=)/g, replace: () => '' },
  { operator: 'rounding', pattern: /\bMath\.(floor|ceil|round)\b/g, replace: (m) => (m[1] === 'floor' ? 'Math.ceil' : 'Math.floor') },
  { operator: 'literal-boundary', pattern: /\b\d[\d_]*\b(?!\.\d)/g, replace: (m, src) =>
    (src[m.index - 1] === '.' ? null : String(Number(m[0].replaceAll('_', '')) + 1)) },
];

const SKIP_LINE = /^\s*(import|export\s+\{|\/\/|\*)|mutation-skip/;

/** Single-line `if (...)` guards: the condition is replaced so the guard never fires. */
function guardBypasses(src: string, mask: boolean[]): Array<{ start: number; end: number; original: string }> {
  const out: Array<{ start: number; end: number; original: string }> = [];
  const re = /\bif\s*\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (!mask[m.index]) continue;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      if (!mask[j]) continue;
      if (src[j] === '(') depth++;
      if (src[j] === ')' && --depth === 0) {
        out.push({ start: open + 1, end: j, original: src.slice(open + 1, j) });
        break;
      }
    }
  }
  return out;
}

/** One-line expression statements that update state, e.g. `x.balance -= amount;`. */
function statementDeletions(src: string, mask: boolean[]): Array<{ start: number; end: number; original: string }> {
  const out: Array<{ start: number; end: number; original: string }> = [];
  let offset = 0;
  for (const line of src.split('\n')) {
    const body = line.trim();
    const start = offset + line.indexOf(body);
    const isStatement = /^[A-Za-z_$][\w$.]*(\[[^\]]+\])?(\.[\w$]+)*\s*(=|\+=|-=)\s*[^=>].*;$|^[A-Za-z_$][\w$.]*\(.*\);$/.test(body)
      && !/^(return|throw|const|let|var|if|for|while|switch|case|break|continue)\b/.test(body);
    if (isStatement && mask[start] && !SKIP_LINE.test(line)) out.push({ start, end: start + body.length, original: body });
    offset += line.length + 1;
  }
  return out;
}

function lineCol(src: string, index: number): { line: number; column: number } {
  const prefix = src.slice(0, index);
  const line = prefix.split('\n').length;
  return { line, column: index - prefix.lastIndexOf('\n') };
}

/**
 * TypeScript is first reduced to JavaScript by Node's own type stripper, which blanks
 * type syntax with whitespace and so keeps every offset. Discovery runs on that
 * JavaScript -- a generic's `<` is never mistaken for a comparison -- and the
 * offsets apply unchanged to the original file.
 */
export function discover(file: string, original: string): Mutant[] {
  const src = file.endsWith('.ts') ? stripTypeScriptTypes(original) : original;
  if (src.length !== original.length) throw new Error(`${file}: type stripping changed offsets; refusing to guess`);
  const mask = codeMask(src);
  const lines = src.split('\n');
  const mutants: Mutant[] = [];
  const add = (operator: string, start: number, end: number, original: string, replacement: string) => {
    const { line, column } = lineCol(src, start);
    if (SKIP_LINE.test(lines[line - 1])) return;
    const id = 'm-' + createHash('sha256').update(`${file}:${start}:${operator}:${replacement}`).digest('hex').slice(0, 10);
    mutants.push({ id, file, line, column, operator, original, replacement, start, end });
  };
  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (let m = re.exec(src); m; m = re.exec(src)) {
      if (!mask.slice(m.index, m.index + m[0].length).every(Boolean)) continue;
      const replacement = rule.replace(m, src);
      if (replacement !== null) add(rule.operator, m.index, m.index + m[0].length, m[0], replacement);
    }
  }
  for (const g of guardBypasses(src, mask)) add('guard-bypass', g.start, g.end, g.original, 'false');
  for (const s of statementDeletions(src, mask)) add('statement-deletion', s.start, s.end, s.original, ';');
  return mutants.sort((a, b) => a.start - b.start || a.operator.localeCompare(b.operator));
}

export function apply(src: string, mutant: Mutant): string {
  return src.slice(0, mutant.start) + mutant.replacement + src.slice(mutant.end);
}
