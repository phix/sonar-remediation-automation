import { describe, it, expect } from 'vitest';
import {
  branchNameFor, legacyBranchNameFor, prTitleFor, namesFor, BRANCH_PREFIX
} from '../naming.mjs';

describe('the Jira key leads both names, and the fingerprint stays in the branch', () => {
  it('puts the ticket number in the branch name', () => {
    expect(branchNameFor({ jiraKey: 'SONAR-42', fingerprint: 'gf-1a2b3c' }))
      .toBe('sonar/SONAR-42-gf-1a2b3c');
  });

  it('still names a branch for a group with no ticket', () => {
    // Jira is opt-in and off by default, so this is a shape rather than a
    // failure: there is simply no key to lead with.
    expect(branchNameFor({ jiraKey: '', fingerprint: 'gf-1a2b3c' })).toBe('sonar/gf-1a2b3c');
    expect(branchNameFor({ fingerprint: 'gf-1a2b3c' })).toBe('sonar/gf-1a2b3c');
  });

  it('does not mistake whitespace for a key', () => {
    expect(branchNameFor({ jiraKey: '   ', fingerprint: 'gf-1a2b3c' })).toBe('sonar/gf-1a2b3c');
  });

  it('keeps the fingerprint, which is what makes a re-run find the branch', () => {
    expect(branchNameFor({ jiraKey: 'SONAR-42', fingerprint: 'gf-1a2b3c' }))
      .toContain('gf-1a2b3c');
  });

  it('knows the name branches created before this change still have', () => {
    expect(legacyBranchNameFor({ fingerprint: 'gf-1a2b3c' })).toBe(`${BRANCH_PREFIX}gf-1a2b3c`);
  });
});

describe('the PR title names the ticket first', () => {
  it('leads with the Jira key', () => {
    expect(prTitleFor({
      jiraKey: 'SONAR-42', module: 'api', rule: 'javascript:S1481',
      findingCount: 3, severity: 'MAJOR'
    })).toBe('[SONAR-42] [api] javascript:S1481: 3 findings (MAJOR)');
  });

  it('keeps the pre-existing title shape when there is no ticket', () => {
    expect(prTitleFor({
      module: 'web', rule: 'typescript:S3358', findingCount: 1, severity: 'CRITICAL'
    })).toBe('[web] typescript:S3358: 1 finding (CRITICAL)');
  });

  it('does not pluralise one finding', () => {
    expect(prTitleFor({ module: 'api', rule: 'r', findingCount: 1, severity: 'MINOR' }))
      .toContain('1 finding (');
    expect(prTitleFor({ module: 'api', rule: 'r', findingCount: 0, severity: 'MINOR' }))
      .toContain('0 findings (');
  });
});

describe('namesFor is the one place the two names are derived together', () => {
  const group = {
    fingerprint: 'gf-1a2b3c', module: 'api', rule: 'javascript:S1481',
    severity: 'MAJOR', findings: [{ key: 'a' }, { key: 'b' }]
  };

  it('derives the branch, the legacy name and the title from the same key', () => {
    expect(namesFor(group, 'SONAR-42')).toEqual({
      branch: 'sonar/SONAR-42-gf-1a2b3c',
      legacyBranch: 'sonar/gf-1a2b3c',
      title: '[SONAR-42] [api] javascript:S1481: 2 findings (MAJOR)'
    });
  });

  it('counts from findings when the group carries them', () => {
    expect(namesFor({ ...group, findings: [{}] }, null).title).toContain('1 finding (');
  });
});
