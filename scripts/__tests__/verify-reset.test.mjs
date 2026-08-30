import { describe, it, expect } from 'vitest';
import { verifyReset, DEFAULTS } from '../verify-reset.mjs';

// ---- a fake git/gh, keyed on the exact argv git.mjs would issue -----------
//
// Every entry is either a string (stdout, success) or an Error to throw —
// the same shape execFileSync itself produces, including a `.status` on the
// thrown Error so the ancestry check (which distinguishes status 1 from any
// other failure) is exercised honestly rather than short-circuited.

function makeGit(table) {
  const calls = [];
  const impl = (...args) => {
    const key = args.join(' ');
    calls.push(key);
    const entry = table[key];
    if (entry === undefined) throw new Error(`unexpected git invocation: git ${key}`);
    if (entry instanceof Error) throw entry;
    return entry;
  };
  impl.calls = calls;
  return impl;
}

function makeGh(table) {
  const calls = [];
  const impl = (...args) => {
    const key = args.join(' ');
    calls.push(key);
    const entry = table[key];
    if (entry === undefined) throw new Error(`unexpected gh invocation: gh ${key}`);
    if (entry instanceof Error) throw entry;
    return entry;
  };
  impl.calls = calls;
  return impl;
}

const notAnAncestor = () => Object.assign(new Error('fatal: not an ancestor'), { status: 1 });

const SHA = { dirty: 'sha-dirty-b2746c5', clean: 'sha-clean-03c5384', main: 'sha-clean-03c5384', branch: 'sha-dirty-b2746c5' };

/** A git table representing a clean, fully-restored baseline: main === clean
 *  tag, branch === dirty tag, dirty diverged from (not contained in) main,
 *  every required file present. Every test starts here and mutates one entry. */
function baselineGitTable({ main = SHA.main, branch = SHA.branch, ancestor = notAnAncestor(), files = DEFAULTS.requiredFiles } = {}) {
  const table = {
    'rev-parse v0-pristine^{commit}': SHA.dirty,
    'rev-parse v0-clean^{commit}': SHA.clean,
    'rev-parse origin/demo/planted-smells': branch,
    'rev-parse main': main,
    [`merge-base --is-ancestor ${SHA.dirty} ${main}`]: ancestor,
  };
  for (const f of DEFAULTS.requiredFiles) {
    const key = `cat-file -e ${main}:${f}`;
    table[key] = files.includes(f) ? '' : Object.assign(new Error(`fatal: Path '${f}' does not exist`), { status: 128 });
  }
  return table;
}

function baselineGhTable({ number = 2, state = 'OPEN', headRefOid = SHA.branch } = {}) {
  return {
    'pr view 2 --repo phix/sonar-sandbox-app --json number,state,headRefOid':
      JSON.stringify({ number, state, headRefOid }),
  };
}

function verifyBaseline(overrides = {}) {
  return verifyReset({
    git: makeGit(baselineGitTable(overrides.git)),
    gh: makeGh(baselineGhTable(overrides.gh)),
    ghRepo: 'phix/sonar-sandbox-app',
    prNumber: 2,
  });
}

describe('a fully restored baseline passes every check', () => {
  it('reports ok:true with no failing checks', () => {
    const result = verifyBaseline();
    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.summary).toMatch(/^PASS/);
  });
});

describe('tag resolution', () => {
  it('fails, naming the tag, when the dirty tag does not resolve', () => {
    const table = baselineGitTable();
    delete table['rev-parse v0-pristine^{commit}'];
    table['rev-parse v0-pristine^{commit}'] = Object.assign(new Error("fatal: ambiguous argument 'v0-pristine^{commit}'"), { status: 128 });
    const result = verifyReset({ git: makeGit(table), gh: makeGh(baselineGhTable()), ghRepo: 'phix/sonar-sandbox-app', prNumber: 2 });
    expect(result.ok).toBe(false);
    const c = result.checks.find((c) => c.name === 'dirty tag resolves');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/v0-pristine/);
  });

  it('fails, naming the tag, when the clean tag does not resolve', () => {
    const table = baselineGitTable();
    table['rev-parse v0-clean^{commit}'] = Object.assign(new Error("fatal: ambiguous argument 'v0-clean^{commit}'"), { status: 128 });
    const result = verifyReset({ git: makeGit(table), gh: makeGh(baselineGhTable()), ghRepo: 'phix/sonar-sandbox-app', prNumber: 2 });
    expect(result.ok).toBe(false);
    const c = result.checks.find((c) => c.name === 'clean tag resolves');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/v0-clean/);
  });
});

