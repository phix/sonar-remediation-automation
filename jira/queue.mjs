/**
 * Which groups `onboard-backlog` should open this round, and how many.
 *
 * A fresh install can have hundreds of findings. Per
 * `docs/decisions/multi-entry-point-flow.md`, each finding-group gets its own
 * branch/PR/ticket rather than one giant PR — so onboarding a backlog means
 * fanning out many of these, and fanning out all of them at once would open
 * a wall of PRs nobody can review and blow through Sonar/GitHub API limits in
 * one run. This is the throttle: it answers "how many are already in flight"
 * and "which N should start next", and nothing else.
 *
 * ## What "in flight" means here
 *
 * A group counts as in flight when the plan already recorded a PR for it and
 * its status is not `Verified`. This is a plan-only approximation — it does
 * not check whether that PR is still open on GitHub, because that would make
 * this script make a network call for every group just to answer a capacity
 * question. The approximation holds because `jira/run.mjs`'s resolved-pass
 * already marks a group `Verified` once Sonar stops reporting it, which is
 * what happens after that PR merges — so a merged PR's group falls out of
 * "in flight" on its own, on the next run that also ran ticketing. A PR
 * closed WITHOUT merging is the gap: it stays counted until someone notices.
 * Accepted rather than solved here, the same way `jira-dedupe-order.md`
 * accepts the residual race after choosing the plan over the lagging index.
 *
 * Usage:
 *   node jira/queue.mjs <findings.json> --plan plan.json --max-concurrent 5
 *                       [--project-key KEY] [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { groupFindings } from './group.mjs';
import { readPlan, missingStages } from './plan.mjs';

function inFlightCount(plan) {
  return (plan.items || []).filter((i) => i.pr_number != null && i.status !== 'Verified').length;
}

const summarize = (g) => ({
  fingerprint: g.fingerprint, rule: g.rule, module: g.module,
  severity: g.severity, findingCount: g.findings.length
});

/**
 * @returns {{eligible: number, inFlight: number, capacity: number, selected: object[]}}
 */
export function nextBatch(findings, plan, { projectKey, maxConcurrent } = {}) {
  const groups = groupFindings(findings, { projectKey });
  const eligible = groups.filter((g) => {
    const item = (plan.items || []).find((i) => i.group_fingerprint === g.fingerprint);
    return missingStages(item).length > 0;
  });
  const inFlight = inFlightCount(plan);
  const capacity = Math.max(0, maxConcurrent - inFlight);
  return {
    eligible: eligible.length,
    inFlight,
    capacity,
    selected: eligible.slice(0, capacity).map(summarize)
  };
}

export async function main(argv) {
  const args = argv.slice(2);
  const findingsPath = args.find((a) => !a.startsWith('--'));
  const val = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
  if (!findingsPath || !val('max-concurrent')) {
    console.error('usage: jira/queue.mjs <findings.json> --plan plan.json --max-concurrent N '
      + '[--project-key KEY] [--json out.json]');
    return 2;
  }

  const findings = JSON.parse(readFileSync(findingsPath, 'utf8'));
  const plan = readPlan(val('plan'));
  const result = nextBatch(findings, plan, {
    projectKey: val('project-key'),
    maxConcurrent: Number(val('max-concurrent'))
  });

  const out = val('json');
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${result.selected.length} of ${result.eligible} eligible group(s) selected `
    + `(${result.inFlight} already in flight, capacity ${result.capacity}).`);
  console.log(JSON.stringify(result));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv).then((c) => { process.exitCode = c; });
}
