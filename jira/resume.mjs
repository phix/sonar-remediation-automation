/**
 * "Where does this group already stand?" — the lookup that makes
 * "start at any step, auto-continue the rest" actually work, rather than
 * being a property only the steps someone remembered to wire up have.
 *
 * A workflow holding a Jira key, a group fingerprint, or a PR number — any
 * one of the three, never all — calls this first and gets back what already
 * exists and what still doesn't, so it can skip straight to the next
 * undone stage instead of either redoing work or requiring a human to know
 * which button starts from where.
 *
 * Deliberately thin: this reads the plan (`plan.mjs`'s `findItem`/
 * `missingStages`) and reports it back as JSON. It does not decide whether
 * remediation still needs to run — that is a live question for the Sonar
 * gate, and this file answering it from a plan snapshot would be exactly the
 * staleness `jira-dedupe-order.md` already rejected for ticket search.
 *
 * Usage:
 *   node jira/resume.mjs --plan plan.json [--fingerprint gf-xxx | --jira-key SONAR-1 | --pr 5]
 *                        [--json out.json]
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readPlan, findItem, missingStages } from './plan.mjs';

/**
 * @returns {{found: boolean, item: object|null, missing: string[], next: string}}
 *   `next` is the single next stage to run — the first element of `missing`,
 *   or `'remediate'` once all three exist. Callers that only care about "is
 *   there anything left before remediation" want `missing`; callers driving
 *   a single `if` branch want `next`.
 */
export function resume(plan, identifier) {
  const item = findItem(plan, identifier);
  const missing = missingStages(item);
  return { found: !!item, item, missing, next: missing[0] || 'remediate' };
}

export async function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const val = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

  const identifier = {
    fingerprint: val('fingerprint'),
    jiraKey: val('jira-key'),
    pr: val('pr')
  };
  if (!identifier.fingerprint && !identifier.jiraKey && !identifier.pr) {
    console.error('usage: jira/resume.mjs --plan plan.json '
      + '[--fingerprint gf-xxx | --jira-key SONAR-1 | --pr 5] [--json out.json]');
    return 2;
  }

  const plan = readPlan(val('plan'));
  const result = resume(plan, identifier);

  const out = val('json');
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv).then((c) => { process.exitCode = c; });
}
