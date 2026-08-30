/**
 * A throwaway copy of the repository that a proposal is allowed to break.
 *
 * The gates in `validate.mjs` are only meaningful if a failing proposal can
 * genuinely fail — which means running the real build and the real suite,
 * which means somewhere they are allowed to go wrong. That is not the checkout
 * the workflow is going to push from. So each proposal is tried in a copy, and
 * only the text of an accepted fix ever travels back.
 *
 * `reset()` restores every file the workspace has touched, so a rejected
 * attempt leaves nothing behind for the next one to inherit. Restoring only
 * what was touched, rather than re-copying the tree, is what keeps a
 * two-attempt retry from costing two full copies.
 */
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runner } from './validate.mjs';

export function createWorkspace(sourceRoot, {
  buildCmd = ['npm', ['run', 'build']],
  suiteCmd = ['npm', ['test']],
  testCmd = (path) => ['npx', ['vitest', 'run', path]],
  timeoutMs = 300_000,
  prepare = null
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentic-'));
  cpSync(sourceRoot, root, { recursive: true, dereference: true });
  const run = runner({ cwd: root, timeoutMs });
  const pristine = new Map();   // relPath -> original contents, or null if it did not exist

  const remember = (rel) => {
    if (pristine.has(rel)) return;
    const abs = join(root, rel);
    pristine.set(rel, existsSync(abs) ? readFileSync(abs, 'utf8') : null);
  };

  return {
    root,
    async write(rel, contents) {
      remember(rel);
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    },
    read(rel) {
      return readFileSync(join(root, rel), 'utf8');
    },
    async reset() {
      for (const [rel, original] of pristine) {
        const abs = join(root, rel);
        if (original === null) rmSync(abs, { force: true });
        else writeFileSync(abs, original);
      }
      pristine.clear();
    },
    async runBuild() { return run(...buildCmd); },
    async runSuite() { return run(...suiteCmd); },
    async runTest(path) { return run(...testCmd(path)); },
    async setup() { return prepare ? run(...prepare) : { ok: true, stdout: '', stderr: '', code: 0 }; },
    dispose() { rmSync(root, { recursive: true, force: true }); }
  };
}
