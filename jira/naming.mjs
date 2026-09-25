/**
 * The branch and PR names for one group, computed in ONE place.
 *
 * Before this, the branch name was built in `_branch-pr.yml`'s bash and the PR
 * title in its github-script, in two different languages. They had to agree on
 * the Jira key and there was nothing making them. Now there is.
 *
 * ## The Jira key leads, the fingerprint stays
 *
 * The operator asked for the ticket number in the branch and the PR name, and
 * that is the first thing a human looks for on a board. The fingerprint stays
 * too, because it — not the ticket — is what makes a re-run find the branch it
 * already made instead of opening a second one for the same group.
 *
 * Jira is opt-in and off by default, so a group can legitimately have no key.
 * That is a shape, not a different code path: the key simply drops out of both
 * names and `sonar/gf-1a2b3c` is what you get.
 */
import { pathToFileURL } from 'node:url';

export const BRANCH_PREFIX = 'sonar/';

function keyOf(jiraKey) {
  return String(jiraKey ?? '').trim();
}

/** `sonar/SONAR-42-gf-1a2b3c`, or `sonar/gf-1a2b3c` when there is no ticket yet. */
export function branchNameFor({ jiraKey, fingerprint }) {
  const key = keyOf(jiraKey);
  return `${BRANCH_PREFIX}${key ? `${key}-` : ''}${fingerprint}`;
}

/**
 * The name every branch created before this change still has. Kept as a
 * lookup fallback — NOT as a second naming scheme — so a group ticketed
 * earlier keeps its existing branch and PR instead of gaining a duplicate
 * under the new name.
 */
export function legacyBranchNameFor({ fingerprint }) {
  return `${BRANCH_PREFIX}${fingerprint}`;
}

/** `[SONAR-42] [api] javascript:S1481: 3 findings (MAJOR)` */
export function prTitleFor({ jiraKey, module, rule, findingCount, severity }) {
  const key = keyOf(jiraKey);
  const n = Number(findingCount) || 0;
  const core = `[${module}] ${rule}: ${n} finding${n === 1 ? '' : 's'} (${severity})`;
  return key ? `[${key}] ${core}` : core;
}

/** Both names, for a caller that needs them together. */
export function namesFor(group, jiraKey) {
  const args = {
    jiraKey,
    fingerprint: group.fingerprint,
    module: group.module,
    rule: group.rule,
    findingCount: group.findings?.length ?? group.findingCount,
    severity: group.severity
  };
  return { branch: branchNameFor(args), legacyBranch: legacyBranchNameFor(args), title: prTitleFor(args) };
}

/**
 * The workflow calls this per group — once for the branch, once for the title —
 * rather than reimplementing either in bash or in JS.
 *
 *   node jira/naming.mjs branch --jira-key SONAR-42 --fingerprint gf-1a2b3c
 *   node jira/naming.mjs branch --fingerprint gf-1a2b3c --legacy
 *   node jira/naming.mjs title  --jira-key SONAR-42 --module api \
 *        --rule javascript:S1481 --finding-count 3 --severity MAJOR
 */
export function main(argv) {
  const args = argv.slice(2);
  const which = args[0];
  const val = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const fingerprint = val('fingerprint', '');

  if (which === 'branch') {
    const name = args.includes('--legacy')
      ? legacyBranchNameFor({ fingerprint })
      : branchNameFor({ jiraKey: val('jira-key', ''), fingerprint });
    process.stdout.write(`${name}\n`);
    return 0;
  }
  if (which === 'title') {
    process.stdout.write(`${prTitleFor({
      jiraKey: val('jira-key', ''),
      module: val('module', ''),
      rule: val('rule', ''),
      findingCount: val('finding-count', '0'),
      severity: val('severity', 'UNKNOWN')
    })}\n`);
    return 0;
  }
  process.stderr.write('usage: naming.mjs branch --fingerprint F [--jira-key K] [--legacy]\n'
    + '       naming.mjs title --jira-key K --module M --rule R --finding-count N --severity S\n');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
