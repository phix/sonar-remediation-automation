import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, plan, PolicyError } from '../lib/plan.mjs';
import { applyPlan, expand } from '../lib/apply.mjs';
import { fromFixture, fromSonar } from '../lib/findings.mjs';
import { comment } from '../lib/verdict.mjs';
import { openEgressLog, proposeFix, resolveSecret, assertApprovedDataClass, GatewayError } from '../lib/gateway.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_TEXT = readFileSync(join(ROOT, 'config', 'example.json'), 'utf8');
const FIXTURE = join(ROOT, 'fixtures', 'findings.json');
const config = parseConfig(CONFIG_TEXT);
const findings = () => fromFixture(FIXTURE);

describe('the plan decides policy first, codemods second, model last', () => {
  it('buckets the fixture by rule coverage', () => {
    const built = plan(findings(), config);
    expect(built.totals).toEqual({ findings: 8, codemod: 3, model: 2, refused: 3 });
  });

  it('refuses by location, by rule and by file type — each with its reason', () => {
    const refused = plan(findings(), config).entries.filter((e) => e.engine === 'refused');
    const reasons = refused.map((e) => e.reason).join('\n');
    expect(reasons).toContain('protected path `src/main/java/com/example/security/`');
    expect(reasons).toContain('`java:S2076` is on the never-auto-fix list');
    expect(reasons).toContain('`buildSrc/src/main/kotlin/Deps.kt` is not a file type this pipeline edits');
  });

  it('carries the deterministic command for a covered rule and none for residue', () => {
    const entries = plan(findings(), config).entries;
    const covered = entries.find((e) => e.key === 'AY-1');
    const residue = entries.find((e) => e.key === 'AY-4');
    expect(covered.engine).toBe('codemod');
    expect(covered.command.join(' ')).toContain('RemoveUnusedLocalVariables');
    expect(residue.engine).toBe('model');
    expect(residue.command).toBeUndefined();
  });

  it('names the overflow instead of dropping it', () => {
    const tiny = { ...config, policy: { ...config.policy, maxFindingsPerPass: 1 } };
    const built = plan(findings(), tiny);
    expect(built.totals.capped).toBe(4);
    expect(built.entries).toHaveLength(8);
    expect(built.entries.find((e) => e.engine === 'capped').reason)
      .toContain('over maxFindingsPerPass (1)');
  });
});

describe('a config that cannot be enforced is refused', () => {
  it('refuses a policy version this build does not implement', () => {
    const edited = CONFIG_TEXT.replace('enterprise-remediation-1.0', 'enterprise-remediation-2.0');
    expect(() => parseConfig(edited)).toThrow(PolicyError);
    expect(() => parseConfig(edited)).toThrow(/does not enforce/);
  });

  it('refuses a typo\'d policy key rather than applying nothing', () => {
    const typo = CONFIG_TEXT.replace('"protectedPaths"', '"protectedPath"');
    expect(() => parseConfig(typo)).toThrow(/protectedPath/);
  });

  it('refuses an unknown top-level key', () => {
    expect(() => parseConfig('{"policyVersion":"enterprise-remediation-1.0","policy":{},"jenkins":{}}'))
      .toThrow(/unknown key/);
  });
});

describe('the live adapter and the fixture are the same shape', () => {
  it('asks for the pull request, never additionalFields, and maps the path', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        json: async () => ({
          issues: [{
            key: 'AY-9', rule: 'java:S1481', line: 5, severity: 'MAJOR', message: 'x',
            component: 'example-app:src/main/java/com/example/OrderService.java'
          }]
        })
      };
    };

    const found = await fromSonar({
      host: 'https://sonarqube.internal.example', token: 'tok', projectKey: 'example-app',
      pullRequest: '42', fetchImpl
    });

    expect(calls[0].url).toContain('pullRequest=42');
    expect(calls[0].url).not.toContain('additionalFields');
    expect(calls[0].url).not.toContain('tok');
    expect(calls[0].init.headers.authorization)
      .toBe(`Basic ${Buffer.from('tok:').toString('base64')}`);
    expect(found[0].file).toBe('src/main/java/com/example/OrderService.java');
  });

  it('fails loud on a rejected request instead of reporting no findings', async () => {
    const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({}) });
    await expect(fromSonar({
      host: 'https://sonarqube.internal.example', token: 'tok', projectKey: 'example-app', fetchImpl
    })).rejects.toThrow(/HTTP 400/);
  });
});

