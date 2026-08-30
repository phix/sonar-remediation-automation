import { describe, it, expect } from 'vitest';
import { fetchQualityGate, fetchScanStatus } from '../gate.mjs';

/**
 * A fetch that answers from a queue and records every URL it was called with.
 * Matches the pattern in codemods/__tests__/agentic.test.mjs.
 */
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (typeof next === 'function') return next();
    return next;
  };
  impl.calls = calls;
  return impl;
}
const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});
const NO_WAIT = { sleep: async () => {}, backoffMs: 0 };

const PROJECT_STATUS_OK = {
  projectStatus: {
    status: 'OK',
    conditions: [
      { status: 'OK', metricKey: 'new_coverage', comparator: 'LT', errorThreshold: '80', actualValue: '92.0' }
    ],
    periods: []
  }
};

const PROJECT_STATUS_COVERAGE_ERROR = {
  projectStatus: {
    status: 'ERROR',
    conditions: [
      { status: 'OK', metricKey: 'new_reliability_rating', comparator: 'GT', errorThreshold: '1', actualValue: '1' },
      { status: 'ERROR', metricKey: 'new_coverage', comparator: 'LT', errorThreshold: '80', actualValue: '5.7' }
    ],
    periods: []
  }
};

describe('fetchQualityGate', () => {
  it('reads a passing gate into the shape classify() expects', async () => {
    const f = fakeFetch([json(PROJECT_STATUS_OK)]);
    const gate = await fetchQualityGate('phix_sonar-sandbox-app', { ...NO_WAIT, pullRequest: '2', org: 'phix', fetchImpl: f });
    expect(gate.status).toBe('OK');
    expect(gate.conditions).toEqual([
      { metricKey: 'new_coverage', status: 'OK', actualValue: '92.0', errorThreshold: '80', comparator: 'LT' }
    ]);
  });

  it('reads the sandbox\'s live coverage-bound failure faithfully', async () => {
    const f = fakeFetch([json(PROJECT_STATUS_COVERAGE_ERROR)]);
    const gate = await fetchQualityGate('phix_sonar-sandbox-app', { ...NO_WAIT, pullRequest: '2', org: 'phix', fetchImpl: f });
    expect(gate.status).toBe('ERROR');
    const coverage = gate.conditions.find((c) => c.metricKey === 'new_coverage');
    expect(coverage).toMatchObject({ status: 'ERROR', actualValue: '5.7', errorThreshold: '80' });
  });

  it('puts pullRequest on the request URL — reading the branch gate instead is the worst failure here', async () => {
    const f = fakeFetch([json(PROJECT_STATUS_OK)]);
    await fetchQualityGate('proj', { ...NO_WAIT, pullRequest: '2', org: 'phix', fetchImpl: f });
    expect(f.calls[0].url).toMatch(/pullRequest=2/);
  });

  it('never throws, and never reads as OK, when the request fails outright', async () => {
    const f = fakeFetch([() => { throw new Error('ECONNREFUSED'); }]);
    let thrown = false;
    let gate;
    try {
      gate = await fetchQualityGate('proj', { ...NO_WAIT, pullRequest: '2', fetchImpl: f, maxRetries: 0 });
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(false);
    expect(gate.status).not.toBe('OK');
    expect(gate.available).toBe(false);
  });

  it('never reads as OK on a 5xx, even after retries are exhausted', async () => {
    const f = fakeFetch([json({}, 503)]);
    const gate = await fetchQualityGate('proj', { ...NO_WAIT, pullRequest: '2', fetchImpl: f, maxRetries: 2 });
    expect(gate.status).not.toBe('OK');
    expect(gate.available).toBe(false);
  });

  it('does not retry a 4xx — a bad project key is still bad next time', async () => {
    const f = fakeFetch([json({ errors: [{ msg: 'not found' }] }, 404)]);
    const gate = await fetchQualityGate('proj', { ...NO_WAIT, pullRequest: '2', fetchImpl: f, maxRetries: 2 });
    expect(gate.status).not.toBe('OK');
    expect(f.calls.length).toBe(1);
  });

  it('retries a 5xx up to the cap, then recovers if it clears in time', async () => {
    let n = 0;
    const f = fakeFetch([() => (++n === 1 ? json({}, 502) : json(PROJECT_STATUS_OK))]);
    const gate = await fetchQualityGate('proj', { ...NO_WAIT, pullRequest: '2', fetchImpl: f, maxRetries: 2 });
    expect(gate.status).toBe('OK');
    expect(f.calls.length).toBe(2);
  });

  it('bounds the wait when the endpoint accepts the connection and never answers', async () => {
    const f = fakeFetch([() => new Promise(() => {})]);
    const started = Date.now();
    const gate = await fetchQualityGate('proj', { ...NO_WAIT, pullRequest: '2', fetchImpl: f, maxRetries: 0, timeoutMs: 30 });
    expect(gate.status).not.toBe('OK');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('never reads a malformed body (missing conditions) as a clean pass', async () => {
    const f = fakeFetch([json({ projectStatus: { status: 'OK' } })]);
    const gate = await fetchQualityGate('proj', { ...NO_WAIT, pullRequest: '2', fetchImpl: f, maxRetries: 0 });
    expect(gate.status).not.toBe('OK');
  });
});

describe('fetchScanStatus', () => {
  const CE_COMPONENT_PR2 = {
    queue: [],
    current: { id: 'task1', status: 'SUCCESS', pullRequest: '2' }
  };

  it('reads a successful scan into the shape classify() expects', async () => {
    const f = fakeFetch([json(CE_COMPONENT_PR2)]);
    const scan = await fetchScanStatus('phix_sonar-sandbox-app', { ...NO_WAIT, pullRequest: '2', fetchImpl: f });
    expect(scan.status).toBe('SUCCESS');
  });

  it('never throws on a request failure, and never reports SUCCESS', async () => {
    const f = fakeFetch([() => { throw new Error('ECONNREFUSED'); }]);
    let thrown = false;
    let scan;
    try {
      scan = await fetchScanStatus('proj', { ...NO_WAIT, pullRequest: '2', fetchImpl: f, maxRetries: 0 });
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(false);
    expect(scan.status).not.toBe('SUCCESS');
  });

  it('does not report SUCCESS when the latest task belongs to a different pull request — api/ce/component cannot be scoped by PR', async () => {
    const f = fakeFetch([json({ queue: [], current: { id: 't', status: 'SUCCESS', pullRequest: '9' } })]);
    const scan = await fetchScanStatus('proj', { ...NO_WAIT, pullRequest: '2', fetchImpl: f });
    expect(scan.status).not.toBe('SUCCESS');
    expect(scan.reason).toMatch(/pull request/i);
  });

  it('does not report SUCCESS when the latest task is for a branch, not any pull request', async () => {
    const f = fakeFetch([json({ queue: [], current: { id: 't', status: 'SUCCESS' } })]);
    const scan = await fetchScanStatus('proj', { ...NO_WAIT, pullRequest: '2', fetchImpl: f });
    expect(scan.status).not.toBe('SUCCESS');
  });

  it('does not retry a 4xx', async () => {
    const f = fakeFetch([json({ errors: [{ msg: 'not found' }] }, 404)]);
    const scan = await fetchScanStatus('proj', { ...NO_WAIT, pullRequest: '2', fetchImpl: f, maxRetries: 2 });
    expect(scan.status).not.toBe('SUCCESS');
    expect(f.calls.length).toBe(1);
  });
});
