import { describe, it, expect } from 'vitest';
import { configFromEnv, sendMessage, TelegramUnavailable, TRANSIENT, PERSISTENT } from '../client.mjs';

const CONFIGURED = { botToken: '110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', chatId: '123456789', configured: true, missing: [] };
const MESSAGE = { text: '✅ <b>PR is ready</b>', parse_mode: 'HTML' };

function fakeFetch(responses) {
  const calls = [];
  let n = 0;
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(n, responses.length - 1)];
    n += 1;
    if (r.throw) throw r.throw;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body ?? ''
    };
  };
  return { impl, calls };
}

describe('configuration', () => {
  it('is unconfigured when both variables are unset, naming each', () => {
    const cfg = configFromEnv({});
    expect(cfg.configured).toBe(false);
    expect(cfg.missing).toContain('TELEGRAM_BOT_TOKEN');
    expect(cfg.missing).toContain('TELEGRAM_CHAT_ID');
  });

  it('a token without a chat id is still unconfigured — it can authenticate but has nowhere to deliver', () => {
    const cfg = configFromEnv({ TELEGRAM_BOT_TOKEN: '110201543:AAH' });
    expect(cfg.configured).toBe(false);
    expect(cfg.missing).toEqual(['TELEGRAM_CHAT_ID']);
  });

  it('is configured once both are present', () => {
    const cfg = configFromEnv({ TELEGRAM_BOT_TOKEN: '110201543:AAH', TELEGRAM_CHAT_ID: '42' });
    expect(cfg.configured).toBe(true);
    expect(cfg.botToken).toBe('110201543:AAH');
    expect(cfg.chatId).toBe('42');
  });
});

describe('a successful send', () => {
  it('POSTs the message as JSON to sendMessage with the chat id attached and no authorization header', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: '{"ok":true}' }]);
    await sendMessage(CONFIGURED, MESSAGE, { fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${CONFIGURED.botToken}/sendMessage`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.authorization).toBeUndefined();
    expect(JSON.parse(calls[0].init.body)).toEqual({ chat_id: CONFIGURED.chatId, ...MESSAGE });
  });
});

describe('retry classification — spec §14 vocabulary', () => {
  it('retries a 5xx up to the cap, then reports it transient', async () => {
    const { impl, calls } = fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }]);
    await expect(sendMessage(CONFIGURED, MESSAGE, {
      fetchImpl: impl, maxRetries: 2, backoffMs: 0, sleep: async () => {}
    })).rejects.toMatchObject({ classification: TRANSIENT });
    expect(calls).toHaveLength(3); // 1 original + 2 retries, the cap, never unbounded
  });

  it('retries a 429 — rate limits heal, unlike a bad token', async () => {
    const { impl, calls } = fakeFetch([{ status: 429 }, { status: 200 }]);
    const result = await sendMessage(CONFIGURED, MESSAGE, {
      fetchImpl: impl, maxRetries: 2, backoffMs: 0, sleep: async () => {}
    });
    expect(result.sent).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry a 4xx — a bad token or wrong chat id fails identically forever', async () => {
    const { impl, calls } = fakeFetch([{ status: 400, body: '{"ok":false}' }, { status: 200 }]);
    await expect(sendMessage(CONFIGURED, MESSAGE, {
      fetchImpl: impl, maxRetries: 2, backoffMs: 0, sleep: async () => {}
    })).rejects.toMatchObject({ classification: PERSISTENT, status: 400 });
    expect(calls).toHaveLength(1); // never touched the second (successful!) response
  });
});

describe('distinguishing what went wrong — opposite problems for the operator', () => {
  it('reads a 401 as "the bot token was rejected"', async () => {
    const { impl } = fakeFetch([{ status: 401 }]);
    await expect(sendMessage(CONFIGURED, MESSAGE, { fetchImpl: impl, maxRetries: 0 }))
      .rejects.toThrow(/token was rejected/i);
  });

  it('reads a 403 as "the recipient has not pressed Start", not as an auth problem', async () => {
    const { impl } = fakeFetch([{ status: 403 }]);
    await expect(sendMessage(CONFIGURED, MESSAGE, { fetchImpl: impl, maxRetries: 0 }))
      .rejects.toThrow(/not pressed Start/i);
  });

  it('reads a 400 as "wrong chat id or rejected message shape"', async () => {
    const { impl } = fakeFetch([{ status: 400 }]);
    await expect(sendMessage(CONFIGURED, MESSAGE, { fetchImpl: impl, maxRetries: 0 }))
      .rejects.toThrow(/TELEGRAM_CHAT_ID is wrong/i);
  });

  it('never leaks the request URL — it embeds the token', async () => {
    const { impl } = fakeFetch([{ status: 400, body: '{"ok":false,"description":"Bad Request: chat not found"}' }]);
    await expect(sendMessage(CONFIGURED, MESSAGE, { fetchImpl: impl, maxRetries: 0 }))
      .rejects.toSatisfy((e) => !e.message.includes(CONFIGURED.botToken));
  });
});

describe('it cannot hang', () => {
  it('gives up on a connection that never resolves, within the connect timeout, rather than waiting forever', async () => {
    const neverResolves = () => new Promise(() => {});
    const start = Date.now();
    await expect(sendMessage(CONFIGURED, MESSAGE, {
      fetchImpl: neverResolves, connectTimeoutMs: 20, maxRetries: 0
    })).rejects.toMatchObject({ classification: TRANSIENT });
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('error shape', () => {
  it('classifies a DNS/connection failure as transient, not thrown raw', async () => {
    const refused = async () => { throw new Error('ECONNREFUSED'); };
    await expect(sendMessage(CONFIGURED, MESSAGE, { fetchImpl: refused, maxRetries: 0 }))
      .rejects.toBeInstanceOf(TelegramUnavailable);
  });
});
