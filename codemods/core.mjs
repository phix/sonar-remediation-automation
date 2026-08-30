/**
 * Shared machinery for the deterministic fixers.
 *
 * Every fixer is targeted at ONE reported finding — file, line, rule — rather
 * than sweeping a file for everything of its kind. The pipeline fixes what
 * Sonar reported; anything else is an unrequested change hiding in a
 * remediation commit.
 *
 * A fixer returns a verdict, never throws for an ordinary refusal:
 *   { changed: true,  reason }  it made the edit
 *   { changed: false, reason, refused: true }   it declined, and why
 *   { changed: false, reason, alreadyGone: true }  nothing there to fix
 *
 * `alreadyGone` is not a failure. Three of the catalogue's S1854 findings sit
 * on the same line as an S1481, and one deletion clears both — so the second
 * fixer to arrive must report "already resolved" rather than an error.
 */
import jscodeshift from 'jscodeshift';

/** TypeScript needs a different parser, and Angular files carry decorators. */
export function parserFor(filePath) {
  if (/\.tsx$/.test(filePath)) return 'tsx';
  if (/\.ts$/.test(filePath)) return 'ts';
  return 'babel';
}

export function apiFor(filePath) {
  return jscodeshift.withParser(parserFor(filePath));
}

/**
 * Is this Identifier path an actual *use* of a binding, rather than a name
 * that merely looks like one?
 *
 * `obj.foo` and `{ foo: 1 }` both contain an Identifier named `foo` that has
 * nothing to do with a binding called `foo`. Counting them is how a fixer
 * convinces itself a dead import is alive and silently does nothing.
 */
export function isReference(path) {
  const { node, parent } = path;
  const p = parent.node;
  if (!p) return true;
  // obj.foo  — but foo[bar] IS a reference to bar
  if (p.type === 'MemberExpression' && p.property === node && !p.computed) return false;
  if (p.type === 'OptionalMemberExpression' && p.property === node && !p.computed) return false;
  // { foo: 1 } — but shorthand { foo } IS a reference
  if ((p.type === 'ObjectProperty' || p.type === 'Property') && p.key === node && !p.computed) {
    return p.shorthand === true;
  }
  if (p.type === 'ObjectMethod' && p.key === node && !p.computed) return false;
  if (p.type === 'ClassMethod' && p.key === node && !p.computed) return false;
  if (p.type === 'ClassProperty' && p.key === node && !p.computed) return false;
  // The declaration site itself is not a use.
  if (p.type === 'ImportSpecifier' || p.type === 'ImportDefaultSpecifier'
      || p.type === 'ImportNamespaceSpecifier') return false;
  if (p.type === 'VariableDeclarator' && p.id === node) return false;
  if (p.type === 'FunctionDeclaration' && p.id === node) return false;
  if (p.type === 'ClassDeclaration' && p.id === node) return false;
  // A label is not a value.
  if (p.type === 'LabeledStatement' || p.type === 'BreakStatement'
      || p.type === 'ContinueStatement') return false;
  // TS type positions still count as uses: removing the import would break the
  // build even though nothing reads the value at runtime.
  return true;
}

/** Count real uses of `name` in the file, ignoring anything under `exclude`. */
export function countReferences(j, root, name, exclude) {
  let n = 0;
  root.find(j.Identifier, { name }).forEach((path) => {
    if (exclude && isUnder(path, exclude)) return;
    if (!isReference(path)) return;
    n += 1;
  });
  return n;
}

/** Also matches JSX identifiers, which Angular templates do not use but React would. */
export function isUnder(path, ancestorNode) {
  let p = path;
  while (p) {
    if (p.node === ancestorNode) return true;
    p = p.parent;
  }
  return false;
}

/** Nodes of `type` whose first line matches `line`. */
export function atLine(j, root, type, line) {
  return root.find(type).filter((p) => p.node.loc && p.node.loc.start.line === line);
}

/**
 * Sonar reports the line of the *finding*, which is not always the line of the
 * node a fixer must edit — a multi-line declaration reports its first line, and
 * an edit above shifts everything below. So fixers search a small window and
 * take the nearest match rather than demanding an exact hit.
 */
export function nearestAtLine(j, root, type, line, window = 2) {
  let best = null;
  let bestDist = Infinity;
  root.find(type).forEach((p) => {
    if (!p.node.loc) return;
    const d = Math.abs(p.node.loc.start.line - line);
    if (d <= window && d < bestDist) { best = p; bestDist = d; }
  });
  return best;
}

