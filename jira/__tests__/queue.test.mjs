import { describe, it, expect } from 'vitest';
import { nextBatch } from '../queue.mjs';
import { recordPR, recordBranch, recordIssueKey, recordStatus } from '../plan.mjs';
import { groupFindings } from '../group.mjs';

const F = (over = {}) => ({
  rule: 'typescript:S3358', file: 'web/src/app/orders/order-stats.ts',
  line: 12, severity: 'MAJOR', message: 'ternary', ...over
});

// Five distinct groups: different module or rule each time, so groupFindings
// splits them apart rather than collapsing them into fewer than five.
const BACKLOG = [
  F({ file: 'web/a.ts' }),
  F({ file: 'api/b.js', rule: 'javascript:S3358' }),
  F({ file: 'cli/c.js', rule: 'javascript:S1854' }),
  F({ file: 'jobs/d.js', rule: 'javascript:S6582' }),
  F({ file: 'web/e.ts', severity: 'CRITICAL' })
];

describe('nextBatch throttles a backlog to the concurrency cap', () => {
  it('selects up to the cap when nothing is ticketed yet', () => {
    const r = nextBatch(BACKLOG, { items: [] }, { projectKey: 'p', maxConcurrent: 3 });
    expect(r.eligible).toBe(5);
    expect(r.inFlight).toBe(0);
    expect(r.capacity).toBe(3);
    expect(r.selected).toHaveLength(3);
  });

  it('selects everything when the cap exceeds the backlog', () => {
    const r = nextBatch(BACKLOG, { items: [] }, { projectKey: 'p', maxConcurrent: 50 });
    expect(r.selected).toHaveLength(5);
  });

  it('does not re-select a group that already has a PR', () => {
    const [g] = groupFindings([BACKLOG[0]], { projectKey: 'p' });
    let plan = recordIssueKey({ items: [] }, g, 'SONAR-1');
    plan = recordBranch(plan, g, 'sonar/gf-x');
    plan = recordPR(plan, g, 10);
    const r = nextBatch(BACKLOG, plan, { projectKey: 'p', maxConcurrent: 50 });
    expect(r.eligible).toBe(4);
    expect(r.selected.some((s) => s.fingerprint === g.fingerprint)).toBe(false);
  });

  it('counts an in-flight PR against capacity for the REST of the backlog', () => {
    const [g] = groupFindings([BACKLOG[0]], { projectKey: 'p' });
    let plan = recordIssueKey({ items: [] }, g, 'SONAR-1');
    plan = recordBranch(plan, g, 'sonar/gf-x');
    plan = recordPR(plan, g, 10);
    const r = nextBatch(BACKLOG, plan, { projectKey: 'p', maxConcurrent: 3 });
    expect(r.inFlight).toBe(1);
    expect(r.capacity).toBe(2);
    expect(r.selected).toHaveLength(2);
  });

  it('frees capacity once a group is marked Verified, the same way jira/run.mjs marks a resolved finding', () => {
    const [g] = groupFindings([BACKLOG[0]], { projectKey: 'p' });
    let plan = recordIssueKey({ items: [] }, g, 'SONAR-1');
    plan = recordBranch(plan, g, 'sonar/gf-x');
    plan = recordPR(plan, g, 10);
    recordStatus(plan, plan.items[0], 'Verified');
    const r = nextBatch(BACKLOG, plan, { projectKey: 'p', maxConcurrent: 3 });
    expect(r.inFlight).toBe(0);
    expect(r.capacity).toBe(3);
  });

  it('never reports negative capacity when in-flight already exceeds the cap', () => {
    let plan = { items: [] };
    const groups = groupFindings(BACKLOG, { projectKey: 'p' });
    for (const g of groups) {
      plan = recordIssueKey(plan, g, `SONAR-${g.fingerprint}`);
      plan = recordBranch(plan, g, `sonar/${g.fingerprint}`);
      plan = recordPR(plan, g, 1);
    }
    const r = nextBatch(BACKLOG, plan, { projectKey: 'p', maxConcurrent: 2 });
    expect(r.inFlight).toBe(5);
    expect(r.capacity).toBe(0);
    expect(r.selected).toHaveLength(0);
  });
});
