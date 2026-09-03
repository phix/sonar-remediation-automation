import { describe, it, expect } from 'vitest';
import { resume } from '../resume.mjs';
import { recordIssueKey, recordBranch, recordPR } from '../plan.mjs';
import { groupFindings } from '../group.mjs';

const F = (over = {}) => ({
  rule: 'typescript:S3358', file: 'web/src/app/orders/order-stats.ts',
  line: 12, severity: 'MAJOR', message: 'nested ternary', ...over
});

describe('resume() answers "where does this group already stand"', () => {
  it('says everything is missing and next is ticket, for a group nobody has touched', () => {
    const r = resume({ items: [] }, { fingerprint: 'gf-nope' });
    expect(r).toEqual({ found: false, item: null, missing: ['ticket', 'branch', 'pr'], next: 'ticket' });
  });

  it('resumes at branch once only the ticket exists — a Jira-first entry', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    const plan = recordIssueKey({ items: [] }, g, 'SONAR-1');
    const r = resume(plan, { jiraKey: 'SONAR-1' });
    expect(r.found).toBe(true);
    expect(r.next).toBe('branch');
    expect(r.missing).toEqual(['branch', 'pr']);
  });

  it('resumes at pr once ticket and branch exist', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    let plan = recordIssueKey({ items: [] }, g, 'SONAR-1');
    plan = recordBranch(plan, g, 'sonar/gf-x');
    const r = resume(plan, { fingerprint: g.fingerprint });
    expect(r.next).toBe('pr');
  });

  it('resumes at remediate once ticket, branch and PR all exist, found by PR number', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    let plan = recordIssueKey({ items: [] }, g, 'SONAR-1');
    plan = recordBranch(plan, g, 'sonar/gf-x');
    plan = recordPR(plan, g, 42);
    const r = resume(plan, { pr: '42' });
    expect(r.missing).toEqual([]);
    expect(r.next).toBe('remediate');
    expect(r.item.jira_issue_key).toBe('SONAR-1');
  });
});
