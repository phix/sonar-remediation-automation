/**
 * The remediation run: policy -> fix -> test -> report.
 *
 * Order is the whole design. Eligibility is decided BEFORE any engine sees a
 * finding, so a refusal cannot be argued away by a fixer that happens to know
 * how. Then the deterministic path runs. Only what is left over — eligible,
 * and with no codemod — is the agentic path's business, and that is the single
 * point in this system where an LLM call is permitted.
 *
 * This does not commit or push; the workflow owns git. Keeping them apart is
 * what makes the interesting half runnable on a laptop.
 *
 * Usage:
 *   node codemods/remediate.mjs <findings.json> --root DIR [--dry-run] [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { partition, DEFAULT_POLICY } from './policy.mjs';
import { applyAll, summarize } from './apply.mjs';
import { fixerFor } from './registry.mjs';

export function remediate(findings, { root = '.', dryRun = false, policy = DEFAULT_POLICY } = {}) {
  const { eligible, refused } = partition(findings, policy);

  // Eligible but with no deterministic fixer: this, and only this, is what the
  // agentic path exists for.
  const needsAgent = eligible.filter((f) => !fixerFor(f.rule));
  const codemoddable = eligible.filter((f) => fixerFor(f.rule));

  const results = codemoddable.length ? applyAll(codemoddable, { root, dryRun }) : [];
  const stats = summarize(results);

  return {
    refused,
    needsAgent,
    results,
    stats,
    ratio: {
      total: findings.length,
      refusedByPolicy: refused.length,
      resolvedDeterministically: stats.resolved || 0,
      awaitingAgent: needsAgent.length,
      refusedByFixer: stats.refused || 0,
      failed: stats.failed || 0
    }
  };
}

/** One commit per rule group — `module|rule` matches the plan's grouping. */
export function groupForCommit(finding) {
  const module = (finding.file || '').split('/')[0] || 'root';
  return `${module}|${finding.rule}`;
}

export function commitPlan(results) {
  const groups = new Map();
  for (const r of results.filter((x) => x.changed)) {
    const key = groupForCommit(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    files: [...new Set(items.map((i) => i.file))],
    message: `Fix ${items.length} ${key.split('|')[1]} finding${items.length === 1 ? '' : 's'} in ${key.split('|')[0]}`,
    findings: items
  }));
}

export function renderReport(run) {
  const { ratio, refused, needsAgent, results } = run;
  const l = [];
  l.push('<!-- sonar-remediation -->');
  l.push('### Automated remediation');
  l.push('');
  l.push('| Outcome | Findings |');
  l.push('|---|---|');
  l.push(`| Fixed deterministically | **${ratio.resolvedDeterministically}** |`);
  l.push(`| Awaiting the agentic path | ${ratio.awaitingAgent} |`);
  l.push(`| Refused by policy | ${ratio.refusedByPolicy} |`);
  if (ratio.refusedByFixer) l.push(`| Refused by a fixer | ${ratio.refusedByFixer} |`);
  if (ratio.failed) l.push(`| Failed | ${ratio.failed} |`);
  l.push(`| **Total reported** | **${ratio.total}** |`);
  l.push('');

  const pct = ratio.total ? Math.round((ratio.resolvedDeterministically / ratio.total) * 100) : 0;
  l.push(`**${pct}% of reported findings were resolved with no LLM call.** That ratio is the `
    + 'argument this pipeline makes: a rule with no codemod costs money and latency on every '
    + 'pull request that trips it.');
  l.push('');

  if (refused.length) {
    l.push('#### Refused by policy — these block the merge and are not waived', '');
    for (const r of refused) l.push(`- \`${r.rule}\` at \`${r.file}:${r.line}\` — ${r.policyReason}`);
    l.push('');
  }
  if (needsAgent.length) {
    const byRule = new Map();
    for (const n of needsAgent) byRule.set(n.rule, (byRule.get(n.rule) || 0) + 1);
    l.push('#### No deterministic fixer exists for these', '');
    for (const [rule, n] of [...byRule].sort()) l.push(`- \`${rule}\` × ${n}`);
    l.push('');
  }
  const changed = results.filter((r) => r.changed);
  if (changed.length) {
    l.push('<details><summary>Every deterministic edit</summary>', '');
    for (const r of changed) l.push(`- \`${r.file}:${r.line}\` — ${r.fixer}: ${r.reason}`);
    l.push('', '</details>');
  }
  return l.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const findingsFile = args.find((a) => !a.startsWith('--'));
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 ? args[rootIdx + 1] : '.';
  const jsonIdx = args.indexOf('--json');
  if (!findingsFile) { console.error('usage: remediate.mjs <findings.json> --root DIR'); process.exit(2); }

  const findings = JSON.parse(readFileSync(findingsFile, 'utf8'));
  const run = remediate(findings, { root, dryRun: args.includes('--dry-run') });

  for (const r of run.results) {
    const mark = r.changed ? 'FIXED  ' : r.alreadyGone ? 'ALREADY' : r.refused ? 'REFUSED' : r.failed ? 'FAILED ' : '-      ';
    console.log(`${mark} ${r.rule.padEnd(20)} ${r.file}:${r.line}  ${r.reason}`);
  }
  for (const r of run.refused) console.log(`POLICY  ${r.rule.padEnd(20)} ${r.file}:${r.line}  refused by policy`);
  for (const r of run.needsAgent) console.log(`AGENT   ${r.rule.padEnd(20)} ${r.file}:${r.line}  no codemod exists`);

  console.log('\ncommit plan:');
  for (const c of commitPlan(run.results)) console.log(`  ${c.message}  [${c.files.join(', ')}]`);

  console.log('\nratio:', JSON.stringify(run.ratio));
  if (jsonIdx >= 0) writeFileSync(args[jsonIdx + 1], JSON.stringify(run.ratio, null, 2));
  writeFileSync('remediation-comment.md', renderReport(run));
  process.exit(run.stats.failed > 0 ? 1 : 0);
}
