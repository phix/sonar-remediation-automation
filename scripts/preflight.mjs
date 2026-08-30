#!/usr/bin/env node
/**
 * Answer, in about two seconds, the questions a workflow otherwise answers in
 * two to four minutes of CI.
 *
 * WHY THIS EXISTS. Four of nine CI runs in one session failed on facts that
 * were knowable locally the whole time:
 *
 *   - a script the workflow runs did not exist on the branch it checks out
 *   - an npm script the workflow calls did not exist in THAT ref's package.json
 *   - a secret the workflow needs was set, but was not a valid credential
 *
 * The trap underneath all three is that `remediate` checks out the raw PR HEAD
 * branch while `sonar-pr-scan` runs on the merge ref. They see different
 * filesystems. Reasoning about one while running the other is easy, silent,
 * and costs a full round trip every time.
 *
 *   node scripts/preflight.mjs <workflow.yml> --repo DIR --ref REF [--gh-repo owner/name]
 *
 * Exits non-zero if anything would fail. Reports everything it finds before
 * exiting, so one run tells you all of it rather than the first problem only.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const workflow = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);

const REPO = flag('--repo', '.');
const REF = flag('--ref');
const GH_REPO = flag('--gh-repo');

if (!workflow || !REF) {
  console.error('usage: preflight.mjs <workflow.yml> --repo DIR --ref REF [--gh-repo owner/name]');
  process.exit(2);
}

const problems = [];
const notes = [];
const ok = [];

/** Read a path as it exists on `ref`, not as it exists in the working tree. */
function showAtRef(path) {
  try {
    return execFileSync('git', ['-C', REPO, 'show', `${REF}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function refExists() {
  try {
    execFileSync('git', ['-C', REPO, 'rev-parse', '--verify', `${REF}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

if (!refExists()) {
  console.error(`ref "${REF}" does not exist in ${REPO} — fetch it first`);
  process.exit(2);
}

const doc = parse(readFileSync(workflow, 'utf8'));
const steps = Object.values(doc.jobs || {}).flatMap((j) => j.steps || []);
const runScripts = steps.map((s) => s.run).filter(Boolean);
const allText = JSON.stringify(doc);

// ---- 1. every `node <path>` the workflow runs must exist on the ref ---------
// Paths under .automation/ come from a separate checkout of THIS repo, so they
// are resolved against the working tree instead.
const nodePaths = new Set();
for (const r of runScripts) {
  for (const m of r.matchAll(/\bnode\s+((?:\.\/)?[\w./@-]+\.(?:mjs|cjs|js))/g)) nodePaths.add(m[1]);
}
for (const p of nodePaths) {
  if (p.startsWith('.automation/')) {
    const local = p.replace(/^\.automation\//, '');
    if (existsSync(local)) ok.push(`node ${p} — present in this repo (checked out as .automation)`);
    else problems.push(`MISSING  ${p} — the workflow checks this repo out at .automation, and "${local}" is not here`);
  } else if (showAtRef(p) !== null) {
    ok.push(`node ${p} — present on ${REF}`);
  } else {
    problems.push(`MISSING  ${p} — not present on ${REF}. `
      + `The branch predates it; move it into the automation checkout or add it to the branch.`);
  }
}

// ---- 2. every `npm run <script>` must exist in THAT ref's package.json ------
const pkgRaw = showAtRef('package.json');
let pkgScripts = null;
if (pkgRaw === null) {
  problems.push(`MISSING  package.json on ${REF}`);
} else {
  try { pkgScripts = JSON.parse(pkgRaw).scripts || {}; }
  catch (e) { problems.push(`BROKEN   package.json on ${REF} does not parse: ${e.message}`); }
}
if (pkgScripts) {
  const wanted = new Set();
  for (const r of runScripts) {
    for (const m of r.matchAll(/\bnpm\s+run\s+([\w:-]+)/g)) wanted.add(m[1]);
  }
  for (const s of wanted) {
    if (s in pkgScripts) ok.push(`npm run ${s} — defined on ${REF}`);
    else problems.push(`MISSING  npm script "${s}" — not in package.json on ${REF}. `
      + `Available: ${Object.keys(pkgScripts).join(', ')}`);
  }
  if (/\bnpm\s+(ci|install)\b/.test(runScripts.join('\n')) && showAtRef('package-lock.json') === null) {
    problems.push(`MISSING  package-lock.json on ${REF} — \`npm ci\` requires it`);
  }
}

// ---- 3. every secret the workflow references must be set on the repo --------
// Existence only: validity needs the credential itself, which is write-only by
// design. The workflow's own probe step covers that — and it exists because a
// secret that was set and invalid cost two CI runs.
const secrets = new Set([...allText.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
secrets.delete('GITHUB_TOKEN');
if (secrets.size) {
  if (!GH_REPO) {
    notes.push(`secrets referenced (${[...secrets].join(', ')}) — pass --gh-repo to check they are set`);
  } else {
    let present = null;
    try {
      present = new Set(execFileSync('gh', ['api', `repos/${GH_REPO}/actions/secrets`, '--jq', '.secrets[].name'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean));
    } catch {
      notes.push('could not list repository secrets (gh not authenticated?) — skipped');
    }
    if (present) {
      for (const s of secrets) {
        if (present.has(s)) ok.push(`secret ${s} — set on ${GH_REPO} (validity is the workflow's probe step to prove)`);
        else problems.push(`MISSING  secret ${s} is not set on ${GH_REPO}. `
          + `A workflow can only read secrets from the repo it runs in.`);
      }
    }
  }
}

// ---- 4. warn when the workflow checks out a ref other than the one given ----
for (const s of steps) {
  if (typeof s.uses === 'string' && s.uses.startsWith('actions/checkout')) {
    const r = s.with && s.with.ref;
    if (r && !/\$\{\{/.test(String(r)) && String(r) !== REF) {
      notes.push(`a checkout step pins ref "${r}" but this preflight ran against "${REF}"`);
    }
  }
}

// ---- report ----------------------------------------------------------------
console.log(`preflight: ${workflow}`);
console.log(`  repo ${REPO}  ref ${REF}${GH_REPO ? `  gh ${GH_REPO}` : ''}\n`);
for (const o of ok) console.log(`  ok       ${o}`);
for (const n of notes) console.log(`  note     ${n}`);
for (const p of problems) console.log(`  ${p}`);
console.log(`\n${problems.length ? `${problems.length} problem(s) — this workflow would fail in CI` : 'no problems found'}`);
process.exit(problems.length ? 1 : 0);