describe('the branch tip', () => {
  it('fails when the branch did not land on the dirty tag', () => {
    const result = verifyBaseline({ git: { branch: 'sha-wrong-branch-tip' } });
    expect(result.ok).toBe(false);
    const c = result.checks.find((c) => c.name === 'branch tip at dirty tag');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/sha-wrong-branch-tip/);
    expect(c.detail).toMatch(/sha-dirty-b2746c5/);
  });
});

describe('main tracking the clean tag', () => {
  it('fails when main has drifted away from the clean tag', () => {
    // main no longer equals the clean tag AND is not descended from the
    // dirty tag either — a plain mismatch, e.g. history diverged unexpectedly.
    const table = baselineGitTable({ main: 'sha-main-drifted' });
    const result = verifyReset({ git: makeGit(table), gh: makeGh(baselineGhTable()), ghRepo: 'phix/sonar-sandbox-app', prNumber: 2 });
    expect(result.ok).toBe(false);
    const c = result.checks.find((c) => c.name === 'main at clean tag');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/sha-main-drifted/);
  });
});

describe('ancestry — the #14 trap', () => {
  it('fails when the defective tip is contained in main (would-be-empty PR diff)', () => {
    // git merge-base --is-ancestor exits 0 (no throw) when it IS an ancestor.
    const result = verifyBaseline({ git: { ancestor: '' } });
    expect(result.ok).toBe(false);
    const c = result.checks.find((c) => c.name === 'defective tip not merged into main');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/contained in/);
  });

  it('passes when the defective tip has merely diverged from main — that is normal', () => {
    // This is the case #14 got backwards: diverged (not an ancestor) is fine.
    const result = verifyBaseline({ git: { ancestor: notAnAncestor() } });
    expect(result.ok).toBe(true);
    const c = result.checks.find((c) => c.name === 'defective tip not merged into main');
    expect(c.ok).toBe(true);
  });

  it('propagates a genuine git error rather than reading it as "not an ancestor"', () => {
    const badError = Object.assign(new Error('fatal: not a valid object name'), { status: 128 });
    expect(() => verifyBaseline({ git: { ancestor: badError } })).toThrow(/not a valid object name/);
  });
});

describe('required files — the #9 trap', () => {
  it('fails and names the specific missing file', () => {
    const result = verifyBaseline({ git: { files: ['smells/catalogue.json', 'eslint.smells.config.mjs'] } });
    expect(result.ok).toBe(false);
    const c = result.checks.find((c) => c.name === 'required file: sonar-project.properties');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/missing/);
    // the other two files being present must not be swept up in the same failure
    expect(result.checks.find((c) => c.name === 'required file: smells/catalogue.json').ok).toBe(true);
  });

  it('passes when all three pipeline files are present', () => {
    const result = verifyBaseline();
    expect(result.checks.filter((c) => c.name.startsWith('required file:')).every((c) => c.ok)).toBe(true);
  });
});

describe('PR #2 — the box that matters most', () => {
  it('fails when the PR is closed, rather than treating a closed PR as fine', () => {
    const result = verifyBaseline({ gh: { state: 'CLOSED' } });
    expect(result.ok).toBe(false);
    const c = result.checks.find((c) => c.name === 'PR #2');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/CLOSED/);
  });

  it('fails when gh reports a different PR number than expected', () => {
    const result = verifyBaseline({ gh: { number: 99 } });
    expect(result.ok).toBe(false);
    const c = result.checks.find((c) => c.name === 'PR #2');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/99/);
  });

  it('fails when the PR head is not the restored branch tip', () => {
    const result = verifyBaseline({ gh: { headRefOid: 'sha-some-other-commit' } });
    expect(result.ok).toBe(false);
    const c = result.checks.find((c) => c.name === 'PR #2');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/sha-some-other-commit/);
  });

  it('is skipped, not failed, when no gh/prNumber is supplied — the CLI is what makes it mandatory', () => {
    const result = verifyReset({ git: makeGit(baselineGitTable()) });
    expect(result.checks.find((c) => c.name.startsWith('PR #'))).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});

describe('idempotency — running verification twice in a row is a pass both times, never an error', () => {
  it('returns byte-identical, ok:true results on back-to-back calls against unchanged state', () => {
    // This is what "run the reset twice" looks like from verify-reset's side:
    // the second reset was a no-op, so the state it reads is IDENTICAL to the
    // first — it must never assume it is witnessing a fresh restore.
    const first = verifyBaseline();
    const second = verifyBaseline();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second).toEqual(first);
  });

  it('states current state ("is at"), never a claimed action ("just restored") — so it reads true on any call, not only the first', () => {
    const result = verifyBaseline();
    for (const c of result.checks) {
      expect(c.detail).not.toMatch(/just restored|just pushed|just moved/i);
    }
  });
});
