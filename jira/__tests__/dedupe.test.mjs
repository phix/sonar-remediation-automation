import { describe, it, expect } from 'vitest';
import { resolveExisting, jqlFor } from '../dedupe.mjs';
import { groupFindings } from '../group.mjs';

const CONFIG = { baseUrl: 'https://x.atlassian.net', projectKey: 'SONAR', email: 'a', token: 't' };
const [GROUP] = groupFindings(
  [{ rule: 'typescript:S3358', file: 'web/src/a.ts', line: 4, severity: 'MAJOR' }],
  { projectKey: 'phix_p' }
);

const done = { key: 'SONAR-1', fields: { status: { statusCategory: { key: 'done' } } } };
const open = { key: 'SONAR-1', fields: { status: { statusCategory: { key: 'indeterminate' } } } };

/** Route by URL so a test can prove which source answered — and which never ran. */
function router({ issue, search = [] }) {
  const calls = { get: 0, search: 0 };
  const fetchImpl = async (url) => {
    if (url.includes('/search/jql')) {
      calls.search++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ issues: search }) };
    }
    calls.get++;
    if (issue === null) return { ok: false, status: 404, text: async () => 'gone' };
    return { ok: true, status: 200, text: async () => JSON.stringify(issue) };
  };
  return { calls, options: { fetchImpl, maxRetries: 0, backoffMs: 0, sleep: async () => {} } };
}

describe('the plan answers first, and its answer is immune to the index lag', () => {
  it('never touches the lagging search when the plan holds an open ticket', async () => {
    const { calls, options } = router({ issue: open });
    const out = await resolveExisting(GROUP, {
      config: CONFIG, index: new Map([[GROUP.fingerprint, 'SONAR-1']]), options
    });
    expect(out).toMatchObject({ key: 'SONAR-1', source: 'plan' });
    // This is the assertion that matters: a second run inside Jira's ~2s
    // index window is answered entirely without asking the index.
    expect(calls.search).toBe(0);
    expect(calls.get).toBe(1);
  });
});

describe('the trap: trusting the plan alone turns dedupe into amnesia', () => {
  it('does NOT dedupe against a ticket the plan remembers but Jira has closed', async () => {
    const { calls, options } = router({ issue: done, search: [] });
    const out = await resolveExisting(GROUP, {
      config: CONFIG, index: new Map([[GROUP.fingerprint, 'SONAR-1']]), options
    });
    // A recurrence of a fixed-and-closed smell is new work and deserves a new
    // ticket. Returning SONAR-1 here would suppress it permanently, and would
    // look like the scanner having stopped reporting it.
    expect(out.key).toBeNull();
    expect(out.note).toMatch(/closed/);
    expect(calls.search).toBe(1);
  });

  it('falls through to search when the plan points at an issue Jira no longer returns', async () => {
    const { calls, options } = router({ issue: null, search: [open] });
    const out = await resolveExisting(GROUP, {
      config: CONFIG, index: new Map([[GROUP.fingerprint, 'SONAR-9']]), options
    });
    expect(out).toMatchObject({ key: 'SONAR-1', source: 'jql' });
    expect(calls.search).toBe(1);
    expect(out.note).toMatch(/no longer returns/);
  });
});

describe('search is the backstop for groups the plan has never seen', () => {
  it('finds an open ticket by label', async () => {
    const { calls, options } = router({ search: [open] });
    const out = await resolveExisting(GROUP, { config: CONFIG, index: new Map(), options });
    expect(out).toMatchObject({ key: 'SONAR-1', source: 'jql' });
    expect(calls.get).toBe(0);
  });

  it('reports no match rather than an empty string, so the caller must decide', async () => {
    const { options } = router({ search: [] });
    const out = await resolveExisting(GROUP, { config: CONFIG, index: new Map(), options });
    expect(out.key).toBeNull();
    expect(out.source).toBeNull();
  });

  it('ignores a closed ticket the search happens to return', async () => {
    const { options } = router({ search: [done] });
    const out = await resolveExisting(GROUP, { config: CONFIG, index: new Map(), options });
    expect(out.key).toBeNull();
  });
});

describe('the JQL', () => {
  it('matches the fingerprint label exactly and excludes finished work', () => {
    const jql = jqlFor(GROUP, 'SONAR');
    expect(jql).toContain(`labels = "${GROUP.fingerprint}"`);
    expect(jql).toContain('statusCategory != Done');
    expect(jql).toContain('project = SONAR');
  });
});
