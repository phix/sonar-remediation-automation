/**
 * javascript:S1128 / typescript:S1128 — unused import should be removed.
 *
 * Removes only the specifiers nothing references. A partly-used import keeps
 * the specifiers that are used, so `import { a, b }` with only `b` dead becomes
 * `import { a }` rather than disappearing.
 */
import { countReferences, nearestAtLine } from '../core.mjs';

export const name = 'remove-unused-import';
export const rules = ['javascript:S1128', 'typescript:S1128'];

export function fix({ j, root, finding }) {
  const path = nearestAtLine(j, root, j.ImportDeclaration, finding.line);
  if (!path) return { changed: false, alreadyGone: true, reason: `no import declaration near line ${finding.line}` };

  const decl = path.node;
  const specifiers = decl.specifiers || [];
  if (specifiers.length === 0) {
    // `import './side-effect.js'` — never dead in the way this rule means.
    return { changed: false, refused: true, reason: 'side-effect-only import; removing it could change behaviour' };
  }

  const dead = specifiers.filter((s) => {
    const local = s.local && s.local.name;
    return local && countReferences(j, root, local, decl) === 0;
  });

  if (dead.length === 0) {
    return { changed: false, alreadyGone: true, reason: 'every specifier is referenced; nothing to remove' };
  }

  const removedNames = dead.map((s) => s.local.name);
  if (dead.length === specifiers.length) {
    j(path).remove();
    return { changed: true, reason: `removed the whole import of ${removedNames.join(', ')}` };
  }
  decl.specifiers = specifiers.filter((s) => !dead.includes(s));
  return { changed: true, reason: `removed unused specifier(s) ${removedNames.join(', ')}` };
}
