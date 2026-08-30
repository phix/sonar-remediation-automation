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
 * So this is a separate entry point from `remediate.mjs`, run after it and
 * never before, and nothing downstream reads its result.
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
 *                     [--pr N] [--pr-url URL] [--dry-run] [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { groupFindings } from './group.mjs';
import { renderBody, summaryFor, dispositionFor } from './body.mjs';
import { configFromEnv, createIssue, addComment, JiraUnavailable } from './client.mjs';
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
  for (const r of remediation.results || []) {
    if (r.changed || r.status === 'resolved') {
      m.set(idOf(r.finding || r), { resolvedDeterministically: true });
    }
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
      // The existing ticket learns that the group is still live. Without this,
      // a ticket filed three scans ago looks stale when it is in fact current,
      // and "no duplicates" starts to read as "no news".
      if (!dryRun) {
        await addComment(config, existing.key,
          `Still reported on the latest scan: ${group.findings.length} `
          + `${group.rule} finding(s) in ${group.module}.`
          + (ctx.prUrl ? `\n\nPull request: ${ctx.prUrl}` : ''), options);
      }
      tickets.push({ group: group.fingerprint, key: existing.key, action: 'deduped',
        source: existing.source, note: existing.note });
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

  return { ran: true, tickets, created, deduped, groups: groups.length, writeBack, plan };
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

  l.push(`${run.groups} group(s): **${run.created} created**, **${run.deduped} already open**.`, '');
  for (const t of run.tickets) {
    l.push(t.action === 'created'
      ? `- \`${t.group}\` → **${t.key}** (new)`
      : t.action === 'deduped'
        ? `- \`${t.group}\` → ${t.key} — already open, found via ${t.source}`
        : `- \`${t.group}\` → would create \`${t.summary}\``);
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
      + '[--pr N] [--pr-url URL] [--dry-run] [--json out.json]');
    return 2;
  }
  const flag = (name) => args.includes(`--${name}`);
  const val = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

  const findings = JSON.parse(readFileSync(findingsPath, 'utf8'));
  let run;
  try {
    run = await runJira(findings, {
      enabled: flag('enabled'),
      planPath: val('plan') || null,
      dryRun: flag('dry-run'),
      sonar: {
        org: process.env.SONAR_ORG,
        projectKey: process.env.SONAR_PROJECT_KEY,
        token: process.env.SONAR_TOKEN,
        readToken: process.env.SONAR_TOKEN_READ
      },
      ctx: { prNumber: val('pr'), prUrl: val('pr-url') },
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
