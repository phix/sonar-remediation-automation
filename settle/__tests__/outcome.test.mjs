import { describe, it, expect } from 'vitest';
import {
  decideOutcomes, looksLikeIssueKey, outcomeComment, recordOutcomeOne, recordOutcomes,
  renderOutcomeReport, REMEDIATED, NOT_REMEDIATED, REMEDIATED_TAG, NOT_REMEDIATED_TAG
} from '../outcome.mjs';
import { groupFindings } from '../../jira/group.mjs';

const KEY = 'AY8xAbCdEfGhIjKlMnOp';
const HASH = '93c255e458941acfe703078ccb676090';
const F = (over = {}) => ({
  key: KEY, rule: 'javascript:S1481', file: 'api/src/a.js', line: 3,
  severity: 'MAJOR', ...over
});

const changed = (over = {}) => ({
  results: [{ rule: 'javascript:S1481', file: 'api/src/a.js', line: 3, changed: true, alreadyGone: false }],
  refused: [], needsAgent: [], ...over
});

describe('an id is only addressable if it is actually an issue key', () => {
  it('accepts a Sonar key and rejects a content hash', () => {
    // finding_ids is `f.key || f.hash || '<fingerprint>-<i>'` — a deliberate
    // mixed bag, so this filter is what stops a hash being POSTed as a key.
    expect(looksLikeIssueKey(KEY)).toBe(true);
    expect(looksLikeIssueKey(HASH)).toBe(false);
    expect(looksLikeIssueKey('gf-1a2b3c-0')).toBe(false);
    expect(looksLikeIssueKey('short')).toBe(false);
    expect(looksLikeIssueKey(undefined)).toBe(false);
  });
});

describe('remediated requires BOTH a change and the finding being gone', () => {
  it('is remediated when the pass changed the file and Sonar stopped reporting it', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    const outcomes = decideOutcomes({
      findings: [], // gone from the fresh scan
      plan: { items: [{
        group_fingerprint: g.fingerprint, rule_key: g.rule, module_prefix: g.module,
        severity: g.severity, pr_number: 7, jira_issue_key: 'SONAR-9',
        finding_ids: [KEY, HASH]
      }] },
      dispositions: changed(),
      pr: 7
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].state).toBe(REMEDIATED);
    expect(outcomes[0].ticketKey).toBe('SONAR-9');
    // The hash in finding_ids is skipped, not addressed to.
    expect(outcomes[0].keys).toEqual([KEY]);
  });

  it('is NOT remediated while Sonar still reports it, change or no change', () => {
    const [g] = groupFindings([F()], { projectKey: 'p' });
    const outcomes = decideOutcomes({
      findings: [F()],
      plan: { items: [{ group_fingerprint: g.fingerprint, rule_key: g.rule,
        module_prefix: g.module, severity: g.severity, pr_number: 7, finding_ids: [KEY] }] },
      dispositions: changed(),
      pr: 7
    });

    expect(outcomes[0].state).toBe(NOT_REMEDIATED);
    expect(outcomes[0].reason).toMatch(/still reports/);
    expect(outcomes[0].keys).toEqual([KEY]);
  });

  it('refuses to credit an absence it cannot attribute to this pass', () => {
    // The live false positive: a PR-scoped fetch omits a file the PR never
    // touched for the same reason it omits a fixed one. Absence alone is not
    // proof, so this must not read as success.
    const [g] = groupFindings([F()], { projectKey: 'p' });
    const outcomes = decideOutcomes({
      findings: [],
      plan: { items: [{ group_fingerprint: g.fingerprint, rule_key: g.rule,
        module_prefix: g.module, severity: g.severity, pr_number: 7, finding_ids: [KEY] }] },
      dispositions: { results: [], refused: [], needsAgent: [] },
      pr: 7
    });

    expect(outcomes[0].state).toBe(NOT_REMEDIATED);
    expect(outcomes[0].reason).toMatch(/cannot be attributed/);
  });

  it('is NOT remediated when there are no dispositions at all', () => {
    const outcomes = decideOutcomes({
      findings: [],
      plan: { items: [{ group_fingerprint: 'gf-x', rule_key: 'r', module_prefix: 'api',
        severity: 'MAJOR', pr_number: 7, finding_ids: [KEY] }] },
      dispositions: null,
      pr: 7
    });
    expect(outcomes[0].state).toBe(NOT_REMEDIATED);
  });

  it('does not credit a change in a different module that happens to share the rule', () => {
    const [g] = groupFindings([F({ file: 'web/src/a.ts' })], { projectKey: 'p' });
    const outcomes = decideOutcomes({
      findings: [],
      plan: { items: [{ group_fingerprint: g.fingerprint, rule_key: 'javascript:S1481',
        module_prefix: 'web', severity: 'MAJOR', pr_number: 7, finding_ids: [KEY] }] },
      dispositions: changed(), // api/src/a.js
      pr: 7
    });
    expect(outcomes[0].state).toBe(NOT_REMEDIATED);
  });
});

