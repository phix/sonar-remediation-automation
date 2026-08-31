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
 * On deadlines, corrected twice against the live tinman endpoint.
 *
 * FIRST, the budget was wrong. `fetch` resolves when the response *headers*
 * arrive, which was read as connect-and-first-byte and given 10s. That is a
 * STREAMING endpoint's timing. Non-streaming, the model generates the whole
 * answer before sending a header, so the header wait IS the generation time,
 * and every call died on the deadline and was blamed on the endpoint.
 *
 * SECOND, and this is why the request now streams: raising that budget does
 * not help, because it was never the binding constraint. **Node's undici
 * enforces its own 300s headers timeout**, independent of anything this module
 * sets, and a real remediation prompt exceeds it. Measured on tinman against
 * the actual sandbox file:
 *
 *   qwen2.5-coder:7b   339.6s, 1742 output tokens, 5.1 tok/s
 *   qwen2.5-coder:14b  did not finish inside 10 minutes
 *
 * 339s > 300s, so a non-streaming request is unfixable here at ANY budget this
 * module could choose. A smaller model does not rescue it either -- the box
 * generates about five tokens a second and the prompt asks for a corrected
 * file plus a test.
 *
 * Streaming makes the headers arrive in 0.4s, which finally makes the
 * two-deadline split mean what it always claimed to mean, and adds the one it
 * was missing:
 *
 *   headerTimeoutMs  - time to response headers. Genuinely a handshake again.
 *   stallTimeoutMs   - longest silence BETWEEN chunks. This is what catches a
 *                      wedged model, and it is the check a non-streaming
 *                      request cannot make at all: silence and work look
 *                      identical when nothing arrives until the end.
 *   totalTimeoutMs   - overall ceiling on one attempt.
 *
 * A dead host still fails in milliseconds without any deadline involved: a
 * refused connection or a DNS failure rejects the fetch promise outright and
 * the catch below classifies it. The budgets have never been what detected
 * that.
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
  // Streaming, so this really is the handshake: 0.4s measured, 120s allowed
  // because a COLD model still loads before it emits its first token (74s
  // measured for a 14B load).
  headerTimeoutMs: 120_000,
  // Longest acceptable silence between chunks once generation has started. At
  // ~5 tok/s a healthy stream never goes 60s without a token, so this is
  // "wedged", not "slow".
  stallTimeoutMs: 60_000,
  // Overall ceiling for one attempt. 339s measured for one real fix at 7b;
  // 15 minutes leaves room for a longer file without being unbounded.
  totalTimeoutMs: 900_000,
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
 * Read an OpenAI-style SSE stream into one string.
 *
 * Two deadlines are enforced while reading, and they answer different
 * questions. `stallTimeoutMs` asks "is anything still arriving?" -- the check
 * that only exists because this streams; a non-streaming request cannot
 * distinguish a working model from a wedged one, because both send nothing
 * until the end. `totalTimeoutMs` asks "has this gone on too long regardless?"
 *
 * Malformed lines are skipped rather than thrown on. A stream that ends early
 * still yields whatever content arrived, and the caller decides whether an
 * empty result is a failure -- which it does, above.
 */
export async function consumeStream(res, opts, deadlines, fail) {
  const reader = res.body[Symbol.asyncIterator]
    ? res.body[Symbol.asyncIterator]()
    : res.body.getReader?.();
  const decoder = new TextDecoder();
  const startedAt = opts.now();
  let buffer = '';
  let content = '';
  let usage = null;

  const next = async () => {
    if (reader.next) return reader.next();
    const { done, value } = await reader.read();
    return { done, value };
  };

  for (;;) {
    const chunk = await withDeadline(
      next(),
      deadlines.stallTimeoutMs,
      () => fail(
        `The stream went silent for ${deadlines.stallTimeoutMs}ms. `
        + 'Tokens were arriving and then stopped, so the model is wedged rather than slow.',
        TRANSIENT
      )
    );
    if (chunk.done) break;
    if (opts.now() - startedAt > deadlines.totalTimeoutMs) {
      throw fail(
        `The stream was still arriving after ${deadlines.totalTimeoutMs}ms. `
        + 'It is generating, just not within any budget worth waiting for.',
        TRANSIENT
      );
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }  // a partial frame, not a failure
      const delta = evt?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') content += delta;
      if (evt?.usage) usage = evt.usage;
    }
  }

  return { content, usage };
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
    // Streaming is required here, not preferred -- see the header comment.
    // A non-streaming request cannot complete at this endpoint's speed
    // because undici kills it at 300s before any budget of ours applies.
    stream: true,
    stream_options: { include_usage: true },
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

  let content, usage = null;
  try {
    ({ content, usage } = await consumeStream(res, opts, deadlines, fail));
  } catch (e) {
    if (e instanceof LlmUnavailable) throw e;
    throw fail(`Reading the stream from ${url} failed: ${e.message}`, TRANSIENT, res.status, e);
  }

  if (typeof content !== 'string' || !content.trim()) {
    // Shape, not transport. A 200 that streams nothing usable means the
    // endpoint is not the API we assumed, which retrying does not correct.
    throw fail(
      `${url} answered 200 but streamed no assistant content. `
      + 'The endpoint may not be OpenAI-compatible.',
      PERSISTENT, res.status
    );
  }

  return { content, usage, raw: null };
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
    stallTimeoutMs: options.stallTimeoutMs ?? options.bodyTimeoutMs
      ?? options.responseTimeoutMs ?? DEFAULTS.stallTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs ?? DEFAULTS.totalTimeoutMs
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
