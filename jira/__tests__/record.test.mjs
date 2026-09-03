import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../record.mjs';
import { recordIssueKey, writePlan } from '../plan.mjs';
import { groupFindings } from '../group.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jira-record-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const [g] = groupFindings([{ rule: 'typescript:S3358', file: 'web/a.ts', line: 1, severity: 'MAJOR' }]);

function seedPlan(planPath) {
  writePlan(planPath, recordIssueKey({ items: [] }, g, 'SONAR-1'));
}

describe('record.mjs is update-only: it refuses a fingerprint the plan has never seen', () => {
  it('exits 1 rather than inventing a plan item from three scalars', async () => {
    const planPath = join(dir, 'plan.json');
    writePlan(planPath, { items: [] });
    const code = await main(['node', 'record.mjs', 'branch', '--plan', planPath,
      '--fingerprint', 'gf-nope', '--name', 'sonar/gf-nope']);
    expect(code).toBe(1);
  });
});

describe('branch mode', () => {
  it('records the branch name and moves status to Branched', async () => {
    const planPath = join(dir, 'plan.json');
    seedPlan(planPath);
    const code = await main(['node', 'record.mjs', 'branch', '--plan', planPath,
      '--fingerprint', g.fingerprint, '--name', 'sonar/gf-x']);
    expect(code).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    expect(plan.items[0]).toMatchObject({ branch_name: 'sonar/gf-x', status: 'Branched', jira_issue_key: 'SONAR-1' });
  });
});

describe('pr mode', () => {
  it('records the PR number, defaulting auto_continue to false', async () => {
    const planPath = join(dir, 'plan.json');
    seedPlan(planPath);
    await main(['node', 'record.mjs', 'pr', '--plan', planPath, '--fingerprint', g.fingerprint, '--pr', '42']);
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    expect(plan.items[0]).toMatchObject({ pr_number: 42, auto_continue: false, status: 'PRed' });
  });

  it('sets auto_continue when the flag is passed', async () => {
    const planPath = join(dir, 'plan.json');
    seedPlan(planPath);
    await main(['node', 'record.mjs', 'pr', '--plan', planPath, '--fingerprint', g.fingerprint,
      '--pr', '42', '--auto-continue']);
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    expect(plan.items[0].auto_continue).toBe(true);
  });
});

describe('status mode', () => {
  it('sets an arbitrary status without touching other fields', async () => {
    const planPath = join(dir, 'plan.json');
    seedPlan(planPath);
    await main(['node', 'record.mjs', 'status', '--plan', planPath,
      '--fingerprint', g.fingerprint, '--value', 'Remediating']);
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    expect(plan.items[0].status).toBe('Remediating');
    expect(plan.items[0].jira_issue_key).toBe('SONAR-1');
  });
});
