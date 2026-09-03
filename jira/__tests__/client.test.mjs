import { describe, it, expect } from 'vitest';
import {
  API, request, createIssue, searchJql, getIssue, addComment, updateLabels, isOpen,
  configFromEnv, JiraUnavailable, TRANSIENT, PERSISTENT
} from '../client.mjs';

const CONFIG = {
  baseUrl: 'https://example.atlassian.net', projectKey: 'SONAR',
  email: 'a@b.c', token: 't'
};

const ok = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => JSON.stringify(body),
  json: async () => body
});
const err = (status, body = 'no') => ({
  ok: false, status, text: async () => body, json: async () => ({})
});

/** Records every call so a test can assert the URL as well as the answer. */
function recorder(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    const next = queue.shift();
    if (typeof next === 'function') return next();
    return next;
  };
  return { calls, fetchImpl };
}

const fast = (over = {}) => ({ maxRetries: 0, backoffMs: 0, sleep: async () => {}, ...over });

describe('the API version is a decision, not an accident', () => {
  it('speaks v2, because v3 would force ADF through renderBody()', async () => {
    expect(API).toBe('2');
    const { calls, fetchImpl } = recorder([ok({ key: 'SONAR-1', id: '1' })]);
    await createIssue(CONFIG, { summary: 's', description: 'plain', labels: [] },
      fast({ fetchImpl }));
    expect(calls[0].url).toContain('/rest/api/2/');
    expect(calls[0].url).not.toContain('/rest/api/3/');
  });

  it('sends the description as a plain string, which is the whole point of v2', async () => {
    const { calls, fetchImpl } = recorder([ok({ key: 'SONAR-1', id: '1' })]);
    await createIssue(CONFIG, { summary: 's', description: 'line one\nline two', labels: ['x'] },
      fast({ fetchImpl }));
    expect(typeof calls[0].body.fields.description).toBe('string');
  });
});

describe('the search endpoint that no longer exists', () => {
  it('calls /search/jql, never the removed /search', async () => {
    const { calls, fetchImpl } = recorder([ok({ issues: [] })]);
    await searchJql(CONFIG, 'project = SONAR', ['key'], fast({ fetchImpl }));
    expect(calls[0].url).toContain('/rest/api/2/search/jql');
  });

  it('names the cause when Jira answers 410, instead of leaving a bare status', async () => {
    const { fetchImpl } = recorder([err(410, 'Gone')]);
    await expect(searchJql(CONFIG, 'x', ['key'], fast({ fetchImpl })))
      .rejects.toThrow(/search endpoint was removed/);
  });

  it('follows nextPageToken and stops when it is absent', async () => {
    const { calls, fetchImpl } = recorder([
      ok({ issues: [{ key: 'A' }], nextPageToken: 'p2' }),
      ok({ issues: [{ key: 'B' }] })
    ]);
    const out = await searchJql(CONFIG, 'x', ['key'], fast({ fetchImpl }));
    expect(out.map((i) => i.key)).toEqual(['A', 'B']);
    expect(calls[1].body.nextPageToken).toBe('p2');
  });

  it('cannot spin forever on a server that always returns a token', async () => {
    let n = 0;
    const fetchImpl = async () => { n++; return ok({ issues: [{ key: `K${n}` }], nextPageToken: 'always' }); };
    const out = await searchJql(CONFIG, 'x', ['key'], fast({ fetchImpl, maxPages: 3 }));
    expect(n).toBe(3);
    expect(out).toHaveLength(3);
  });

  it('asks for fields explicitly, because omitting them returns a minimal issue', async () => {
    const { calls, fetchImpl } = recorder([ok({ issues: [] })]);
    await searchJql(CONFIG, 'x', ['key', 'status'], fast({ fetchImpl }));
    expect(calls[0].body.fields).toEqual(['key', 'status']);
  });
});

