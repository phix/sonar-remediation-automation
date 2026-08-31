/**
 * The one network call in this system that talks to Telegram.
 *
 * ## Telegram Bot API, replacing Teams (descoped 2026-08-31)
 *
 * The Teams half of #2 died on licensing, not code: Power Automate's Teams
 * webhook trigger needs a work/school M365 tenant, and the free developer
 * tenant program is closed to individuals (see
 * docs/decisions/notify-telegram-not-teams.md). The notify stage was built
 * behind a seam precisely so the transport could swap without touching the
 * pipeline — this file is the swap. One `POST
 * https://api.telegram.org/bot<token>/sendMessage` with a JSON body; the
 * token rides in the URL path, so the URL is a credential and must never
 * appear in an error message or a log line. Errors below are status-based
 * only.
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
 * ## Classification: 5xx/429/timeout retries, other 4xx does not
 *
 * A 5xx, a 429 (rate limit) or a timeout is transient — retried within the
 * cap. The other 4xx are persistent: a bad token or a wrong chat id will
 * fail identically forever, and retrying is theatre that just burns the cap.
 *
 * The 4xx shapes are opposite problems for the operator, so the message
 * distinguishes them: 401/404 means the bot token itself was rejected;
 * 403 means the token is fine but the CHAT refused — almost always because
 * the recipient never pressed Start on the bot (a bot cannot open a DM);
 * 400 means the chat id is wrong or the message shape was rejected.
 */
import { TRANSIENT, PERSISTENT } from '../codemods/agentic/client.mjs';

export { TRANSIENT, PERSISTENT };

export const DEFAULTS = Object.freeze({
  connectTimeoutMs: 10_000,
  responseTimeoutMs: 15_000,
  maxRetries: 2,          // spec §15: 1-2, never unbounded
  backoffMs: 750
});

export class TelegramUnavailable extends Error {
  constructor(message, { classification, status = null, cause = null, attempts = 1 } = {}) {
    super(message);
    this.name = 'TelegramUnavailable';
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
 * somebody to check a healthy bot. The caller (notify.mjs) turns this into
 * a stated skip or a stated red. Both values are required together: a token
 * without a chat id can authenticate and still has nowhere to deliver.
 */
export function configFromEnv(env = process.env) {
  const botToken = env.TELEGRAM_BOT_TOKEN || '';
  const chatId = env.TELEGRAM_CHAT_ID || '';
  const missing = [
    ...(botToken ? [] : ['TELEGRAM_BOT_TOKEN']),
    ...(chatId ? [] : ['TELEGRAM_CHAT_ID'])
  ];
  return { botToken, chatId, configured: missing.length === 0, missing };
}

/** 4xx that will still be 4xx next time. 429 is the exception: it heals. */
function isPersistentStatus(status) {
  return status === 400 || status === 401 || status === 403 || status === 404;
}

/** The extra sentence that makes a 4xx status actionable rather than opaque. */
function statusHint(status) {
  if (status === 401 || status === 404) {
    return ' The bot token was rejected — it may have been regenerated in BotFather, '
      + 'or the stored value is not a token at all.';
  }
  if (status === 403) {
    return ' The token is valid but the chat refused the message — the recipient has '
      + 'not pressed Start on the bot (a bot cannot open a DM first), or has blocked it.';
  }
  if (status === 400) {
    return ' The API rejected the request — TELEGRAM_CHAT_ID is wrong ("chat not found"), '
      + "or the message's HTML failed to parse.";
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
 * TelegramUnavailable, never a bare throw or an undefined return. The error
 * text carries the response body's `description` when one arrives — Telegram
 * error bodies do not echo the token — but never the request URL, which does.
 */
async function attempt(config, message, opts, deadlines) {
  let res;
  try {
    res = await withDeadline(
      opts.fetchImpl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: config.chatId, ...message })
      }),
      deadlines.connectTimeoutMs,
      () => new TelegramUnavailable(
        `No response headers from the Telegram API within ${deadlines.connectTimeoutMs}ms.`,
        { classification: TRANSIENT }
      )
    );
  } catch (e) {
    if (e instanceof TelegramUnavailable) throw e;
    // DNS failure, refused connection, TLS: the host is not there.
    throw new TelegramUnavailable(`Cannot reach the Telegram API: ${e.message}`,
      { classification: TRANSIENT, cause: e });
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* body is a bonus */ }
    throw new TelegramUnavailable(
      `Telegram API returned HTTP ${res.status}.${statusHint(res.status)} ${detail}`.trim(),
      { classification: isPersistentStatus(res.status) ? PERSISTENT : TRANSIENT, status: res.status }
    );
  }

  // A 2xx from sendMessage is a delivered message ({"ok":true,...}). Draining
  // the body is a bonus, bounded like anything else here, never load-bearing
  // for the outcome.
  try {
    await withDeadline(res.text(), deadlines.responseTimeoutMs,
      () => new TelegramUnavailable(
        `Headers arrived but the body did not complete within ${deadlines.responseTimeoutMs}ms.`,
        { classification: TRANSIENT }
      ));
  } catch (e) {
    if (e instanceof TelegramUnavailable) throw e;
    // A 2xx with an unreadable body is still a delivered message.
  }

  return true;
}

/**
 * POST one message. Retried only where retrying can help, and only within
 * the cap — there is deliberately no path that loops past it or hangs past a
 * deadline.
 *
 * @returns {Promise<{sent: true, attempts: number}>}
 */
export async function sendMessage(config, message, options = {}) {
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
      await attempt(config, message, opts, deadlines);
      return { sent: true, attempts: n + 1 };
    } catch (e) {
      if (!(e instanceof TelegramUnavailable)) throw e;
      last = e;
      last.attempts = n + 1;
      if (e.classification === PERSISTENT) break;   // retrying a bad token is theatre
      if (n < maxRetries) await opts.sleep(backoffMs * (n + 1));
    }
  }
  throw last;
}
