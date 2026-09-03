/**
 * The ticketing step, as the workflow calls it.
 *
 * ## Optional is a property of the architecture, not a flag bolted on
 *
 * Nick's requirement was that remediation try to fix things without waiting on
 * a Jira round trip. That is affordable here for one reason only: spec §4.1
 * already made the plan JSON the system of record and Jira a **projection** of
 * it. Turning off a projection costs nothing. Had Jira been the state store,
 * this switch would have been a rewrite — worth saying out loud, because it is
 * the design property that bought the option.
 *
 * ## The ticket exists before the work does, not after
 *
 * This runs as its own entry point *before* `remediate.mjs` and before any
 * GitHub-side change lands — a group only needs `findings`, never a
 * remediation outcome, to be filed. `remediation` here is optional precisely
 * so that "file first" and "turn Jira on after remediation already ran" are
 * the same code path: `dispositionsFrom(null)` is an empty map, so an
 * early-stage call and a late one differ only in how much a ticket's body
 * already knows, never in whether it runs. Nothing downstream *reads* this
 * step's result and remediation never waits on it — optional and non-blocking
 * stays true regardless of when it runs.
 *
 * The same entry point runs again after remediation, a push and a re-scan —
 * see `ctx.verdict` below — to record the outcome on tickets that already
 * exist, not to file new ones for work already done.
 *
 * ## Disabled is silent; enabled-but-unconfigured is red
 *
 * These are opposite situations wearing similar clothes. `--enabled false`
 * means nobody asked for tickets: say so and exit 0. Enabled with no
 * credential means somebody *did* ask and did not get them, and exiting 0 on
 * that is how a pipeline reports success for work it never did.
 *
 * Usage:
 *   node jira/run.mjs <findings.json> [--enabled] [--plan plan.json]
 *                     [--pr N] [--pr-url URL] [--dispositions disp.json]
 *                     [--verdict ready|red] [--reason TEXT]
 *                     [--dry-run] [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { groupFindings, NEEDS_WORK_LABEL, READY_LABEL } from './group.mjs';
import { renderBody, summaryFor, dispositionFor, resolvedComment, verdictComment } from './body.mjs';
import {
  configFromEnv, createIssue, addComment, updateLabels, getIssue, isOpen, JiraUnavailable
} from './client.mjs';
import { resolveExisting } from './dedupe.mjs';
import { readPlan, planIndex, recordIssueKey, writePlan } from './plan.mjs';
import { writeBackGroup } from './writeback.mjs';
import { fetchRules } from '../codemods/sonar-rules.mjs';

const idOf = (f) => `${f.rule}|${f.file}|${f.line}`;

/**
 * What the automation already did with each group, so the ticket is not silent
 * about work that happened before it existed.
 *
 * This is also the whole of the answer to "turn Jira on mid-flight": the
 * findings are the same findings, the groups are the same groups, and the only
 * difference is that some of them now carry an outcome. Nothing errors,
 * because nothing here assumed it was running first.
 */
export function dispositionsFrom(remediation) {
  const m = new Map();
  if (!remediation) return m;
  for (const f of remediation.refused || []) {
    m.set(idOf(f), { refusedByPolicy: true, reason: f.policyReason || '' });
  }
  for (const f of remediation.needsAgent || []) m.set(idOf(f), { awaitingAgent: true });
  // `alreadyGone` counts as resolved, because apply.mjs defines it that way:
  // a finding cleared as a side effect of a co-located fix is fixed. Disagreeing
  // with that here would leave a group whose findings were ALL cleared that way
  // with no disposition at all — a ticket silent about work that is already done.
  for (const r of remediation.results || []) {
    if (r.changed || r.alreadyGone) m.set(idOf(r), { resolvedDeterministically: true });
  }
  return m;
}

function dispositionForGroup(group, map) {
  for (const f of group.findings) {
    const d = map.get(idOf(f));
    const text = dispositionFor(group, d);
    if (text) return text;
  }
  return null;
}

/**
 * @returns {Promise<{ran: boolean, reason?: string, tickets: Array, created: number,
 *                    deduped: number, writeBack: object}>}
 */
