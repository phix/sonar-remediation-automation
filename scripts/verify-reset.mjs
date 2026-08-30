#!/usr/bin/env node
/**
 * Assert that a reset actually restored what it claims to have restored.
 *
 * `demo-reset.yml` (sonar-sandbox-app) already does most of this inline in
 * shell — this module is that same reasoning, extracted somewhere it can be
 * unit-tested with zero network and zero repository mutation, plus the two
 * checks the workflow does not do at all.
 *
 * ## Why the reset gets no benefit of the doubt
 *
 * The reset is the one operation in this system that destroys work by
 * design, so it is the one that least deserves to be trusted on its own
 * report. A reset that reports success without checking is precisely the
 * failure this pipeline is built against.
 *
 * ## The box that matters most: PR #2's number
 *
 * PR #2's *number* is what Sonar PR analysis, Jira links and the required
 * status check are all keyed to. Closing and reopening the PR renumbers it
 * and breaks every one of those references — silently, because nothing
 * errors, the links just point at a closed PR. So this checks the PR by
 * number, not just "is there an open PR on this branch": OPEN, the expected
 * number, and its head at the restored branch tip.
 *
 * ## Idempotency is a property of what gets asserted, not of this module
 *
 * Every check below is a STATE fact ("X is at Y"), never an ACTION claim
 * ("X was just restored"). A state fact is true regardless of whether the
 * reset that produced it just ran or ran an hour ago and nothing has moved
 * since — which is exactly what "running the reset twice in a row" looks
 * like from here: the second run's state is identical to the first's, so
 * this reports the same pass both times rather than needing to know which
 * run it is.
 *
 * ## Two traps already paid for once
 *
 * `#14`: an empty PR diff happens only when the defective tip is CONTAINED
 * in main — having *diverged* from main is normal and fine, and asserting
 * the stricter "must descend from main" version breaks the moment main
 * advances on its own. `#9`: a required file added to main after the clean
 * tag was cut is silently gone on reset, and the failure it causes surfaces
 * three steps downstream with no visible link back to the reset.
 *
 *   node scripts/verify-reset.mjs --repo DIR --gh-repo owner/name --pr N
 *        [--base main] [--dirty-tag v0-pristine] [--clean-tag v0-clean]
 *        [--branch demo/planted-smells] [--branch-ref origin/demo/planted-smells]
 *        [--required-file path]...
 *
 * Exits non-zero if anything does not match the baseline. Reports every
 * check it ran, not just the first failure.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULTS = Object.freeze({
  base: 'main',
  dirtyTag: 'v0-pristine',
  cleanTag: 'v0-clean',
  dirtyBranch: 'demo/planted-smells',
  requiredFiles: Object.freeze(['sonar-project.properties', 'smells/catalogue.json', 'eslint.smells.config.mjs'])
});

/** The real `git`, scoped to a checkout. Throws on a non-zero exit, `.status`
 *  carrying the exit code and `.stderr` git's own explanation — the same
 *  shape a fake git must throw for the ancestry check to reason about it. */
