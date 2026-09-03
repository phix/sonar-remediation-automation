/**
 * Every group in a findings file, cross-referenced with whatever ticket the
 * plan already has for it.
 *
 * `_file-ticket.yml` runs this right after `jira/run.mjs` to hand its caller
 * (`onboard-backlog`) the list it fans a branch/PR matrix out over — group
 * identity plus the Jira key `jira/run.mjs` just created or found, in one
 * shape neither of those two scripts otherwise produces on its own.
 *
 * Usage:
 *   node jira/groups.mjs <findings.json> --plan plan.json [--project-key KEY] [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { groupFindings } from './group.mjs';
import { readPlan, findItem } from './plan.mjs';

export function listGroups(findings, plan, { projectKey } = {}) {
  return groupFindings(findings, { projectKey }).map((g) => {
    const item = findItem(plan, { fingerprint: g.fingerprint });
    return {
      fingerprint: g.fingerprint,
      rule: g.rule,
      module: g.module,
      severity: g.severity,
      findingCount: g.findings.length,
      jira_issue_key: item?.jira_issue_key || null
    };
  });
}

export async function main(argv) {
  const args = argv.slice(2);
  const findingsPath = args.find((a) => !a.startsWith('--'));
  const val = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  if (!findingsPath) {
    console.error('usage: jira/groups.mjs <findings.json> --plan plan.json [--project-key KEY] [--json out.json]');
    return 2;
  }

  const findings = JSON.parse(readFileSync(findingsPath, 'utf8'));
  const plan = readPlan(val('plan'));
  const groups = listGroups(findings, plan, { projectKey: val('project-key') });

  const out = val('json');
  if (out) writeFileSync(out, `${JSON.stringify(groups, null, 2)}\n`);
  console.log(JSON.stringify(groups));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv).then((c) => { process.exitCode = c; });
}
