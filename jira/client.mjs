/**
 * The Jira half of the ticketing step: three calls, bounded and classified.
 *
 * ## Why this is v2, and why that is only one function's problem
 *
 * `docs/research/api-contracts.md` §5.6 settled it: v2 takes a plain string for
 * a description or a comment; v3 demands ADF, a nested document tree, for both.
 * ADF is real code and real bugs for zero benefit at this fidelity. The hedge
 * that makes the choice reversible is that every string this module sends was
 * built by `renderBody()` in `body.mjs` — so an office Jira stuck on v3 changes
 * that one function and the `API` constant here, not every call site.
 *
 * ## The search endpoint that no longer exists
 *
 * `GET|POST /rest/api/2/search` was removed, not deprecated: it answers **410
 * Gone** (Atlassian CHANGE-2046). This module speaks only to
 * `POST /rest/api/2/search/jql`, which differs from the old one in three ways
 * that each bite silently rather than loudly:
 *
 *   1. Pagination is a **cursor** (`nextPageToken`), not `startAt`.
 *   2. There is **no `total`** in the response. Code that reports "found N"
 *      must count what it actually fetched.
 *   3. `fields` is not optional in practice — omit it and you get a minimal
 *      representation that is missing the very thing you asked the question for.
 *
 * ## It cannot hang
 *
 * Same reasoning as `codemods/agentic/client.mjs`, and the same two spec §14
 * classes, imported rather than redefined so there is one definition of what
 * "persistent" means. A CI step that stalls on Jira is worse than one that
 * fails on Jira, because remediation is *supposed* to not wait for this.
 */
import { TRANSIENT, PERSISTENT } from '../codemods/agentic/client.mjs';

export { TRANSIENT, PERSISTENT };

/** The version this module speaks. Changing it is not enough on its own — see body.mjs. */
export const API = '2';

export const DEFAULTS = Object.freeze({
  timeoutMs: 20_000,
  maxRetries: 2,
  backoffMs: 750
});

export class JiraUnavailable extends Error {
  constructor(message, { classification, status = null, cause = null, attempts = 1 } = {}) {
    super(message);
    this.name = 'JiraUnavailable';
    this.classification = classification;
    this.status = status;
    this.cause = cause;
    this.attempts = attempts;
  }
}

/**
 * Read configuration without deciding what to do about it being absent.
 *
 * Missing configuration is not an outage, and reporting it as one sends
 * somebody to check a healthy Jira. The caller turns this into a stated skip.
 */
export function configFromEnv(env = process.env) {
  const cfg = {
    baseUrl: (env.JIRA_BASE_URL || '').replace(/\/+$/, ''),
    projectKey: env.JIRA_PROJECT_KEY || '',
    email: env.JIRA_USER_EMAIL || '',
    token: env.JIRA_API_TOKEN || ''
  };
  const missing = ['JIRA_BASE_URL', 'JIRA_PROJECT_KEY', 'JIRA_USER_EMAIL', 'JIRA_API_TOKEN']
    .filter((k) => !env[k]);
  return { ...cfg, configured: missing.length === 0, missing };
}

/** 4xx that will still be 4xx next time. Retrying a bad token is theatre. */
function isPersistentStatus(status) {
  return status === 400 || status === 401 || status === 403
    || status === 404 || status === 410 || status === 422;
}

function authHeader(config) {
  return `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`;
}

