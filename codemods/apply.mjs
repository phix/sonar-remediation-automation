/**
 * Apply the deterministic fixers to a set of reported findings.
 *
 * Findings within a file are processed HIGHEST LINE FIRST. Every edit shifts
 * the lines below it, and the line numbers in the findings describe the
 * original file — so working downwards would make each fix miss by however
 * many lines the previous one removed. Working upwards, an edit never moves a
 * target that has not been handled yet.
 *
 * The source is re-parsed after every applied fix rather than mutating one AST
 * through the whole list, so each fixer sees the file as it actually is.
 *
 * Usage:
 *   node codemods/apply.mjs <findings.json> [--root DIR] [--dry-run]
 *
 * findings.json: [{ "rule": "javascript:S1128", "file": "api/src/app.js", "line": 2 }]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiFor } from './core.mjs';
import { fixerFor } from './registry.mjs';

export function applyOne(source, filePath, finding) {
  const fixer = fixerFor(finding.rule);
  if (!fixer) {
    return { source, changed: false, reason: `no codemod for ${finding.rule}`, noFixer: true };
  }
  const j = apiFor(filePath);
  let root;
  try {
    root = j(source);
  } catch (e) {
    return { source, changed: false, failed: true, reason: `parse failed: ${e.message}` };
  }
  let verdict;
  try {
    verdict = fixer.fix({ j, root, finding });
  } catch (e) {
    return { source, changed: false, failed: true, reason: `${fixer.name} threw: ${e.message}`, fixer: fixer.name };
  }
  const next = verdict.changed ? root.toSource({ quote: 'single' }) : source;
  return { ...verdict, source: next, fixer: fixer.name };
}

export function applyAll(findings, { root = '.', dryRun = false, read = readFileSync, write = writeFileSync } = {}) {
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  const results = [];
  for (const [file, list] of byFile) {
    const abs = join(root, file);
    let source;
    try {
      source = read(abs, 'utf8');
    } catch (e) {
      for (const f of list) results.push({ ...f, changed: false, failed: true, reason: `unreadable: ${e.message}` });
      continue;
    }
    const original = source;
    // Highest line first — see the note at the top of this file.
    const ordered = [...list].sort((a, b) => (b.line || 0) - (a.line || 0));
    // Lines already edited in this pass. A second finding on an edited line is
    // resolved, not fixable: the construct it pointed at is gone, and searching
    // near that line now finds whatever moved up into it. That is how the
    // co-located S1481/S1854 pairs previously produced a confident refusal
    // about an entirely different variable.
    const editedLines = new Set();
    for (const finding of ordered) {
      if (editedLines.has(finding.line)) {
        results.push({ ...finding, fixer: null, changed: false, refused: false, alreadyGone: true,
          failed: false, noFixer: false,
          reason: `already resolved by the fix applied at ${file}:${finding.line}` });
        continue;
      }
      const r = applyOne(source, file, finding);
      if (r.changed) editedLines.add(finding.line);
      source = r.source;
      results.push({ ...finding, fixer: r.fixer, changed: !!r.changed, refused: !!r.refused,
        alreadyGone: !!r.alreadyGone, failed: !!r.failed, noFixer: !!r.noFixer, reason: r.reason });
    }
    if (source !== original && !dryRun) write(abs, source);
  }
  return results;
}

export function summarize(results) {
  const s = {
    total: results.length,
    fixed: results.filter((r) => r.changed).length,
    refused: results.filter((r) => r.refused).length,
    alreadyGone: results.filter((r) => r.alreadyGone).length,
    failed: results.filter((r) => r.failed).length,
    noFixer: results.filter((r) => r.noFixer).length
  };
  // A finding cleared as a side effect of another fix is RESOLVED. Counting
  // only direct edits would under-report the deterministic path by exactly the
  // number of co-located findings, which is the ratio this project argues from.
  s.resolved = s.fixed + s.alreadyGone;
  s.deterministicRatio = s.total ? +(s.resolved / s.total).toFixed(3) : 0;
  return s;
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 ? args[rootIdx + 1] : '.';
  const dryRun = args.includes('--dry-run');
  if (!file) { console.error('usage: apply.mjs <findings.json> [--root DIR] [--dry-run]'); process.exit(2); }

  const findings = JSON.parse(readFileSync(file, 'utf8'));
  const results = applyAll(findings, { root, dryRun });
  for (const r of results) {
    const mark = r.changed ? 'FIXED   ' : r.refused ? 'REFUSED ' : r.alreadyGone ? 'ALREADY ' : r.failed ? 'FAILED  ' : 'NOFIXER ';
    console.log(`${mark} ${r.rule.padEnd(20)} ${r.file}:${r.line}  ${r.reason}`);
  }
  const s = summarize(results);
  console.log(`\n${s.resolved} resolved deterministically (${s.fixed} edits + ${s.alreadyGone} cleared `
    + `as a side effect), ${s.refused} refused, ${s.failed} failed, `
    + `${s.noFixer} with no codemod (of ${s.total} findings)`);
  process.exit(s.failed > 0 ? 1 : 0);
}
