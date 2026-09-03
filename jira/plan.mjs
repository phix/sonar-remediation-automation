/**
 * The plan JSON, read and written for exactly one purpose: which group already
 * has a ticket.
 *
 * ## Why the plan and not Jira
 *
 * Spec §4.1 makes the plan the system of record and Jira a projection of it,
 * and §5.3b of the API research is what turns that from an architectural
 * preference into a correctness requirement. Jira's JQL index updates
 * **asynchronously** from the write — measured at ~2s on the live site. A
 * second planning run started inside that window searches, finds nothing, and
 * creates a duplicate of the ticket the first run just made. That is precisely
 * the duplicate-issue problem spec §2.3 exists to prevent, arriving through
 * the mechanism meant to prevent it.
 *
 * The plan has no such window. It is a file, written by the run that created
 * the ticket, read by the run that comes next.
 *
 * ## This deliberately does not write a whole plan
 *
 * Building the plan is #16's job. This module reads whatever plan exists,
 * tolerates there being none, and touches only `jira_issue_key` and `status`.
 * Where a plan has no item for a group it appends one that satisfies
 * `docs/source/sonar_remediation_plan.schema.json` in full — every required
 * field is derivable from the group itself — so that a later, richer producer
 * finds a valid document rather than a half one.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** A missing plan is "we know nothing", not an error. */
export function readPlan(path) {
  if (!path || !existsSync(path)) return { items: [] };
  try {
    const plan = JSON.parse(readFileSync(path, 'utf8'));
    return { ...plan, items: Array.isArray(plan.items) ? plan.items : [] };
  } catch (e) {
    // A corrupt plan must not be silently treated as an empty one: that would
    // recreate every ticket the plan was holding.
    throw new Error(`Plan at ${path} is not readable JSON (${e.message}). `
      + 'Refusing to continue, because treating it as empty would duplicate every ticket it holds.');
  }
}

/** `group_fingerprint -> jira_issue_key`, for the keys the plan actually knows. */
export function planIndex(plan) {
  const m = new Map();
  for (const item of plan.items || []) {
    if (item.group_fingerprint && item.jira_issue_key) {
      m.set(item.group_fingerprint, item.jira_issue_key);
    }
  }
  return m;
}

/** Every required field of a schema item, derived from the group. */
function itemFor(group) {
  return {
    group_id: group.key,
    group_fingerprint: group.fingerprint,
    rule_key: group.rule,
    severity: group.severity,
    module_prefix: group.module,
    // The Sonar issue key where we have it, the content hash where we do not.
    // Both identify the finding; only the first can be written back to.
    finding_ids: group.findings.map((f, i) => f.key || f.hash || `${group.fingerprint}-${i}`),
    finding_count: group.findings.length,
    eligibility: { is_eligible: true, reason: 'grouped for ticketing' },
    status: 'Grouped',
    attempt_count: 0,
    // Populated by recordBranch()/recordPR() as a group moves through the
    // multi-entry-point flow (docs/decisions/multi-entry-point-flow.md).
    // null, not absent: a workflow reading this file with `node -e` or `jq`
    // should never have to distinguish "not yet reached" from "field renamed".
    branch_name: null,
    pr_number: null,
    auto_continue: false
  };
}

function findOrCreate(plan, group) {
  const items = plan.items || (plan.items = []);
  let item = items.find((i) => i.group_fingerprint === group.fingerprint);
  if (!item) { item = itemFor(group); items.push(item); }
  return item;
}

/**
 * Record a ticket against a group, in place, returning the plan.
 *
 * Called once per created ticket rather than once per run, on purpose: the
 * window between creating a ticket and recording it is the only window in
 * which a crash can produce a duplicate, and batching the writes until the end
 * would widen that window to the length of the whole run.
 */
export function recordIssueKey(plan, group, issueKey) {
  const item = findOrCreate(plan, group);
  item.jira_issue_key = issueKey;
  item.status = 'Ticketed';
  return plan;
}

/** Same immediate-write discipline as recordIssueKey, for the same reason. */
export function recordBranch(plan, group, branchName) {
  const item = findOrCreate(plan, group);
  item.branch_name = branchName;
  item.status = 'Branched';
  return plan;
}

/**
 * @param {boolean} autoContinue whether this group's PR should be picked up
 *   automatically once the scan it triggers resolves — read by the
 *   `workflow_run` watcher, which has no other way to know a human's intent
 *   from a run days in the past.
 */
export function recordPR(plan, group, prNumber, { autoContinue = false } = {}) {
  const item = findOrCreate(plan, group);
  item.pr_number = Number(prNumber);
  item.auto_continue = !!autoContinue;
  item.status = 'PRed';
  return plan;
}

/** A plain status update — 'Remediating', 'Settled-Ready', 'Settled-Red', 'Verified' — with no field to also set. */
export function recordStatus(plan, item, status) {
  item.status = status;
  return plan;
}

/** `group_fingerprint`, a Jira key, or a PR number — whichever a caller happens to be holding. */
export function findItem(plan, { fingerprint, jiraKey, pr } = {}) {
  const items = plan.items || [];
  if (fingerprint) return items.find((i) => i.group_fingerprint === fingerprint) || null;
  if (jiraKey) return items.find((i) => i.jira_issue_key === jiraKey) || null;
  if (pr != null) return items.find((i) => i.pr_number === Number(pr)) || null;
  return null;
}

/**
 * Which of ticket/branch/PR a group is still missing, in the order the flow
 * creates them. An empty array means all three exist — remediation is the
 * only stage left, and whether it still NEEDS to run is a live question for
 * Sonar/the gate to answer, not something this file tries to predict.
 */
export function missingStages(item) {
  const missing = [];
  if (!item || !item.jira_issue_key) missing.push('ticket');
  if (!item || !item.branch_name) missing.push('branch');
  if (!item || !item.pr_number) missing.push('pr');
  return missing;
}

export function writePlan(path, plan) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
  return path;
}
