/**
 * Eligibility policy: what the pipeline is allowed to touch.
 *
 * This runs BEFORE any fixer and is deliberately about LOCATION and RISK, not
 * about whether a fix is technically possible. `javascript:S1121` in
 * token-verifier.js is trivially fixable by hand; it is refused purely because
 * of where it lives.
 *
 * Refusals are never waived. A pipeline that can waive its own refusal has a
 * policy in the same sense that a door with no lock has a key.
 *
 * The path list is the first thing an adopting team must change, so it is data
 * rather than logic — see docs/decisions/pr-remediation-flow.md.
 */

export const DEFAULT_POLICY = {
  // Anything under these prefixes is refused regardless of rule.
  protectedPaths: [
    'api/src/auth/',
    'web/src/app/auth/'
  ],
  // Rules that are never auto-fixed even in ordinary code.
  refusedRules: [],
  // Only these extensions are ever edited.
  editableExtensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx']
};

export function evaluate(finding, policy = DEFAULT_POLICY) {
  const file = finding.file || '';

  const protectedPrefix = policy.protectedPaths.find((p) => file.startsWith(p));
  if (protectedPrefix) {
    return {
      eligible: false,
      reason: `\`${file}\` is under the protected path \`${protectedPrefix}\`. Security-sensitive code is `
        + 'refused by location, not by whether the fix looks easy.'
    };
  }

  if (policy.refusedRules.includes(finding.rule)) {
    return { eligible: false, reason: `\`${finding.rule}\` is on the never-auto-fix list.` };
  }

  if (!policy.editableExtensions.some((e) => file.endsWith(e))) {
    return { eligible: false, reason: `\`${file}\` is not a file type this pipeline edits.` };
  }

  return { eligible: true, reason: 'eligible' };
}

export function partition(findings, policy = DEFAULT_POLICY) {
  const eligible = [];
  const refused = [];
  for (const f of findings) {
    const v = evaluate(f, policy);
    (v.eligible ? eligible : refused).push({ ...f, policyReason: v.reason });
  }
  return { eligible, refused };
}
