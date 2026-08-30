/**
 * Emit a characterization test for a module a codemod edited.
 *
 * WHAT THIS ASSERTS, AND WHAT IT DOES NOT
 *
 * The ticket asks for two things that cannot both be true:
 *
 *   "Templates emit a characterization test ... Not a test asserting the
 *    variable is gone."
 *   "the generated test ... fails against the unfixed code."
 *
 * Unfixed code works. That is what a code smell is — a maintainability
 * complaint, not a defect. A test that asserts behaviour therefore passes
 * before AND after a correct fix, and the only test that fails on unfixed code
 * is one asserting the smell is absent, which the first requirement forbids.
 *
 * So the useful question is not "does it fail before the fix" but "does it fail
 * when the fix is WRONG" — which is the ticket's own stated rationale:
 *
 *   "It would catch a codemod that deleted the wrong line, which is exactly
 *    the failure worth catching."
 *
 * These templates are therefore verified by MUTATION, not by running them
 * against unfixed source. See __tests__/templates.test.mjs, which breaks each
 * fix on purpose and requires the generated test to notice.
 *
 * The assertions are deliberately about the module's shape rather than its
 * values, because shape is what a deletion damages and it can be derived
 * automatically. Value-level tests are the agentic path's job.
 */

/** Escape a string for embedding in single quotes. */
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * @param {object} spec
 * @param {string} spec.file          repo-relative path of the edited module
 * @param {string} spec.importPath    specifier the test should import
 * @param {string} spec.rule          the Sonar rule that was fixed
 * @param {string} spec.fixer         which codemod made the edit
 * @param {Array<{name:string,kind:string,arity:number}>} spec.surface
 */
export function renderCharacterizationTest({ file, importPath, rule, fixer, surface }) {
  const names = surface.map((s) => s.name);
  const fns = surface.filter((s) => s.kind === 'function');

  const lines = [
    `import { describe, it, expect } from 'vitest';`,
    `import * as mod from ${q(importPath)};`,
    ``,
    `// Characterization test generated for ${file}`,
    `// Fix: ${fixer} (${rule})`,
    `//`,
    `// This does not assert the smell is gone. It asserts the module still`,
    `// presents the same surface it did before the edit, which is what a`,
    `// codemod that deleted the wrong line would break.`,
    `describe(${q(`${file} after ${fixer}`)}, () => {`,
    `  it('still loads and exports the same names', () => {`,
    `    expect(Object.keys(mod).sort()).toEqual(${JSON.stringify(names.slice().sort())});`,
    `  });`,
  ];

  if (fns.length) {
    lines.push(``, `  it('keeps every exported function callable with the same arity', () => {`);
    for (const f of fns) {
      lines.push(`    expect(typeof mod.${f.name}).toBe('function');`);
      lines.push(`    expect(mod.${f.name}.length).toBe(${f.arity});`);
    }
    lines.push(`  });`);
  }

  lines.push(`});`, ``);
  return lines.join('\n');
}

/**
 * Describe a module's public surface by importing it.
 *
 * Only works for modules the test runner can import directly — plain ESM. A
 * TypeScript Angular component needs compilation, so the caller gets null and
 * must fall back rather than emit a test that cannot run.
 */
export async function describeSurface(importPath) {
  let mod;
  try {
    mod = await import(importPath);
  } catch {
    return null;
  }
  return Object.keys(mod).sort().map((name) => {
    const v = mod[name];
    const kind = typeof v === 'function' ? 'function' : typeof v;
    return { name, kind, arity: kind === 'function' ? v.length : 0 };
  });
}
