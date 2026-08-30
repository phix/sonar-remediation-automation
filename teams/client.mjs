/**
 * The one network call in this system that talks to Teams.
 *
 * ## Power Automate, not a classic webhook
 *
 * IMPLEMENTATION_PLAN.md §4.2: classic Office 365 Teams incoming webhooks
 * were disabled May 2026. The only supported transport is a Power Automate
 * Workflow ("When a Teams webhook request is received" → "Post card in a
 * chat or channel"), a plain HTTPS POST of an Adaptive Card. The URL itself
 * carries a SAS signature and IS the credential — there is no separate
 * authorization header to send, unlike jira/client.mjs.
 *
 * ## It cannot hang
 *
 * Same reasoning as jira/client.mjs and codemods/agentic/client.mjs, and the
 * same spec §14 failure classes, imported rather than redefined so there is
 * one definition of what "transient" and "persistent" mean. A pipeline step
 * that stalls posting its own terminal-state message is worse than one that
 * fails at it — the person waiting cannot tell "still working" from "never
 * coming back". Every wait is bounded: connect, response, and a retry cap
 * that is never unbounded.
 *
 * ## Classification: 5xx/timeout retries, 4xx does not
 *
 * A 5xx or a timeout is transient — retried within the cap. A 4xx is
 * persistent: a malformed card or a revoked Workflow URL will fail
 * identically forever, and retrying it is theatre that just burns the cap.
 *
 * Two different 4xx shapes are opposite problems for the operator, so the
 * message distinguishes them where the status makes that possible: 404/410
 * means this URL is not (or is no longer) a live Power Automate trigger;
 * 400/422 means the endpoint IS a trigger but rejected this card's shape;
 * 401/403 means the URL's embedded signature was rejected.
 */
import { TRANSIENT, PERSISTENT } from '../codemods/agentic/client.mjs';

export { TRANSIENT, PERSISTENT };

export const DEFAULTS = Object.freeze({
  connectTimeoutMs: 10_000,
  responseTimeoutMs: 15_000,
  maxRetries: 2,          // spec §15: 1-2, never unbounded
  backoffMs: 750
});

export class TeamsUnavailable extends Error {
  constructor(message, { classification, status = null, cause = null, attempts = 1 } = {}) {
    super(message);
    this.name = 'TeamsUnavailable';
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
 * somebody to check a healthy Power Automate flow. The caller (notify.mjs)
 * turns this into a stated skip or a stated red.
 */
export function configFromEnv(env = process.env) {
  const webhookUrl = env.TEAMS_WEBHOOK_URL || '';
  const missing = webhookUrl ? [] : ['TEAMS_WEBHOOK_URL'];
  return { webhookUrl, configured: missing.length === 0, missing };
}

/** 4xx that will still be 4xx next time. Retrying a bad card is theatre. */
function isPersistentStatus(status) {
  return status === 400 || status === 401 || status === 403
    || status === 404 || status === 410 || status === 422;
}

/** The extra sentence that makes a 4xx status actionable rather than opaque. */
function statusHint(status) {
  if (status === 404 || status === 410) {
    return ' This does not look like a live Power Automate trigger URL — the flow may be '
      + 'deleted, disabled, or this URL was never a trigger.';
  }
  if (status === 401 || status === 403) {
    return " The trigger URL's embedded signature was rejected — it may have been regenerated "
      + 'or revoked.';
  }
  if (status === 400 || status === 422) {
    return " The endpoint is reachable and is a workflow trigger, but it rejected this card's "
      + "shape — check the flow's expected schema against what buildCard() sends.";
  }
  return '';
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
 * One attempt. Never resolves on a non-2xx; every exit is a classified
 * TeamsUnavailable, never a bare throw or an undefined return.
 */
async function attempt(config, card, opts, deadlines) {
  let res;
  try {
    res = await withDeadline(
      opts.fetchImpl(config.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(card)
      }),
      deadlines.connectTimeoutMs,
      () => new TeamsUnavailable(
        `No response headers from the Teams webhook within ${deadlines.connectTimeoutMs}ms.`,
        { classification: TRANSIENT }
      )
    );
  } catch (e) {
    if (e instanceof TeamsUnavailable) throw e;
    // DNS failure, refused connection, TLS: the host is not there.
    throw new TeamsUnavailable(`Cannot reach the Teams webhook: ${e.message}`,
      { classification: TRANSIENT, cause: e });
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* body is a bonus */ }
    throw new TeamsUnavailable(
      `Teams webhook returned HTTP ${res.status}.${statusHint(res.status)} ${detail}`.trim(),
      { classification: isPersistentStatus(res.status) ? PERSISTENT : TRANSIENT, status: res.status }
    );
  }

  // Power Automate's "Post card" trigger typically answers 202 (or 200) with
  // an empty or plain body — there is nothing to parse and nothing
  // downstream needs from it. Draining it is a bonus, bounded like anything
  // else here, never load-bearing for the outcome.
  try {
    await withDeadline(res.text(), deadlines.responseTimeoutMs,
      () => new TeamsUnavailable(
        `Headers arrived but the body did not complete within ${deadlines.responseTimeoutMs}ms.`,
        { classification: TRANSIENT }
      ));
  } catch (e) {
    if (e instanceof TeamsUnavailable) throw e;
    // Draining is a bonus, not a requirement — a 2xx with an unreadable body
    // is still a delivered message.
  }

  return true;
}

/**
 * POST one card. Retried only where retrying can help, and only within the
 * cap — there is deliberately no path that loops past it or hangs past a
 * deadline.
 *
 * @returns {Promise<{sent: true, attempts: number}>}
 */
export async function postCard(config, card, options = {}) {
  const opts = {
    fetchImpl: options.fetchImpl || globalThis.fetch,
    sleep: options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  };
  const deadlines = {
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
    responseTimeoutMs: options.responseTimeoutMs ?? DEFAULTS.responseTimeoutMs
  };
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
  const backoffMs = options.backoffMs ?? DEFAULTS.backoffMs;

  let last = null;
  for (let n = 0; n <= maxRetries; n++) {
    try {
      await attempt(config, card, opts, deadlines);
      return { sent: true, attempts: n + 1 };
    } catch (e) {
      if (!(e instanceof TeamsUnavailable)) throw e;
      last = e;
      last.attempts = n + 1;
      if (e.classification === PERSISTENT) break;   // retrying a 4xx is theatre
      if (n < maxRetries) await opts.sleep(backoffMs * (n + 1));
    }
  }
  throw last;
}
