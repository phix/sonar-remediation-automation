import { describe, it, expect } from 'vitest';
import { recordIssueKey, recordBranch, recordPR, recordStatus, findItem, missingStages } from '../plan.mjs';
import { groupFindings } from '../group.mjs';

const F = (over = {}) => ({
  rule: 'typescript:S3358', file: 'web/src/app/orders/order-stats.ts',
  line: 12, severity: 'MAJOR', message: 'nested ternary', ...over
});

describe('a fresh item carries every multi-entry-point field, not just the ticketing ones', () => {
  it('starts branch/PR fields null and auto_continue false, not absent', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    const plan = recordIssueKey({ items: [] }, g, 'SONAR-1');
    expect(plan.items[0]).toMatchObject({ branch_name: null, pr_number: null, auto_continue: false });
  });
});

describe('recordBranch and recordPR follow the same immediate-write discipline as recordIssueKey', () => {
  it('creates an item if none exists yet — a group can reach "branch" before it has a ticket recorded here', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    const plan = recordBranch({ items: [] }, g, 'sonar/gf-abc123');
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ branch_name: 'sonar/gf-abc123', status: 'Branched' });
  });

  it('fills in the branch on the SAME item a ticket was already recorded against', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    let plan = recordIssueKey({ items: [] }, g, 'SONAR-1');
    plan = recordBranch(plan, g, 'sonar/gf-abc123');
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ jira_issue_key: 'SONAR-1', branch_name: 'sonar/gf-abc123', status: 'Branched' });
  });

  it('records the PR number and the auto_continue flag the watcher will read later', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    const plan = recordPR({ items: [] }, g, '42', { autoContinue: true });
    expect(plan.items[0]).toMatchObject({ pr_number: 42, auto_continue: true, status: 'PRed' });
  });

  it('defaults auto_continue to false when a caller does not say otherwise', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    const plan = recordPR({ items: [] }, g, 7);
    expect(plan.items[0].auto_continue).toBe(false);
  });
});

describe('recordStatus is the plain setter for stages nothing else writes', () => {
  it('sets status on the item it is given, and nothing else', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    const plan = recordPR({ items: [] }, g, 7);
    recordStatus(plan, plan.items[0], 'Remediating');
    expect(plan.items[0].status).toBe('Remediating');
    expect(plan.items[0].pr_number).toBe(7);
  });
});

describe('findItem answers with whichever identifier a caller happens to be holding', () => {
  it('finds by fingerprint, by Jira key, or by PR number', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    let plan = recordIssueKey({ items: [] }, g, 'SONAR-1');
    plan = recordPR(plan, g, 9);
    expect(findItem(plan, { fingerprint: g.fingerprint })).toBe(plan.items[0]);
    expect(findItem(plan, { jiraKey: 'SONAR-1' })).toBe(plan.items[0]);
    expect(findItem(plan, { pr: 9 })).toBe(plan.items[0]);
    expect(findItem(plan, { pr: '9' })).toBe(plan.items[0]); // a workflow input arrives as a string
  });

  it('returns null rather than throwing when nothing matches', () => {
    expect(findItem({ items: [] }, { jiraKey: 'SONAR-404' })).toBeNull();
  });

  it('returns null when called with no identifier, rather than guessing', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    const plan = recordIssueKey({ items: [] }, g, 'SONAR-1');
    expect(findItem(plan, {})).toBeNull();
  });
});

describe('missingStages names what a group still needs, in creation order', () => {
  it('names all three for an item that does not exist at all', () => {
    expect(missingStages(null)).toEqual(['ticket', 'branch', 'pr']);
  });

  it('drops ticket once one is filed, keeps branch and pr', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    const plan = recordIssueKey({ items: [] }, g, 'SONAR-1');
    expect(missingStages(plan.items[0])).toEqual(['branch', 'pr']);
  });

  it('is empty once ticket, branch and PR all exist — remediation is a live question, not this file\'s to predict', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    let plan = recordIssueKey({ items: [] }, g, 'SONAR-1');
    plan = recordBranch(plan, g, 'sonar/gf-x');
    plan = recordPR(plan, g, 3);
    expect(missingStages(plan.items[0])).toEqual([]);
  });
});
