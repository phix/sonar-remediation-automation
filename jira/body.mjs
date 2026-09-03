/**
 * What a ticket says. The single `renderBody()` seam the API-version decision
 * is built on.
 *
 * v2 takes a plain string; v3 forces ADF, a nested document tree, for every
 * description and comment. The decision recorded in `api-contracts.md` §5.6 is
 * v2 — real code and real bugs for zero benefit at this fidelity. Keeping the
 * formatting in one function is what makes that reversible: an office Jira
 * stuck on v3 changes this file and nothing else.
 */
import { describeRule, ruleDocsUrl } from '../codemods/sonar-rules.mjs';

export function summaryFor(group) {
  const n = group.findings.length;
  return `[${group.module}] ${group.rule}: ${n} finding${n === 1 ? '' : 's'} (${group.severity})`;
}

/**
 * @param {object} group     from groupFindings()
 * @param {object} rule      from fetchRule(); may be unavailable
 * @param {object} ctx       { projectKey, prNumber, prUrl, dashboardUrl, disposition }
 */
export function renderBody(group, rule, ctx = {}) {
  const l = [];
  l.push(`SonarQube reported ${group.findings.length} `
    + `${group.rule} finding${group.findings.length === 1 ? '' : 's'} in ${group.module}.`);
  l.push('');

  l.push('Locations:');
  for (const f of group.findings) {
    l.push(`  * ${f.file}:${f.line}${f.message ? ` — ${f.message}` : ''}`);
  }
  l.push('');

  // Step 3 of #17: the ticket has to say what to actually do. This is the text
  // that was thought to be plan-gated and is not — it is merely not anonymous.
  l.push('How to fix');
  l.push(describeRule(rule, group.findings[0]));
  l.push('');

  if (ctx.disposition) {
    l.push('Automation disposition');
    l.push(`  ${ctx.disposition}`);
    l.push('');
  }
  if (ctx.prUrl) l.push(`Pull request: ${ctx.prUrl}`);
  if (ctx.dashboardUrl) l.push(`Sonar: ${ctx.dashboardUrl}`);
  l.push(`Rule reference: ${rule?.docs || ruleDocsUrl(group.rule)}`);
  l.push('');
  // Not decoration: this is what makes a ticket findable by the run that comes
  // after the one that created it.
  l.push(`Group fingerprint: ${group.fingerprint}`);
  return l.join('\n');
}

/**
 * How the automation describes what it did with a group, so the ticket is not
 * silent about work that already happened.
 */
export function dispositionFor(group, outcome) {
  if (!outcome) return null;
  if (outcome.refusedByPolicy) {
    return `Refused by policy and NOT auto-fixed. ${outcome.reason} This ticket is the whole of the work.`;
  }
  if (outcome.resolvedDeterministically) {
    return 'Fixed automatically by a deterministic codemod, with a characterization test. '
      + 'This ticket exists for the record; verify the fix rather than repeating it.';
  }
  if (outcome.awaitingAgent) {
    return 'No deterministic fixer exists for this rule. Queued for the model-backed path, '
      + 'which may still reject its own proposals — so this ticket may be the work.';
  }
  return null;
}

/**
 * Posted once a later scan stops reporting the group at all — the only signal
 * that is actually about *this* group's findings, rather than the PR's whole
 * quality gate (which can stay red on an unrelated axis, e.g. new-code
 * coverage, while every finding this ticket names is gone).
 */
export function resolvedComment(group, ctx = {}) {
  const what = group?.rule ? ` (${group.rule}${group.module ? ` in ${group.module}` : ''})` : '';
  const l = [`SonarQube no longer reports this${what} on the latest scan — marking **${ctx.readyLabel || 'Ready'}**.`];
  if (ctx.prUrl) l.push(`Pull request: ${ctx.prUrl}`);
  return l.join('\n\n');
}

/**
 * Posted on a group whose findings are STILL reported after a remediation
 * attempt ran — the failure-or-not-yet case, distinguished from
 * `resolvedComment` by the fact that Sonar still names this group.
 *
 * @param {{state: 'ready'|'red', reason?: string}} verdict settle's classify() output
 */
export function verdictComment(group, verdict, ctx = {}) {
  const l = [verdict.state === 'ready'
    ? 'Remediation ran and the quality gate is green, but this finding is still reported — '
      + 'not resolved by this pass.'
    : `Remediation ran but the quality gate is still red: ${verdict.reason}`];
  if (ctx.prUrl) l.push(`Pull request: ${ctx.prUrl}`);
  return l.join('\n\n');
}
