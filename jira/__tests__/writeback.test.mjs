import { describe, it, expect } from 'vitest';
import {
  writeBackOne, writeBackGroup, commentText, WRITTEN, FORBIDDEN, NO_KEY, FAILED
} from '../writeback.mjs';
import { groupFindings } from '../group.mjs';

const TICKET = { key: 'SONAR-12', url: 'https://x.atlassian.net/browse/SONAR-12' };
const F = (over = {}) => ({
  key: 'AaBUHTIMZAs_M-b0fH6Z', rule: 'javascript:S3776',
  file: 'api/src/a.js', line: 3, severity: 'MAJOR', ...over
});

const responder = (fn) => {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body?.toString() });
      return fn(calls.length);
    }
  };
};
const ok = { ok: true, status: 200, text: async () => '{}' };
const status = (s) => ({ ok: false, status: s, text: async () => 'no' });

describe('a finding with no address cannot be written back to', () => {
  it('says so, instead of reporting a silent success', async () => {
    const out = await writeBackOne(F({ key: undefined }), TICKET, { token: 't' });
    expect(out.outcome).toBe(NO_KEY);
    expect(out.reason).toMatch(/no Sonar issue key/);
  });

  it('is the state findings normalised before #17 are actually in', async () => {
    // fetch-findings.mjs dropped `key` until this ticket needed it. A fixture
    // captured before that change has none, and this is what happens then.
    const legacy = { rule: 'javascript:S1128', file: 'api/src/app.js', line: 2,
      hash: '93c255e458941acfe703078ccb676090' };
    const out = await writeBackOne(legacy, TICKET, { token: 't' });
    expect(out.outcome).toBe(NO_KEY);
  });
});

describe('whether this token may comment was genuinely unknown', () => {
  it('reports a 403 as a permission answer, not as an outage', async () => {
    const { fetchImpl } = responder(() => status(403));
    const out = await writeBackOne(F(), TICKET, { token: 't', fetchImpl });
    expect(out.outcome).toBe(FORBIDDEN);
    expect(out.reason).toMatch(/not permitted to comment/);
    expect(out.reason).toMatch(/ticket was still created/);
  });

  it('stops after the first forbidden answer instead of asking nine more times', async () => {
    const { calls, fetchImpl } = responder(() => status(403));
    const [g] = groupFindings([F({ key: 'k1' }), F({ key: 'k2', line: 9 }), F({ key: 'k3', line: 14 })],
      { projectKey: 'p' });
    const out = await writeBackGroup(g, TICKET, { token: 't', fetchImpl });
    expect(calls).toHaveLength(1);
    expect(out.permitted).toBe(false);
    expect(out.total).toBe(3);
    expect(out.attempted).toBe(1);
  });

  it('treats a missing token as forbidden without making a request at all', async () => {
    const { calls, fetchImpl } = responder(() => ok);
    const out = await writeBackOne(F(), TICKET, { fetchImpl });
    expect(out.outcome).toBe(FORBIDDEN);
    expect(calls).toHaveLength(0);
  });
});

describe('when it is permitted', () => {
  it('names the ticket on every finding in the group, not just one', async () => {
    const { calls, fetchImpl } = responder(() => ok);
    const [g] = groupFindings([F({ key: 'k1' }), F({ key: 'k2', line: 9 })], { projectKey: 'p' });
    const out = await writeBackGroup(g, TICKET, { token: 't', fetchImpl });
    expect(out.written).toBe(2);
    expect(out.permitted).toBe(true);
    expect(calls.map((c) => new URLSearchParams(c.body).get('issue'))).toEqual(['k1', 'k2']);
  });

  it('sends form encoding to add_comment, which is what that endpoint takes', async () => {
    const { calls, fetchImpl } = responder(() => ok);
    await writeBackOne(F(), TICKET, { token: 't', fetchImpl });
    expect(calls[0].url).toContain('/api/issues/add_comment');
    const p = new URLSearchParams(calls[0].body);
    expect(p.get('issue')).toBe(F().key);
    expect(p.get('text')).toContain('SONAR-12');
  });

  it('puts the browse URL in the comment, so the link is one click', () => {
    expect(commentText('SONAR-12', TICKET.url)).toContain(TICKET.url);
    expect(commentText('SONAR-12', null)).toContain('SONAR-12');
  });
});

describe('this step must never take the ticket run down with it', () => {
  it('reports a thrown network error rather than propagating it', async () => {
    const fetchImpl = async () => { throw new Error('ECONNRESET'); };
    const out = await writeBackOne(F(), TICKET, { token: 't', fetchImpl });
    expect(out.outcome).toBe(FAILED);
    expect(out.reason).toMatch(/ECONNRESET/);
  });

  it('reports a 500 as failed but keeps going through the group', async () => {
    const { calls, fetchImpl } = responder((n) => (n === 1 ? status(500) : ok));
    const [g] = groupFindings([F({ key: 'k1' }), F({ key: 'k2', line: 9 })], { projectKey: 'p' });
    const out = await writeBackGroup(g, TICKET, { token: 't', fetchImpl });
    expect(calls).toHaveLength(2);
    expect(out.written).toBe(1);
    expect(out.permitted).toBe(true);
  });
});