export async function runJira(findings, {
  enabled = false,
  config = configFromEnv(),
  planPath = null,
  dryRun = false,
  remediation = null,
  sonar = {},
  ctx = {},
  options = {},
  log = () => {}
} = {}) {
  if (!enabled) {
    return { ran: false, reason: 'ticketing is off (jira: false), which is the default',
      disabled: true, tickets: [], created: 0, deduped: 0 };
  }
  if (!config.configured) {
    return { ran: false, disabled: false,
      reason: `ticketing was requested but is not configured: ${config.missing.join(', ')} unset`,
      tickets: [], created: 0, deduped: 0 };
  }

  const groups = groupFindings(findings, { projectKey: sonar.projectKey });
  const rules = await fetchRules(groups.map((g) => g.rule), {
    org: sonar.org, token: sonar.readToken || sonar.token, fetchImpl: options.fetchImpl
  });
  const dispositions = dispositionsFrom(remediation);
  const plan = readPlan(planPath);
  const index = planIndex(plan);

  const tickets = [];
  let created = 0;
  let deduped = 0;
  const writeBack = { written: 0, attempted: 0, permitted: null, reason: null };

  for (const group of groups) {
    const existing = await resolveExisting(group, { config, index, options });
    const body = renderBody(group, rules.get(group.rule), {
      ...ctx, disposition: dispositionForGroup(group, dispositions)
    });

    if (existing.key) {
      deduped += 1;
      const planItem = plan.items?.find((i) => i.group_fingerprint === group.fingerprint);
      // A regression: the resolved-pass below already marked this ticket
      // `ready` on a scan that stopped reporting the group, and now a later
      // scan reports it again. The label must not be left saying `ready`
      // while `findings` — the thing it is supposed to reflect — disagrees.
      const regressed = planItem?.status === 'Verified';
      if (!dryRun) {
        await addComment(config, existing.key,
          (regressed ? 'Reopened — reported again after a previous scan showed it resolved: '
            : 'Still reported on the latest scan: ')
          + `${group.findings.length} ${group.rule} finding(s) in ${group.module}.`
          + (ctx.prUrl ? `\n\nPull request: ${ctx.prUrl}` : ''), options);
        if (regressed) {
          await updateLabels(config, existing.key, { add: [NEEDS_WORK_LABEL], remove: [READY_LABEL] }, options);
        }
        if (ctx.verdict) {
          await addComment(config, existing.key, verdictComment(group, ctx.verdict, ctx), options);
        }
      }
      if (regressed) { planItem.status = 'Ticketed'; if (planPath) writePlan(planPath, plan); }
      tickets.push({ group: group.fingerprint, key: existing.key, action: 'deduped',
        source: existing.source, note: existing.note, regressed });
      log(`= ${group.key} -> ${existing.key} (${existing.source})`);
      continue;
    }

    if (dryRun) {
      tickets.push({ group: group.fingerprint, key: null, action: 'would-create',
        summary: summaryFor(group), labels: group.labels, body });
      continue;
    }

    const ticket = await createIssue(config, {
      summary: summaryFor(group), description: body, labels: group.labels
    }, options);
    created += 1;

    // Recorded immediately, not batched: the gap between creating a ticket and
    // remembering it is the only window in which a crash produces a duplicate,
    // and batching would widen that window to the length of the whole run.
    recordIssueKey(plan, group, ticket.key);
    if (planPath) writePlan(planPath, plan);

    const wb = await writeBackGroup(group, ticket, {
      token: sonar.token, host: sonar.host, fetchImpl: options.fetchImpl
    });
    writeBack.written += wb.written;
    writeBack.attempted += wb.attempted;
    if (writeBack.permitted === null) writeBack.permitted = wb.permitted;
    else writeBack.permitted = writeBack.permitted && wb.permitted;
    if (!wb.permitted && !writeBack.reason) writeBack.reason = wb.reason;

    tickets.push({ group: group.fingerprint, key: ticket.key, url: ticket.url,
      action: 'created', writeBack: wb.written });
    log(`+ ${group.key} -> ${ticket.key}`);
  }

  // Groups the plan ticketed before that `findings` no longer reports at
  // all. Absence is only a trustworthy "fixed" signal when `findings` is a
  // WHOLE-PROJECT view (branch:main, say) — a PR-scoped fetch reflects that
  // PR's own diff, and a file the PR has never touched is absent from it
  // for exactly the same reason a genuinely fixed file would be: neither
  // one shows up. Confirmed live (2026-09-03): a freshly-opened, not-yet-
  // remediated group-PR whose diff had not yet touched the flagged file got
  // its ticket relabelled `ready` on the very first PR-scoped check, before
  // any fix had even been attempted. So this sweep runs ONLY for a
  // whole-project call (`ctx.prNumber` unset) — bulk onboarding's ticketing
  // pass, or a periodic branch:main sweep. A PR-scoped call (settle's
  // per-PR outcome pass, remediate.yml's ticket job) never marks anything
  // resolved; it can only comment on a group that IS still present via the
  // dedupe/regression path above. The direction this errs in is
  // deliberate — under-reporting "ready" is recoverable by a later sweep;
  // a false "ready" is not caught by anything downstream at all.
  const resolved = [];
  if (ctx.prNumber == null || ctx.prNumber === '') {
    const currentFingerprints = new Set(groups.map((g) => g.fingerprint));
    for (const item of plan.items || []) {
      if (!item.jira_issue_key || item.status === 'Verified') continue;
      if (currentFingerprints.has(item.group_fingerprint)) continue;

      if (dryRun) {
        resolved.push({ group: item.group_fingerprint, key: item.jira_issue_key, action: 'would-resolve' });
        continue;
      }

      // A ticket the plan still calls open may already be Done in Jira — a
      // human closed it, say. Nothing to relabel or comment on in that case.
      const issue = await getIssue(config, item.jira_issue_key, ['key', 'status'], options);
      if (!issue || !isOpen(issue)) continue;

      await updateLabels(config, item.jira_issue_key, { add: [READY_LABEL], remove: [NEEDS_WORK_LABEL] }, options);
      await addComment(config, item.jira_issue_key,
        resolvedComment({ rule: item.rule_key, module: item.module_prefix }, { prUrl: ctx.prUrl }), options);
      item.status = 'Verified';
      resolved.push({ group: item.group_fingerprint, key: item.jira_issue_key, action: 'resolved' });
      log(`✓ ${item.group_fingerprint} -> ${item.jira_issue_key} (ready)`);
    }
  }
  if (resolved.some((r) => r.action === 'resolved') && planPath) writePlan(planPath, plan);

  return { ran: true, tickets, created, deduped, resolved: resolved.length, resolvedTickets: resolved,
    groups: groups.length, writeBack, plan };
}

