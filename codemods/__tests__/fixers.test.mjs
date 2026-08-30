import { describe, it, expect } from 'vitest';
import { applyOne, applyAll, summarize } from '../apply.mjs';

/** Apply one fixer to a source string and return the verdict plus the result. */
function run(source, rule, line, file = 'x.js') {
  return applyOne(source, file, { rule, line, file });
}

describe('remove-unused-import', () => {
  it('removes an import nothing references', () => {
    const r = run(`import { randomUUID } from 'node:crypto';\nexport const a = 1;\n`, 'javascript:S1128', 1);
    expect(r.changed).toBe(true);
    expect(r.source).not.toContain('randomUUID');
  });

  it('keeps an import that IS referenced', () => {
    const r = run(`import { randomUUID } from 'node:crypto';\nexport const id = randomUUID();\n`, 'javascript:S1128', 1);
    expect(r.changed).toBe(false);
    expect(r.source).toContain('randomUUID');
  });

  it('removes only the dead specifier from a partly-used import', () => {
    const r = run(`import { map, catchError } from 'rxjs';\nexport const f = map;\n`, 'typescript:S1128', 1, 'x.ts');
    expect(r.changed).toBe(true);
    expect(r.source).toContain('map');
    expect(r.source).not.toContain('catchError');
  });

  it('does not count a property named like the import as a use', () => {
    const r = run(`import { total } from './m.js';\nexport const o = { total: 1 };\nexport const x = o.total;\n`, 'javascript:S1128', 1);
    expect(r.changed).toBe(true);
  });

  it('refuses a side-effect-only import', () => {
    const r = run(`import './polyfills.js';\n`, 'javascript:S1128', 1);
    expect(r.refused).toBe(true);
  });
});

describe('remove-unused-variable', () => {
  it('removes an unused variable with a pure initializer', () => {
    const r = run(`export function f(xs) {\n  const n = 25;\n  return xs.length;\n}\n`, 'javascript:S1481', 2);
    expect(r.changed).toBe(true);
    expect(r.source).not.toContain('const n');
  });

  it('REFUSES when the initializer may have side effects', () => {
    const src = `export function f(xs) {\n  const n = audit(xs);\n  return xs.length;\n}\n`;
    const r = run(src, 'javascript:S1481', 2);
    expect(r.changed).toBe(false);
    expect(r.refused).toBe(true);
    expect(r.reason).toMatch(/side effects/);
    expect(r.source).toBe(src);
  });

  it('leaves a variable that is actually read', () => {
    const r = run(`export function f() {\n  const n = 25;\n  return n;\n}\n`, 'javascript:S1481', 2);
    expect(r.changed).toBe(false);
  });
});

describe('remove-dead-store', () => {
  it('drops an initial value that is overwritten before any read', () => {
    const src = `export function f(xs) {\n  let t = xs.map((x) => x.v).reduce((a, b) => a + b, 0);\n  t = 1;\n  return t;\n}\n`;
    const r = run(src, 'javascript:S1854', 2);
    expect(r.changed).toBe(true);
    expect(r.source).toMatch(/let t;/);
  });

  it('REFUSES to delete a dead store whose value came from a call', () => {
    const src = `export function f() {\n  let t = compute();\n  t = 1;\n  return t;\n}\n`;
    const r = run(src, 'javascript:S1854', 2);
    expect(r.refused).toBe(true);
    expect(r.source).toBe(src);
  });
});

describe('var-to-const', () => {
  it('uses const when the binding is never reassigned', () => {
    const r = run(`var SCALE = 100;\nexport const f = () => SCALE;\n`, 'javascript:S3504', 1);
    expect(r.changed).toBe(true);
    expect(r.source).toMatch(/^const SCALE/m);
  });

  it('uses let when the binding IS reassigned', () => {
    const r = run(`var n = 1;\nexport function f() { n = 2; return n; }\n`, 'javascript:S3504', 1);
    expect(r.changed).toBe(true);
    expect(r.source).toMatch(/^let n/m);
  });

  it('uses let for an increment, which const would break at runtime', () => {
    const r = run(`var n = 1;\nexport function f() { n++; return n; }\n`, 'javascript:S3504', 1);
    expect(r.source).toMatch(/^let n/m);
  });

  it('REFUSES when the binding is used above its declaration (var hoisting)', () => {
    const src = `export function f() {\n  const a = n;\n  var n = 1;\n  return a;\n}\n`;
    const r = run(src, 'javascript:S3504', 3);
    expect(r.refused).toBe(true);
    expect(r.source).toBe(src);
  });
});

