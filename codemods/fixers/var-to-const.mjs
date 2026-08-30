/**
 * javascript:S3504 / typescript:S3504 — use let or const, not var.
 *
 * const vs let is decided by whether the binding is ever reassigned. Getting it
 * wrong does not produce a subtle bug, it produces a build that does not run —
 * which is at least honest, but the point is not to need the build to find out.
 *
 * Refuses when a reference appears above the declaration: that code relies on
 * `var` hoisting, and let/const would put it in the temporal dead zone.
 */
import { nearestAtLine } from '../core.mjs';

export const name = 'var-to-const';
export const rules = ['javascript:S3504', 'typescript:S3504'];

export function fix({ j, root, finding }) {
  const path = nearestAtLine(j, root, j.VariableDeclaration, finding.line);
  if (!path) return { changed: false, alreadyGone: true, reason: `no variable declaration near line ${finding.line}` };
  const decl = path.node;
  if (decl.kind !== 'var') {
    return { changed: false, alreadyGone: true, reason: `already declared with \`${decl.kind}\`` };
  }

  const names = [];
  for (const d of decl.declarations) {
    if (d.id.type === 'Identifier') names.push(d.id.name);
    else return { changed: false, refused: true, reason: `destructuring pattern (${d.id.type})` };
  }

  const declLine = decl.loc ? decl.loc.start.line : 0;
  for (const n of names) {
    let usedAbove = false;
    root.find(j.Identifier, { name: n }).forEach((p) => {
      if (p.node.loc && p.node.loc.start.line < declLine) usedAbove = true;
    });
    if (usedAbove) {
      return { changed: false, refused: true, reason: `${n} is referenced above its declaration and relies on var hoisting` };
    }
  }

  const reassigned = names.some((n) => isReassigned(j, root, n));
  const missingInit = decl.declarations.some((d) => !d.init);
  decl.kind = reassigned || missingInit ? 'let' : 'const';
  return { changed: true, reason: `var -> ${decl.kind} for ${names.join(', ')}` };
}

function isReassigned(j, root, name) {
  let hit = false;
  root.find(j.AssignmentExpression).forEach((p) => {
    if (p.node.left.type === 'Identifier' && p.node.left.name === name) hit = true;
  });
  root.find(j.UpdateExpression).forEach((p) => {
    if (p.node.argument.type === 'Identifier' && p.node.argument.name === name) hit = true;
  });
  root.find(j.ForOfStatement).forEach((p) => { if (mentions(p.node.left, name)) hit = true; });
  root.find(j.ForInStatement).forEach((p) => { if (mentions(p.node.left, name)) hit = true; });
  return hit;
}

function mentions(node, name) {
  if (!node) return false;
  if (node.type === 'Identifier') return node.name === name;
  if (node.type === 'VariableDeclaration') {
    return node.declarations.some((d) => d.id.type === 'Identifier' && d.id.name === name);
  }
  return false;
}
