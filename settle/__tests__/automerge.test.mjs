import { describe, it, expect, vi } from 'vitest';
import { runAutoMerge, enableAutoMerge, configFromEnv, AutoMergeUnavailable } from '../automerge.mjs';

const READY = { state: 'ready', reason: 'the quality gate passed and nothing is outstanding.' };
const RED = { state: 'red', reason: 'quality gate failed: new-code coverage is 5.7 against a threshold of 80.' };

const CONFIGURED = { pullRequestId: 'PR_kwABC', mergeMethod: 'SQUASH', configured: true, missing: [] };
const PR = { id: 'PR_kwABC', number: 2 };

describe('configFromEnv', () => {
  it('is unconfigured when PR_NODE_ID is unset', () => {
    const cfg = configFromEnv({});
    expect(cfg.configured).toBe(false);
    expect(cfg.missing).toContain('PR_NODE_ID');
  });

  it('is configured once PR_NODE_ID is present', () => {
    const cfg = configFromEnv({ PR_NODE_ID: 'PR_kwABC' });
    expect(cfg.configured).toBe(true);
  });
});

describe('runAutoMerge — the tri-state pattern (mirrors jira/run.mjs)', () => {
  it('never fires on a red classification, regardless of the enabled flag', async () => {
    const call = vi.fn();
    const result = await runAutoMerge(RED, PR, { enabled: true, config: CONFIGURED, call });
    expect(result.ran).toBe(false);
    expect(result.reason).toMatch(/red/i);
    // The reason names the classification, never the gate: a run can classify
    // red with the gate OK (undetermined inputs), and sandbox PR #3's verdict
    // rendered "Quality gate | OK" beside "the quality gate is red" for it.
    expect(result.reason).not.toMatch(/quality gate/i);
    expect(call).not.toHaveBeenCalled();
  });

  it('is off by default: silent and green when ready', async () => {
    const call = vi.fn();
    const result = await runAutoMerge(READY, PR, { config: CONFIGURED, call });
    expect(result.ran).toBe(false);
    expect(result.disabled).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('is red when enabled but unconfigured — opposite of disabled, mirroring jira/run.mjs', async () => {
    const call = vi.fn();
    const result = await runAutoMerge(READY, PR, {
      enabled: true, config: configFromEnv({}), call
    });
    expect(result.ran).toBe(false);
    expect(result.disabled).toBeFalsy();
    expect(result.reason).toMatch(/not configured/i);
    expect(call).not.toHaveBeenCalled();
  });

  it('enables native auto-merge when ready, enabled and configured', async () => {
    const call = vi.fn(async () => ({}));
    const result = await runAutoMerge(READY, PR, { enabled: true, config: CONFIGURED, call });
    expect(result.ran).toBe(true);
    expect(result.enabled).toBe(true);
    expect(call).toHaveBeenCalledWith({ pullRequestId: 'PR_kwABC', mergeMethod: 'SQUASH' });
  });

  it('treats "already enabled" as an idempotent success, not an error', async () => {
    const call = vi.fn(async () => {
      throw new Error('Pull request Auto Merge is already enabled for this pull request.');
    });
    const result = await runAutoMerge(READY, PR, { enabled: true, config: CONFIGURED, call });
    expect(result.ran).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.alreadyEnabled).toBe(true);
    expect(result.failed).toBeFalsy();
  });

  it('names "not allowed on the repository" as its own actionable failure', async () => {
    const call = vi.fn(async () => {
      throw new Error('Auto merge is not allowed for this repository.');
    });
    const result = await runAutoMerge(READY, PR, { enabled: true, config: CONFIGURED, call });
    expect(result.ran).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.classification).toBe('not_allowed');
    expect(result.reason).toMatch(/not allowed/i);
  });

  it('names "PR not mergeable" as its own actionable failure, distinct from not-allowed', async () => {
    const call = vi.fn(async () => {
      throw new Error('Pull request Pull Request 2 is not in the correct state to enable auto-merge');
    });
    const result = await runAutoMerge(READY, PR, { enabled: true, config: CONFIGURED, call });
    expect(result.ran).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.classification).toBe('not_mergeable');
    expect(result.reason).toMatch(/mergeable/i);
  });

  it('reports an unrecognised GitHub error as unknown rather than swallowing it', async () => {
    const call = vi.fn(async () => { throw new Error('a wire error nobody has seen before'); });
    const result = await runAutoMerge(READY, PR, { enabled: true, config: CONFIGURED, call });
    expect(result.ran).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.classification).toBe('unknown');
  });

  it('is red when enabled, configured, but the PR identity is missing', async () => {
    const call = vi.fn();
    const result = await runAutoMerge(READY, null, { enabled: true, config: CONFIGURED, call });
    expect(result.ran).toBe(false);
    expect(result.reason).toMatch(/identity/i);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('enableAutoMerge — the low-level call, still never a merge itself', () => {
  it('calls only enablePullRequestAutoMerge-shaped input, never a merge mutation', async () => {
    const call = vi.fn(async () => ({}));
    await enableAutoMerge(PR, { call });
    const [args] = call.mock.calls[0];
    expect(Object.keys(args).sort()).toEqual(['mergeMethod', 'pullRequestId']);
  });

  it('throws AutoMergeUnavailable, not a bare Error, on a classified failure', async () => {
    const call = vi.fn(async () => { throw new Error('Auto merge is not allowed for this repository.'); });
    await expect(enableAutoMerge(PR, { call })).rejects.toBeInstanceOf(AutoMergeUnavailable);
  });
});
