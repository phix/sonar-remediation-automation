/**
 * The planning core: policy first, codemod second, model last — all decided
 * before any fixer runs.
 *
 * This directory is the *portable* half of the pipeline. Nothing here opens a
 * socket, shells out, or knows which CI it is under, so the same file serves a
 * hosted scanner, a self-hosted SonarQube Server and a Jira Cloud tenant by
 * changing config alone. `docs/decisions/pr-remediation-flow.md` in the demo
 * engine carries the argument for the ordering; this is that argument with the
 * sandbox detached.
 *
 * Two behaviours are deliberate, and both are what an adopting organisation
 * actually reviews:
 *  - a refusal is a first-class outcome, named in the plan, never a silent skip;
 *  - a policy this build does not recognise is REFUSED at load, because a policy
 *    that silently did not apply is worse than an error.
 */
import { readFileSync } from 'node:fs';

export class PolicyError extends Error {}

/**
 * Versions this build can enforce. Editing a policy in place means changing this
 * string, and a string this build does not know is refused rather than ignored.
 */
export const KNOWN_POLICY_VERSIONS = ['enterprise-remediation-1.0'];

const TOP_LEVEL_KEYS = ['policyVersion', 'policy', 'codemods', 'sonar', 'gateway', 'fixtures'];
const POLICY_KEYS = [
  'protectedPaths', 'refusedRules', 'editableExtensions',
  'maxFindingsPerPass', 'maxAttemptsPerFinding'
];

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Read and validate a config. Every failure names the field it rejected, because
 * the failure mode being defended against is a typo'd key that quietly applies
 * nothing and leaves the pipeline looking like it ran.
 */
export function parseConfig(text, label = 'config') {
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new PolicyError(`${label} is not valid JSON: ${error.message}`);
  }

  const unknown = Object.keys(config).filter((k) => !TOP_LEVEL_KEYS.includes(k));
  if (unknown.length) throw new PolicyError(`${label} has unknown key(s): ${unknown.join(', ')}`);

  if (!KNOWN_POLICY_VERSIONS.includes(config.policyVersion)) {
    throw new PolicyError(
      `${label} declares policyVersion \`${config.policyVersion}\`, which this build does not enforce `
      + `(known: ${KNOWN_POLICY_VERSIONS.join(', ')}). Re-version the policy and teach the build it, `
      + 'rather than letting an unenforced policy look enforced.'
    );
  }

  const policy = config.policy;
  if (!policy || typeof policy !== 'object') throw new PolicyError(`${label} has no \`policy\` object`);
  const unknownPolicy = Object.keys(policy).filter((k) => !POLICY_KEYS.includes(k));
  if (unknownPolicy.length) throw new PolicyError(`${label}.policy has unknown key(s): ${unknownPolicy.join(', ')}`);

  for (const key of ['protectedPaths', 'refusedRules']) {
    if (!isStringArray(policy[key])) throw new PolicyError(`${label}.policy.${key} must be an array of strings`);
  }
  if (!isStringArray(policy.editableExtensions) || policy.editableExtensions.length === 0) {
    throw new PolicyError(`${label}.policy.editableExtensions must be a non-empty array of strings`);
  }
  for (const key of ['maxFindingsPerPass', 'maxAttemptsPerFinding']) {
    const value = policy[key];
    if (!Number.isInteger(value) || value < 1) {
      throw new PolicyError(`${label}.policy.${key} must be a positive integer`);
    }
  }
  if (config.codemods !== undefined && (typeof config.codemods !== 'object' || config.codemods === null)) {
    throw new PolicyError(`${label}.codemods must be an object of rule key -> command`);
  }
  return config;
}

export const readConfig = (path) => parseConfig(readFileSync(path, 'utf8'), path);

/**
 * Eligibility. This is about LOCATION and RISK, never about whether a fix looks
 * easy: a one-character edit inside an auth module is refused by where it lives.
 * Refusals are not waivable by anything downstream.
 */
export function evaluate(finding, policy) {
  const file = finding.file || '';

  const protectedPrefix = policy.protectedPaths.find((p) => file.startsWith(p));
  if (protectedPrefix) {
    return { eligible: false, reason: `\`${file}\` is under the protected path \`${protectedPrefix}\`` };
  }
  if (policy.refusedRules.includes(finding.rule)) {
    return { eligible: false, reason: `\`${finding.rule}\` is on the never-auto-fix list` };
  }
  if (!policy.editableExtensions.some((e) => file.endsWith(e))) {
    return { eligible: false, reason: `\`${file}\` is not a file type this pipeline edits` };
  }
  return { eligible: true, reason: 'eligible' };
}

/**
 * Rule key -> deterministic command. This map is the economic argument: a rule
 * absent here costs a model call on every pass that trips it, so adding an entry
 * is the highest-leverage change an adopting team can make. Commands are run by
 * whatever executes the plan (CI), not by this file.
 */
export const codemodFor = (config, ruleKey) => (config.codemods || {})[ruleKey] || null;

const brief = (finding) => ({
  key: finding.key,
  rule: finding.rule,
  file: finding.file,
  line: finding.line ?? null,
  severity: finding.severity || 'UNKNOWN',
  module: (finding.file || '').split('/')[0] || '',
  message: finding.message || ''
});

/**
 * Findings in, plan out. Nothing is executed here — the plan IS the artifact a
 * credential-free phase can produce, and it is what the verdict comment is
 * rendered from later.
 *
 * The cap applies to eligible findings only and the overflow is NAMED in `capped`
 * rather than dropped: a pass that quietly ignored forty findings would read
 * exactly like a pass that found forty fewer.
 */
export function plan(findings, config, { now = () => new Date() } = {}) {
  const policy = config.policy;
  const refused = [];
  const eligible = [];

  for (const finding of findings) {
    const verdict = evaluate(finding, policy);
    if (!verdict.eligible) {
      refused.push({ ...brief(finding), engine: 'refused', reason: verdict.reason });
      continue;
    }
    const codemod = codemodFor(config, finding.rule);
    eligible.push({
      ...brief(finding),
      engine: codemod ? 'codemod' : 'model',
      reason: codemod
        ? 'a deterministic fixer covers this rule'
        : 'no deterministic fixer: this is model residue',
      ...(codemod ? { command: codemod.command, commandNote: codemod.note } : {})
    });
  }

  const accepted = eligible.slice(0, policy.maxFindingsPerPass);
  const capped = eligible.slice(policy.maxFindingsPerPass).map((entry) => ({
    ...entry,
    cappedAs: entry.engine,
    engine: 'capped',
    reason: `over maxFindingsPerPass (${policy.maxFindingsPerPass}): ${entry.reason}`
  }));

  const entries = [...accepted, ...refused, ...capped];
  const totals = { findings: findings.length };
  for (const entry of entries) totals[entry.engine] = (totals[entry.engine] || 0) + 1;

  return {
    policyVersion: config.policyVersion,
    generatedAt: now().toISOString(),
    maxAttemptsPerFinding: policy.maxAttemptsPerFinding,
    totals,
    entries
  };
}
