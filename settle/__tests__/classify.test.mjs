import { describe, it, expect } from 'vitest';
import { classify } from '../classify.mjs';

/**
 * Fixture shapes match `docs/decisions/coverage-and-the-gate.md`'s table,
 * which is itself Sonar's `api/qualitygates/project_status` response shape:
 * `{ status, conditions: [{ metricKey, status, actualValue, errorThreshold }] }`.
 */
const OK_CONDITIONS = [
  { metricKey: 'new_reliability_rating', status: 'OK', actualValue: '1', errorThreshold: '1', comparator: 'GT' },
  { metricKey: 'new_security_rating', status: 'OK', actualValue: '1', errorThreshold: '1', comparator: 'GT' },
  { metricKey: 'new_maintainability_rating', status: 'OK', actualValue: '1', errorThreshold: '1', comparator: 'GT' },
  { metricKey: 'new_duplicated_lines_density', status: 'OK', actualValue: '0.0', errorThreshold: '3', comparator: 'GT' },
  { metricKey: 'new_security_hotspots_reviewed', status: 'OK', actualValue: '100.0', errorThreshold: '100', comparator: 'LT' }
];

const COVERAGE_FAILING_GATE = {
  status: 'ERROR',
  conditions: [
    ...OK_CONDITIONS,
    { metricKey: 'new_coverage', status: 'ERROR', actualValue: '5.7', errorThreshold: '80', comparator: 'LT' }
  ]
};

const PASSING_GATE = { status: 'OK', conditions: [...OK_CONDITIONS, { metricKey: 'new_coverage', status: 'OK', actualValue: '92.0', errorThreshold: '80', comparator: 'LT' }] };

const SUCCESSFUL_SCAN = { status: 'SUCCESS' };

const NO_DISPOSITIONS = { refused: [], needsAgent: [], results: [] };

describe('classify', () => {
  it('is ready when the gate passes and nothing is refused', () => {
    const v = classify(PASSING_GATE, SUCCESSFUL_SCAN, NO_DISPOSITIONS);
    expect(v.state).toBe('ready');
    expect(v.reason).toMatch(/passed/i);
  });

  it('names new-code coverage, not code smells, on the sandbox\'s live case', () => {
    const v = classify(COVERAGE_FAILING_GATE, SUCCESSFUL_SCAN, NO_DISPOSITIONS);
    expect(v.state).toBe('red');
    expect(v.reason).toMatch(/new-code coverage/i);
    expect(v.reason).toMatch(/5\.7/);
    expect(v.reason).toMatch(/80/);
    expect(v.reason).not.toMatch(/smell/i);
  });

  it('names every failing condition when more than one fails', () => {
    const gate = {
      status: 'ERROR',
      conditions: [
        ...OK_CONDITIONS.filter((c) => c.metricKey !== 'new_maintainability_rating'),
        { metricKey: 'new_maintainability_rating', status: 'ERROR', actualValue: '3', errorThreshold: '1', comparator: 'GT' },
        { metricKey: 'new_coverage', status: 'ERROR', actualValue: '5.7', errorThreshold: '80', comparator: 'LT' }
      ]
    };
    const v = classify(gate, SUCCESSFUL_SCAN, NO_DISPOSITIONS);
    expect(v.state).toBe('red');
    expect(v.reason).toMatch(/new-code coverage/i);
    expect(v.reason).toMatch(/maintainability/i);
  });

  it('stays red and names the findings when policy refused them, even if the gate passed', () => {
    const dispositions = {
      refused: [{ rule: 'javascript:S1121', file: 'api/src/auth/token-verifier.js', line: 12, policyReason: 'protected path' }],
      needsAgent: [], results: []
    };
    const v = classify(PASSING_GATE, SUCCESSFUL_SCAN, dispositions);
    expect(v.state).toBe('red');
    expect(v.reason).toMatch(/refused/i);
    expect(v.reason).toMatch(/api\/src\/auth\/token-verifier\.js/);
    expect(v.reason).toMatch(/never waived|not waived/i);
  });

  it('never waives a refusal to report ready, and combines it with a failing gate', () => {
    const dispositions = {
      refused: [{ rule: 'javascript:S1121', file: 'api/src/auth/token-verifier.js', line: 12, policyReason: 'protected path' }],
      needsAgent: [], results: []
    };
    const v = classify(COVERAGE_FAILING_GATE, SUCCESSFUL_SCAN, dispositions);
    expect(v.state).toBe('red');
    expect(v.reason).toMatch(/new-code coverage/i);
    expect(v.reason).toMatch(/refused/i);
  });

  it('is red, not ready, when the scan itself did not complete', () => {
    const v = classify(PASSING_GATE, { status: 'FAILED' }, NO_DISPOSITIONS);
    expect(v.state).toBe('red');
    expect(v.reason).toMatch(/scan/i);
    expect(v.reason).toMatch(/FAILED/);
  });

  it('is red, never ready and never a throw, when the gate is missing conditions entirely', () => {
    expect(() => classify(null, SUCCESSFUL_SCAN, NO_DISPOSITIONS)).not.toThrow();
    const v = classify(null, SUCCESSFUL_SCAN, NO_DISPOSITIONS);
    expect(v.state).toBe('red');
    expect(v.reason).toMatch(/could not be determined/i);
  });

  it('is red when the gate has an unrecognised status, never assumed ready', () => {
    const v = classify({ status: 'NONE', conditions: [] }, SUCCESSFUL_SCAN, NO_DISPOSITIONS);
    expect(v.state).toBe('red');
    expect(v.reason).toMatch(/not recognised|could not be determined/i);
  });

  it('is red when the gate says ERROR but names no failing condition', () => {
    const v = classify({ status: 'ERROR', conditions: OK_CONDITIONS }, SUCCESSFUL_SCAN, NO_DISPOSITIONS);
    expect(v.state).toBe('red');
    expect(v.reason).toMatch(/could not determine|could not be determined/i);
  });

  it('is red, never a throw, when dispositions are malformed', () => {
    expect(() => classify(PASSING_GATE, SUCCESSFUL_SCAN, {})).not.toThrow();
    const v = classify(PASSING_GATE, SUCCESSFUL_SCAN, {});
    expect(v.state).toBe('red');
    expect(v.reason).toMatch(/could not be determined/i);
  });

  it('is red, never a throw, when the scan is missing', () => {
    expect(() => classify(PASSING_GATE, undefined, NO_DISPOSITIONS)).not.toThrow();
    const v = classify(PASSING_GATE, undefined, NO_DISPOSITIONS);
    expect(v.state).toBe('red');
  });
});
