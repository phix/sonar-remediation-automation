import { describe, it, expect } from 'vitest';
import { groupFindings, fingerprint, groupKey, projectLabel, moduleOf, NEEDS_WORK_LABEL, READY_LABEL } from '../group.mjs';
import { renderBody, summaryFor, dispositionFor, resolvedComment, verdictComment } from '../body.mjs';

const F = (over = {}) => ({
  rule: 'typescript:S3358', file: 'web/src/app/orders/order-stats.ts',
  line: 12, severity: 'MAJOR', message: 'nested ternary', ...over
});

describe('one ticket per group, not one per finding', () => {
  it('collapses findings that are one piece of work for one person', () => {
    const g = groupFindings([F({ line: 12 }), F({ line: 20 }), F({ line: 33 })], { projectKey: 'p' });
    expect(g).toHaveLength(1);
    expect(g[0].findings).toHaveLength(3);
  });

  it('splits on module, rule and severity, because each changes who does what', () => {
    const g = groupFindings([
      F(),
      F({ file: 'api/src/a.js', rule: 'javascript:S3358' }),
      F({ severity: 'CRITICAL' })
    ], { projectKey: 'p' });
    expect(g).toHaveLength(3);
  });

  it('takes the module from the path prefix the plan already groups by', () => {
    expect(moduleOf('api/src/reports/summary.js')).toBe('api');
    expect(moduleOf('README.md')).toBe('README.md');
    expect(moduleOf('')).toBe('root');
  });
});

describe('the fingerprint has to survive being a Jira label', () => {
  it('emits only characters a label accepts', () => {
    const fp = fingerprint(groupKey(F()));
    expect(fp).toMatch(/^gf-[0-9a-f]{12}$/);
    expect(fp).not.toMatch(/[+/=\s]/);
  });

  it('is stable across re-scans, so the next run finds what the last one made', () => {
    expect(fingerprint(groupKey(F({ line: 1 })))).toBe(fingerprint(groupKey(F({ line: 999 }))));
  });

  it('differs when the group differs', () => {
    expect(fingerprint(groupKey(F()))).not.toBe(fingerprint(groupKey(F({ severity: 'MINOR' }))));
  });

  it('sanitises a project key rather than trusting it to be label-safe', () => {
    expect(projectLabel('phix_sonar-sandbox-app')).toBe('phix_sonar-sandbox-app');
    expect(projectLabel('org:proj key')).toBe('org-proj-key');
  });

  it('labels every ticket with the project key, which is what makes dedupe possible', () => {
    const [g] = groupFindings([F()], { projectKey: 'phix_sonar-sandbox-app' });
    expect(g.labels).toContain('phix_sonar-sandbox-app');
    expect(g.labels).toContain(g.fingerprint);
  });

  it('labels a freshly-grouped finding needs-work, because that is why the group exists', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    expect(g.labels).toContain(NEEDS_WORK_LABEL);
    expect(g.labels).not.toContain(READY_LABEL);
  });
});

describe('the comments that record live outcome, not pipeline progress', () => {
  it('says a group is resolved once Sonar stops reporting it', () => {
    const c = resolvedComment({ rule: 'typescript:S3358', module: 'web' }, { prUrl: 'https://x/pull/1' });
    expect(c).toMatch(/no longer reports/);
    expect(c).toMatch(/typescript:S3358/);
    expect(c).toMatch(/marking \*\*Ready\*\*/);
    expect(c).toMatch(/pull\/1/);
  });

  it('names the red reason when remediation ran but the gate is still red', () => {
    const c = verdictComment({}, { state: 'red', reason: 'new-code coverage 6.9 < 80' });
    expect(c).toMatch(/still red: new-code coverage 6\.9 < 80/);
  });

  it('says the gate is green but this finding survived, when the gate passed anyway', () => {
    const c = verdictComment({}, { state: 'ready' });
    expect(c).toMatch(/gate is green/);
    expect(c).toMatch(/still reported/);
  });
});

describe('what the ticket says', () => {
  const [g] = groupFindings([F(), F({ line: 20 })], { projectKey: 'p' });

  it('carries the rule guidance when it is available', () => {
    const body = renderBody(g, {
      available: true, name: 'Ternary operators should not be nested',
      howToFix: 'Extract the inner ternary into a named variable.',
      docs: 'https://rules.sonarsource.com/typescript/RSPEC-3358/'
    });
    expect(body).toMatch(/Extract the inner ternary into a named variable/);
  });

  it('degrades to the message and a public link rather than saying nothing', () => {
    const body = renderBody(g, { available: false, reason: 'HTTP 401', key: 'typescript:S3358' });
    expect(body).toMatch(/nested ternary/);
    expect(body).toMatch(/rules\.sonarsource\.com/);
    expect(body).toMatch(/not retrievable \(HTTP 401\)/);
  });

  it('names every location, so nobody has to open Sonar to find them', () => {
    const body = renderBody(g, { available: false });
    expect(body).toMatch(/order-stats\.ts:12/);
    expect(body).toMatch(/order-stats\.ts:20/);
  });

  it('ends with the fingerprint that makes it findable next run', () => {
    expect(renderBody(g, {}).trimEnd().endsWith(g.fingerprint)).toBe(true);
  });

  it('summarises as what and how much, not as a rule key alone', () => {
    expect(summaryFor(g)).toBe('[web] typescript:S3358: 2 findings (MAJOR)');
  });
});

describe('the ticket is not silent about work that already happened', () => {
  const [g] = groupFindings([F()], { projectKey: 'p' });

  it('says a policy refusal is the whole of the work', () => {
    const d = dispositionFor(g, { refusedByPolicy: true, reason: 'Protected path.' });
    expect(d).toMatch(/NOT auto-fixed/);
    expect(d).toMatch(/whole of the work/);
  });

  it('tells a reader to verify a codemod fix rather than repeat it', () => {
    expect(dispositionFor(g, { resolvedDeterministically: true })).toMatch(/verify the fix rather than repeating/);
  });

  it('warns that the agentic path may still reject its own proposals', () => {
    expect(dispositionFor(g, { awaitingAgent: true })).toMatch(/may still reject its own proposals/);
  });

  it('says nothing when there is nothing to say', () => {
    expect(dispositionFor(g, null)).toBeNull();
  });
});