/** The PR comment, in the same shape the other stages report in. */
export function renderJiraReport(run) {
  const l = ['<!-- sonar-jira -->', '### Jira ticketing', ''];
  if (!run.ran) {
    l.push(run.disabled
      ? `**Not run.** ${run.reason}. Remediation does not wait for this step, `
        + 'so nothing below it was affected.'
      : `**Requested but did not run.** ${run.reason}. This is reported red rather `
        + 'than skipped, because somebody asked for tickets and did not get any.');
    return l.join('\n');
  }

  const resolvedCount = run.resolved || 0;
  l.push(`${run.groups} group(s): **${run.created} created**, **${run.deduped} already open**`
    + `${resolvedCount ? `, **${resolvedCount} now resolved**` : ''}.`, '');
  for (const t of run.tickets) {
    l.push(t.action === 'created'
      ? `- \`${t.group}\` → **${t.key}** (new, labelled \`needs-work\`)`
      : t.action === 'deduped'
        ? `- \`${t.group}\` → ${t.key} — ${t.regressed ? 'reopened, back to `needs-work`' : 'already open'}, found via ${t.source}`
        : `- \`${t.group}\` → would create \`${t.summary}\``);
  }
  for (const r of run.resolvedTickets || []) {
    l.push(r.action === 'resolved'
      ? `- \`${r.group}\` → ${r.key} — no longer reported, relabelled \`ready\``
      : `- \`${r.group}\` → ${r.key} — would relabel \`ready\``);
  }
  l.push('');

  if (run.writeBack && run.writeBack.permitted === false) {
    l.push(`**The Sonar back-link was not written.** ${run.writeBack.reason} `
      + 'The tickets exist and name their findings; the findings do not name the tickets.');
  } else if (run.writeBack && run.writeBack.attempted) {
    l.push(`Back-link written onto ${run.writeBack.written}/${run.writeBack.attempted} Sonar finding(s).`);
  }
  return l.join('\n');
}

export async function main(argv) {
  const args = argv.slice(2);
  const findingsPath = args.find((a) => !a.startsWith('--'));
  if (!findingsPath) {
    console.error('usage: jira/run.mjs <findings.json> [--enabled] [--plan plan.json] '
      + '[--pr N] [--pr-url URL] [--dispositions disp.json] '
      + '[--verdict ready|red] [--reason TEXT] [--dry-run] [--json out.json]');
    return 2;
  }
  const flag = (name) => args.includes(`--${name}`);
  const val = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

  const findings = JSON.parse(readFileSync(findingsPath, 'utf8'));

  // What remediate.mjs already decided about each finding. Absent is fine and
  // means "nothing ran before this" — the tickets then simply carry no
  // disposition, rather than the step refusing to file them.
  const dispPath = val('dispositions');
  const remediation = dispPath ? JSON.parse(readFileSync(dispPath, 'utf8')) : null;

  // settle's classify() verdict, for the second call — after remediation, a
  // push and a re-scan — that records the outcome on tickets already filed.
  // Absent on the first call, which runs before any of that has happened.
  const verdictState = val('verdict');
  const verdict = verdictState ? { state: verdictState, reason: val('reason') || '' } : null;

  let run;
  try {
    run = await runJira(findings, {
      enabled: flag('enabled'),
      planPath: val('plan') || null,
      dryRun: flag('dry-run'),
      remediation,
      sonar: {
        org: process.env.SONAR_ORG,
        projectKey: process.env.SONAR_PROJECT_KEY,
        token: process.env.SONAR_TOKEN,
        readToken: process.env.SONAR_TOKEN_READ
      },
      ctx: { prNumber: val('pr'), prUrl: val('pr-url'), verdict },
      log: (m) => console.log(m)
    });
  } catch (e) {
    if (e instanceof JiraUnavailable) {
      console.error(`Jira is unusable [${e.classification}]: ${e.message}`);
      return 1;
    }
    throw e;
  }

  const out = val('json');
  if (out) writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`);
  console.log(renderJiraReport(run));

  // Disabled is success. Requested-and-unconfigured is not.
  if (!run.ran) return run.disabled ? 0 : 1;
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv).then((c) => { process.exitCode = c; });
}
