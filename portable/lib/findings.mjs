/**
 * Where findings come from: a fixture file, or any SonarQube-compatible API.
 *
 * The fixture is not a second shape to maintain — it IS the API response shape,
 * so a plan built from the fixture is the plan the live call would produce. That
 * is what makes a credential-free phase honest instead of a mock.
 */
import { readFileSync } from 'node:fs';

/** `component` arrives as "projectKey:path"; everything downstream wants the path. */
export function normalize(issue, projectKey = '') {
  const component = issue.component || '';
  const prefix = projectKey ? `${projectKey}:` : '';
  return {
    key: issue.key,
    rule: issue.rule,
    file: prefix && component.startsWith(prefix) ? component.slice(prefix.length) : component,
    line: issue.line ?? null,
    severity: issue.severity || 'UNKNOWN',
    message: issue.message || ''
  };
}

export function fromFixture(path) {
  const body = JSON.parse(readFileSync(path, 'utf8'));
  const issues = Array.isArray(body) ? body : body.issues || [];
  return issues.map((issue) => normalize(issue, body.projectKey || ''));
}

/**
 * The live twin. SonarQube Server and the hosted service share this endpoint, so
 * the only thing an adopting environment changes is `host`, `projectKey` and
 * where the token comes from.
 */
export async function fromSonar({
  host, token, projectKey, pullRequest, branch, fetchImpl = globalThis.fetch
}) {
  if (!host || !projectKey) throw new Error('fromSonar needs a host and a projectKey');
  if (!token) throw new Error('fromSonar needs a token');

  const url = new URL('/api/issues/search', host);
  url.searchParams.set('componentKeys', projectKey);
  url.searchParams.set('statuses', 'OPEN,CONFIRMED,REOPENED');
  url.searchParams.set('ps', '500');
  if (pullRequest) url.searchParams.set('pullRequest', pullRequest);
  else if (branch) url.searchParams.set('branch', branch);
  // Deliberately no `additionalFields`: Sonar answers 400 for `tags` there, and a
  // rejected request degrades into "no findings" if nobody reads the status. The
  // demo engine carries that scar (jira/client.mjs, #31); this adapter fails loud
  // instead, and reads tags per issue only if something needs them.

  const res = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`
    }
  });
  if (!res.ok) throw new Error(`Sonar answered HTTP ${res.status} for ${url.pathname}`);
  const body = await res.json();
  return (body.issues || []).map((issue) => normalize(issue, projectKey));
}
