import { describe, it, expect } from 'vitest';
import { containerGate, waitForHealth, renderGateReport, DEFAULT_TAG } from '../container.mjs';

/** A docker CLI that answers by verb, recording everything it was asked to do. */
function fakeDocker({ buildCode = 0, runCode = 0, logs = 'Error: cannot find module' } = {}) {
  const calls = [];
  return {
    calls,
    run: async (cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'build') {
        return { code: buildCode, stdout: '', stderr: buildCode ? 'the build broke' : '' };
      }
      if (args[0] === 'run') {
        return { code: runCode, stdout: runCode ? '' : 'cid123\n', stderr: runCode ? 'port in use' : '' };
      }
      if (args[0] === 'logs') return { code: 0, stdout: logs, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }
  };
}

const healthyFetch = async (url) => (url.endsWith('/health')
  ? { ok: true, status: 200 }
  : { ok: true, status: 200, json: async () => ({ orders: [] }) });

describe('a healthy app passes every check', () => {
  it('builds, boots, answers, and tears the container down', async () => {
    const { calls, run } = fakeDocker();
    const result = await containerGate({ root: '/repo', run, fetchImpl: healthyFetch });

    expect(result.ok).toBe(true);
    expect(result.built).toBe(true);
    expect(result.booted).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      'image built', 'container started', 'health endpoint', 'GET /api/orders'
    ]);
    expect(calls[0]).toContain('build -t');
    expect(calls.some((c) => c.startsWith('run --rm -d'))).toBe(true);
    // The last thing it does is remove the container it started.
    expect(calls[calls.length - 1]).toContain('rm -f');
  });
});

describe('the gate is red for a stated reason', () => {
  it('does not even try to run an image that failed to build', async () => {
    const { calls, run } = fakeDocker({ buildCode: 1 });
    const result = await containerGate({ run, fetchImpl: healthyFetch });

    expect(result.ok).toBe(false);
    expect(result.built).toBe(false);
    expect(result.reason).toMatch(/build failed/);
    expect(result.reason).toMatch(/the build broke/);
    expect(calls.some((c) => c.startsWith('run '))).toBe(false);
  });

  it('reports the container log when the app never comes up', async () => {
    const { calls, run } = fakeDocker({ logs: 'Error: PORT is not defined' });
    let t = 0;
    const result = await containerGate({
      run,
      timeoutMs: 3000,
      now: () => t,
      sleep: async () => { t += 1000; },
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
    });

    expect(result.ok).toBe(false);
    expect(result.booted).toBe(false);
    expect(result.reason).toMatch(/did not answer/);
    expect(result.reason).toMatch(/PORT is not defined/);
    // The failed run still cleans up after itself.
    expect(calls[calls.length - 1]).toContain('rm -f');
  });

  it('fails when the app boots but the order route is not wired', async () => {
    const { run } = fakeDocker();
    const result = await containerGate({
      run,
      fetchImpl: async (url) => (url.endsWith('/health')
        ? { ok: true, status: 200 }
        : { ok: false, status: 500 })
    });

    expect(result.ok).toBe(false);
    expect(result.booted).toBe(true);
    expect(result.reason).toMatch(/HTTP 500/);
  });

  it('fails when the order route answers with the wrong shape', async () => {
    const { run } = fakeDocker();
    const result = await containerGate({
      run,
      fetchImpl: async (url) => (url.endsWith('/health')
        ? { ok: true, status: 200 }
        : { ok: true, status: 200, json: async () => ({ nope: true }) })
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/did not return an \{orders: \[\]\} payload/);
  });

  it('reports a container that cannot be started at all', async () => {
    const { run } = fakeDocker({ runCode: 125 });
    const result = await containerGate({ run, fetchImpl: healthyFetch });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/run failed/);
  });
});

describe('waitForHealth keeps its own honest account of failure', () => {
  it('returns rather than throwing when nothing ever answers', async () => {
    let t = 0;
    const out = await waitForHealth('http://x/health', {
      timeoutMs: 2000, now: () => t, sleep: async () => { t += 1000; },
      fetchImpl: async () => { throw new Error('boom'); }
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/boom/);
  });

  it('gives up on a 500 rather than waiting forever for a 200', async () => {
    let t = 0;
    const out = await waitForHealth('http://x/health', {
      timeoutMs: 2000, now: () => t, sleep: async () => { t += 1000; },
      fetchImpl: async () => ({ ok: false, status: 503 })
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/HTTP 503/);
  });

  it('succeeds as soon as the app answers', async () => {
    let n = 0;
    const out = await waitForHealth('http://x/health', {
      timeoutMs: 10_000, sleep: async () => {},
      fetchImpl: async () => (++n < 3 ? { ok: false, status: 502 } : { ok: true, status: 200 })
    });
    expect(out.ok).toBe(true);
  });
});

describe('the report never overstates what the gate proved', () => {
  it('says out loud that a boot is not a fix', () => {
    const md = renderGateReport({
      ok: true, reason: null, checks: [{ name: 'image built', ok: true }]
    }, DEFAULT_TAG);
    expect(md).toContain('**Passed.**');
    expect(md).toMatch(/does \*\*not\*\* prove any finding is fixed/);
  });
});
