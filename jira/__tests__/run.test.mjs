import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJira, renderJiraReport, dispositionsFrom } from '../run.mjs';
import { readPlan, planIndex, recordIssueKey, writePlan } from '../plan.mjs';
import { groupFindings } from '../group.mjs';

const CONFIGURED = {
  baseUrl: 'https://x.atlassian.net', projectKey: 'SONAR',
  email: 'a@b.c', token: 't', configured: true, missing: []
};

const FINDINGS = [
  { key: 'S1', rule: 'javascript:S3776', file: 'api/src/a.js', line: 3, severity: 'CRITICAL', message: 'complex' },
  { key: 'S2', rule: 'javascript:S3776', file: 'api/src/b.js', line: 9, severity: 'CRITICAL', message: 'complex' },
  { key: 'S3', rule: 'typescript:S3358', file: 'web/src/c.ts', line: 4, severity: 'MAJOR', message: 'ternary' }
];

/**
 * One fake for three hosts. Every handler may assert, and an assertion that
 * fires inside a request is what proves ORDER — which is the only way to test
 * the crash window between creating a ticket and remembering it.
 */
function world({ existingByLabel = {}, issues = {}, onSonarComment, sonarStatus = 200 } = {}) {
  const calls = { create: [], search: [], get: [], comment: [], sonar: [], rules: [] };
  let n = 0;
  const fetchImpl = async (url, init) => {
    const body = init?.body;
    if (url.includes('/api/rules/show')) {
      calls.rules.push(url);
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({ rule: {} }) };
    }
    if (url.includes('/api/issues/add_comment')) {
      calls.sonar.push(body?.toString());
      onSonarComment?.();
      return { ok: sonarStatus === 200, status: sonarStatus, text: async () => '{}' };
    }
    if (url.includes('/search/jql')) {
      const jql = JSON.parse(body).jql;
      calls.search.push(jql);
      const label = jql.match(/labels = "([^"]+)"/)?.[1];
      return { ok: true, status: 200,
        text: async () => JSON.stringify({ issues: existingByLabel[label] || [] }) };
    }
    if (url.includes('/issue/') && url.includes('/comment')) {
      calls.comment.push(url);
      return { ok: true, status: 204, text: async () => '' };
    }
    if (init?.method === 'GET' || !init?.method) {
      const key = decodeURIComponent(url.split('/issue/')[1].split('?')[0]);
      calls.get.push(key);
      if (!issues[key]) return { ok: false, status: 404, text: async () => 'gone' };
      return { ok: true, status: 200, text: async () => JSON.stringify(issues[key]) };
    }
    calls.create.push(JSON.parse(body));
    n += 1;
    return { ok: true, status: 201, text: async () => JSON.stringify({ key: `SONAR-${n}`, id: `${n}` }) };
  };
  return { calls, options: { fetchImpl, maxRetries: 0, backoffMs: 0, sleep: async () => {} } };
}

const open = (key) => ({ key, fields: { status: { statusCategory: { key: 'indeterminate' } } } });

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jira-run-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('optional means optional', () => {
  it('does nothing at all when ticketing is off, which is the default', async () => {
    const { calls, options } = world();
    const run = await runJira(FINDINGS, { config: CONFIGURED, options });
    expect(run.ran).toBe(false);
    expect(run.disabled).toBe(true);
    expect(calls.create).toHaveLength(0);
    expect(calls.search).toHaveLength(0);
    expect(renderJiraReport(run)).toMatch(/Remediation does not wait/);
  });

  it('is RED, not skipped, when somebody asked for tickets and it is unconfigured', async () => {
    const run = await runJira(FINDINGS, {
      enabled: true,
      config: { configured: false, missing: ['JIRA_API_TOKEN'] }
    });
    expect(run.ran).toBe(false);
    // The distinction that matters: nobody asked (silent) vs asked and did not
    // get it (loud). Reporting the second as a skip is how a pipeline claims
    // success for work it never did.
    expect(run.disabled).toBe(false);
    expect(run.reason).toMatch(/JIRA_API_TOKEN/);
    expect(renderJiraReport(run)).toMatch(/Requested but did not run/);
  });
});

