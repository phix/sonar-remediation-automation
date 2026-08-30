/**
 * What the agentic path is allowed to be asked about.
 *
 * This is a guard, not a routing table. `remediate.mjs` already decides who
 * gets a finding: anything with a codemod never arrives here. So a finding
 * reaching this module for a rule outside the set below means one of two
 * things, and both are worth an alarm rather than a shrug:
 *
 *   - a codemod regressed, and work that used to be free now costs a token
 *     bill on every pull request that trips the rule;
 *   - a new rule appeared and nobody decided how it should be handled.
 *
 * Silent scope creep here is the pipeline quietly getting more expensive,
 * which is the one failure mode that never shows up as a red build. So it is
 * refused loudly instead of served quietly.
 */
import { hasCodemod } from '../registry.mjs';

/** The 10 findings #19 exists for — cognitive complexity, duplicate bodies, nested ternaries. */
export const AGENTIC_RULES = Object.freeze([
  'javascript:S3776', 'typescript:S3776',   // cognitive complexity
  'javascript:S4144', 'typescript:S4144',   // identical function bodies
  'typescript:S3358'                        // nested ternary
]);

const ALLOWED = new Set(AGENTIC_RULES);

/**
 * @returns {{inScope: boolean, reason: string, alarm?: string}}
 *   `alarm` is set only when the answer is a symptom of something broken
 *   elsewhere, so the caller can raise it rather than merely record a refusal.
 */
export function checkScope(finding) {
  const rule = finding.rule;

  if (hasCodemod(rule)) {
    return {
      inScope: false,
      reason: `\`${rule}\` has a deterministic fixer and must never reach the agentic path.`,
      alarm: `ROUTING BUG: ${rule} at ${finding.file}:${finding.line} has a codemod but was sent to the LLM. `
        + 'Every pull request tripping this rule is now paying for a fix that is already free.'
    };
  }

  if (!ALLOWED.has(rule)) {
    return {
      inScope: false,
      reason: `\`${rule}\` is outside the agreed agentic scope.`,
      alarm: `SCOPE CREEP: ${rule} at ${finding.file}:${finding.line} is neither codemod-fixable nor on the `
        + 'agentic list. Either a codemod regressed or a new rule appeared and nobody decided who owns it.'
    };
  }

  return { inScope: true, reason: `\`${rule}\` is on the agentic list.` };
}

/**
 * Split a batch, surfacing every alarm rather than only the first.
 * Callers are expected to print `alarms` before doing anything else.
 */
export function partitionByScope(findings) {
  const inScope = [];
  const outOfScope = [];
  const alarms = [];
  for (const f of findings) {
    const v = checkScope(f);
    if (v.inScope) inScope.push(f);
    else {
      outOfScope.push({ ...f, scopeReason: v.reason });
      if (v.alarm) alarms.push(v.alarm);
    }
  }
  return { inScope, outOfScope, alarms };
}
