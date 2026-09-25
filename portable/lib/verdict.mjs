/**
 * The verdict, on the artifact.
 *
 * One comment, on the pull request the pass is scoped to. There is deliberately
 * no notification channel: a chat or mail path is a second copy of the truth,
 * it can drift from the change it describes, and it is the copy that leaves the
 * organisation's boundary. `docs/decisions/notify-pr-comment-only.md` in the
 * demo engine records the same decision.
 */

const line = (entry) => `- \`${entry.file}:${entry.line ?? '?'}\` — \`${entry.rule}\`: ${entry.reason}`;

export function comment({ plan, scan } = {}) {
  if (!plan) throw new Error('comment() needs a plan');

  const total = plan.totals || {};
  const refused = (plan.entries || []).filter((e) => e.engine === 'refused');
  const capped = (plan.entries || []).filter((e) => e.engine === 'capped');
  const model = (plan.entries || []).filter((e) => e.engine === 'model');

  const rows = [
    ['fixed deterministically', total.codemod || 0],
    ['awaiting the model', total.model || 0],
    ['refused by policy', total.refused || 0],
    ['over this pass\'s cap', total.capped || 0]
  ];

  const out = [
    `### Remediation plan — ${total.findings || 0} finding(s)`,
    '',
    `Policy \`${plan.policyVersion}\`, attempt cap ${plan.maxAttemptsPerFinding ?? '?'}.`,
    '',
    '| outcome | count |',
    '| --- | --- |',
    ...rows.map(([label, count]) => `| ${label} | ${count} |`)
  ];

  if (refused.length) {
    out.push('', '**Refused — never auto-fixed, whatever the fix would cost:**', ...refused.map(line));
  }
  if (capped.length) {
    out.push('', '**Over the cap this pass — carried by name, not dropped:**', ...capped.map(line));
  }
  if (model.length) {
    out.push('', '**Awaiting the model** (the residue the codemods could not cover):', ...model.map(line));
  }
  if (scan) {
    out.push(
      '',
      `**Re-scan:** ${scan.after ?? '?'} of ${scan.before ?? '?'} finding(s) still reported`
      + `${scan.gate ? ` — gate \`${scan.gate}\`` : ''}. The re-scan is the verification; `
      + 'a green suite cannot establish that a smell is gone.'
    );
  }
  return out.join('\n');
}
