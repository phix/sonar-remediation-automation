/**
 * Fetches the two Sonar-sourced inputs `settle/classify.mjs` needs: the
 * quality gate and the analysis run behind it. Neither has a fetcher
 * anywhere else in the repo; `classify.mjs`'s header comment inferred both
 * shapes from Sonar's documentation, and this module is what turns that
 * inference into something read from the live API.
 *
 * Follows `codemods/sonar-rules.mjs`'s discipline: Basic auth built from a
 * token, `fetchImpl` injection, and — the part that matters most — **never
 * throws**. A gate or scan that cannot be read is a red terminal state with a
 * reason, not an exception; `classify()` already knows how to turn a
 * malformed input into `red`, so this module's only job is to never hand it
 * something a malformed input could be mistaken for a clean pass.
 *
 * ## Two things verified live against SonarQube Cloud, 2026-08-30, project
 * `phix_sonar-sandbox-app` (org `phix`), anonymous GETs only
 *
 * 1. **`api/qualitygates/project_status` genuinely needs `pullRequest`.**
 *    Without it the sandbox project returns `{status:"NONE", conditions:[]}`
 *    — not the PR's red-on-coverage result — and an unrecognised `NONE`
 *    status is exactly the kind of plausible-but-wrong read the issue warned
 *    about. *With* `pullRequest=2` it reproduces
 *    `docs/decisions/coverage-and-the-gate.md`'s table exactly. An unknown
 *    `pullRequest` value (tried: `999999`) correctly 400s rather than
 *    silently falling back to something else, so a bad PR number surfaces as
 *    an error here, not as a wrong-but-quiet answer.
 *
 * 2. **`api/ce/component` has no PR/branch scoping parameter at all — this
 *    was not assumed, it was discovered.** `classify.mjs`'s header cites
 *    `api/ce/component` or `api/ce/task` without settling which; querying
 *    Sonar's own `api/webservices/list` shows `ce/component`'s only
 *    parameters are `component`/`componentId`. Live-tested: adding
 *    `pullRequest=999999` (a PR that does not exist) or `branch=main` to the
 *    request changes nothing — the endpoint always returns the single
 *    `current` task for the whole component, whichever ref it happened to be
 *    for, and does not error even when the PR named does not exist. In this
 *    sandbox that silently-returned task happens to be PR 2's because it is
 *    the only analysis ever run, but nothing about the endpoint guarantees
 *    that. `fetchScanStatus` therefore cross-checks the returned task's own
 *    `pullRequest` field against the one asked for and refuses to report
 *    `SUCCESS` on a mismatch — see the comment at that check. This is a
 *    discrepancy from what a reasonable reading of `classify.mjs`'s header
 *    would assume (that the scan fetch can be scoped the same way the gate
 *    fetch can), and `classify.mjs` is not owned by this module, so it is
 *    reported here rather than "fixed" by editing that file's contract.
 */

const DEFAULT_HOST = 'https://sonarcloud.io';

const DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  maxRetries: 2,
  backoffMs: 500
});