describe('one ticket per group', () => {
  it('creates a ticket per group, not per finding', async () => {
    const { calls, options } = world();
    const run = await runJira(FINDINGS, { enabled: true, config: CONFIGURED, options });
    expect(run.groups).toBe(2);          // S3776/api/CRITICAL and S3358/web/MAJOR
    expect(run.created).toBe(2);
    expect(calls.create).toHaveLength(2);
  });

  it('labels every ticket with the project key and the fingerprint', async () => {
    const { calls, options } = world();
    await runJira(FINDINGS, {
      enabled: true, config: CONFIGURED, options, sonar: { projectKey: 'phix_sonar-sandbox-app' }
    });
    for (const c of calls.create) {
      expect(c.fields.labels).toContain('phix_sonar-sandbox-app');
      expect(c.fields.labels.some((l) => /^gf-[0-9a-f]{12}$/.test(l))).toBe(true);
    }
  });
});

describe('the crash window between creating a ticket and remembering it', () => {
  it('has the plan on disk BEFORE the next network call happens', async () => {
    const planPath = join(dir, 'plan.json');
    let planAtWriteBack = null;
    const { options } = world({
      onSonarComment: () => {
        // Runs mid-flight, after createIssue and before the run ends. If the
        // plan were written at the end, this would see nothing — and a crash
        // here would leave a ticket the next run cannot find, which is the
        // duplicate this whole ordering exists to prevent.
        planAtWriteBack = existsSync(planPath) ? readFileSync(planPath, 'utf8') : null;
      }
    });
    await runJira([FINDINGS[0]], {
      enabled: true, config: CONFIGURED, options, planPath, sonar: { token: 'st' }
    });
    expect(planAtWriteBack).toBeTruthy();
    expect(planAtWriteBack).toMatch(/SONAR-1/);
  });

  it('writes a plan item that satisfies every required field of the schema', async () => {
    const planPath = join(dir, 'plan.json');
    await runJira([FINDINGS[0]], {
      enabled: true, config: CONFIGURED, planPath, options: world().options
    });
    const item = JSON.parse(readFileSync(planPath, 'utf8')).items[0];
    for (const k of ['group_id', 'group_fingerprint', 'rule_key', 'severity', 'module_prefix',
      'finding_ids', 'finding_count', 'eligibility', 'status', 'attempt_count']) {
      expect(item, `missing ${k}`).toHaveProperty(k);
    }
    expect(item.status).toBe('Ticketed');
    expect(item.jira_issue_key).toBe('SONAR-1');
  });
});

describe('re-running creates no duplicates', () => {
  it('finds its own ticket through the plan, without asking the lagging index', async () => {
    const planPath = join(dir, 'plan.json');
    const [g] = groupFindings([FINDINGS[2]], { projectKey: 'p' });
    writePlan(planPath, recordIssueKey({ items: [] }, g, 'SONAR-7'));

    const { calls, options } = world({ issues: { 'SONAR-7': open('SONAR-7') } });
    const run = await runJira([FINDINGS[2]], {
      enabled: true, config: CONFIGURED, options, planPath, sonar: { projectKey: 'p' }
    });
    expect(run.created).toBe(0);
    expect(run.deduped).toBe(1);
    expect(calls.search).toHaveLength(0);
    expect(run.tickets[0].source).toBe('plan');
  });

  it('finds a ticket somebody else filed, through the label search', async () => {
    const [g] = groupFindings([FINDINGS[2]], { projectKey: 'p' });
    const { calls, options } = world({ existingByLabel: { [g.fingerprint]: [open('SONAR-99')] } });
    const run = await runJira([FINDINGS[2]], {
      enabled: true, config: CONFIGURED, options, sonar: { projectKey: 'p' }
    });
    expect(run.created).toBe(0);
    expect(run.tickets[0]).toMatchObject({ key: 'SONAR-99', source: 'jql' });
  });

  it('tells the existing ticket the group is still live, so no news is not silence', async () => {
    const [g] = groupFindings([FINDINGS[2]], { projectKey: 'p' });
    const { calls, options } = world({ existingByLabel: { [g.fingerprint]: [open('SONAR-99')] } });
    await runJira([FINDINGS[2]], {
      enabled: true, config: CONFIGURED, options, sonar: { projectKey: 'p' },
      ctx: { prUrl: 'https://github.com/x/y/pull/2' }
    });
    expect(calls.comment).toHaveLength(1);
    expect(calls.comment[0]).toContain('SONAR-99');
  });
});

