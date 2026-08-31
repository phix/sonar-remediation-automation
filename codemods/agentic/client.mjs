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
 * On deadlines, corrected 2026-08-30 against the live tinman endpoint:
 *
 * `fetch` resolves when the response *headers* arrive. This was originally
 * read as connect-and-first-byte and given a 10s budget — which is true of a
 * STREAMING endpoint, and false of this one. A non-streaming completion
 * generates the entire answer before it sends a single header, so the wait for
 * headers IS the generation time. Measured on tinman: 74s cold (model loading)
 * and comfortably over 10s warm on a real remediation prompt. The 10s budget
 * killed every attempt and reported `infra_failure_transient` — telling
 * somebody to go check a server that was working perfectly, which is the exact
 * confusion the top of this file says it exists to prevent.
 *
 * The deadline was never what caught a dead host anyway. A refused connection
 * or a DNS failure REJECTS the fetch promise immediately, and the catch below
 * classifies it in milliseconds without any deadline being involved. The
 * header budget only ever bounded "accepted the socket, then went quiet" —
 * indistinguishable, on a non-streaming endpoint, from "is generating".
 *
 * So it is now named for what it measures, and sized for a self-hosted model
 * rather than a hosted API. The body budget is its own number instead of
 * whatever is left over, because deriving it meant a slow generation starved
 * the parse of the small JSON that followed it.
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
  // Time to headers, which on a non-streaming endpoint is the generation
  // budget. Sized for a cold self-hosted model (74s measured on tinman for a
  // 14B load), not for a hosted API.
  headerTimeoutMs: 180_000,
  // Draining the completed JSON body. Its own number, not the remainder of
  // some larger budget.
  bodyTimeoutMs: 30_000,
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
    // Explicit, because the deadline model above depends on it. Turning this
    // on would make headers arrive immediately and would require the body to
    // be consumed as an event stream rather than parsed as one JSON document.
    stream: false,
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
      deadlines.headerTimeoutMs,
      () => fail(
        `No response headers from ${url} within ${deadlines.headerTimeoutMs}ms. `
        + 'On a non-streaming endpoint this is the generation budget, so the model '
        + 'is either much slower than expected or wedged.',
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

  let payload;
  try {
    payload = await withDeadline(
      res.json(),
      deadlines.bodyTimeoutMs,
      () => fail(
        `Headers arrived but the body did not complete within ${deadlines.bodyTimeoutMs}ms.`,
        TRANSIENT
      )
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
  // The old names are still accepted. prove-gates.mjs and the suite both drive
  // this with tiny `connectTimeoutMs` values to force the bounded-wait path,
  // and silently ignoring them would turn those into tests that wait three
  // minutes instead of tests that fail.
  const deadlines = {
    headerTimeoutMs: options.headerTimeoutMs ?? options.connectTimeoutMs
      ?? DEFAULTS.headerTimeoutMs,
    bodyTimeoutMs: options.bodyTimeoutMs ?? options.responseTimeoutMs
      ?? DEFAULTS.bodyTimeoutMs
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
