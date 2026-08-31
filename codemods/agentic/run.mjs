/**
 * The agentic path as the workflow calls it.
 *
 * Deliberately a separate entry point from `remediate.mjs` rather than a flag
 * on it. The deterministic pass is synchronous, offline, and free; this one is
 * asynchronous, networked, and metered. Keeping them apart means the cheap
 * half stays runnable on a laptop with no credential at all, and means a
 * broken endpoint can never stop the 18 findings that never needed it.
 *
 * Order is still the design: this reads the SAME `needsAgent` list that
 * `remediate()` computed, so a finding with a codemod cannot arrive here even
 * by mistake — and `scope.mjs` raises an alarm if one somehow does.
 *
 * Usage:
 *   node codemods/agentic/run.mjs <findings.json> --root DIR [--json out.json] [--max-attempts N]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { remediate } from '../remediate.mjs';
import { fetchRules } from '../sonar-rules.mjs';
import { createWorkspace } from './workspace.mjs';
import { runAgentic, summarizeAgentic } from './agent.mjs';
import { configFromEnv } from './client.mjs';

export function renderAgenticReport(run, summary, deferred = []) {
  const l = ['<!-- sonar-agentic -->', '### Agentic remediation', ''];
  if (deferred.length) {
    // Named, not silently dropped. A capped run and an exhaustive one must
    // never produce the same-looking report, or the cap becomes a way to
    // claim coverage nobody had.
    l.push(`**${deferred.length} finding(s) were deferred by \`--max-findings\`** and were `
      + 'not attempted. They remain unresolved:', '',
      ...deferred.map((f) => `- \`${f.rule}\` ${f.file}:${f.line}`), '');
  }

  if (!run.ran) {
    l.push(`**This path did not run.** ${run.reason}.`, '',
      `${run.inScope.length} finding(s) that no codemod can fix were therefore left open. `
      + 'They are reported as unresolved rather than as absent, because a stage that never '
      + 'ran and a stage that found nothing are not the same result.');
    return l.join('\n');
  }

  l.push('| Outcome | Findings |', '|---|---|');
  l.push(`| Fixed and verified | **${summary.accepted}** |`);
  l.push(`| Rejected by a gate | ${summary.rejected} |`);
  if (summary.infraFailures) l.push(`| Endpoint unavailable | ${summary.infraFailures} |`);
  l.push(`| **Considered** | **${summary.considered}** |`, '');
  l.push(`Approximately ${summary.tokens} tokens. Every other finding in this pull request `
    + 'was resolved or refused without one.', '');

  for (const r of run.results.filter((x) => !x.accepted)) {
    const f = r.finding;
    l.push(`- \`${f.rule}\` at \`${f.file}:${f.line}\` — **${r.classification}**: ${r.summary}`);
    for (const rej of r.rejections || []) l.push(`  - rejected at \`${rej.gate}\`: ${rej.reason}`);
  }
  if (summary.alarms) {
    l.push('', '#### Alarms', '');
    for (const a of run.alarms) l.push(`- ${a}`);
  }
  return l.join('\n');
}

export async function main(argv) {
  const args = argv.slice(2);
  const findingsFile = args.find((a) => !a.startsWith('--'));
  const at = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
  const root = at('--root', '.');
  if (!findingsFile) { console.error('usage: run.mjs <findings.json> --root DIR [--max-findings N]'); return 2; }

  const findings = JSON.parse(readFileSync(findingsFile, 'utf8'));
  // Dry-run: we only want the routing decision, not the deterministic edits.
  // Those have already been applied by the time this runs.
  const { needsAgent } = remediate(findings, { root, dryRun: true });

  if (!needsAgent.length) {
    console.log('Nothing for the agentic path: every eligible finding had a codemod.');
    return 0;
  }
  console.log(`${needsAgent.length} finding(s) with no deterministic fixer.`);

  // A demo budget, not a correctness knob. Each finding costs a full
  // generate-and-verify round trip against a self-hosted 14B -- minutes, not
  // seconds -- so a ten-finding run is a coffee break and a two-finding run
  // still shows the whole mechanism.
  //
  // The findings NOT taken are reported as deferred, never dropped silently.
  // A capped run and an exhaustive run must not produce the same-looking
  // output, or the cap becomes a way to claim coverage nobody had.
  const maxFindings = Number(at('--max-findings', '0')) || 0;
  let deferred = [];
  let selected = needsAgent;
  if (maxFindings > 0 && needsAgent.length > maxFindings) {
    selected = needsAgent.slice(0, maxFindings);
    deferred = needsAgent.slice(maxFindings);
    console.log(`--max-findings ${maxFindings}: taking ${selected.length}, deferring ${deferred.length}.`);
  }

  const cfg = configFromEnv();
  if (!cfg.configured) {
    // Report loudly and exit red. A pipeline that quietly skipped its only
    // model-backed stage would report the same green as one that ran it.
    const run = { ran: false, reason: `the agentic path is not configured: ${cfg.missing.join(', ')} unset`,
      inScope: selected, outOfScope: [], alarms: [], results: [] };
    const report = renderAgenticReport(run, summarizeAgentic(run), deferred);
    writeFileSync('agentic-comment.md', report);
    console.log(`\n${run.reason}`);
    console.log(`${needsAgent.length} finding(s) left open. Set LLM_BASE_URL, LLM_MODEL and LLM_API_KEY to run it.`);
    return 1;
  }

  const rules = await fetchRules(selected.map((f) => f.rule), {
    org: process.env.SONAR_ORG || 'phix',
    token: process.env.SONAR_TOKEN_READ || process.env.SONAR_TOKEN
  });
  for (const [key, r] of rules) {
    if (!r.available) console.log(`  note: no guidance for ${key} (${r.reason}); the prompt is weaker for it.`);
  }

  const workspace = createWorkspace(root);
  let run;
  try {
    run = await runAgentic(selected, {
      root,
      workspace,
      config: cfg,
      maxProposalAttempts: Number(at('--max-attempts', '2')),
      rules,
      log: (m) => console.log(m)
    });
  } finally {
    workspace.dispose();
  }

  const summary = summarizeAgentic(run);
  console.log('\n', JSON.stringify(summary, null, 2));
  writeFileSync('agentic-comment.md', renderAgenticReport(run, summary, deferred));
  const jsonOut = at('--json', null);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(
    { summary, deferred: deferred.map((f) => ({ rule: f.rule, file: f.file, line: f.line })), results: run.results },
    null, 2));

  // Accepted fixes are written back into the real tree; the workflow commits.
  for (const r of run.results.filter((x) => x.accepted)) {
    writeFileSync(join(root, r.finding.file), r.fix);
    const abs = join(root, r.testPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, r.test);
    console.log(`wrote ${r.finding.file} and ${r.testPath}`);
  }

  return summary.accepted === summary.considered ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => process.exit(code));
}