describe('a fixed finding is still addressable without a plan', () => {
  it('takes the keys from what remediation ran against', () => {
    // The demo PR's groups are in no plan — nothing ticketed them — so the
    // pre-remediation fetch is the only surviving record of their issue keys
    // once the fix removes them from the current scan.
    const outcomes = decideOutcomes({
      findings: [],
      before: [F()],
      plan: null,
      dispositions: changed()
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].state).toBe(REMEDIATED);
    expect(outcomes[0].keys).toEqual([KEY]);
  });

  it('uses the live key, not the stale pre-remediation one, while the finding is present', () => {
    // Both keys address the same defect before and after a partial edit, but
    // only the live one is the issue Sonar is reporting right now — annotating
    // the old key would tag an issue the reader is not looking at.
    const outcomes = decideOutcomes({
      findings: [F({ key: 'AY8xLiveKeyHere00000' })],
      before: [F({ key: KEY })],
      dispositions: changed()
    });
    expect(outcomes[0].keys).toEqual(['AY8xLiveKeyHere00000']);
  });
});

describe('the outcome is scoped to this PR', () => {
  it('ignores plan items belonging to another pull request', () => {
    const outcomes = decideOutcomes({
      findings: [],
      plan: { items: [
        { group_fingerprint: 'gf-a', rule_key: 'r', module_prefix: 'api', severity: 'MAJOR',
          pr_number: 8, finding_ids: [KEY] },
        { group_fingerprint: 'gf-b', rule_key: 'r', module_prefix: 'api', severity: 'MAJOR',
          pr_number: 7, finding_ids: [KEY] }
      ] },
      dispositions: null,
      pr: 7
    });
    expect(outcomes.map((o) => o.fingerprint)).toEqual(['gf-b']);
  });

  it('still reports a group the fresh scan sees, PR scope or not', () => {
    const outcomes = decideOutcomes({ findings: [F()], plan: null, dispositions: null, pr: 7 });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].state).toBe(NOT_REMEDIATED);
  });
});

describe('the comment says which it was, and never muddles the two', () => {
  it('states success plainly', () => {
    const text = outcomeComment({ ticketKey: 'SONAR-9', state: REMEDIATED, reason: 'gone' });
    expect(text).toContain('**Remediated successfully.**');
    expect(text).toContain('SONAR-9');
  });

  it('states failure, and says when no ticket existed', () => {
    const text = outcomeComment({ ticketKey: null, state: NOT_REMEDIATED, reason: 'still there' });
    expect(text).toContain('**Not remediated.**');
    expect(text).toMatch(/No Jira ticket was filed/);
  });
});