describe('it cannot hang, and it retries only what retrying can fix', () => {
  it('gives up on a deadline rather than waiting forever', async () => {
    const fetchImpl = () => new Promise(() => {});   // never resolves
    await expect(request(CONFIG, 'GET', '/x', undefined,
      fast({ fetchImpl, timeoutMs: 5 }))).rejects.toMatchObject({ classification: TRANSIENT });
  });

  it('does not retry a 401, because a bad token is bad next time too', async () => {
    let n = 0;
    const fetchImpl = async () => { n++; return err(401); };
    await expect(request(CONFIG, 'GET', '/x', undefined,
      { fetchImpl, maxRetries: 3, backoffMs: 0, sleep: async () => {} }))
      .rejects.toMatchObject({ classification: PERSISTENT });
    expect(n).toBe(1);
  });

  it('does retry a 500, up to the cap and no further', async () => {
    let n = 0;
    const fetchImpl = async () => { n++; return err(500); };
    await expect(request(CONFIG, 'GET', '/x', undefined,
      { fetchImpl, maxRetries: 2, backoffMs: 0, sleep: async () => {} }))
      .rejects.toBeInstanceOf(JiraUnavailable);
    expect(n).toBe(3);
  });

  it('treats an unreachable host as transient, not as a bug in the caller', async () => {
    const fetchImpl = async () => { throw new Error('ENOTFOUND'); };
    await expect(request(CONFIG, 'GET', '/x', undefined, fast({ fetchImpl })))
      .rejects.toMatchObject({ classification: TRANSIENT });
  });
});

describe('answers that are not JSON', () => {
  it('accepts a 204 with no body instead of reporting the write as failed', async () => {
    const fetchImpl = async () => ({ ok: true, status: 204, text: async () => '' });
    await expect(addComment(CONFIG, 'SONAR-1', 'hi', fast({ fetchImpl })))
      .resolves.toEqual({});
  });

  it('reports an HTML error page as persistent rather than retrying it three times', async () => {
    let n = 0;
    const fetchImpl = async () => { n++; return { ok: true, status: 200, text: async () => '<html>' }; };
    await expect(request(CONFIG, 'GET', '/x', undefined,
      { fetchImpl, maxRetries: 2, backoffMs: 0, sleep: async () => {} }))
      .rejects.toMatchObject({ classification: PERSISTENT });
    expect(n).toBe(1);
  });
});

describe('a key the plan remembers may simply be gone', () => {
  it('returns null on 404 rather than throwing, because absence is an answer', async () => {
    const { fetchImpl } = recorder([err(404)]);
    await expect(getIssue(CONFIG, 'SONAR-9', ['key'], fast({ fetchImpl }))).resolves.toBeNull();
  });

  it('returns null on 403 too — invisible and deleted are the same to dedupe', async () => {
    const { fetchImpl } = recorder([err(403)]);
    await expect(getIssue(CONFIG, 'SONAR-9', ['key'], fast({ fetchImpl }))).resolves.toBeNull();
  });

  it('still throws on a 500, which is an outage and not an answer', async () => {
    const { fetchImpl } = recorder([err(500), err(500), err(500)]);
    await expect(getIssue(CONFIG, 'SONAR-9', ['key'], fast({ fetchImpl })))
      .rejects.toBeInstanceOf(JiraUnavailable);
  });
});

describe('"is it finished" has to be asked in a way that ports', () => {
  it('reads statusCategory, not the status name, which differs per site', () => {
    expect(isOpen({ fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } })).toBe(false);
    expect(isOpen({ fields: { status: { name: 'In Review', statusCategory: { key: 'indeterminate' } } } })).toBe(true);
    // A site whose "finished" status is called something else entirely still
    // answers correctly, which a name match would not.
    expect(isOpen({ fields: { status: { name: 'Shipped', statusCategory: { key: 'done' } } } })).toBe(false);
  });

  it('assumes open on an unrecognised shape, so an oddity dedupes rather than duplicates', () => {
    expect(isOpen({})).toBe(true);
    expect(isOpen(null)).toBe(true);
  });
});

describe('changing a subset of labels without clobbering the rest', () => {
  it('sends add/remove ops, not a replacement array', async () => {
    const { calls, fetchImpl } = recorder([ok({}, 204)]);
    await updateLabels(CONFIG, 'SONAR-1', { add: ['ready'], remove: ['needs-work'] }, fast({ fetchImpl }));
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].url).toContain('/issue/SONAR-1');
    expect(calls[0].body).toEqual({ update: { labels: [{ add: 'ready' }, { remove: 'needs-work' }] } });
  });

  it('skips the request entirely when there is nothing to add or remove', async () => {
    const { calls, fetchImpl } = recorder([]);
    await updateLabels(CONFIG, 'SONAR-1', {}, fast({ fetchImpl }));
    expect(calls).toHaveLength(0);
  });
});

describe('configuration', () => {
  it('names every missing variable rather than just failing', () => {
    const c = configFromEnv({ JIRA_BASE_URL: 'https://x/' });
    expect(c.configured).toBe(false);
    expect(c.missing).toEqual(['JIRA_PROJECT_KEY', 'JIRA_USER_EMAIL', 'JIRA_API_TOKEN']);
    expect(c.baseUrl).toBe('https://x');
  });
});
