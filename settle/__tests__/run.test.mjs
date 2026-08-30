import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, renderSettleReport } from '../run.mjs';

// main() writes settle-comment.md next to the process cwd. Tests run in a
// throwaway directory so a unit test can never leave a report in the repo.
let cwd, dir;
beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), 'settle-')); process.chdir(dir); });
afterEach(() => process.chdir(cwd));

const OK_GATE = { status: 'OK', conditions: [] };
const RED_GATE = { status: 'ERROR', conditions: [
  { metricKey: 'new_coverage', status: 'ERROR', actualValue: '5.7', errorThreshold: '80', comparator: 'LT' }
] };
const OK_SCAN = { status: 'SUCCESS' };
const CLEAN = { refused: [], needsAgent: [], results: [] };

const argv = (...a) => ['node', 'run.mjs', ...a];
const deps = (over = {}) => ({
  fetchQualityGate: async () => OK_GATE,
  fetchScanStatus: async () => OK_SCAN,
  ...over
});

function withDispositions(d = CLEAN) {
  const f = join(process.cwd(), 'dispositions.json');
  writeFileSync(f, JSON.stringify(d));
  return f;
}

describe('settle/run.mjs — the entry point the libraries never had', () => {
  it('refuses to run without a project and a PR, rather than guessing either', async () => {
    expect(await main(argv('--project', 'k'), deps())).toBe(2);
    expect(await main(argv('--pr', '2'), deps())).toBe(2);
  });

  it('exits 0 on a RED verdict — a blocked gate is the demo working, not settle breaking', async () => {
    const f = withDispositions();
    const code = await main(argv('--project', 'k', '--pr', '2', '--dispositions', f),
      deps({ fetchQualityGate: async () => RED_GATE }));
    expect(code).toBe(0);
    expect(readFileSync('settle-comment.md', 'utf8')).toMatch(/\*\*Red\.\*\*.*coverage is 5\.7/);
  });

  it('names the coverage condition and not an unrelated axis', async () => {
    const f = withDispositions();
    await main(argv('--project', 'k', '--pr', '2', '--dispositions', f),
      deps({ fetchQualityGate: async () => RED_GATE }));
    const body = readFileSync('settle-comment.md', 'utf8');
    expect(body).toMatch(/coverage/);
    expect(body).not.toMatch(/code smell/i);
  });

  it('reports ready when the gate passed and nothing is outstanding', async () => {
    const f = withDispositions();
    const code = await main(argv('--project', 'k', '--pr', '2', '--dispositions', f), deps());
    expect(code).toBe(0);
    expect(readFileSync('settle-comment.md', 'utf8')).toMatch(/\*\*Ready\.\*\*/);
  });

  // The artifact-passing boundary. Absent dispositions must not read as clean.
  it('treats absent dispositions as undetermined-red, never as a silent pass', async () => {
    const code = await main(argv('--project', 'k', '--pr', '2'), deps());
    expect(code).toBe(0);
    const body = readFileSync('settle-comment.md', 'utf8');
    expect(body).toMatch(/could not be determined/);
    expect(body).not.toMatch(/\*\*Ready\.\*\*/);
  });

  it('fails loudly when --dispositions points at a file that is not there', async () => {
    expect(await main(argv('--project', 'k', '--pr', '2', '--dispositions', 'nope.json'), deps())).toBe(2);
  });

  it('never enables auto-merge on a red verdict, even when asked', async () => {
    const f = withDispositions();
    let called = false;
    await main(argv('--project', 'k', '--pr', '2', '--dispositions', f, '--auto-merge', '--pr-node-id', 'PR_1'),
      deps({ fetchQualityGate: async () => RED_GATE, call: async () => { called = true; return {}; } }));
    expect(called).toBe(false);
  });

  it('exits 1 when auto-merge was asked for on a ready PR and could not be delivered', async () => {
    const f = withDispositions();
    const code = await main(argv('--project', 'k', '--pr', '2', '--dispositions', f, '--auto-merge'),
      deps({ runAutoMerge: async () => ({ ran: false, disabled: false, reason: 'not configured' }) }));
    expect(code).toBe(1);
  });

  it('stays green when auto-merge was never asked for — nobody asked is not a failure', async () => {
    const f = withDispositions();
    const code = await main(argv('--project', 'k', '--pr', '2', '--dispositions', f), deps());
    expect(code).toBe(0);
  });

  it('reads BOTH inputs even when the first is unreadable, so neither hides the other', async () => {
    let scanFetched = false;
    await main(argv('--project', 'k', '--pr', '2'), deps({
      fetchQualityGate: async () => ({ status: 'UNKNOWN', conditions: [], available: false, reason: 'gate down' }),
      fetchScanStatus: async () => { scanFetched = true; return { status: 'UNKNOWN', available: false, reason: 'scan down' }; }
    }));
    expect(scanFetched).toBe(true);
    const body = readFileSync('settle-comment.md', 'utf8');
    expect(body).toMatch(/gate down/);
    expect(body).toMatch(/scan down/);
  });

  it('writes a machine-readable record when asked', async () => {
    const f = withDispositions();
    await main(argv('--project', 'k', '--pr', '2', '--dispositions', f, '--json', 'settle.json'), deps());
    expect(existsSync('settle.json')).toBe(true);
    expect(JSON.parse(readFileSync('settle.json', 'utf8')).verdict.state).toBe('ready');
  });

  it('carries its own marker so the report upserts instead of stacking', () => {
    expect(renderSettleReport({ state: 'ready', reason: 'x' }, OK_GATE, OK_SCAN, { disabled: true }))
      .toMatch(/^<!-- sonar-settle -->/);
  });
});
