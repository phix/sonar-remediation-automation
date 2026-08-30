/**
 * javascript:S6582 — prefer optional chaining.
 *
 *   if (a && a.b)      ->  if (a?.b)
 *   if (!a || !a.b)    ->  if (!a?.b)
 *
 * ONLY in a condition. This is the fixer that has to refuse, and the reason is
 * worth stating precisely:
 *
 *   const x = a && a.b;   with a === 0  gives  0
 *   const x = a?.b;       with a === 0  gives  undefined
 *
 * `&&` yields the falsy left operand; `?.` short-circuits only on null and
 * undefined and otherwise yields undefined. In a boolean test both are falsy
 * and nothing can observe the difference. In a value position the difference is
 * the whole value — a silent behaviour change, which is strictly worse than an
 * unfixed code smell.
 */
import { nearestAtLine } from '../core.mjs';

export const name = 'to-optional-chain';
export const rules = ['javascript:S6582', 'typescript:S6582'];

export function fix({ j, root, finding }) {
  const path = nearestAtLine(j, root, j.LogicalExpression, finding.line);
  if (!path) return { changed: false, alreadyGone: true, reason: `no logical expression near line ${finding.line}` };

  if (!inConditionPosition(path)) {
    return {
      changed: false, refused: true,
      reason: 'not in a condition: `a && a.b` yields the falsy left operand (0, "") where `a?.b` yields undefined, '
        + 'so rewriting here would silently change the value'
    };
  }

  const replacement = rewrite(j, path.node);
  if (!replacement) {
    return { changed: false, refused: true, reason: 'shape is not a recognised `a && a.b` or `!a || !a.b` chain' };
  }
  j(path).replaceWith(replacement);
  return { changed: true, reason: 'rewrote to an optional chain' };
}

function src(j, node) {
  try { return j(node).toSource(); } catch { return null; }
}

function rewrite(j, node) {
  if (node.type !== 'LogicalExpression') return null;

  if (node.operator === '&&') {
    const { left, right } = node;
    if (right.type !== 'MemberExpression' && right.type !== 'OptionalMemberExpression') return null;
    // The left operand must be exactly the object being guarded.
    const leftSrc = src(j, left);
    const objSrc = src(j, right.object);
    if (leftSrc === null || leftSrc !== objSrc) {
      // `a && a.b && a.b.c` — recurse into the left first.
      const inner = rewrite(j, left);
      if (!inner) return null;
      if (src(j, inner) !== objSrc && src(j, left) !== objSrc) return null;
      return j.optionalMemberExpression(inner, right.property, right.computed, true);
    }
    return j.optionalMemberExpression(left, right.property, right.computed, true);
  }

  if (node.operator === '||') {
    const { left, right } = node;
    if (left.type !== 'UnaryExpression' || left.operator !== '!') return null;
    if (right.type !== 'UnaryExpression' || right.operator !== '!') return null;
    const inner = rewrite(j, {
      type: 'LogicalExpression', operator: '&&',
      left: left.argument, right: right.argument
    });
    if (!inner) return null;
    return j.unaryExpression('!', inner);
  }

  return null;
}

/**
 * Walk out to the nearest construct that consumes the expression. Logical and
 * unary operators are transparent — `!(a && a.b)` inside an `if` is still a
 * condition — everything else decides.
 */
function inConditionPosition(path) {
  let node = path.node;
  let p = path.parent;
  while (p && p.node) {
    const parent = p.node;
    switch (parent.type) {
      case 'IfStatement': case 'WhileStatement': case 'DoWhileStatement':
        return parent.test === node;
      case 'ForStatement':
        return parent.test === node;
      case 'ConditionalExpression':
        return parent.test === node;
      case 'UnaryExpression':
        if (parent.operator !== '!') return false;
        break;
      case 'LogicalExpression':
        break; // still inside a boolean chain; keep walking out
      default:
        return false;
    }
    node = parent;
    p = p.parent;
  }
  return false;
}
