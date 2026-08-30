#!/usr/bin/env node
/**
 * Stop a commit on `main` from silently disabling CI.
 *
 * THE FAILURE THIS PREVENTS. The demo branch and `main` both own copies of
 * some files. Edit one of those on `main` without making the branch's copy
 * byte-identical and the demo PR goes CONFLICTING. GitHub then computes no
 * merge ref — and a `pull_request` workflow runs FROM the merge ref, so it
 * does not run at all.
 *
 * The pull request shows zero checks. Zero checks looks exactly like "no
 * workflow is configured", so the natural reading is that the gate was never
 * set up, rather than that it was switched off by an unrelated docs edit.
 * It cost a wasted trigger and four diagnostic steps to find once; it would
 * cost that every time.
 *
 *   node scripts/branch-contract.mjs --repo DIR --base main --branch demo/planted-smells \
 *        [--gh-repo owner/name --pr 2]
 *
 * Exits non-zero on a collision. Suitable as a pre-push hook.
 */
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const REPO = flag('--repo', '.');
const BASE = flag('--base', 'main');
const BRANCH = flag('--branch');
const GH_REPO = flag('--gh-repo');
const PR = flag('--pr');

if (!BRANCH) {
  console.error('usage: branch-contract.mjs --repo DIR --base main --branch <branch> [--gh-repo owner/name --pr N]');
  process.exit(2);
}

const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitOrNull = (...a) => { try { return git(...a); } catch { return null; } };

const mergeBase = gitOrNull('merge-base', BASE, BRANCH);
if (!mergeBase) {
  console.error(`could not find a merge base between ${BASE} and ${BRANCH} — are both fetched?`);
  process.exit(2);
}

const listChanged = (from, to) => {
  const out = gitOrNull('diff', '--name-only', from, to);
  return out ? out.split('\n').filter(Boolean) : [];
};

// Files the BRANCH has modified since the fork point. These are the mines.
const branchOwned = new Set(listChanged(mergeBase, BRANCH));
// Files BASE has modified since the fork point.
const baseChanged = listChanged(mergeBase, BASE);

const contested = baseChanged.filter((f) => branchOwned.has(f));
const collisions = [];
for (const f of contested) {
  const a = gitOrNull('show', `${BASE}:${f}`);
  const b = gitOrNull('show', `${BRANCH}:${f}`);
  if (a === null || b === null) continue;  // deleted on one side; git handles it
  if (a !== b) collisions.push(f);
}

console.log(`branch contract: ${BASE} vs ${BRANCH}`);
console.log(`  merge base ${mergeBase.slice(0, 7)}`);
console.log(`  ${branchOwned.size} file(s) owned by the branch, ${baseChanged.length} changed on ${BASE}\n`);

if (contested.length && !collisions.length) {
  for (const f of contested) console.log(`  ok       ${f} — touched on both sides but byte-identical`);
}
for (const f of collisions) {
  console.log(`  CONFLICT ${f}`);
  console.log(`           Both ${BASE} and ${BRANCH} changed this file and they differ.`);
  console.log(`           Fix: make ${BASE}'s copy identical —  git -C ${REPO} checkout ${BRANCH} -- ${f}`);
}
if (!contested.length) console.log('  ok       no file is edited on both sides');

// A live mergeability check catches anything the file comparison misses.
if (GH_REPO && PR) {
  try {
    const raw = execFileSync('gh', ['pr', 'view', PR, '--repo', GH_REPO, '--json', 'mergeable,mergeStateStatus'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const { mergeable, mergeStateStatus } = JSON.parse(raw);
    const line = `  PR #${PR}: mergeable=${mergeable} state=${mergeStateStatus}`;
    if (mergeable === 'CONFLICTING') {
      console.log(`${line}  <-- no merge ref exists, so pull_request workflows are NOT running`);
      collisions.push(`PR #${PR} is CONFLICTING`);
    } else if (mergeable === 'UNKNOWN') {
      console.log(`${line}  (GitHub is still recomputing — re-check in a few seconds)`);
    } else {
      console.log(`${line}`);
    }
  } catch {
    console.log(`  note     could not read PR #${PR} (gh not authenticated?)`);
  }
}

console.log(`\n${collisions.length
  ? `${collisions.length} collision(s) — pushing this would stop the demo PR's checks from running`
  : 'no collisions — the demo PR stays mergeable'}`);
process.exit(collisions.length ? 1 : 0);
