import { describe, it, expect } from 'vitest';
import { configFromEnv, postCard, TeamsUnavailable, TRANSIENT, PERSISTENT } from '../client.mjs';

const CONFIGURED = { webhookUrl: 'https://prod-00.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=xyz', configured: true, missing: [] };
const CARD = { type: 'AdaptiveCard', body: [] };

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
  it('is unconfigured when TEAMS_WEBHOOK_URL is unset', () => {
    const cfg = configFromEnv({});
    expect(cfg.configured).toBe(false);
    expect(cfg.missing).toContain('TEAMS_WEBHOOK_URL');
  });

  it('is configured once the URL is present — the URL is the whole credential, no auth header needed', () => {
    const cfg = configFromEnv({ TEAMS_WEBHOOK_URL: 'https://example.test/hook' });
    expect(cfg.configured).toBe(true);
    expect(cfg.webhookUrl).toBe('https://example.test/hook');
  });
});

describe('a successful post', () => {
  it('POSTs the card as JSON to the webhook URL with no authorization header', async () => {
    const { impl, calls } = fakeFetch([{ status: 202 }]);
    await postCard(CONFIGURED, CARD, { fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CONFIGURED.webhookUrl);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.authorization).toBeUndefined();
    expect(JSON.parse(calls[0].init.body)).toEqual(CARD);
  });
});

describe('retry classification — spec §14 vocabulary', () => {
  it('retries a 5xx up to the cap, then reports it transient', async () => {
    const { impl, calls } = fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }]);
    await expect(postCard(CONFIGURED, CARD, {
      fetchImpl: impl, maxRetries: 2, backoffMs: 0, sleep: async () => {}
    })).rejects.toMatchObject({ classification: TRANSIENT });
    expect(calls).toHaveLength(3); // 1 original + 2 retries, the cap, never unbounded
  });

  it('does NOT retry a 4xx — a malformed card or a revoked URL fails identically forever', async () => {
    const { impl, calls } = fakeFetch([{ status: 400, body: 'bad request' }, { status: 202 }]);
    await expect(postCard(CONFIGURED, CARD, {
      fetchImpl: impl, maxRetries: 2, backoffMs: 0, sleep: async () => {}
    })).rejects.toMatchObject({ classification: PERSISTENT, status: 400 });
    expect(calls).toHaveLength(1); // never touched the second (successful!) response
  });

  it('succeeds after a transient failure within the cap', async () => {
    const { impl, calls } = fakeFetch([{ status: 503 }, { status: 202 }]);
    const result = await postCard(CONFIGURED, CARD, {
      fetchImpl: impl, maxRetries: 2, backoffMs: 0, sleep: async () => {}
    });
    expect(result.sent).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe('distinguishing what went wrong — opposite problems for the operator', () => {
  it('reads a 404/410 as "not a Power Automate endpoint"', async () => {
    const { impl } = fakeFetch([{ status: 404 }]);
    await expect(postCard(CONFIGURED, CARD, { fetchImpl: impl, maxRetries: 0 }))
      .rejects.toThrow(/does not look like a live Power Automate/i);
  });

  it('reads a 400 as "the endpoint rejected the card"', async () => {
    const { impl } = fakeFetch([{ status: 400 }]);
    await expect(postCard(CONFIGURED, CARD, { fetchImpl: impl, maxRetries: 0 }))
      .rejects.toThrow(/rejected this card/i);
  });
});

describe('it cannot hang', () => {
  it('gives up on a connection that never resolves, within the connect timeout, rather than waiting forever', async () => {
    const neverResolves = () => new Promise(() => {});
    const start = Date.now();
    await expect(postCard(CONFIGURED, CARD, {
      fetchImpl: neverResolves, connectTimeoutMs: 20, maxRetries: 0
    })).rejects.toMatchObject({ classification: TRANSIENT });
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('error shape', () => {
  it('classifies a DNS/connection failure as transient, not thrown raw', async () => {
    const refused = async () => { throw new Error('ECONNREFUSED'); };
    await expect(postCard(CONFIGURED, CARD, { fetchImpl: refused, maxRetries: 0 }))
      .rejects.toBeInstanceOf(TeamsUnavailable);
  });
});
