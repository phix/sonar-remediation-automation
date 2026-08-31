import { describe, it, expect } from 'vitest';
import { notifyTelegram, renderTelegramReport } from '../notify.mjs';

const CONFIGURED = { botToken: '110201543:AAH', chatId: '42', configured: true, missing: [] };
const UNCONFIGURED = { botToken: '', chatId: '', configured: false, missing: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] };

function fakeFetch(status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => '' };
  };
  return { impl, calls };
}

describe('off is silent and green', () => {
  it('sends nothing and reports itself as disabled, not merely absent', async () => {
    const { impl, calls } = fakeFetch();
    const result = await notifyTelegram({ verdict: 'ready' }, {
      enabled: false, config: CONFIGURED, options: { fetchImpl: impl }
    });
    expect(result.ran).toBe(false);
    expect(result.disabled).toBe(true);
    expect(calls).toHaveLength(0);
    expect(renderTelegramReport(result)).toMatch(/Not sent/);
  });
});

describe('on-but-unconfigured is RED — opposite of off, never the same message', () => {
  it('is reported as requested-but-not-sent, not as a skip', async () => {
    const { impl, calls } = fakeFetch();
    const result = await notifyTelegram({ verdict: 'ready' }, {
      enabled: true, config: UNCONFIGURED, options: { fetchImpl: impl }
    });
    expect(result.sent).toBe(false);
    expect(result.disabled).toBe(false);
    expect(result.reason).toMatch(/TELEGRAM_BOT_TOKEN/);
    expect(calls).toHaveLength(0);
    const report = renderTelegramReport(result);
    expect(report).toMatch(/not sent/i);
    // The two reports must never read the same — that IS the distinction.
    const disabledReport = renderTelegramReport(await notifyTelegram({ verdict: 'ready' }, {
      enabled: false, config: CONFIGURED, options: { fetchImpl: impl }
    }));
    expect(report).not.toBe(disabledReport);
  });
});

describe('exactly one message per terminal state', () => {
  it('sends the message exactly once on a clean success', async () => {
    const { impl, calls } = fakeFetch(200);
    const result = await notifyTelegram(
      { verdict: 'ready', repo: 'phix/sonar-sandbox-app' },
      { enabled: true, config: CONFIGURED, options: { fetchImpl: impl } }
    );
    expect(result.sent).toBe(true);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body);
    expect(body.chat_id).toBe('42');
    expect(body.text).toMatch(/PR is ready/);
    expect(body.parse_mode).toBe('HTML');
  });

  it('never throws for an expected condition — a delivery failure comes back as a result', async () => {
    const { impl, calls } = fakeFetch(400);
    const result = await notifyTelegram(
      { verdict: 'red', reason: 'S3776 exceeded threshold' },
      { enabled: true, config: CONFIGURED, options: { fetchImpl: impl, maxRetries: 0 } }
    );
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/infra_failure_persistent/);
    expect(calls).toHaveLength(1); // one attempt at the message, not a silent second try
  });
});

describe('the red reason', () => {
  it('is carried through to the actually-sent message unmodified', async () => {
    const { impl, calls } = fakeFetch(200);
    const reason = 'javascript:S3776 could not be fixed deterministically.';
    await notifyTelegram({ verdict: 'red', reason }, {
      enabled: true, config: CONFIGURED, options: { fetchImpl: impl }
    });
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.text).toContain(reason);
  });
});
