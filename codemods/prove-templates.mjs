/**
 * Prove the generated characterization tests are not decoration.
 *
 * A characterization test cannot fail against unfixed code — unfixed code
 * works, that is what a code smell is. What it CAN do is fail when the codemod
 * damages the module, which is the failure actually worth catching.
 *
 * So this writes a real module, generates its test, and runs that test three
 * times under vitest as a subprocess:
 *
 *   1. against the ORIGINAL module              -> must PASS
 *   2. against a CORRECTLY fixed module         -> must PASS
 *   3. against a module the fix damaged         -> must FAIL
 *
 * Step 3 is the one that matters. If it passes, the template asserts nothing.
 *
 * Usage: node codemods/prove-templates.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { renderCharacterizationTest, describeSurface } from './templates/characterization.mjs';
import { applyOne } from './apply.mjs';

const ORIGINAL = `const seed = [1, 2, 3];

export function total(xs) {
  const unusedTally = 0;
  return xs.reduce((a, b) => a + b, 0);
}

export function count(xs) {
  return xs.length;
}

export function seeds() {
  return [...seed];
}
`;

// What a codemod that deleted the wrong line looks like: it removed the
// exported function instead of the unused variable inside it.
const DAMAGED = `const seed = [1, 2, 3];

export function total(xs) {
  const unusedTally = 0;
  return xs.reduce((a, b) => a + b, 0);
}

export function seeds() {
  return [...seed];
}
`;

const dir = mkdtempSync(join(tmpdir(), 'codemod-proof-'));
const run = (label, moduleSource, testSource) => {
  const caseDir = join(dir, label);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, 'mod.js'), moduleSource);
  writeFileSync(join(caseDir, 'mod.test.js'), testSource);
  try {
    execFileSync('npx', ['vitest', 'run', '--root', caseDir, '--reporter', 'dot'],
      { stdio: 'pipe', encoding: 'utf8' });
    return 'PASS';
  } catch {
    return 'FAIL';
  }
};

const surface = await describeSurface(pathToFileURL(await writeTmp('base.js', ORIGINAL)).href);
async function writeTmp(name, src) {
  const p = join(dir, name);
  writeFileSync(p, src);
  return p;
}

const testSource = renderCharacterizationTest({
  file: 'mod.js', importPath: './mod.js',
  rule: 'javascript:S1481', fixer: 'remove-unused-variable', surface
});

const fixed = applyOne(ORIGINAL, 'mod.js', { rule: 'javascript:S1481', file: 'mod.js', line: 4 });
if (!fixed.changed) { console.error('setup failed: the fixer did not apply'); process.exit(1); }

const results = [
  ['original', run('original', ORIGINAL, testSource), 'PASS'],
  ['correctly-fixed', run('correctly-fixed', fixed.source, testSource), 'PASS'],
  ['damaged-by-fix', run('damaged-by-fix', DAMAGED, testSource), 'FAIL']
];

console.log('\n--- generated characterization test ---');
console.log(testSource.trim());
console.log('\n--- proof ---');
let ok = true;
for (const [label, got, want] of results) {
  const verdict = got === want ? 'ok  ' : 'BAD ';
  if (got !== want) ok = false;
  console.log(`${verdict} ${label.padEnd(16)} expected ${want}, got ${got}`);
}
rmSync(dir, { recursive: true, force: true });

console.log(ok
  ? '\nThe template passes a correct fix and catches a damaging one. It is not decoration.'
  : '\nThe template does not discriminate. It is decoration and must be rewritten.');
process.exit(ok ? 0 : 1);
