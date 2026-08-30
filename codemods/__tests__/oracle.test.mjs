import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, cpSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remediate, commitPlan, renderReport } from '../remediate.mjs';

/**
 * The catalogue as an executable oracle.
 *
 * Every unit test in fixers.test.mjs uses a synthetic snippet, and all 35 of
 * them passed while three real bugs were live — the co-located S1481/S1854
 * mismatch, enclosingExport returning null for every export, and TS interfaces
 * being asserted as runtime exports. Each bug lived in the gap between a
 * hand-written snippet and a real file.
 *
 * So this runs the whole pipeline against the actual defective sources, taken
 * verbatim from the sandbox's v0-pristine tag, and pins the outcome. The ratio
 * assertion below is the comparison that found the first bug when it was done
 * by hand, once. Here it runs in milliseconds, every time.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'sandbox');
const FINDINGS = JSON.parse(readFileSync(join(HERE, 'fixtures', 'findings.json'), 'utf8'));

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
}

describe('the sandbox catalogue, end to end', () => {
  let run, root, filesBefore;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'oracle-'));
    cpSync(FIXTURES, root, { recursive: true });
    filesBefore = walk(root).sort();
    run = remediate(FINDINGS, { root });
  });

  it('routes every reported finding to exactly one destination', () => {
    // If this number ever moves, either a fixer regressed or the policy changed.
    // Both are things a human should be told about, not discover in CI.
    expect(run.ratio).toEqual({
      total: 32,
      refusedByPolicy: 4,
      resolvedDeterministically: 18,
      awaitingAgent: 10,
      refusedByFixer: 0,
      failed: 0
    });
  });

  it('accounts for every finding — nothing silently vanishes', () => {
    const { total, ...rest } = run.ratio;
    expect(Object.values(rest).reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('never touches a protected path', () => {
    const touched = run.results.filter((r) => r.changed).map((r) => r.file);
    expect(touched.filter((f) => f.startsWith('api/src/auth/'))).toEqual([]);
    expect(run.refused.every((r) => r.file.startsWith('api/src/auth/'))).toBe(true);
  });

  it('writes exactly one test case per applied fix', () => {
    const cases = run.tests.reduce((n, t) => n + t.cases, 0);
    expect(cases).toBe(run.stats.fixed);
  });

  it('creates no files other than the generated tests', () => {
    const added = walk(root).sort().filter((f) => !filesBefore.includes(f));
    expect(added.every((f) => /\.generated\.(test\.js|spec\.ts)$/.test(f))).toBe(true);
  });

  it('groups commits by module and rule', () => {
    expect(commitPlan(run.results).map((c) => c.key).sort()).toMatchSnapshot();
  });
});

describe('golden output — the exact text, not just "it changed"', () => {
  let root;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'golden-'));
    cpSync(FIXTURES, root, { recursive: true });
    remediate(FINDINGS, { root });
  });

  // Both the enclosingExport bug and the TS-interface bug were plainly visible
  // in this text and still took a careful read to notice. A diff cannot miss.
  for (const f of [
    'api/src/reports/summary.js',
    'api/src/routes/orders.js',
    'api/src/store.js',
    'web/src/app/orders/order-stats.ts',
    'web/src/app/orders/order.service.ts'
  ]) {
    it(`remediated source: ${f}`, () => {
      expect(readFileSync(join(root, f), 'utf8')).toMatchSnapshot();
    });
  }

  for (const f of [
    'api/test/orders.generated.test.js',
    'api/test/summary.generated.test.js',
    'web/src/app/orders/order-stats.generated.spec.ts'
  ]) {
    it(`generated test: ${f}`, () => {
      expect(existsSync(join(root, f))).toBe(true);
      expect(readFileSync(join(root, f), 'utf8')).toMatchSnapshot();
    });
  }

  it('the PR report reads correctly to someone who has not seen this repo', () => {
    expect(renderReport(remediate(FINDINGS, { root, dryRun: true }))).toMatchSnapshot();
  });
});