describe('turning Jira on mid-flight, after remediation already ran', () => {
  it('does not error, and the ticket says what was already done', async () => {
    const { calls, options } = world();
    const remediation = {
      refused: [{ ...FINDINGS[0], policyReason: 'refused by location.' }],
      needsAgent: [FINDINGS[2]],
      results: []
    };
    const run = await runJira(FINDINGS, {
      enabled: true, config: CONFIGURED, options, remediation
    });
    expect(run.ran).toBe(true);
    expect(run.created).toBe(2);
    const bodies = calls.create.map((c) => c.fields.description).join('\n');
    expect(bodies).toMatch(/Refused by policy and NOT auto-fixed/);
    expect(bodies).toMatch(/No deterministic fixer exists/);
  });

  it('calls a finding cleared as a side effect resolved, as apply.mjs does', async () => {
    const { calls, options } = world();
    // summarize() in apply.mjs is explicit that resolved = fixed + alreadyGone.
    // A group where EVERY finding went that way must not produce a ticket that
    // is silent about the fix.
    const run = await runJira([FINDINGS[2]], {
      enabled: true, config: CONFIGURED, options,
      remediation: { refused: [], needsAgent: [], results: [{ ...FINDINGS[2], changed: false, alreadyGone: true }] }
    });
    expect(run.created).toBe(1);
    expect(calls.create[0].fields.description).toMatch(/Fixed automatically by a deterministic codemod/);
  });

  it('maps a finding to its disposition by rule, file and line together', () => {
    const m = dispositionsFrom({
      refused: [FINDINGS[0]], needsAgent: [FINDINGS[1]], results: []
    });
    // Same rule, same severity, different file: they must not collide.
    expect(m.get('javascript:S3776|api/src/a.js|3')).toMatchObject({ refusedByPolicy: true });
    expect(m.get('javascript:S3776|api/src/b.js|9')).toMatchObject({ awaitingAgent: true });
  });
});

describe('the write-back is reported, never silently absent', () => {
  it('says outright when the token was not permitted to comment', async () => {
    const { options } = world({ sonarStatus: 403 });
    const run = await runJira([FINDINGS[2]], {
      enabled: true, config: CONFIGURED, options, sonar: { token: 'st' }
    });
    expect(run.writeBack.permitted).toBe(false);
    expect(renderJiraReport(run)).toMatch(/back-link was not written/);
    expect(renderJiraReport(run)).toMatch(/tickets exist and name their findings/);
  });

  it('counts what it actually wrote when it was permitted', async () => {
    const { options } = world();
    const run = await runJira(FINDINGS, {
      enabled: true, config: CONFIGURED, options, sonar: { token: 'st' }
    });
    expect(run.writeBack.written).toBe(3);
    expect(renderJiraReport(run)).toMatch(/3\/3 Sonar finding/);
  });
});

describe('a dry run', () => {
  it('shows what it would file and touches nothing', async () => {
    const { calls, options } = world();
    const run = await runJira(FINDINGS, {
      enabled: true, config: CONFIGURED, options, dryRun: true
    });
    expect(calls.create).toHaveLength(0);
    expect(calls.sonar).toHaveLength(0);
    expect(run.tickets.every((t) => t.action === 'would-create')).toBe(true);
  });
});

describe('the plan file itself', () => {
  it('treats a missing plan as knowing nothing, not as an error', () => {
    expect(readPlan(join(dir, 'nope.json'))).toEqual({ items: [] });
    expect(planIndex({ items: [] }).size).toBe(0);
  });

  it('REFUSES a corrupt plan rather than treating it as empty', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{ this is not json');
    // Treating it as empty would recreate every ticket the plan was holding —
    // a corrupt file turning into a board full of duplicates.
    expect(() => readPlan(p)).toThrow(/duplicate every ticket/);
  });

  it('fills in a key on an item a richer producer already wrote', () => {
    const [g] = groupFindings([FINDINGS[2]], { projectKey: 'p' });
    const plan = { items: [{ group_fingerprint: g.fingerprint, rule_key: g.rule, status: 'Grouped' }] };
    recordIssueKey(plan, g, 'SONAR-5');
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ jira_issue_key: 'SONAR-5', status: 'Ticketed' });
  });
});
