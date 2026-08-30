/**
 * javascript:S7765 — `.some(x => x === v)` should be `.includes(v)`.
 *
 * The compared value must not mention the callback parameter, or `includes`
 * would be given something that does not exist outside the callback.
 */
import { nearestAtLine } from '../core.mjs';

export const name = 'some-to-includes';
export const rules = ['javascript:S7765', 'typescript:S7765'];

export function fix({ j, root, finding }) {
  const path = nearestAtLine(j, root, j.CallExpression, finding.line, 3);
  if (!path) return { changed: false, alreadyGone: true, reason: `no call expression near line ${finding.line}` };

  const call = path.node;
  const callee = call.callee;
  if (!callee || callee.type !== 'MemberExpression' || callee.computed
      || !callee.property || callee.property.name !== 'some') {
    return { changed: false, alreadyGone: true, reason: 'not a `.some(...)` call' };
  }
  if (call.arguments.length !== 1) {
    return { changed: false, refused: true, reason: '`.some` called with a thisArg or no callback' };
  }

  const fn = call.arguments[0];
  if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') {
    return { changed: false, refused: true, reason: 'callback is not a function literal, so its shape is unknown' };
  }
  if (fn.params.length !== 1 || fn.params[0].type !== 'Identifier') {
    return { changed: false, refused: true, reason: 'callback does not take exactly one plain parameter' };
  }
  const param = fn.params[0].name;

  const cmp = comparisonOf(fn);
  if (!cmp) return { changed: false, refused: true, reason: 'callback body is not a single `x === value` comparison' };
  if (cmp.operator !== '===') {
    return { changed: false, refused: true, reason: `comparison uses ${cmp.operator}; only === maps to includes` };
  }

  let other = null;
  if (cmp.left.type === 'Identifier' && cmp.left.name === param) other = cmp.right;
  else if (cmp.right.type === 'Identifier' && cmp.right.name === param) other = cmp.left;
  if (!other) return { changed: false, refused: true, reason: 'neither side of the comparison is the callback parameter' };

  if (mentionsIdentifier(other, param)) {
    return { changed: false, refused: true, reason: `the compared value mentions ${param}, which does not exist outside the callback` };
  }

  callee.property = j.identifier('includes');
  call.arguments = [other];
  return { changed: true, reason: '`.some(x => x === v)` -> `.includes(v)`' };
}

function comparisonOf(fn) {
  const body = fn.body;
  if (body.type === 'BinaryExpression') return body;
  if (body.type === 'BlockStatement') {
    const stmts = body.body.filter((s) => s.type !== 'EmptyStatement');
    if (stmts.length !== 1 || stmts[0].type !== 'ReturnStatement') return null;
    const arg = stmts[0].argument;
    return arg && arg.type === 'BinaryExpression' ? arg : null;
  }
  return null;
}

function mentionsIdentifier(node, name) {
  let hit = false;
  const walk = (n) => {
    if (!n || typeof n !== 'object' || hit) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'Identifier' && n.name === name) { hit = true; return; }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range' || k === 'comments') continue;
      walk(n[k]);
    }
  };
  walk(node);
  return hit;
}
