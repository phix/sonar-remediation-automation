// Diff what SonarQube actually reported against what the catalogue planted.
//
// The scan gate does not accept "the scan completed" as success. A workflow
// step that reports green because it *ran* rather than because it *achieved
// something* is the failure mode this whole pipeline is built against. So:
// pull the findings back, and assert every planted rule key actually appears.
//
//   node scripts/assert-catalogue-coverage.mjs \
//     --issues findings.json --catalogue catalogue.json [--report report.md]
//
// --issues accepts either one api/issues/search response or an array of pages,
// which is what paginating the Web API produces.
//
// Exit 1 if any catalogue rule key went unreported. Extra findings nobody
// planted are expected and are reported, not failed on — they become real
// grouping input for the planning workflow.
import { readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);
for (const required of ['issues', 'catalogue']) {
  if (!args[required]) {
    console.error(`missing --${required}`);
    process.exit(2);
  }
}

const raw = JSON.parse(readFileSync(args.issues, 'utf8'));
const pages = Array.isArray(raw) ? raw : [raw];
const issues = pages.flatMap((p) => p.issues || []);
const catalogue = JSON.parse(readFileSync(args.catalogue, 'utf8'));

// Sonar's `component` is `<projectKey>:<path>`. The catalogue speaks repo-
// relative paths, so strip the project prefix to compare like with like.
const filePath = (component) => component.slice(component.indexOf(':') + 1);

// Fingerprint on the content hash, not the line number — a deliberate
// deviation from spec §8.1. Line numbers shift on every unrelated edit above a
// finding, which would re-fingerprint the same defect constantly.
const fingerprint = (i) => `${i.rule}|${filePath(i.component)}|${i.hash ?? `line:${i.line}`}`;

const reported = new Map();
for (const issue of issues) {
  const key = issue.rule;
  if (!reported.has(key)) reported.set(key, []);
  reported.get(key).push({
    finding_id: issue.key,
    finding_fingerprint: fingerprint(issue),
    rule_key: issue.rule,
    severity: issue.severity,
    type: issue.type,
    file_path: filePath(issue.component),
    line: issue.line ?? null,
    message: issue.message
  });
}

const planted = new Map();
for (const smell of catalogue.smells) {
  if (!planted.has(smell.sonar_rule_key)) planted.set(smell.sonar_rule_key, []);
  planted.get(smell.sonar_rule_key).push(smell);
}

const rows = [];
let misses = 0;
for (const [rule, smells] of [...planted].sort()) {
  const found = reported.get(rule) ?? [];
  const expectedSeverity = smells[0].expected_severity;
  const actualSeverity = found.length ? found[0].severity : null;
  const severityMatches = !found.length || actualSeverity === expectedSeverity;
  const ok = found.length > 0 && severityMatches;
  if (!ok) misses += 1;
  rows.push({
    rule,
    planted: smells.length,
    reported: found.length,
    expectedSeverity,
    actualSeverity,
    ok,
    why: !found.length
      ? 'NOT REPORTED — the rule key is wrong, Sonar does not flag this pattern the way we assumed, or the smell did not land'
      : severityMatches
        ? ''
        : `severity mismatch: catalogue says ${expectedSeverity}, Sonar reported ${actualSeverity}`
  });
}

const unplanted = [...reported.keys()].filter((r) => !planted.has(r)).sort();

const lines = [
  '# Catalogue coverage',
  '',
  `${issues.length} finding(s) reported by Sonar · ${catalogue.smells.length} planted across ${planted.size} rule key(s)`,
  '',
  '| rule | planted | reported | severity | verdict |',
  '|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| \`${r.rule}\` | ${r.planted} | ${r.reported} | ${
        r.actualSeverity ?? '—'
      } | ${r.ok ? 'ok' : `**MISS** — ${r.why}`} |`
  ),
  '',
  `## Findings nobody planted (${unplanted.length})`,
  '',
  'Expected and fine. These are real grouping input for the planning workflow.',
  '',
  ...(unplanted.length
    ? unplanted.map((r) => `- \`${r}\` × ${reported.get(r).length}`)
    : ['_none_'])
];

if (args.report) {
  writeFileSync(args.report, lines.join('\n') + '\n');
  console.log(`report written to ${args.report}`);
}

for (const r of rows.filter((r) => !r.ok)) {
  console.error(`MISS  ${r.rule}  ${r.why}`);
}
console.log(
  `${misses === 0 ? 'PASS' : 'FAIL'}  ${planted.size - misses}/${planted.size} planted rule key(s) ` +
    `reported, ${unplanted.length} unplanted rule key(s) also found`
);
if (misses > 0) process.exitCode = 1;
