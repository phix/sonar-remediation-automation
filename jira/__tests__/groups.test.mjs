import { describe, it, expect } from 'vitest';
import { listGroups } from '../groups.mjs';
import { recordIssueKey } from '../plan.mjs';
import { groupFindings } from '../group.mjs';

const F = (over = {}) => ({
  rule: 'typescript:S3358', file: 'web/a.ts', line: 1, severity: 'MAJOR', ...over
});

describe('listGroups cross-references findings with whatever ticket the plan already has', () => {
  it('carries a null jira_issue_key for a group the plan has never seen', () => {
    const [g] = listGroups([F()], { items: [] });
    expect(g).toMatchObject({ rule: 'typescript:S3358', module: 'web', severity: 'MAJOR', jira_issue_key: null });
  });

  it('fills in the key once the plan already has one recorded', () => {
    const findings = [F()];
    const [group] = groupFindings(findings);
    const plan = recordIssueKey({ items: [] }, group, 'SONAR-1');
    const [g] = listGroups(findings, plan);
    expect(g.jira_issue_key).toBe('SONAR-1');
    expect(g.fingerprint).toBe(group.fingerprint);
  });

  it('lists one entry per group, not per finding', () => {
    const findings = [F({ line: 1 }), F({ line: 2 }), F({ file: 'api/b.js', rule: 'javascript:S3358' })];
    const groups = listGroups(findings, { items: [] });
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.module === 'web').findingCount).toBe(2);
  });
});
