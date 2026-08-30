import { describe, it, expect } from 'vitest';
import { notifyTeams, renderTeamsReport } from '../notify.mjs';

const CONFIGURED = { webhookUrl: 'https://example.test/hook', configured: true, missing: [] };
const UNCONFIGURED = { webhookUrl: '', configured: false, missing: ['TEAMS_WEBHOOK_URL'] };

function fakeFetch(status = 202) {
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
    const result = await notifyTeams({ verdict: 'ready' }, {
      enabled: false, config: CONFIGURED, options: { fetchImpl: impl }
    });
    expect(result.ran).toBe(false);
    expect(result.disabled).toBe(true);
    expect(calls).toHaveLength(0);
    expect(renderTeamsReport(result)).toMatch(/Not sent/);
  });
});

describe('on-but-unconfigured is RED — opposite of off, never the same message', () => {
  it('is reported as requested-but-not-sent, not as a skip', async () => {
    const { impl, calls } = fakeFetch();
    const result = await notifyTeams({ verdict: 'ready' }, {
      enabled: true, config: UNCONFIGURED, options: { fetchImpl: impl }
    });
    expect(result.sent).toBe(false);
    expect(result.disabled).toBe(false);
    expect(result.reason).toMatch(/TEAMS_WEBHOOK_URL/);
    expect(calls).toHaveLength(0);
    const report = renderTeamsReport(result);
    expect(report).toMatch(/not sent/i);
    // The two reports must never read the same — that IS the distinction.
    const disabledReport = renderTeamsReport(await notifyTeams({ verdict: 'ready' }, {
      enabled: false, config: CONFIGURED, options: { fetchImpl: impl }
    }));
    expect(report).not.toBe(disabledReport);
  });
});

describe('exactly one message per terminal state', () => {
  it('posts the card exactly once on a clean success', async () => {
    const { impl, calls } = fakeFetch(202);
    const result = await notifyTeams(
      { verdict: 'ready', repo: 'phix/sonar-sandbox-app' },
      { enabled: true, config: CONFIGURED, options: { fetchImpl: impl } }
    );
    expect(result.sent).toBe(true);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body).type).toBe('AdaptiveCard');
  });

  it('never throws for an expected condition — a delivery failure comes back as a result', async () => {
    const { impl, calls } = fakeFetch(400);
    const result = await notifyTeams(
      { verdict: 'red', reason: 'S3776 exceeded threshold' },
      { enabled: true, config: CONFIGURED, options: { fetchImpl: impl, maxRetries: 0 } }
    );
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/infra_failure_persistent/);
    expect(calls).toHaveLength(1); // one attempt at the message, not a silent second try
  });
});

describe('the red reason', () => {
  it('is carried through to the actually-sent card unmodified', async () => {
    const { impl, calls } = fakeFetch(202);
    const reason = 'javascript:S3776 could not be fixed deterministically.';
    await notifyTeams({ verdict: 'red', reason }, {
      enabled: true, config: CONFIGURED, options: { fetchImpl: impl }
    });
    const sentCard = JSON.parse(calls[0].init.body);
    const texts = sentCard.body.map((b) => b.text);
    expect(texts).toContain(reason);
  });
});
