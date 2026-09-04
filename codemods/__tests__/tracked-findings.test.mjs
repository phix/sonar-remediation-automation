import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTrackedFindings, main } from '../tracked-findings.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tracked-findings-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ledger = (findings) => JSON.stringify({
  fingerprint: 'gf-x', rule: 'css:S4667', module: 'web', severity: 'MAJOR',
  jira_issue_key: 'SONAR-3', opened_at: '2026-09-04T00:00:00.000Z', findings
});

describe('readTrackedFindings', () => {
  it('returns nothing when the directory does not exist — not a pipeline-created PR', () => {
    expect(readTrackedFindings(join(dir, 'nope'))).toEqual([]);
  });

  it('returns nothing when the directory exists but is empty', () => {
    const trackingDir = join(dir, '.sonar-tracking');
    mkdirSync(trackingDir);
    expect(readTrackedFindings(trackingDir)).toEqual([]);
  });

  it('reads the findings out of one ledger file', () => {
    const trackingDir = join(dir, '.sonar-tracking');
    mkdirSync(trackingDir);
    writeFileSync(join(trackingDir, 'gf-x.json'),
      ledger([{ rule: 'css:S4667', file: 'web/src/app/app.css', line: 1, message: 'Empty source' }]));
    const findings = readTrackedFindings(trackingDir);
    expect(findings).toEqual([{ rule: 'css:S4667', file: 'web/src/app/app.css', line: 1, message: 'Empty source' }]);
  });

  it('concatenates findings across multiple ledger files, in filename order', () => {
    const trackingDir = join(dir, '.sonar-tracking');
    mkdirSync(trackingDir);
    writeFileSync(join(trackingDir, 'gf-b.json'), ledger([{ rule: 'B', file: 'b.js', line: 1 }]));
    writeFileSync(join(trackingDir, 'gf-a.json'), ledger([{ rule: 'A', file: 'a.js', line: 1 }]));
    const findings = readTrackedFindings(trackingDir);
    expect(findings.map((f) => f.rule)).toEqual(['A', 'B']);
  });
});

describe('the CLI exit code distinguishes "used the ledger" from "there was none"', () => {
  it('exits 1 and writes nothing when no ledger exists', async () => {
    const out = join(dir, 'out.json');
    const code = await main(['node', 'tracked-findings.mjs', out, '--dir', join(dir, '.sonar-tracking')]);
    expect(code).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it('exits 0 and writes the findings when a ledger exists', async () => {
    const trackingDir = join(dir, '.sonar-tracking');
    mkdirSync(trackingDir);
    writeFileSync(join(trackingDir, 'gf-x.json'), ledger([{ rule: 'css:S4667', file: 'a.css', line: 1 }]));
    const out = join(dir, 'out.json');
    const code = await main(['node', 'tracked-findings.mjs', out, '--dir', trackingDir]);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual([{ rule: 'css:S4667', file: 'a.css', line: 1 }]);
  });
});
