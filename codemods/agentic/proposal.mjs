/**
 * Asking the model, and reading the answer back.
 *
 * The prompt is deliberately narrow. The model is not asked "improve this
 * file"; it is given one finding, the rule's own guidance from Sonar, the file
 * it lives in, and a contract that makes a wrong answer easy to detect. Every
 * constraint below exists so that `validate.mjs` can refuse mechanically
 * rather than someone reading the diff and forming an opinion.
 *
 * The response format is marker-delimited rather than JSON or a unified diff.
 * JSON loses to embedded backslashes and newlines in source; diffs lose because
 * models produce plausible hunks with wrong line numbers, and a diff that fails
 * to apply is a wasted attempt rather than information. Whole files parse or
 * they do not, and "does it parse" is a question with one answer.
 */

const FIX = '===FIX===';
const TEST = '===TEST===';
const END = '===END===';

/** Number the source so a line reference in the finding means something. */
export function numbered(source, focusLine, radius = null) {
  const lines = source.split('\n');
  const from = radius ? Math.max(1, focusLine - radius) : 1;
  const to = radius ? Math.min(lines.length, focusLine + radius) : lines.length;
  const width = String(to).length;
  return lines.slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(width)}| ${l}`)
    .join('\n');
}

export const SYSTEM_PROMPT = [
  'You refactor JavaScript and TypeScript to clear a specific SonarQube finding.',
  '',
  'You are one stage of an automated pipeline. Nothing you produce is trusted on your',
  'say-so: the file is re-parsed, the exports are compared, the build runs, the whole',
  'suite runs, and the accompanying test is re-run against a deliberately broken copy',
  'of your own fix to check it actually exercises the code you changed. A confident',
  'explanation counts for nothing here, so do not write one.',
  '',
  'Rules you must not break:',
  '1. Behaviour is preserved exactly. These are refactorings, not improvements.',
  '2. Every exported name keeps its name and its signature. Callers are not in scope.',
  '3. You edit ONE file: the one you are given. No new modules, no imports of packages',
  '   that are not already imported somewhere in the file.',
  '4. You write exactly ONE test file, and its cases must call the function you changed.',
  '   A test that would still pass if that function returned undefined is worthless and',
  '   will be rejected.',
  '5. No comments explaining that you fixed a Sonar issue. The commit message says that.'
].join('\n');

export function buildPrompt({ finding, source, rule, testPath, importPath, enclosing }) {
  const guidance = rule?.available
    ? `The rule's own guidance:\n\n${(rule.howToFix || rule.rootCause).slice(0, 2500)}`
    : `No rule guidance was retrievable (${rule?.reason || 'unknown'}); rely on the message and the code.`;

  const user = [
    `Finding: ${finding.rule} at ${finding.file}:${finding.line}`,
    finding.message ? `Message: ${finding.message}` : '',
    enclosing ? `Enclosing exported symbol: ${enclosing}` : '',
    '',
    guidance,
    '',
    `Full contents of ${finding.file}, line-numbered (the numbers are NOT part of the file):`,
    '',
    numbered(source, finding.line),
    '',
    'Reply with exactly this shape and nothing outside it — no prose, no fences:',
    '',
    FIX,
    `<the complete new contents of ${finding.file}>`,
    TEST,
    `<the complete contents of ${testPath}, importing from '${importPath}'>`,
    END
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user }
  ];
}

/** Models like to wrap things in fences even when told not to. Take them off. */
function unfence(text) {
  const t = text.trim();
  const m = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  return (m ? m[1] : t).trim();
}

/**
 * @returns {{ok: true, fix: string, test: string} | {ok: false, reason: string}}
 * A malformed reply is a rejected attempt, not a crash — it costs a retry and
 * the reason is logged, which is exactly what the retry cap is for.
 */
export function parseProposal(content) {
  const iFix = content.indexOf(FIX);
  const iTest = content.indexOf(TEST);
  const iEnd = content.indexOf(END);

  if (iFix < 0) return { ok: false, reason: `reply has no ${FIX} marker` };
  if (iTest < 0) return { ok: false, reason: `reply has no ${TEST} marker` };
  if (iTest < iFix) return { ok: false, reason: `${TEST} appears before ${FIX}` };

  const fix = unfence(content.slice(iFix + FIX.length, iTest));
  const test = unfence(content.slice(iTest + TEST.length, iEnd < 0 ? undefined : iEnd));

  if (!fix) return { ok: false, reason: 'the fix section is empty' };
  if (!test) return { ok: false, reason: 'the test section is empty' };
  return { ok: true, fix, test };
}

export const MARKERS = { FIX, TEST, END };