describe('to-optional-chain', () => {
  it('rewrites `a && a.b` inside an if', () => {
    const r = run(`export function f(o) {\n  if (o && o.b) { return 1; }\n  return 0;\n}\n`, 'javascript:S6582', 2);
    expect(r.changed).toBe(true);
    expect(r.source).toContain('o?.b');
  });

  it('rewrites the negated `!a || !a.b` form', () => {
    const r = run(`export function f(o) {\n  if (!o || !o.id) { return 0; }\n  return 1;\n}\n`, 'javascript:S6582', 2);
    expect(r.changed).toBe(true);
    expect(r.source).toContain('!o?.id');
  });

  it('REFUSES in a value position, where `a && a.b` and `a?.b` differ', () => {
    // With o === 0: `o && o.b` is 0, `o?.b` is undefined. Rewriting silently
    // changes the value, which is worse than leaving the smell.
    const src = `export function f(o) {\n  const v = o && o.b;\n  return v;\n}\n`;
    const r = run(src, 'javascript:S6582', 2);
    expect(r.changed).toBe(false);
    expect(r.refused).toBe(true);
    expect(r.reason).toMatch(/not in a condition/);
    expect(r.source).toBe(src);
  });

  it('REFUSES a return position too', () => {
    const src = `export function f(o) {\n  return o && o.b;\n}\n`;
    const r = run(src, 'javascript:S6582', 2);
    expect(r.refused).toBe(true);
  });

  it('refuses when the guard is not the object being accessed', () => {
    const src = `export function f(a, b) {\n  if (a && b.c) { return 1; }\n  return 0;\n}\n`;
    const r = run(src, 'javascript:S6582', 2);
    expect(r.changed).toBe(false);
  });
});

describe('some-to-includes', () => {
  it('rewrites a function-expression callback', () => {
    const src = `export function f(xs, v) {\n  return xs.some(function m(x) {\n    return x === v;\n  });\n}\n`;
    const r = run(src, 'javascript:S7765', 2);
    expect(r.changed).toBe(true);
    expect(r.source).toContain('xs.includes(v)');
  });

  it('rewrites an arrow callback', () => {
    const r = run(`export const f = (xs, v) => xs.some((x) => x === v);\n`, 'javascript:S7765', 1);
    expect(r.changed).toBe(true);
    expect(r.source).toContain('includes(v)');
  });

  it('REFUSES when the compared value mentions the callback parameter', () => {
    const src = `export const f = (xs) => xs.some((x) => x === x.id);\n`;
    const r = run(src, 'javascript:S7765', 1);
    expect(r.refused).toBe(true);
    expect(r.source).toBe(src);
  });

  it('REFUSES a loose == comparison, which includes does not reproduce', () => {
    const src = `export const f = (xs, v) => xs.some((x) => x == v);\n`;
    const r = run(src, 'javascript:S7765', 1);
    expect(r.refused).toBe(true);
  });
});

describe('the engine', () => {
  it('resolves a co-located S1481/S1854 pair once, with no spurious failure', () => {
    const files = { 'a.js': `export function f() {\n  const n = 25;\n  return 1;\n}\n` };
    const results = applyAll(
      [
        { rule: 'javascript:S1481', file: 'a.js', line: 2 },
        { rule: 'javascript:S1854', file: 'a.js', line: 2 }
      ],
      {
        root: '.',
        read: (p) => files[p.replace(/^\.\//, '')],
        write: (p, s) => { files[p.replace(/^\.\//, '')] = s; }
      }
    );
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(results.filter((r) => r.alreadyGone)).toHaveLength(1);
    expect(results.filter((r) => r.failed || r.refused)).toHaveLength(0);
    const s = summarize(results);
    expect(s.resolved).toBe(2);
  });

  it('applies highest line first so earlier edits do not shift later targets', () => {
    const src = `import { a } from 'm';\nexport function f(o) {\n  const dead = 1;\n  if (o && o.b) { return 2; }\n  return 3;\n}\n`;
    const files = { 'b.js': src };
    const results = applyAll(
      [
        { rule: 'javascript:S1128', file: 'b.js', line: 1 },
        { rule: 'javascript:S1481', file: 'b.js', line: 3 },
        { rule: 'javascript:S6582', file: 'b.js', line: 4 }
      ],
      { root: '.', read: (p) => files[p.replace(/^\.\//, '')], write: (p, s) => { files[p.replace(/^\.\//, '')] = s; } }
    );
    expect(results.every((r) => r.changed)).toBe(true);
    expect(files['b.js']).toContain('o?.b');
    expect(files['b.js']).not.toContain('const dead');
    expect(files['b.js']).not.toContain("from 'm'");
  });

  it('reports no fixer rather than inventing one', () => {
    const r = run(`export const f = 1;\n`, 'javascript:S3776', 1);
    expect(r.noFixer).toBe(true);
    expect(r.changed).toBe(false);
  });
});