function authHeader(token) {
  return token ? { authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` } : {};
}

/** 4xx will still be 4xx next time; retrying it just spends the cap for nothing. */
function isPersistentStatus(status) {
  return status >= 400 && status < 500;
}

async function withTimeout(promise, ms, controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One GET, retried only where retrying can help. Never throws: every exit is
 * `{ ok: true, res }` or `{ ok: false, reason, status }`.
 */
async function boundedGet(url, { headers, fetchImpl, timeoutMs, maxRetries, backoffMs, sleep }) {
  let lastReason = 'unknown error';
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await withTimeout(
        fetchImpl(url, { headers, signal: controller.signal }),
        timeoutMs,
        controller
      );
      if (res.ok) return { ok: true, res };
      if (isPersistentStatus(res.status)) {
        return { ok: false, reason: `HTTP ${res.status}`, status: res.status };
      }
      lastReason = `HTTP ${res.status}`;
    } catch (e) {
      lastReason = e.message;
    }
    if (attempt < maxRetries) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(backoffMs * (attempt + 1));
    }
  }
  return { ok: false, reason: `${lastReason} (gave up after ${maxRetries + 1} attempt(s))` };
}

function retryOptions(options) {
  return {
    fetchImpl: options.fetchImpl || globalThis.fetch,
    sleep: options.sleep || ((ms) => new Promise((r) => { setTimeout(r, ms); })),
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
    backoffMs: options.backoffMs ?? DEFAULTS.backoffMs
  };
}

/**
 * `api/qualitygates/project_status`, in the shape `classify()` expects:
 * `{ status, conditions: [{ metricKey, status, actualValue, errorThreshold,
 * comparator }] }`.
 *
 * `pullRequest` is what makes this the PR's gate rather than the branch's —
 * see the module header. `available`/`reason` say why a fetch that could not
 * be trusted was answered with something that reads as red, not `OK`, so a
 * caller that cares can say so out loud.
 */
export async function fetchQualityGate(projectKey, options = {}) {
  const unreadable = (reason) => ({ status: 'UNKNOWN', conditions: [], available: false, reason });
  if (!projectKey) return unreadable('no project key was given.');

  const { pullRequest, org, token, host = DEFAULT_HOST } = options;
  const params = new URLSearchParams({ projectKey });
  if (org) params.set('organization', org);
  if (pullRequest !== undefined && pullRequest !== null && pullRequest !== '') {
    params.set('pullRequest', String(pullRequest));
  }
  const url = `${host}/api/qualitygates/project_status?${params}`;

  const result = await boundedGet(url, {
    headers: { accept: 'application/json', ...authHeader(token) },
    ...retryOptions(options)
  });
  if (!result.ok) return unreadable(`quality gate request failed: ${result.reason}`);

  let body;
  try {
    body = await result.res.json();
  } catch (e) {
    return unreadable(`quality gate response was not JSON: ${e.message}`);
  }

  const projectStatus = body?.projectStatus;
  if (!projectStatus || typeof projectStatus.status !== 'string' || !Array.isArray(projectStatus.conditions)) {
    return unreadable('quality gate response had no usable projectStatus.');
  }

  return {
    status: projectStatus.status,
    conditions: projectStatus.conditions.map((c) => ({
      metricKey: c.metricKey,
      status: c.status,
      actualValue: c.actualValue,
      errorThreshold: c.errorThreshold,
      comparator: c.comparator
    })),
    available: true,
    reason: 'ok'
  };
}

/**
 * The analysis/background-task status behind a gate result, in the shape
 * `classify()` expects: `{ status }`.
 *
 * `api/ce/component` — the only anonymously-readable analysis-status
 * endpoint — cannot itself be scoped to a pull request or branch (see the
 * module header). So this checks the returned task's own `pullRequest`
 * field against the one requested, and refuses to report `SUCCESS` when they
 * do not match — an unrelated task's success must never stand in for this
 * PR's.
 */
export async function fetchScanStatus(projectKey, options = {}) {
  const unreadable = (reason) => ({ status: 'UNKNOWN', available: false, reason });
  if (!projectKey) return unreadable('no project key was given.');

  const { pullRequest, token, host = DEFAULT_HOST } = options;
  const params = new URLSearchParams({ component: projectKey });
  const url = `${host}/api/ce/component?${params}`;

  const result = await boundedGet(url, {
    headers: { accept: 'application/json', ...authHeader(token) },
    ...retryOptions(options)
  });
  if (!result.ok) return unreadable(`scan status request failed: ${result.reason}`);

  let body;
  try {
    body = await result.res.json();
  } catch (e) {
    return unreadable(`scan status response was not JSON: ${e.message}`);
  }

  const task = body?.current;
  if (!task || typeof task.status !== 'string') {
    return unreadable('no analysis task was found for this component.');
  }

  const wantsPullRequest = pullRequest !== undefined && pullRequest !== null && pullRequest !== '';
  if (wantsPullRequest && String(task.pullRequest ?? '') !== String(pullRequest)) {
    const got = task.pullRequest ? `pull request ${task.pullRequest}` : 'a branch, not any pull request';
    return unreadable(
      `the latest analysis task on this component is for ${got}, not pull request ${pullRequest} — `
      + 'api/ce/component cannot be scoped to a PR, so this task cannot be trusted to describe the one requested.'
    );
  }

  return { status: task.status, available: true, reason: 'ok' };
}
