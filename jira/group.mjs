/**
 * Findings -> ticket groups.
 *
 * One ticket per `module_prefix + rule_key + severity`, which is the grouping
 * the catalogue and the plan schema already use. Grouping at all is the point:
 * four `typescript:S3358` findings in one file are one piece of work for one
 * person, and four tickets for it is how a Jira board becomes something people
 * stop reading.
 *
 * ## The fingerprint has to survive being a Jira label
 *
 * Spec §8.2 wants lookup by `group_fingerprint`. The correct home for that is a
 * custom field, which needs site-admin configuration and a per-site field id —
 * portable to exactly one Jira. Labels work everywhere, so labels it is, and
 * that constrains the format: **Jira labels cannot contain spaces**, and
 * anything outside `[A-Za-z0-9_-]` is asking for trouble. So the fingerprint is
 * emitted as `gf-<hex>` rather than base64, which would contain `+`, `/` and
 * `=`.
 */
import { createHash } from 'node:crypto';

/** `api/src/reports/summary.js` -> `api` — the same prefix the plan groups by. */
export function moduleOf(file) {
  return String(file || '').split('/')[0] || 'root';
}

export function groupKey(finding) {
  return `${moduleOf(finding.file)}|${finding.rule}|${finding.severity || 'UNKNOWN'}`;
}

/** Label-safe, stable across re-scans, and short enough to read on a board. */
export function fingerprint(key) {
  return `gf-${createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
}

/**
 * Sonar's project key contains a `_`, which labels allow, but anything else a
 * project key might contain does not. Sanitising here rather than trusting the
 * input is what stops one odd project key from making every ticket unfindable.
 */
export function projectLabel(projectKey) {
  return String(projectKey || '').replace(/[^A-Za-z0-9_-]/g, '-');
}

export function groupFindings(findings, { projectKey } = {}) {
  const groups = new Map();
  for (const f of findings) {
    const key = groupKey(f);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        fingerprint: fingerprint(key),
        module: moduleOf(f.file),
        rule: f.rule,
        severity: f.severity || 'UNKNOWN',
        findings: [],
        labels: [projectLabel(projectKey), fingerprint(key)].filter(Boolean)
      });
    }
    groups.get(key).findings.push(f);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
