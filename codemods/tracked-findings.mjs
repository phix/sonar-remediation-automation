/**
 * Read findings from `.sonar-tracking/<fingerprint>.json` ledger files
 * instead of a live Sonar fetch.
 *
 * Exists because a PR-scoped Sonar query cannot see a pre-existing finding
 * on a file the PR's own diff has not touched yet — confirmed live
 * 2026-09-04 (docs/decisions/multi-entry-point-flow.md): a freshly-created
 * group-PR's "Fetch the PR findings from Sonar" step returned 0 findings,
 * so codemods/remediate.mjs was handed nothing and fixed nothing, even
 * with the LLM endpoint fully reachable. The ledger file `_branch-pr.yml`
 * commits when it opens that branch (docs/decisions/multi-entry-point-flow.md)
 * already carries the exact findings the group was ticketed for; this is
 * what lets remediate.yml use those instead of a query that structurally
 * cannot answer the question for a not-yet-touched file.
 *
 * remediate.yml deletes the ledger file in the same commit as a real fix
 * attempt, so a SECOND remediation run on the same branch finds no ledger
 * file here and falls back to a live PR-scoped fetch — correct at that
 * point, since the file is now genuinely part of the diff.
 *
 * Usage: node codemods/tracked-findings.mjs <out.json> [--dir .sonar-tracking]
 * Exit 0 and writes `out.json` if at least one ledger file was found;
 * exit 1 and writes nothing otherwise, so a caller can tell "used the
 * ledger" from "there was none" without parsing output.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function readTrackedFindings(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const findings = [];
  for (const file of files) {
    const ledger = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    findings.push(...(ledger.findings || []));
  }
  return findings;
}

export async function main(argv) {
  const args = argv.slice(2);
  const out = args.find((a) => !a.startsWith('--'));
  const val = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
  if (!out) {
    console.error('usage: codemods/tracked-findings.mjs <out.json> [--dir .sonar-tracking]');
    return 2;
  }

  const findings = readTrackedFindings(val('dir', '.sonar-tracking'));
  if (!findings.length) {
    console.log('no tracking ledger found; nothing written');
    return 1;
  }

  writeFileSync(out, JSON.stringify(findings, null, 1));
  console.log(`${findings.length} finding(s) read from the tracking ledger, written to ${out}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv).then((c) => { process.exitCode = c; });
}