/**
 * Array methods that cannot themselves cause an observable effect. Whether the
 * CALL is side-effect free still depends on its arguments, which are checked
 * separately — `xs.map(f)` where f is an unknown function is not safe.
 */
const PURE_ARRAY_METHODS = new Set([
  'map', 'filter', 'reduce', 'reduceRight', 'slice', 'concat', 'join',
  'includes', 'indexOf', 'lastIndexOf', 'find', 'findIndex', 'some', 'every',
  'flat', 'flatMap', 'keys', 'values', 'entries', 'at'
]);

const PURE_GLOBALS = new Set(['Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON']);

/**
 * Conservative: returns true only for expressions this can PROVE cannot have an
 * observable effect. Anything unrecognised is treated as effectful.
 *
 * Deleting a dead store means deleting whatever computing it did. If that
 * computation mutated something, the "fix" is a silent behaviour change — the
 * worst possible output of an automated remediation, because the tests it also
 * writes will happily encode the new behaviour as correct.
 */
export function isSideEffectFree(node, depth = 0) {
  if (!node || depth > 12) return false;
  switch (node.type) {
    case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral':
    case 'NullLiteral': case 'RegExpLiteral': case 'BigIntLiteral':
    case 'Literal': case 'Identifier': case 'ThisExpression':
      return true;
    case 'TemplateLiteral':
      return node.expressions.every((e) => isSideEffectFree(e, depth + 1));
    case 'MemberExpression': case 'OptionalMemberExpression':
      // A getter can do anything, but a getter that does something observable
      // is already a defect; property reads are treated as pure.
      return isSideEffectFree(node.object, depth + 1)
        && (!node.computed || isSideEffectFree(node.property, depth + 1));
    case 'UnaryExpression':
      return node.operator !== 'delete' && isSideEffectFree(node.argument, depth + 1);
    case 'BinaryExpression': case 'LogicalExpression':
      return isSideEffectFree(node.left, depth + 1) && isSideEffectFree(node.right, depth + 1);
    case 'ConditionalExpression':
      return isSideEffectFree(node.test, depth + 1)
        && isSideEffectFree(node.consequent, depth + 1)
        && isSideEffectFree(node.alternate, depth + 1);
    case 'ArrayExpression':
      return node.elements.every((e) => e === null || isSideEffectFree(e, depth + 1));
    case 'ObjectExpression':
      return node.properties.every((p) =>
        (p.type === 'ObjectProperty' || p.type === 'Property')
        && !p.computed && isSideEffectFree(p.value, depth + 1));
    case 'ArrowFunctionExpression': case 'FunctionExpression':
      // Creating a function is pure. Calling it is what this guards.
      return true;
    case 'TSAsExpression': case 'TSNonNullExpression': case 'TypeCastExpression':
      return isSideEffectFree(node.expression, depth + 1);
    case 'CallExpression': {
      const callee = node.callee;
      if (!callee || callee.type !== 'MemberExpression' || callee.computed) return false;
      const name = callee.property && callee.property.name;
      const isPureArray = PURE_ARRAY_METHODS.has(name)
        && isSideEffectFree(callee.object, depth + 1);
      const isPureGlobal = callee.object && callee.object.type === 'Identifier'
        && PURE_GLOBALS.has(callee.object.name);
      if (!isPureArray && !isPureGlobal) return false;
      // A callback that assigns to anything outside itself makes the whole
      // chain effectful, however pure `map` is.
      return node.arguments.every((a) => isSideEffectFree(a, depth + 1) && !mutatesAnything(a));
    }
    default:
      return false;
  }
}

/** Does this function body assign, update, delete, await or yield? */
export function mutatesAnything(node) {
  if (!node) return false;
  if (node.type !== 'ArrowFunctionExpression' && node.type !== 'FunctionExpression') return false;
  let dirty = false;
  const walk = (n) => {
    if (!n || typeof n !== 'object' || dirty) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n.type === 'string') {
      if (n.type === 'AssignmentExpression' || n.type === 'UpdateExpression'
          || n.type === 'AwaitExpression' || n.type === 'YieldExpression'
          || (n.type === 'UnaryExpression' && n.operator === 'delete')) {
        dirty = true; return;
      }
      // A call inside the callback is unknown territory.
      if (n.type === 'CallExpression' || n.type === 'NewExpression') { dirty = true; return; }
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range' || k === 'comments') continue;
      walk(n[k]);
    }
  };
  walk(node.body);
  return dirty;
}
