import { describe, it, expect } from 'vitest';
import { evaluate, partition, DEFAULT_POLICY } from '../policy.mjs';
import { remediate, commitPlan, groupForCommit } from '../remediate.mjs';

describe('eligibility policy', () => {
  it('refuses by location even when a codemod exists for the rule', () => {
    // S7765 has a perfectly good codemod. Location wins anyway — that is the
    // whole point of deciding eligibility before any engine is consulted.
    const v = evaluate({ rule: 'javascript:S7765', file: 'api/src/auth/session.js', line: 47 });
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/protected path/);
  });

  it('allows the same rule outside the protected path', () => {
    const v = evaluate({ rule: 'javascript:S7765', file: 'api/src/reports/summary.js', line: 47 });
    expect(v.eligible).toBe(true);
  });

  it('refuses a file type the pipeline does not edit', () => {
    const v = evaluate({ rule: 'css:S4667', file: 'web/src/app/app.css', line: 1 });
    expect(v.eligible).toBe(false);
  });

  it('partitions without losing or duplicating a finding', () => {
    const findings = [
      { rule: 'javascript:S1128', file: 'api/src/app.js', line: 2 },
      { rule: 'javascript:S1121', file: 'api/src/auth/token-verifier.js', line: 33 }
    ];
    const { eligible, refused } = partition(findings);
    expect(eligible).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(eligible.length + refused.length).toBe(findings.length);
  });

  it('is data, not logic — an adopting team changes the list, not the code', () => {
    const custom = { ...DEFAULT_POLICY, protectedPaths: ['src/payments/'] };
    expect(evaluate({ rule: 'javascript:S1128', file: 'api/src/auth/x.js', line: 1 }, custom).eligible).toBe(true);
    expect(evaluate({ rule: 'javascript:S1128', file: 'src/payments/x.js', line: 1 }, custom).eligible).toBe(false);
  });
});

describe('remediation run', () => {
  const findings = [
    { rule: 'javascript:S1128', file: 'a.js', line: 1 },   // codemod
    { rule: 'javascript:S3776', file: 'a.js', line: 3 },   // agentic
    { rule: 'javascript:S1121', file: 'api/src/auth/t.js', line: 1 } // refused
  ];

  it('routes each finding to exactly one destination', () => {
    const files = { 'a.js': `import { x } from 'm';\nexport function f() {\n  return 1;\n}\n` };
    const run = remediate(findings, {
      root: '.',
      // applyAll's injected io is used through apply.mjs defaults, so run dry
      // and assert routing rather than file contents here.
      dryRun: true
    });
    expect(run.refused).toHaveLength(1);
    expect(run.needsAgent).toHaveLength(1);
    expect(run.needsAgent[0].rule).toBe('javascript:S3776');
    expect(run.ratio.total).toBe(3);
    expect(run.ratio.refusedByPolicy + run.ratio.awaitingAgent
      + run.ratio.resolvedDeterministically + run.ratio.refusedByFixer
      + run.ratio.failed).toBe(3);
  });

  it('never sends a refused finding to an engine', () => {
    const run = remediate(findings, { root: '.', dryRun: true });
    const refusedPaths = run.refused.map((r) => r.file);
    expect(run.results.some((r) => refusedPaths.includes(r.file))).toBe(false);
    expect(run.needsAgent.some((r) => refusedPaths.includes(r.file))).toBe(false);
  });
});

describe('commit plan', () => {
  it('groups by module and rule', () => {
    expect(groupForCommit({ file: 'api/src/a.js', rule: 'javascript:S1128' })).toBe('api|javascript:S1128');
    expect(groupForCommit({ file: 'web/src/b.ts', rule: 'typescript:S1128' })).toBe('web|typescript:S1128');
  });

  it('produces one commit per group, not one per finding', () => {
    const results = [
      { changed: true, file: 'api/src/a.js', rule: 'javascript:S1128', line: 1 },
      { changed: true, file: 'api/src/b.js', rule: 'javascript:S1128', line: 1 },
      { changed: true, file: 'web/src/c.ts', rule: 'typescript:S3504', line: 1 },
      { changed: false, file: 'api/src/d.js', rule: 'javascript:S1481', line: 1 }
    ];
    const plan = commitPlan(results);
    expect(plan).toHaveLength(2);
    expect(plan.find((p) => p.key === 'api|javascript:S1128').files).toHaveLength(2);
  });
});