export function realGit(repo) {
  return (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The real `gh`. Same throwing contract as {@link realGit}. */
export function realGh() {
  return (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const passed = (name, detail) => ({ name, ok: true, detail });
const failed = (name, detail) => ({ name, ok: false, detail });

/** git's own stderr is the actionable part of a failure; the generic
 *  "Command failed" message on the Error itself is not. */
function explain(e) {
  const stderr = e && e.stderr ? String(e.stderr).trim() : '';
  return stderr || e.message;
}

/**
 * @param {object} opts
 * @param {(...args: string[]) => string} opts.git - throws on failure
 * @param {(...args: string[]) => string} [opts.gh] - throws on failure; omit
 *   together with ghRepo/prNumber to skip the PR check entirely
 * @param {string} [opts.ghRepo] - "owner/name"
 * @param {number} [opts.prNumber]
 * @returns {{ ok: boolean, checks: Array<{name: string, ok: boolean, detail: string}>, summary: string }}
 */
export function verifyReset({
  git,
  gh = null,
  base = DEFAULTS.base,
  dirtyTag = DEFAULTS.dirtyTag,
  cleanTag = DEFAULTS.cleanTag,
  dirtyBranch = DEFAULTS.dirtyBranch,
  branchRef = `origin/${dirtyBranch}`,
  requiredFiles = DEFAULTS.requiredFiles,
  ghRepo = null,
  prNumber = null
} = {}) {
  if (!git) throw new Error('verifyReset requires a git callable');

  const checks = [];
  let dirtySha = null;
  let cleanSha = null;
  let mainSha = null;
  let branchSha = null;

  // ---- both tags resolve ---------------------------------------------------
  try {
    dirtySha = git('rev-parse', `${dirtyTag}^{commit}`);
    checks.push(passed('dirty tag resolves', `${dirtyTag} -> ${dirtySha}`));
  } catch (e) {
    checks.push(failed('dirty tag resolves', `${dirtyTag} does not resolve to a commit: ${explain(e)}`));
  }
  try {
    cleanSha = git('rev-parse', `${cleanTag}^{commit}`);
    checks.push(passed('clean tag resolves', `${cleanTag} -> ${cleanSha}`));
  } catch (e) {
    checks.push(failed('clean tag resolves', `${cleanTag} does not resolve to a commit: ${explain(e)}`));
  }

  // ---- the branch tip equals the dirty tag ---------------------------------
  if (dirtySha) {
    try {
      branchSha = git('rev-parse', branchRef);
      checks.push(branchSha === dirtySha
        ? passed('branch tip at dirty tag', `${dirtyBranch} is at ${dirtyTag} (${branchSha})`)
        : failed('branch tip at dirty tag', `${dirtyBranch} is at ${branchSha}, expected ${dirtyTag} (${dirtySha})`));
    } catch (e) {
      checks.push(failed('branch tip at dirty tag', `could not read ${branchRef}: ${explain(e)}`));
    }
  } else {
    checks.push(failed('branch tip at dirty tag', `skipped — ${dirtyTag} did not resolve`));
  }

  // ---- main equals the clean tag -------------------------------------------
  try {
    mainSha = git('rev-parse', base);
    if (cleanSha) {
      checks.push(mainSha === cleanSha
        ? passed('main at clean tag', `${base} is at ${cleanTag} (${mainSha})`)
        : failed('main at clean tag', `${base} is at ${mainSha}, ${cleanTag} is at ${cleanSha}`));
    } else {
      checks.push(failed('main at clean tag', `skipped — ${cleanTag} did not resolve`));
    }
  } catch (e) {
    checks.push(failed('main at clean tag', `could not read ${base}: ${explain(e)}`));
  }

  // ---- ancestry: the defective tip must not be CONTAINED in main (#14) ----
  // Diverged is normal; contained means the PR diff would come out empty.
  if (dirtySha && mainSha) {
    let isAncestor;
    try {
      git('merge-base', '--is-ancestor', dirtySha, mainSha); // exit 0 == is an ancestor
      isAncestor = true;
    } catch (e) {
      if (e.status === 1) {
        isAncestor = false; // git's documented "no" for --is-ancestor
      } else {
        throw e; // a real failure (bad object name, etc.) — do not read it as "no"
      }
    }
    checks.push(isAncestor
      ? failed('defective tip not merged into main',
          `${dirtyTag} is contained in ${base} — PR #${prNumber ?? '?'} looks merged; the PR diff would come out empty`)
      : passed('defective tip not merged into main',
          `${dirtyTag} carries commits ${base} does not (diverged, not an ancestor — this is normal)`));
  } else {
    checks.push(failed('defective tip not merged into main', 'skipped — missing the dirty tag or main sha'));
  }

  // ---- the restored tree still carries what the pipeline needs (#9) -------
  if (mainSha) {
    for (const path of requiredFiles) {
      try {
        git('cat-file', '-e', `${mainSha}:${path}`);
        checks.push(passed(`required file: ${path}`, `present on ${base}`));
      } catch {
        checks.push(failed(`required file: ${path}`,
          `missing on ${base} (${mainSha}) — the next scan fails for a reason with no visible link to this reset`));
      }
    }
  } else {
    checks.push(failed('required files present', `skipped — ${base} did not resolve`));
  }

  // ---- PR #N: open, unchanged number, head at the restored tip ------------
  if (gh && ghRepo && prNumber != null) {
    try {
      const raw = gh('pr', 'view', String(prNumber), '--repo', ghRepo, '--json', 'number,state,headRefOid');
      const pr = JSON.parse(raw);
      const problems = [];
      if (pr.number !== prNumber) problems.push(`number is ${pr.number}, expected ${prNumber}`);
      if (pr.state !== 'OPEN') {
        problems.push(`state is ${pr.state}, expected OPEN — a closed-and-reopened PR silently breaks every `
          + `Sonar/Jira reference keyed to #${prNumber}`);
      }
      if (branchSha && pr.headRefOid !== branchSha) {
        problems.push(`head is ${pr.headRefOid}, expected the restored branch tip ${branchSha}`);
      }
      checks.push(problems.length
        ? failed(`PR #${prNumber}`, problems.join('; '))
        : passed(`PR #${prNumber}`, `open, head ${pr.headRefOid}, number unchanged`));
    } catch (e) {
      checks.push(failed(`PR #${prNumber}`, `could not read the PR: ${explain(e)}`));
    }
  }
  // No gh/ghRepo/prNumber at all means the caller did not ask for the PR
  // check — the CLI is what makes it mandatory, this function stays generic.

  const failing = checks.filter((c) => !c.ok);
  return {
    ok: failing.length === 0,
    checks,
    summary: failing.length === 0
      ? `PASS — ${base} and ${dirtyBranch} both match the baseline`
        + (prNumber != null ? `, PR #${prNumber} unchanged` : '')
      : `FAIL — ${failing.length} check(s) failed: ${failing.map((c) => c.name).join(', ')}`
  };
}

export async function main(argv) {
  const args = argv.slice(2);
  const flag = (name, d = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
  const flagList = (name) => args.reduce((acc, a, i) => (a === `--${name}` ? [...acc, args[i + 1]] : acc), []);

  const repo = flag('repo', '.');
  const ghRepo = flag('gh-repo');
  const prArg = flag('pr');
  const prNumber = prArg != null ? Number(prArg) : null;

  if (!ghRepo || prNumber == null || Number.isNaN(prNumber)) {
    console.error('usage: verify-reset.mjs --repo DIR --gh-repo owner/name --pr N [--base main] '
      + '[--dirty-tag v0-pristine] [--clean-tag v0-clean] [--branch demo/planted-smells] '
      + '[--branch-ref origin/demo/planted-smells] [--required-file path]...');
    return 2;
  }

  const dirtyBranch = flag('branch', DEFAULTS.dirtyBranch);
  const requiredFiles = flagList('required-file');

  let result;
  try {
    result = verifyReset({
      git: realGit(repo),
      gh: realGh(),
      base: flag('base', DEFAULTS.base),
      dirtyTag: flag('dirty-tag', DEFAULTS.dirtyTag),
      cleanTag: flag('clean-tag', DEFAULTS.cleanTag),
      dirtyBranch,
      branchRef: flag('branch-ref', `origin/${dirtyBranch}`),
      requiredFiles: requiredFiles.length ? requiredFiles : undefined,
      ghRepo,
      prNumber
    });
  } catch (e) {
    console.error(`verify-reset could not run to completion: ${explain(e)}`);
    return 2;
  }

  console.log(`verify-reset: ${repo}  gh ${ghRepo}  PR #${prNumber}\n`);
  for (const c of result.checks) console.log(`  ${c.ok ? 'ok      ' : 'FAIL    '} ${c.name} — ${c.detail}`);
  console.log(`\n${result.summary}`);
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv).then((c) => { process.exitCode = c; });
}
