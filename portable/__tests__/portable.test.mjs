import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, plan, PolicyError } from '../lib/plan.mjs';
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
    expect(text).toContain('`src/main/java/com/example/security/TokenVerifier.java:21`');
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
});
