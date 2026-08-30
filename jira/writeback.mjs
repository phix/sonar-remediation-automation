/**
 * Step 4 of #17: make the two systems point at each other rather than one way.
 *
 * A ticket that names its findings is half a link. Someone reading the finding
 * in SonarQube — which is where the finding is actually looked at — still has
 * no way to reach the ticket. This closes that direction by commenting the
 * Jira key onto each Sonar issue.
 *
 * ## Two things were genuinely unknown here, and neither is faked
 *
 * **1. Whether this token may comment at all.** `api/issues/search` returns no
 * `actions` field for the analysis token, so its permissions are unknown
 * rather than merely untested — the question is answered by trying, not by
 * reading. So a 401/403 here is reported as *"this token may not comment"*,
 * distinct from an outage and distinct from success, and it does not fail the
 * run: the ticket is the deliverable, the back-link is the bonus.
 *
 * **2. Whether the finding even has an address.** It did not. `fetch-findings.mjs`
 * dropped Sonar's issue `key` during normalisation, because nothing downstream
 * had ever needed it — which made this step not merely untested but
 * unbuildable. It is preserved now; findings normalised before that change
 * have no key, and this reports them as such instead of pretending.
 *
 * ## Every finding, not the representative one
 *
 * The group is one piece of work, so one ticket. But the *link* has to be
 * where the reader is, and a reader is on whichever finding they opened. A
 * comment only on the representative finding leaves the other nine dead ends,
 * which is most of the value of a back-link gone to save requests that are
 * cheap.
 */
const DEFAULT_HOST = 'https://sonarcloud.io';

export const WRITTEN = 'written';
export const FORBIDDEN = 'forbidden';
export const NO_KEY = 'no_sonar_issue_key';
export const FAILED = 'failed';

export function commentText(issueKey, browseUrl) {
  return `Tracked in Jira as ${issueKey}${browseUrl ? ` — ${browseUrl}` : ''}. `
    + 'Filed automatically by the Sonar remediation pipeline.';
}

/**
 * Comment on one Sonar issue. Never throws: this whole step is optional and a
 * thrown error here would take the ticket run down with it.
 */
export async function writeBackOne(finding, ticket, {
  token, host = DEFAULT_HOST, fetchImpl = globalThis.fetch
} = {}) {
  if (!finding.key) {
    return { outcome: NO_KEY, finding: finding.file, reason:
      'this finding carries no Sonar issue key, so there is nothing to address' };
  }
  if (!token) {
    return { outcome: FORBIDDEN, finding: finding.key, reason: 'no SONAR_TOKEN was provided' };
  }

  const body = new URLSearchParams({
    issue: finding.key,
    text: commentText(ticket.key, ticket.url)
  });

  try {
    const res = await fetchImpl(`${host}/api/issues/add_comment`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body
    });
    if (res.ok) return { outcome: WRITTEN, finding: finding.key };
    if (res.status === 401 || res.status === 403) {
      return { outcome: FORBIDDEN, finding: finding.key, status: res.status, reason:
        `Sonar answered HTTP ${res.status}. This token is not permitted to comment on issues; `
        + 'the ticket was still created and the finding is simply not annotated.' };
    }
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* a bonus */ }
    return { outcome: FAILED, finding: finding.key, status: res.status,
      reason: `Sonar answered HTTP ${res.status}. ${detail}`.trim() };
  } catch (e) {
    return { outcome: FAILED, finding: finding.key, reason: e.message };
  }
}

/** Write back for a whole group, and summarise honestly. */
export async function writeBackGroup(group, ticket, options = {}) {
  const results = [];
  for (const f of group.findings) {
    results.push(await writeBackOne(f, ticket, options));
    // One forbidden answer settles it for every finding in the run: the token
    // either may comment or it may not. Retrying the same 403 nine more times
    // is nine more requests to learn nothing.
    if (results[results.length - 1].outcome === FORBIDDEN) break;
  }
  return summarize(results, group);
}

export function summarize(results, group) {
  const by = (o) => results.filter((r) => r.outcome === o).length;
  const forbidden = results.find((r) => r.outcome === FORBIDDEN);
  return {
    results,
    written: by(WRITTEN),
    attempted: results.length,
    total: group ? group.findings.length : results.length,
    permitted: !forbidden,
    reason: forbidden?.reason
      || (by(NO_KEY) === results.length && results.length
        ? 'no finding in this group carries a Sonar issue key'
        : null)
  };
}
