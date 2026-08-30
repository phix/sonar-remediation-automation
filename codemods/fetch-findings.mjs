/**
 * Fetch the PR-scoped findings and write them in the shape the remediation
 * engine expects: { rule, file, line }.
 *
 * Reads anonymously — the sandbox project is public — so this needs no token
 * and works in a job that has none. SONAR_TOKEN is used when present.
 *
 * Usage: node .github/scripts/fetch-findings.mjs <projectKey> <pr> <out.json>
 */
import { writeFileSync } from 'node:fs';

const [projectKey, pr, out] = process.argv.slice(2);
if (!projectKey || !pr || !out) {
  console.error('usage: fetch-findings.mjs <projectKey> <pr> <out.json>');
  process.exit(2);
}

const BASE = (process.env.SONAR_HOST_URL || 'https://sonarcloud.io').replace(/\/$/, '');
const headers = { Accept: 'application/json' };
if (process.env.SONAR_TOKEN) headers.Authorization = `Bearer ${process.env.SONAR_TOKEN}`;

const issues = [];
for (let page = 1; ; page += 1) {
  const url = `${BASE}/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}`
    + `&pullRequest=${encodeURIComponent(pr)}&types=CODE_SMELL&statuses=OPEN,CONFIRMED,REOPENED&ps=500&p=${page}`;
  const res = await fetch(url, { headers });
  if (!res.ok) { console.error(`GET ${url} -> HTTP ${res.status}`); process.exit(1); }
  const body = await res.json();
  issues.push(...(body.issues || []));
  const total = body.paging?.total ?? body.total ?? issues.length;
  if (issues.length >= total || (body.issues || []).length === 0) break;
}

const findings = issues
  // A finding with no line cannot be located, and guessing where it lives is
  // exactly the kind of confident wrongness this pipeline is built against.
  .filter((i) => Number.isInteger(i.line))
  .map((i) => ({
    rule: i.rule,
    file: i.component.includes(':') ? i.component.split(':').slice(1).join(':') : i.component,
    line: i.line,
    severity: i.severity,
    message: i.message,
    hash: i.hash
  }));

const dropped = issues.length - findings.length;
writeFileSync(out, JSON.stringify(findings, null, 1));
console.log(`${findings.length} finding(s) written to ${out}`
  + (dropped ? ` (${dropped} skipped: no line number)` : ''));
