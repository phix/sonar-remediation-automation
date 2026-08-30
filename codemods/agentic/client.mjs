/**
 * The one network call in this system that talks to a model.
 *
 * Two properties matter more than anything else here, and they are the reason
 * this is a module rather than three lines of `fetch` inline:
 *
 * 1. **It cannot hang.** A self-hosted endpoint can be down, slow, or
 *    rate-limited, and the person waiting on the run cannot tell "still
 *    working" from "never coming back". Every wait is bounded — connect,
 *    response, and total attempts — and running out of any of them is a
 *    terminal red state carrying a reason, not a silent stall.
 *
 * 2. **It is not bound to a vendor.** OpenLLM serves an OpenAI-compatible API,
 *    so `POST {base}/chat/completions` with bearer auth is the default. If the
 *    office's approved endpoint differs, this function is the only thing that
 *    changes. That is what the seam is for.
 *
 * The connect and response deadlines are genuinely separate rather than one
 * budget wearing two names: `fetch` resolves when the response *headers*
 * arrive, so the time to that point is connect-and-first-byte, and the time
 * spent draining the body afterwards is measured against what remains of the
 * total. A model that accepts the connection and then streams nothing is the
 * exact failure this split catches.
 */

/** Spec §14 failure classes, the two this module can produce. */
export const TRANSIENT = 'infra_failure_transient';
export const PERSISTENT = 'infra_failure_persistent';

export class LlmUnavailable extends Error {
  constructor(message, { classification, attempts, elapsedMs, status = null, cause = null } = {}) {
    super(message);
    this.name = 'LlmUnavailable';
    this.classification = classification;
    this.attempts = attempts;
    this.elapsedMs = elapsedMs;
    this.status = status;
    this.cause = cause;
  }
  /** What the run reports when this ends the item. */
  toTerminalState() {
    return {
      state: 'red',
      classification: this.classification,
      summary: this.message,
      attempts: this.attempts,
      elapsedMs: this.elapsedMs,
      humanAction: this.classification === PERSISTENT
        ? 'Fix the endpoint configuration or credential; retrying will not help.'
        : 'The endpoint was reachable but not usable in time. Re-run once it is healthy.'
    };
  }
}

export const DEFAULTS = Object.freeze({
  connectTimeoutMs: 10_000,
  responseTimeoutMs: 120_000,
  maxRetries: 2,          // spec §15: 1-2, never unbounded
  backoffMs: 1_000
});

/**
 * Read configuration without deciding what to do about it being absent.
 *
 * Missing configuration is NOT an infra failure — the endpoint is not down,
 * nobody told us where it is. Conflating the two sends someone to check a
 * healthy server. The caller turns this into its own terminal state.
 */
export function configFromEnv(env = process.env) {
  const cfg = {
    baseUrl: (env.LLM_BASE_URL || '').replace(/\/+$/, ''),
    model: env.LLM_MODEL || '',
    apiKey: env.LLM_API_KEY || ''
  };
  const missing = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY'].filter((k) => !env[k]);
  return { ...cfg, configured: missing.length === 0, missing };
}

/** 4xx that will still be 4xx next time. Retrying a bad key just wastes the cap. */
function isPersistentStatus(status) {
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 422;
}

async function withDeadline(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One attempt. Throws `LlmUnavailable` with a classification; never resolves
 * on a non-2xx.
 */
async function attempt(config, messages, opts, deadlines, startedAt) {
  const controller = new AbortController();
  const url = `${config.baseUrl}/chat/completions`;
  const body = JSON.stringify({
    model: config.model,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 4096
  });

  const fail = (msg, classification, status = null, cause = null) => {
    controller.abort();
    return new LlmUnavailable(msg, {
      classification, status, cause,
      attempts: 1,
      elapsedMs: opts.now() - startedAt
    });
  };

  let res;
  try {
    res = await withDeadline(
      opts.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`
        },
        body,
        signal: controller.signal
      }),
      deadlines.connectTimeoutMs,
      () => fail(
        `No response headers from ${url} within ${deadlines.connectTimeoutMs}ms.`,
        TRANSIENT
      )
    );
  } catch (e) {
    if (e instanceof LlmUnavailable) throw e;
    // DNS failure, refused connection, TLS error: the host is not there.
    throw fail(`Cannot reach ${url}: ${e.message}`, TRANSIENT, null, e);
  }

  if (!res.ok) {
    const cls = isPersistentStatus(res.status) ? PERSISTENT : TRANSIENT;
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* body is a bonus, not a requirement */ }
    throw fail(`${url} returned HTTP ${res.status}. ${detail}`.trim(), cls, res.status);
  }

  const spent = opts.now() - startedAt;
  const remaining = Math.max(1, deadlines.responseTimeoutMs - spent);
  let payload;
  try {
    payload = await withDeadline(
      res.json(),
      remaining,
      () => fail(`Headers arrived but the body did not complete within ${remaining}ms.`, TRANSIENT)
    );
  } catch (e) {
    if (e instanceof LlmUnavailable) throw e;
    throw fail(`Response from ${url} was not JSON: ${e.message}`, TRANSIENT, res.status, e);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    // Shape, not transport. A 200 with nothing usable means the endpoint is
    // not the API we assumed, which no amount of retrying corrects.
    throw fail(
      `${url} answered 200 but with no choices[0].message.content. `
      + 'The endpoint may not be OpenAI-compatible.',
      PERSISTENT, res.status
    );
  }

  return { content, usage: payload.usage || null, raw: payload };
}

/**
 * Call the model, retrying only what retrying can fix.
 *
 * Every exit is bounded and classified. There is deliberately no path that
 * returns undefined or loops again after the cap.
 */
export async function chat(config, messages, options = {}) {
  const opts = {
    fetchImpl: options.fetchImpl || globalThis.fetch,
    sleep: options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: options.now || (() => Date.now()),
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    log: options.log || (() => {})
  };
  const deadlines = {
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
    responseTimeoutMs: options.responseTimeoutMs ?? DEFAULTS.responseTimeoutMs
  };
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
  const backoffMs = options.backoffMs ?? DEFAULTS.backoffMs;

  const startedAt = opts.now();
  let last = null;

  for (let n = 0; n <= maxRetries; n++) {
    try {
      const out = await attempt(config, messages, opts, deadlines, startedAt);
      return { ...out, attempts: n + 1, elapsedMs: opts.now() - startedAt };
    } catch (e) {
      if (!(e instanceof LlmUnavailable)) throw e;
      last = e;
      opts.log(`llm attempt ${n + 1}/${maxRetries + 1} failed [${e.classification}]: ${e.message}`);
      if (e.classification === PERSISTENT) break;   // retrying a 401 is theatre
      if (n < maxRetries) await opts.sleep(backoffMs * (n + 1));
    }
  }

  const attempts = last.classification === PERSISTENT ? last.attempts : maxRetries + 1;
  throw new LlmUnavailable(
    last.classification === PERSISTENT
      ? last.message
      : `${last.message} Gave up after ${attempts} attempts.`,
    {
      classification: last.classification,
      status: last.status,
      cause: last.cause,
      attempts,
      elapsedMs: opts.now() - startedAt
    }
  );
}