describe('writing it onto the finding', () => {
  function responder({ commentStatus = 200, tags = ['existing-tag'], tagsStatus = 200 } = {}) {
    const calls = [];
    return {
      calls,
      fetchImpl: async (url, init = {}) => {
        const method = init.method || 'GET';
        calls.push({ url, method, body: init.body?.toString(), auth: init.headers?.authorization });
        if (url.includes('add_comment')) {
          return commentStatus === 200
            ? { ok: true, status: 200, text: async () => '{}' }
            : { ok: false, status: commentStatus, text: async () => 'nope' };
        }
        if (url.includes('set_tags')) {
          return tagsStatus === 200
            ? { ok: true, status: 200, text: async () => '{}' }
            : { ok: false, status: tagsStatus, text: async () => 'nope' };
        }
        return { ok: true, status: 200, json: async () => ({ issues: [{ key: KEY, tags }] }) };
      }
    };
  }

  /** set_tags takes a comma-joined string; compare tags, not a substring of one. */
  const sentTags = (calls) => new URLSearchParams(
    calls.find((c) => c.url.includes('set_tags')).body
  ).get('tags').split(',');

  it('comments the outcome and tags the issue as remediated', async () => {
    const { calls, fetchImpl } = responder();
    const out = await recordOutcomeOne(KEY, { ticketKey: 'SONAR-9', state: REMEDIATED, reason: 'gone' },
      { token: 't', fetchImpl });

    expect(out.outcome).toBe('written');
    expect(out.tag).toBe(REMEDIATED_TAG);
    const comment = calls.find((c) => c.url.includes('add_comment'));
    expect(new URLSearchParams(comment.body).get('text')).toContain('Remediated successfully');
    const tags = sentTags(calls);
    expect(tags).toContain(REMEDIATED_TAG);
    // Somebody else's tag survives, and the opposite state is cleared.
    expect(tags).toContain('existing-tag');
    expect(tags).not.toContain(NOT_REMEDIATED_TAG);
  });

  it('flips an earlier success to not-remediated on a later run', async () => {
    const { calls, fetchImpl } = responder({ tags: [REMEDIATED_TAG, 'mine'] });
    await recordOutcomeOne(KEY, { ticketKey: 'SONAR-9', state: NOT_REMEDIATED, reason: 'back' },
      { token: 't', fetchImpl });
    const sent = sentTags(calls);
    expect(sent).toContain(NOT_REMEDIATED_TAG);
    expect(sent).not.toContain(REMEDIATED_TAG);
    expect(sent).toContain('mine');
  });

  it('sends basic auth, which is what the Sonar API takes', async () => {
    const { calls, fetchImpl } = responder();
    await recordOutcomeOne(KEY, { state: REMEDIATED, reason: 'gone' }, { token: 'sekret', fetchImpl });
    expect(calls[0].auth).toBe(`Basic ${Buffer.from('sekret:').toString('base64')}`);
  });

  it('reports a permission answer as forbidden, so the run stops asking', async () => {
    const { fetchImpl } = responder({ commentStatus: 403 });
    const out = await recordOutcomeOne(KEY, { state: REMEDIATED, reason: 'gone' }, { token: 't', fetchImpl });
    expect(out.outcome).toBe('forbidden');
    expect(out.step).toBe('comment');
    expect(out.reason).toMatch(/may not write to issues/);
  });

  it('treats a missing token as forbidden without making a request', async () => {
    const { calls, fetchImpl } = responder();
    const out = await recordOutcomeOne(KEY, { state: REMEDIATED }, { fetchImpl });
    expect(out.outcome).toBe('forbidden');
    expect(calls).toHaveLength(0);
  });

  it('survives a thrown network error', async () => {
    const out = await recordOutcomeOne(KEY, { state: REMEDIATED }, {
      token: 't', fetchImpl: async () => { throw new Error('ECONNRESET'); }
    });
    expect(out.outcome).toBe('failed');
    expect(out.reason).toMatch(/ECONNRESET/);
  });

  // The call that was wrong once. Measured 2026-09-25 against
  // GET /api/webservices/list?q=issues: additionalFields accepts only
  // [_all, comments, languages, actionPlans, rules, ruleDescriptionContextKey,
  // transitions, actions, users]. "tags" is a 400, not a silently-ignored
  // parameter — and because the comment is posted FIRST, that failure surfaced
  // only as a missing tag, which reads like success from the outside. Tags come
  // back by default, so asking for them is the bug.
  it('does not send additionalFields to read tags, which Sonar answers with a 400', async () => {
    const { calls, fetchImpl } = responder();
    await recordOutcomeOne(KEY, { state: REMEDIATED, reason: 'gone' }, { token: 't', fetchImpl });

    const lookup = calls.find((c) => c.url.includes('/api/issues/search'));
    expect(lookup).toBeDefined();
    expect(lookup.url).not.toContain('additionalFields');
  });

  it('bails without clobbering tags it could not read', async () => {
    // set_tags REPLACES the whole list, so writing before a successful read
    // would delete somebody else's tags — this failure has to be safe rather
    // than best-effort.
    const calls = [];
    const out = await recordOutcomeOne(KEY, { state: REMEDIATED }, {
      token: 't',
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.includes('add_comment')) return { ok: true, status: 200, text: async () => '{}' };
        return { ok: false, status: 400, text: async () => 'bad param' };
      }
    });

    expect(out.outcome).toBe('failed');
    expect(out.step).toBe('read_tags');
    expect(calls.some((u) => u.includes('set_tags'))).toBe(false);
  });
});

describe('recording a group', () => {
  it('says so per group instead of silently doing nothing', async () => {
    const summary = await recordOutcomes([
      { fingerprint: 'gf-a', state: NOT_REMEDIATED, keys: [], reason: 'gone, unattributed' }
    ], { token: 't' });
    expect(summary.results[0].attempted).toBe(0);
    expect(summary.results[0].reason).toMatch(/no addressable Sonar issue key/);
  });

  it('stops after the first forbidden answer instead of asking once per finding', async () => {
    let n = 0;
    const summary = await recordOutcomes([
      { fingerprint: 'gf-a', state: REMEDIATED, keys: [KEY, 'AY8xSecondKeyHere00'] }
    ], {
      token: 't',
      fetchImpl: async () => { n += 1; return { ok: false, status: 403, text: async () => 'no' }; }
    });
    expect(n).toBe(1);
    expect(summary.written).toBe(0);
  });

  it('renders every group into the report', () => {
    const md = renderOutcomeReport({
      results: [
        { fingerprint: 'gf-a', state: REMEDIATED, attempted: 1, written: 1, tags: REMEDIATED_TAG },
        { fingerprint: 'gf-b', state: NOT_REMEDIATED, attempted: 0, written: 0, reason: 'no key' }
      ]
    });
    expect(md).toContain('`gf-a` — **remediated**');
    expect(md).toContain('`gf-b` — **not remediated**');
  });
});