describe('the model is last and bounded', () => {
  it('refuses a data class the gateway has not been approved for', () => {
    expect(() => assertApprovedDataClass({ approvedDataClasses: ['finding-metadata'] }, 'source-file'))
      .toThrow(GatewayError);
  });

  it('leaves a named seam instead of a fallback when the secret store is not wired', () => {
    expect(() => resolveSecret('vault:model/gateway')).toThrow(/vault:model\/gateway/);
    expect(() => resolveSecret('env:NOT_SET_ANYWHERE')).toThrow(/did not resolve/);
  });

  it('writes the egress line before the call and reports the reply', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'portable-egress-'));
    const path = join(dir, 'nested', 'egress.jsonl');
    process.env.PORTABLE_TEST_GATEWAY_TOKEN = 'test-token';

    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url: String(url), init };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'the patch' } }] }) };
    };

    try {
      const result = await proposeFix({
        gateway: { ...config.gateway, secretRef: 'env:PORTABLE_TEST_GATEWAY_TOKEN' },
        finding: { key: 'AY-4', rule: 'java:S1854' },
        source: 'class A {}',
        prompt: { system: 'fix it', user: (source, finding) => `${finding.key}: ${source}` },
        egress: openEgressLog(path),
        fetchImpl
      });

      expect(result.text).toBe('the patch');
      expect(seen.init.headers.authorization).toBe('Bearer test-token');
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]);
      expect(record.kind).toBe('model');
      expect(record.findingKey).toBe('AY-4');
      expect(record.promptHash).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      delete process.env.PORTABLE_TEST_GATEWAY_TOKEN;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the verdict goes on the artifact', () => {
  it('reports the buckets and names every refusal', () => {
    const text = comment({ plan: plan(findings(), config) });
    expect(text).toContain('| fixed deterministically | 3 |');
    expect(text).toContain('| refused by policy | 3 |');
    expect(text).toContain(`\`src/main/java/com/example/security/TokenVerifier.java:21\``);
    expect(text).toContain('Policy `enterprise-remediation-1.0`');
  });

  it('says the re-scan is the verification when a scan result is supplied', () => {
    const text = comment({
      plan: plan(findings(), config),
      scan: { before: 8, after: 3, gate: 'red' }
    });
    expect(text).toContain('3 of 8 finding(s) still reported');
    expect(text).toContain('a green suite cannot establish that a smell is gone');
  });

  it('reports what was applied, and marks the fixes nothing checked', () => {
    const applied = {
      totals: { applied: 2, 'already-clean': 1 },
      results: [
        { outcome: 'applied', file: 'api/src/reports/summary.js', line: 8, rule: 'javascript:S3504', verified: true },
        { outcome: 'applied', file: 'api/src/legacy.js', line: 3, rule: 'javascript:S1854', verified: false }
      ]
    };
    const text = comment({ plan: plan(findings(), config), applied });
    expect(text).toContain('**Applied this pass:** 2 fix(es)');
    expect(text).toContain('`api/src/reports/summary.js:8` — `javascript:S3504` — verified by its own check');
    expect(text).toContain('unverified: no per-fix check is registered');
  });
});

