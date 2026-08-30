/**
 * javascript:S1854 — dead store: an assignment whose value is never read.
 *
 * Two shapes in practice, and they need different edits:
 *
 *   const x = 25;              nothing ever reads x   -> delete the declaration
 *   let total = <dead>;        line below overwrites  -> keep `let total;`
 *   total = <dead>;            plain statement        -> delete the statement
 *
 * The first shape is the same edit remove-unused-variable makes, and three of
 * the catalogue's four S1854 findings sit on the same line as an S1481. So
 * whichever fixer runs second must report alreadyGone, not an error.
 */
import { countReferences, isSideEffectFree, nearestAtLine } from '../core.mjs';

export const name = 'remove-dead-store';
export const rules = ['javascript:S1854', 'typescript:S1854'];

export function fix({ j, root, finding }) {
  const declPath = nearestAtLine(j, root, j.VariableDeclarator, finding.line);
  if (declPath) return fixDeclarator({ j, root, path: declPath });

  const assignPath = nearestAtLine(j, root, j.AssignmentExpression, finding.line);
  if (assignPath) return fixAssignment({ j, path: assignPath });

  return { changed: false, alreadyGone: true, reason: `no declarator or assignment near line ${finding.line}` };
}

function fixDeclarator({ j, root, path }) {
  const decl = path.node;
  if (decl.id.type !== 'Identifier') {
    return { changed: false, refused: true, reason: `destructuring pattern (${decl.id.type})` };
  }
  if (!decl.init) {
    return { changed: false, alreadyGone: true, reason: `${decl.id.name} has no initializer; the store is already gone` };
  }
  if (!isSideEffectFree(decl.init)) {
    return {
      changed: false, refused: true,
      reason: `the dead value assigned to ${decl.id.name} may have side effects; deleting it could change behaviour`
    };
  }

  const uses = countReferences(j, root, decl.id.name, path.parent.node);
  if (uses === 0) {
    // Nothing reads it at all — the declaration itself is dead.
    const declaration = path.parent.node;
    if (declaration.declarations.length === 1) j(path.parent).remove();
    else declaration.declarations = declaration.declarations.filter((d) => d !== decl);
    return { changed: true, reason: `removed dead declaration of ${decl.id.name}` };
  }

  // Read later, but this initial value is overwritten first: drop the value,
  // keep the binding.
  decl.init = null;
  return { changed: true, reason: `dropped the overwritten initial value of ${decl.id.name}` };
}

function fixAssignment({ j, path }) {
  const node = path.node;
  if (!isSideEffectFree(node.right)) {
    return { changed: false, refused: true, reason: 'the assigned expression may have side effects' };
  }
  if (path.parent.node.type !== 'ExpressionStatement') {
    return { changed: false, refused: true, reason: 'assignment is used as a value, not a statement' };
  }
  const target = node.left.type === 'Identifier' ? node.left.name : 'target';
  j(path.parent).remove();
  return { changed: true, reason: `removed dead store to ${target}` };
}
