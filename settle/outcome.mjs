/**
 * "Remediated successfully or not", recorded on the Sonar findings themselves.
 *
 * The Jira back-link (`jira/writeback.mjs`) answers "which ticket is this?".
 * This answers the other question a reader of Sonar actually has: did the
 * automation fix it? It writes both the outcome and the ticket onto every
 * finding in the group, because a reader is on whichever finding they opened.
 *
 * ## The rule that keeps it honest
 *
 * A group counts as remediated only when BOTH are true:
 *
 *   1. remediation actually changed a file in that group, AND
 *   2. Sonar's fresh scan no longer reports the group.
 *
 * Either one alone lies, and both lies were already found the hard way:
 *
 * - **Absence alone is not proof.** A PR-scoped Sonar fetch omits a file the PR
 *   never touched for exactly the same reason it omits a fixed one. This is a
 *   confirmed live false positive (2026-09-03, and
 *   `docs/decisions/pr-remediation-flow.md`): a freshly-opened, not-yet-
 *   remediated group-PR had its group read as resolved on the first PR-scoped
 *   check. That is why `jira/run.mjs` refuses to resolve from a PR-scoped
 *   fetch at all.
 * - **A change alone is not proof.** An edit that compiles, boots and passes
 *   every test can leave the smell exactly where it was.
 *
 * So the disposition supplies the "we touched it" half and the fresh scan
 * supplies the "it is gone" half, and a group that is absent without a change
 * is reported as `not_remediated` with a reason saying the absence cannot be
 * attributed — never as a success.
 *
 * ## Where the issue keys come from when the finding is gone
 *
 * For a group that IS still reported, the fresh fetch carries the keys. For one
 * that is gone, the only surviving record is `finding_ids` on the plan item.
 * Those are Sonar issue keys where the normaliser had one and content hashes
 * where it did not (`jira/plan.mjs`), so the hash-shaped entries are skipped
 * and counted rather than addressed to a key that was never an address.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { groupFindings } from '../jira/group.mjs';

const DEFAULT_HOST = 'https://sonarcloud.io';

export const REMEDIATED_TAG = 'remediated';
export const NOT_REMEDIATED_TAG = 'not-remediated';

export const REMEDIATED = 'remediated';
export const NOT_REMEDIATED = 'not_remediated';

/** 32 lowercase hex is a content hash; a Sonar issue key is longer and mixed. */
const CONTENT_HASH = /^[0-9a-f]{32}$/;

/**
 * Can this id be addressed at all? `finding_ids` is `f.key || f.hash ||
 * '<fingerprint>-<i>'`, so it is deliberately a mixed bag and this is the
 * filter that keeps us from POSTing a hash to an endpoint expecting a key.
 */
export function looksLikeIssueKey(id) {
  const s = String(id ?? '');
  return s.length >= 10 && /^[A-Za-z0-9_-]+$/.test(s)
    && !CONTENT_HASH.test(s) && !s.startsWith('gf-');
}

/** Did this pass actually edit a file belonging to this group? */
export function groupWasChanged(group, dispositions) {
  const results = dispositions?.results;
  if (!Array.isArray(results)) return false;
  const prefix = `${group.module}/`;
  return results.some((r) => r?.changed === true && r.rule === group.rule
    && String(r.file || '').startsWith(prefix));
}

/**
 * One entry per group this PR was working on.
 *
 * @param {object} o
 * @param {object[]} o.findings       the fresh, PR-scoped Sonar findings
 * @param {object[]} o.before         the findings remediation ran against — see below
 * @param {object} o.plan             the plan (`{items: []}`), may be null
 * @param {object} o.dispositions     `dispositionSummary()` from remediate.mjs, may be null
 * @param {string|number} o.pr        the PR number, to scope which plan items count
 */
