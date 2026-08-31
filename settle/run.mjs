/**
 * The settle stage as a workflow calls it.
 *
 * `classify.mjs`, `gate.mjs` and `automerge.mjs` were built as libraries and
 * nothing has ever called them: there was no entry point and no npm script, so
 * the terminal-state decision existed only in tests. This is the seam that
 * makes it runnable.
 *
 * ## Red is not a failure of this program
 *
 * `red` is a correct, expected outcome — the sandbox's whole demonstration is
 * a gate that blocks. So a red verdict exits 0. The only non-zero exit is when
 * this stage could not do its job: auto-merge was asked for and could not be
 * delivered. Conflating "the PR is red" with "settle broke" would make the
 * demo's success indistinguishable from a tooling failure, and the blocking
 * itself is already branch protection's job, not this program's.
 *
 * ## Dispositions are optional, and their absence is not silent
 *
 * `dispositionSummary()` is produced by `remediate.mjs` in a DIFFERENT workflow
 * run — remediation pushes, the push re-triggers the scan, and only then does
 * settle have a gate worth reading. Getting that file across the boundary is an
 * artifact-passing decision that has not been made. Until it is, `--dispositions`
 * is optional, and omitting it is passed to `classify()` as the undetermined
 * input it genuinely is, producing a red that names the missing input rather
 * than a green that quietly ignored policy refusals.
 *
 * Usage:
 *   node settle/run.mjs --project KEY --pr N [--dispositions FILE]
 *                       [--auto-merge] [--pr-node-id ID] [--json OUT]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classify } from './classify.mjs';
import { fetchQualityGate, fetchScanStatus } from './gate.mjs';
import { runAutoMerge, configFromEnv } from './automerge.mjs';

export function renderSettleReport(verdict, gate, scan, merge) {
  const l = ['<!-- sonar-settle -->', '### Settle', ''];
  l.push(verdict.state === 'ready'
    ? '**Ready.** The quality gate passed and nothing is outstanding.'
    : `**Red.** ${verdict.reason}`);
  l.push('', '| Input | Read |', '|---|---|');
  l.push(`| Quality gate | ${gate.available === false ? `unreadable — ${gate.reason}` : gate.status} |`);
  l.push(`| Analysis run | ${scan.available === false ? `unreadable — ${scan.reason}` : scan.status} |`);
  if (merge && (merge.ran || !merge.disabled)) l.push(`| Auto-merge | ${merge.reason || (merge.ran ? 'enabled' : 'not run')} |`);
  return l.join('\n');
}

export async function main(argv, deps = {}) {
  const args = argv.slice(2);
  const flag = (n) => args.includes(`--${n}`);
  const val = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

  const project = val('project');
  const pr = val('pr');
  if (!project || !pr) {
    console.error('usage: settle/run.mjs --project KEY --pr N [--dispositions FILE] '
      + '[--auto-merge] [--pr-node-id ID] [--json OUT]');
    return 2;
  }

  const token = process.env.SONAR_TOKEN_READ || process.env.SONAR_TOKEN;
  const org = process.env.SONAR_ORG || 'phix';
  const fetchOpts = { pullRequest: pr, org, token, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };

  // Both are fetched even when the first is already unreadable: the report
  // names every input it could not read, and stopping at the first would hide
  // a second, independent problem behind it.
  const gate = await (deps.fetchQualityGate || fetchQualityGate)(project, fetchOpts);
  const scan = await (deps.fetchScanStatus || fetchScanStatus)(project, fetchOpts);

  let dispositions;
  const dfile = val('dispositions');
  if (dfile) {
    if (!existsSync(dfile)) {
      console.error(`--dispositions ${dfile} does not exist.`);
      return 2;
    }
    dispositions = JSON.parse(readFileSync(dfile, 'utf8'));
  }

  const verdict = classify(gate, scan, dispositions);

  const merge = await (deps.runAutoMerge || runAutoMerge)(verdict, { id: val('pr-node-id', configFromEnv().pullRequestId), number: Number(pr) }, {
    enabled: flag('auto-merge'),
    call: deps.call,
    log: (m) => console.log(m)
  });

  console.log(`settle: ${verdict.state} — ${verdict.reason}`);
  if (merge.reason) console.log(`auto-merge: ${merge.reason}`);

  writeFileSync('settle-comment.md', renderSettleReport(verdict, gate, scan, merge));
  const out = val('json');
  if (out) writeFileSync(out, JSON.stringify({ verdict, gate, scan, merge }, null, 2));

  // Asked for and not delivered. `disabled` means nobody asked, which is green.
  if (flag('auto-merge') && !merge.ran && !merge.disabled && verdict.state === 'ready') return 1;
  if (merge.failed) return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => process.exit(code));
}