async function withDeadline(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One request, retried only where retrying can help.
 *
 * Every exit is bounded and classified; there is deliberately no path that
 * resolves to undefined or loops past the cap.
 */
export async function request(config, method, path, body, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
  const backoffMs = options.backoffMs ?? DEFAULTS.backoffMs;
  const url = `${config.baseUrl}/rest/api/${API}${path}`;

  let last = null;
  for (let n = 0; n <= maxRetries; n++) {
    try {
      const res = await withDeadline(
        fetchImpl(url, {
          method,
          headers: {
            accept: 'application/json',
            authorization: authHeader(config),
            ...(body === undefined ? {} : { 'content-type': 'application/json' })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }),
        timeoutMs,
        () => new JiraUnavailable(
          `${method} ${url} did not answer within ${timeoutMs}ms.`,
          { classification: TRANSIENT, attempts: n + 1 }
        )
      );

      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch { /* body is a bonus */ }
        // 410 earns its own sentence: it is almost always this exact mistake,
        // and "HTTP 410" alone sends the reader looking for an outage.
        const hint = res.status === 410
          ? ' The old /search endpoint was removed; this module must use /search/jql.'
          : '';
        throw new JiraUnavailable(
          `${method} ${url} returned HTTP ${res.status}.${hint} ${detail}`.trim(),
          {
            classification: isPersistentStatus(res.status) ? PERSISTENT : TRANSIENT,
            status: res.status,
            attempts: n + 1
          }
        );
      }

      // 204 on some writes. `.json()` on an empty body throws, and that throw
      // would be reported as a failure of a call that in fact succeeded.
      if (res.status === 204) return {};
      const text = await res.text();
      if (!text.trim()) return {};
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new JiraUnavailable(
          `${method} ${url} answered ${res.status} with a body that is not JSON: ${e.message}`,
          { classification: PERSISTENT, status: res.status, attempts: n + 1, cause: e }
        );
      }
    } catch (e) {
      if (!(e instanceof JiraUnavailable)) {
        // DNS, refused connection, TLS: the host is not there.
        last = new JiraUnavailable(`Cannot reach ${url}: ${e.message}`, {
          classification: TRANSIENT, attempts: n + 1, cause: e
        });
      } else {
        last = e;
      }
      if (last.classification === PERSISTENT) break;
      if (n < maxRetries) await sleep(backoffMs * (n + 1));
    }
  }
  throw last;
}

/**
 * Create one ticket. Returns `{ key, id, url }`.
 *
 * `description` is a plain string because this is v2. Passing an ADF object
 * here would be accepted by `JSON.stringify` and rejected by Jira, which is
 * why the type of what `renderBody()` returns is part of the version decision
 * rather than incidental to it.
 */
export async function createIssue(config, { summary, description, labels, issueType = 'Task' }, options = {}) {
  const out = await request(config, 'POST', '/issue', {
    fields: {
      project: { key: config.projectKey },
      issuetype: { name: issueType },
      summary,
      labels,
      description
    }
  }, options);
  return { key: out.key, id: out.id, url: `${config.baseUrl}/browse/${out.key}` };
}

/**
 * Search, following the cursor to exhaustion.
 *
 * Returns the issues actually fetched. There is no `total` to report and this
 * deliberately does not synthesise one: a count that is really "how many we
 * happened to page through" is worse than no count.
 */
export async function searchJql(config, jql, fields = ['key', 'status', 'summary', 'labels'], options = {}) {
  const issues = [];
  let nextPageToken;
  // Bounded rather than `while (true)`: a server that always returns a token
  // would otherwise spin forever, and dedupe needs one match, not every match.
  for (let page = 0; page < (options.maxPages ?? 20); page++) {
    const body = {
      jql,
      maxResults: options.maxResults ?? 50,
      fields,
      ...(nextPageToken ? { nextPageToken } : {})
    };
    const out = await request(config, 'POST', '/search/jql', body, options);
    issues.push(...(out.issues || []));
    nextPageToken = out.nextPageToken;
    if (!nextPageToken) break;
  }
  return issues;
}

/**
 * Fetch one issue by key.
 *
 * This exists because it is the *only* read in this module that is immune to
 * the JQL index lag measured in §5.3b — it addresses the issue directly rather
 * than asking an index that updates asynchronously from the write. Dedupe
 * depends on that property; see `dedupe.mjs`.
 */
export async function getIssue(config, key, fields = ['key', 'status', 'summary', 'labels'], options = {}) {
  const q = `?fields=${encodeURIComponent(fields.join(','))}`;
  try {
    return await request(config, 'GET', `/issue/${encodeURIComponent(key)}${q}`, undefined, options);
  } catch (e) {
    // A key the plan remembers can be genuinely gone — deleted, or moved to a
    // project this token cannot see. That is not an outage, it is an answer.
    if (e instanceof JiraUnavailable && (e.status === 404 || e.status === 403)) return null;
    throw e;
  }
}

/** Plain-string comment, v2. */
export async function addComment(config, key, text, options = {}) {
  return request(config, 'POST', `/issue/${encodeURIComponent(key)}/comment`, { body: text }, options);
}

/**
 * Jira's status *category* is the portable question.
 *
 * §5.5 found four statuses here and specifies twelve; an office Jira will have
 * different names again. `statusCategory.key` is one of `new`,
 * `indeterminate`, `done` on every Jira there is, so asking "is this finished"
 * through the category is the only form of the question that ports.
 */
export function isOpen(issue) {
  const cat = issue?.fields?.status?.statusCategory?.key;
  if (!cat) return true;   // unknown shape: assume open, and dedupe rather than duplicate
  return cat !== 'done';
}