export function decideOutcomes({
  findings = [], before = [], plan = null, dispositions = null, pr = null
} = {}) {
  const groups = new Map(groupFindings(findings).map((g) => [g.fingerprint, g]));
  const beforeGroups = new Map(groupFindings(before).map((g) => [g.fingerprint, g]));

  // Scope is the union of three views, and each one is load-bearing:
  //   - the fresh scan, for a group that is STILL broken;
  //   - what remediation ran against, for a group that got fixed and is
  //     therefore absent from the fresh scan;
  //   - the plan, for a group whose PR ran before the artifact carried its
  //     findings at all.
  // `before` is what makes this work on the demo PR, whose groups the plan has
  // never heard of because nothing ticketed them.
  const items = (plan?.items || []).filter((i) => pr == null || i.pr_number === Number(pr));
  const scope = new Map();
  for (const g of groups.values()) {
    scope.set(g.fingerprint, { fingerprint: g.fingerprint, rule: g.rule, module: g.module,
      severity: g.severity, group: g, item: null, present: true });
  }
  for (const g of beforeGroups.values()) {
    if (!scope.has(g.fingerprint)) {
      scope.set(g.fingerprint, { fingerprint: g.fingerprint, rule: g.rule, module: g.module,
        severity: g.severity, group: null, beforeGroup: g, item: null, present: false });
    }
  }
  for (const item of items) {
    if (scope.has(item.group_fingerprint)) {
      scope.get(item.group_fingerprint).item = item;
      continue;
    }
    scope.set(item.group_fingerprint, {
      fingerprint: item.group_fingerprint, rule: item.rule_key, module: item.module_prefix,
      severity: item.severity, group: null, item, present: false
    });
  }

  const outcomes = [];
  for (const s of scope.values()) {
    const changed = groupWasChanged({ rule: s.rule, module: s.module }, dispositions);
    const ticketKey = s.item?.jira_issue_key || null;
    let state;
    let reason;

    if (s.present) {
      state = NOT_REMEDIATED;
      reason = 'Sonar still reports this finding on the current scan.';
    } else if (changed) {
      state = REMEDIATED;
      reason = 'Remediation changed this file and Sonar no longer reports the finding.';
    } else {
      state = NOT_REMEDIATED;
      reason = 'Sonar no longer reports this finding, but this pass made no change to it, '
        + 'so its absence cannot be attributed to the remediation.';
    }

    // Keys where the finding is live; the pre-remediation fetch and then the
    // plan where it is gone. A live key is best because it is unambiguous — a
    // plan id may be a content hash.
    const fromFresh = s.group ? s.group.findings.map((f) => f.key).filter(Boolean) : [];
    const fromBefore = s.beforeGroup ? s.beforeGroup.findings.map((f) => f.key).filter(Boolean) : [];
    const fromPlan = (s.item?.finding_ids || []).filter(looksLikeIssueKey);
    const keys = [...new Set([...fromFresh, ...fromBefore, ...fromPlan])];

    outcomes.push({ ...s, group: undefined, beforeGroup: undefined, ticketKey, state, reason, keys });
  }
  return outcomes.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

export function outcomeComment({ ticketKey, state, reason }) {
  const verdict = state === REMEDIATED
    ? '**Remediated successfully.**'
    : '**Not remediated.**';
  const ticket = ticketKey
    ? `Jira: ${ticketKey}.`
    : 'No Jira ticket was filed for this group (Jira is opt-in).';
  return `${verdict} ${reason}\n\n${ticket} `
    + 'Recorded automatically by the Sonar remediation pipeline.';
}

/** Current tags, so setting ours does not silently drop somebody else's. */
export async function fetchTags(issueKey, { token, host = DEFAULT_HOST, fetchImpl = globalThis.fetch } = {}) {
  const url = `${host}/api/issues/search?issues=${encodeURIComponent(issueKey)}`
    + '&additionalFields=tags&ps=1';
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`
      }
    });
    if (!res.ok) return { ok: false, tags: [], status: res.status };
    const body = await res.json();
    const tags = body?.issues?.[0]?.tags;
    return { ok: true, tags: Array.isArray(tags) ? tags : [] };
  } catch (e) {
    return { ok: false, tags: [], reason: e.message };
  }
}

/**
 * Comment the outcome and tag the issue. Never throws: the terminal verdict is
 * settle's job, and a Sonar API hiccup must not take that down with it — the
 * same discipline as the Jira back-link.
 */
export async function recordOutcomeOne(issueKey, outcome, {
  token, host = DEFAULT_HOST, fetchImpl = globalThis.fetch
} = {}) {
  if (!issueKey) {
    return { key: issueKey, outcome: 'no_issue_key', reason: 'this group has no addressable Sonar issue key' };
  }
  if (!token) return { key: issueKey, outcome: 'forbidden', reason: 'no SONAR_TOKEN was provided' };

  const auth = `Basic ${Buffer.from(`${token}:`).toString('base64')}`;
  const want = outcome.state === REMEDIATED ? REMEDIATED_TAG : NOT_REMEDIATED_TAG;
  const drop = outcome.state === REMEDIATED ? NOT_REMEDIATED_TAG : REMEDIATED_TAG;

  const comment = await post(host, fetchImpl, '/api/issues/add_comment', {
    issue: issueKey, text: outcomeComment(outcome)
  }, auth);
  if (!comment.ok) return step('comment', comment, issueKey);

  const current = await fetchTags(issueKey, { token, host, fetchImpl });
  if (!current.ok) return step('read_tags', current, issueKey);

  const tags = [...new Set([...current.tags.filter((t) => t !== drop), want])];
  const tagged = await post(host, fetchImpl, '/api/issues/set_tags', {
    issue: issueKey, tags: tags.join(',')
  }, auth);
  if (!tagged.ok) return step('set_tags', tagged, issueKey);

  return { key: issueKey, outcome: 'written', tag: want, tags };
}

/**
 * A 401/403 is the token's answer about the whole run, not about this one
 * finding — `recordOutcomes` stops on it. Folding it into `failed` would make
 * the loop ask the same question once per finding, which is the exact waste
 * `jira/writeback.mjs` already learned to avoid.
 */
function step(which, r, issueKey) {
  const forbidden = r.status === 401 || r.status === 403;
  return { key: issueKey, outcome: forbidden ? 'forbidden' : 'failed', step: which, ...r };
}

async function post(host, fetchImpl, path, params, auth) {
  try {
    const res = await fetchImpl(`${host}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: auth,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(params)
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, reason:
        `Sonar answered HTTP ${res.status} — this token may not write to issues.` };
    }
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* best effort */ }
    return { ok: false, status: res.status, reason: `Sonar answered HTTP ${res.status}. ${detail}`.trim() };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Every finding in every outcome, and a summary that counts what it could not reach. */
