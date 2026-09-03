import { describe, it, expect } from 'vitest';
import { filterByFingerprint } from '../filter-findings.mjs';
import { groupFindings } from '../group.mjs';

const F = (over = {}) => ({
  rule: 'typescript:S3358', file: 'web/a.ts', line: 1, severity: 'MAJOR', ...over
});

describe('filterByFingerprint keeps only the named groups', () => {
  it('drops findings whose group was not selected', () => {
    const findings = [F(), F({ file: 'api/b.js', rule: 'javascript:S3358' })];
    const [wanted] = groupFindings([findings[0]]);
    const out = filterByFingerprint(findings, [wanted.fingerprint]);
    expect(out).toEqual([findings[0]]);
  });

  it('keeps every finding belonging to a wanted group, not just the first', () => {
    const findings = [F({ line: 1 }), F({ line: 2 }), F({ file: 'api/b.js', rule: 'javascript:S3358' })];
    const [wanted] = groupFindings([findings[0]]);
    const out = filterByFingerprint(findings, [wanted.fingerprint]);
    expect(out).toHaveLength(2);
  });

  it('returns nothing when no fingerprint matches', () => {
    expect(filterByFingerprint([F()], ['gf-does-not-exist'])).toEqual([]);
  });
});
