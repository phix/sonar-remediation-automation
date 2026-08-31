/**
 * The part that decides whether a model's answer is allowed to reach a branch.
 *
 * A model claiming it fixed something is evidence of nothing, so nothing here
 * reads the model's explanation — it did not ask for one. Every gate is a
 * mechanical question with a mechanical answer, and any gate can reject.
 * Rejection is not failure: it costs one retry from a cap that is always
 * finite.
 *
 * ## Why "the test must fail against the unfixed code" is not the gate here
 *
 * Issue #19 asks for a test that fails before the fix and passes after. For
 * the three rules this path owns — cognitive complexity, duplicated function
 * bodies, nested ternaries — that test cannot exist, and asking for it would
 * get one that lies. All three are behaviour-preserving refactorings: the
 * unfixed code is correct, which is precisely what makes it a *smell* rather
 * than a bug. Any test that failed against it would be asserting the smell,
 * and would then have to be deleted by the very fix it was written to guard.
 *
 * `prove-templates.mjs` reached the same wall for the codemod templates and
 * answered it the same way, so this is the house rule rather than a local
 * exception: the discriminating question is not "did it fail before" but
 * **"would it fail if the fix were wrong"**. So the accompanying test is run
 * against a deliberately broken copy of the model's own fix — the changed
 * function stubbed out to return undefined — and must fail there. A test that
 * survives that never exercised the code it was supposed to be guarding.
 */
import { execFile } from 'node:child_process';
import { apiFor } from '../core.mjs';
import { staticSurface } from '../templates/characterization.mjs';

/** Gate names, in the order they run. Cheapest and most specific first. */
export const GATES = Object.freeze(['admissible', 'testDiscriminates', 'build', 'suite', 'findingGone']);

export function reject(gate, reason, detail = null) {
  return { ok: false, gate, reason, detail };
}
export const accept = (gate, detail = null) => ({ ok: true, gate, detail });

/**
 * Gate 1 — is this even a candidate?
 *
 * Parses, actually differs, and does not change the module's public surface.
 * The surface check is the load-bearing one: it is what stops a "refactor"
 * that renames an export, drops one, or changes an arity, none of which the
 * build in this sandbox would necessarily catch and all of which break callers
 * the model was never shown.
 */
export function admissible({ original, proposed, filePath }) {
  if (proposed === original) return reject('admissible', 'the proposed file is byte-identical to the original');

  const j = apiFor(filePath);
  let before, after;
  try {
    before = staticSurface(j, j(original));
  } catch (e) {
    return reject('admissible', `the ORIGINAL file no longer parses: ${e.message}`);
  }
  try {
    after = staticSurface(j, j(proposed));
  } catch (e) {
    return reject('admissible', `the proposed file does not parse: ${e.message}`);
  }

  const key = (s) => `${s.name}/${s.kind}/${s.arity}`;
  const beforeKeys = before.map(key);
  const afterKeys = after.map(key);
  const lost = beforeKeys.filter((k) => !afterKeys.includes(k));
  const gained = afterKeys.filter((k) => !beforeKeys.includes(k));

  if (lost.length) {
    return reject('admissible',
      `the public surface changed: ${lost.join(', ')} no longer exported as before`,
      { lost, gained });
  }
  // Gaining an export is not automatically wrong — extracting a helper is a
  // normal way to cut complexity — but it is worth recording, because a fix
  // that grows the API is a bigger change than the finding asked for.
  return accept('admissible', gained.length ? { gained } : null);
}

/**
 * Replace the body of one exported function with `return undefined`.
 *
 * This is the mutant that gives the test something to fail against. It is a
 * deliberately blunt mutation: not "change a boundary condition" but "delete
 * the function entirely", because the question being asked is not "is this
 * test thorough" — it is the much weaker and much more often violated "does
 * this test call the thing at all".
 *
 * @returns {string|null} null when the symbol could not be found or stubbed,
 *   which the caller must treat as an inconclusive gate rather than a pass.
 */
export function stubSymbol(source, filePath, name) {
  const j = apiFor(filePath);
  let root;
  try { root = j(source); } catch { return null; }

  const stubBody = () => j.blockStatement([j.returnStatement(j.identifier('undefined'))]);
  let hit = 0;

  const blank = (node) => {
    if (!node) return;
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
        || node.type === 'ArrowFunctionExpression') {
      node.body = stubBody();
      node.expression = false;   // an expression-bodied arrow now has a block
      hit++;
    } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      for (const m of node.body.body) {
        if (m.value && m.value.body) { m.value.body = stubBody(); hit++; }
      }
    }
  };

  root.find(j.ExportNamedDeclaration).forEach((p) => {
    const d = p.node.declaration;
    if (!d) return;
    if (d.type === 'VariableDeclaration') {
      d.declarations.forEach((dec) => {
        if (dec.id.type === 'Identifier' && dec.id.name === name) blank(dec.init);
      });
    } else if (d.id && d.id.name === name) {
      blank(d);
    }
  });

  if (!hit) return null;
  return root.toSource({ quote: 'single' });
}

/** Run a command, never hang, and hand back enough to explain a failure. */
export function runner({ cwd, timeoutMs = 300_000, env = process.env } = {}) {
  return (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, env, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        code: err?.code ?? 0,
        timedOut: err?.killed === true,
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      }));
  });
}

/**
 * Last 40 lines — enough to see the failure, short enough to put in a comment.
 * Colour codes are stripped: everything that reads this — the JSON artifact,
 * the PR comment, the retry prompt — treats it as text, not a terminal.
 */
export function tail(text, n = 40) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trimEnd().split('\n').slice(-n).join('\n');
}