export async function recordOutcomes(outcomes, options = {}) {
  const results = [];
  for (const o of outcomes) {
    if (!o.keys.length) {
      results.push({ fingerprint: o.fingerprint, state: o.state, attempted: 0,
        reason: 'no addressable Sonar issue key for this group' });
      continue;
    }
    const per = [];
    for (const key of o.keys) {
      const r = await recordOutcomeOne(key, o, options);
      per.push(r);
      // One permission answer settles it for every finding in the run: the
      // token either may write or it may not. Asking the same 403 once per
      // finding learns nothing, exactly as in the Jira back-link.
      if (r.outcome === 'forbidden') break;
    }
    results.push({
      fingerprint: o.fingerprint, state: o.state,
      attempted: per.length,
      written: per.filter((r) => r.outcome === 'written').length,
      tags: per[0]?.tag || null,
      reason: per.find((r) => r.reason)?.reason || null
    });
    // …and it settles the remaining GROUPS too — there is nothing left to
    // learn from the next group's findings.
    if (per.some((r) => r.outcome === 'forbidden')) break;
  }
  return {
    results,
    groups: outcomes.length,
    written: results.reduce((n, r) => n + r.written, 0),
    attempted: results.reduce((n, r) => n + r.attempted, 0)
  };
}

export function renderOutcomeReport(summary) {
  const l = ['<!-- sonar-outcome -->', '### Remediation outcome, recorded on Sonar', ''];
  for (const r of summary.results) {
    const mark = r.state === REMEDIATED ? 'remediated' : 'not remediated';
    l.push(`- \`${r.fingerprint}\` — **${mark}**`
      + `${r.attempted ? ` (${r.written}/${r.attempted} finding(s) annotated, tag \`${r.tags}\`)` : ''}`
      + `${r.reason ? ` — ${r.reason}` : ''}`);
  }
  return l.join('\n');
}

export async function main(argv) {
  const args = argv.slice(2);
  const val = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const readJson = (p) => (p ? JSON.parse(readFileSync(p, 'utf8')) : null);

  const findingsPath = val('findings');
  const planPath = val('plan');
  if (!findingsPath && !planPath) {
    console.error('usage: settle/outcome.mjs [--findings f.json] [--before pre-fix.json] '
      + '[--plan plan.json] [--dispositions d.json] [--pr N] [--json out.json]');
    return 2;
  }

  const outcomes = decideOutcomes({
    findings: readJson(findingsPath) || [],
    before: readJson(val('before')) || [],
    plan: readJson(planPath),
    dispositions: readJson(val('dispositions')),
    pr: val('pr', null)
  });

  const summary = await recordOutcomes(outcomes, {
    token: process.env.SONAR_TOKEN || process.env.SONAR_TOKEN_READ,
    host: process.env.SONAR_HOST || DEFAULT_HOST
  });

  for (const o of outcomes) {
    console.log(`${o.state === REMEDIATED ? 'FIXED  ' : 'NOT    '} ${o.fingerprint} `
      + `${o.rule} ${o.keys.length} finding(s) ${o.ticketKey || ''}`);
  }
  console.log(`outcome: ${summary.written}/${summary.attempted} finding(s) annotated `
    + `across ${summary.groups} group(s)`);

  const out = val('json');
  if (out) writeFileSync(out, `${JSON.stringify({ outcomes, summary }, null, 2)}\n`);
  writeFileSync('outcome-comment.md', renderOutcomeReport(summary));

  // A group whose outcome could not be recorded is reported, not failed: the
  // annotation is a bonus on a verdict that is already published on the PR.
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => process.exit(code));
}
