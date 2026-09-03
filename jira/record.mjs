/**
 * The CLI face of plan.mjs's record*() functions, for a workflow step that
 * only has scalars (a fingerprint, a branch name, a PR number) — not a full
 * `group` object with findings attached — to hand it.
 *
 * Deliberately update-only: every mode here requires the plan item to
 * already exist. `_file-ticket.yml` is what creates it (from real group
 * data, so `finding_ids`/`finding_count` are genuine); a caller that reaches
 * this file for a fingerprint the plan has never seen has skipped a stage,
 * and the fix is to run that stage, not to synthesize a group record here
 * from three scalars and a guess.
 *
 * Usage:
 *   node jira/record.mjs branch --plan plan.json --fingerprint gf-x --name BRANCH
 *   node jira/record.mjs pr     --plan plan.json --fingerprint gf-x --pr N [--auto-continue]
 *   node jira/record.mjs status --plan plan.json --fingerprint gf-x --value STATUS
 */
import { pathToFileURL } from 'node:url';
import { readPlan, writePlan, recordBranch, recordPR, recordStatus, findItem } from './plan.mjs';

const MODES = ['branch', 'pr', 'status'];

export async function main(argv) {
  const args = argv.slice(2);
  const mode = args[0];
  const val = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const flag = (name) => args.includes(`--${name}`);
  const planPath = val('plan');
  const fingerprint = val('fingerprint');

  if (!planPath || !fingerprint || !MODES.includes(mode)) {
    console.error(`usage: jira/record.mjs <${MODES.join('|')}> --plan plan.json --fingerprint gf-x `
      + '[--name BRANCH | --pr N [--auto-continue] | --value STATUS]');
    return 2;
  }

  const plan = readPlan(planPath);
  const existing = findItem(plan, { fingerprint });
  if (!existing) {
    console.error(`No plan item for fingerprint ${fingerprint} — file a ticket for it before recording a ${mode}.`);
    return 1;
  }
  const group = { fingerprint }; // record*() only reads .fingerprint once the item already exists (checked above)

  if (mode === 'branch') {
    const name = val('name');
    if (!name) { console.error('branch mode needs --name'); return 2; }
    recordBranch(plan, group, name);
  } else if (mode === 'pr') {
    const pr = val('pr');
    if (!pr) { console.error('pr mode needs --pr'); return 2; }
    recordPR(plan, group, pr, { autoContinue: flag('auto-continue') });
  } else {
    const value = val('value');
    if (!value) { console.error('status mode needs --value'); return 2; }
    recordStatus(plan, existing, value);
  }

  writePlan(planPath, plan);
  console.log(`recorded ${mode} for ${fingerprint}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv).then((c) => { process.exitCode = c; });
}