describe('the apply half runs only what the plan allowed, and only when it can prove it', () => {
  const built = () => plan(findings(), config);
  // The Java example registers commands but no verifiers, so these cases supply
  // their own contract: check the file, fix the file.
  const verifying = {
    codemods: {
      'java:S1481': { command: ['fix', '{file}'], verifyCommand: ['check', '{file}'] },
      'java:S1128': { command: ['fix', '{file}'], verifyCommand: ['check', '{file}'] }
    }
  };

  it('never invokes a command for a refused, model or capped finding', () => {
    const result = applyPlan(built(), verifying, { run: () => ({ status: 0 }) });
    expect(result.totals.skipped).toBe(5); // 2 model + 3 refused
    expect(result.totals.applied).toBeUndefined();
  });

  it('counts a fix as applied only once the verifier flips from red to green', () => {
    const fixed = new Set();
    const run = (argv) => {
      const [command, file] = argv;
      if (command === 'check') return { status: fixed.has(file) ? 0 : 1 };
      fixed.add(file);
      return { status: 0 };
    };

    const result = applyPlan(built(), verifying, { run });
    // All three codemod entries live in one file, and one command fixes that
    // file: the second and third findings are reported, not double-counted.
    expect(result.totals.applied).toBe(1);
    expect(result.totals['already-clean']).toBe(2);
    expect(result.results.find((r) => r.outcome === 'applied').verified).toBe(true);
  });

  it('refuses to call a fix applied when its check cannot discriminate', () => {
    const result = applyPlan(built(), verifying, { run: () => ({ status: 0 }) });
    expect(result.totals.applied).toBeUndefined();
    expect(result.totals['already-clean']).toBe(3);
    expect(result.results[0].reason).toContain('cannot discriminate');
  });

  it('treats a non-zero fix exit as informational when the verifier flips green', () => {
    // Measured on the first real run: `eslint --fix` exits 1 while unrelated
    // rules still fire, on a file it just fixed. The verifier is the verdict.
    const fixed = new Set();
    const run = (argv) => {
      const [command, file] = argv;
      if (command === 'check') return { status: fixed.has(file) ? 0 : 1 };
      fixed.add(file);
      return { status: 1, stderr: 'other rules still fire\n' };
    };

    const result = applyPlan(built(), verifying, { run });
    expect(result.totals.failed).toBeUndefined();
    expect(result.totals.applied).toBe(1);
    expect(result.results.find((r) => r.outcome === 'applied').fixStatus).toBe(1);
  });

  it('reports a failed command instead of a quiet green when nothing can verify it', () => {
    const run = () => ({ status: 2, stderr: 'boom\n' });
    // The Java example registers commands but no verifier, so the exit status is
    // the only signal there is.
    const result = applyPlan(built(), config, { run });
    expect(result.totals.failed).toBe(3);
    expect(result.results[0].reason).toContain('exited 2: boom');
  });

  it('fails a finding whose verifier still reports it after the fix', () => {
    const run = (argv) => ({ status: argv[0] === 'fix' ? 0 : 1 });
    const result = applyPlan(built(), verifying, { run });
    expect(result.totals.failed).toBe(3);
    expect(result.results[0].reason).toContain('the verifier exited 1 after the fix');
  });

  it('marks a fix unverified rather than claiming proof it does not have', () => {
    const result = applyPlan(built(), config, { run: () => ({ status: 0 }) });
    const applied = result.results.filter((r) => r.outcome === 'applied');
    expect(applied).toHaveLength(3);
    expect(applied.every((r) => r.verified === false)).toBe(true);
  });

  it('runs nothing at all in a dry run', () => {
    const calls = [];
    const result = applyPlan(built(), verifying, { dryRun: true, run: (argv) => { calls.push(argv); return { status: 0 }; } });
    expect(calls).toHaveLength(0);
    expect(result.totals.planned).toBe(3);
  });

  it('substitutes placeholders per argument, so a path is data and never syntax', () => {
    expect(expand(['fix', '{file}', '{nope}', '{configDir}'], { file: 'a b; rm -rf.js' }, { configDir: '/cfg' }))
      .toEqual(['fix', 'a b; rm -rf.js', '{nope}', '/cfg']);
  });
});
