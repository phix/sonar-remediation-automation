/**
 * Cut a findings file down to only the groups a caller named.
 *
 * `queue.mjs` decides WHICH groups get a branch/PR/ticket this round (the
 * concurrency cap); this is what turns that decision back into a findings
 * file `jira/run.mjs` can file tickets from, without re-teaching `run.mjs`
 * anything about capacity. Grouping identity (`groupKey`/`fingerprint`) is
 * independent of the project key label, so no project key is needed here.
 *
 * Usage:
 *   node jira/filter-findings.mjs <findings.json> --fingerprints gf-a,gf-b --out out.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { groupKey, fingerprint } from './group.mjs';

export function filterByFingerprint(findings, fingerprints) {
  const want = new Set(fingerprints);
  return findings.filter((f) => want.has(fingerprint(groupKey(f))));
}

export async function main(argv) {
  const args = argv.slice(2);
  const findingsPath = args.find((a) => !a.startsWith('--'));
  const val = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const fps = (val('fingerprints') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = val('out');

  if (!findingsPath || !fps.length || !out) {
    console.error('usage: jira/filter-findings.mjs <findings.json> --fingerprints gf-a,gf-b --out out.json');
    return 2;
  }

  const findings = JSON.parse(readFileSync(findingsPath, 'utf8'));
  const filtered = filterByFingerprint(findings, fps);
  writeFileSync(out, JSON.stringify(filtered, null, 1));
  console.log(`${filtered.length} of ${findings.length} finding(s) kept.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv).then((c) => { process.exitCode = c; });
}
