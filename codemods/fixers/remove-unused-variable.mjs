/**
 * javascript:S1481 — unused local variable should be removed.
 *
 * Refuses when the initializer could do something. `const x = audit();` is an
 * unused variable AND a call somebody may be relying on; deleting it is a
 * behaviour change wearing a cleanup's clothes.
 */
import { countReferences, isSideEffectFree, nearestAtLine } from '../core.mjs';

export const name = 'remove-unused-variable';
export const rules = ['javascript:S1481', 'typescript:S1481'];

export function fix({ j, root, finding }) {
  const path = nearestAtLine(j, root, j.VariableDeclarator, finding.line);
  if (!path) return { changed: false, alreadyGone: true, reason: `no variable declarator near line ${finding.line}` };

  const decl = path.node;
  if (decl.id.type !== 'Identifier') {
    return { changed: false, refused: true, reason: `destructuring pattern (${decl.id.type}) — removal is not a one-liner` };
  }
  const varName = decl.id.name;
  const uses = countReferences(j, root, varName, path.parent.node);
  if (uses > 0) {
    return { changed: false, alreadyGone: true, reason: `${varName} is referenced ${uses}x; not dead` };
  }
  if (decl.init && !isSideEffectFree(decl.init)) {
    return {
      changed: false, refused: true,
      reason: `initializer of ${varName} may have side effects; refusing to delete a computation this cannot prove is dead`
    };
  }

  const declaration = path.parent.node; // VariableDeclaration
  if (declaration.declarations.length === 1) {
    j(path.parent).remove();
  } else {
    declaration.declarations = declaration.declarations.filter((d) => d !== decl);
  }
  return { changed: true, reason: `removed unused variable ${varName}` };
}
