/**
 * The apply half: run the plan's commands, and prove each one did something.
 *
 * Two properties make this safe to point at a real repository:
 *
 *  - only `codemod` entries execute. Refused findings, model residue and findings
 *    over the cap are untouched *by construction*, not because every command was
 *    written carefully. The engine never decides to run a refused fix;
 *  - a codemod is only counted as applied when its check discriminates. The
 *    verifier runs BEFORE the fix and afterwards; a verifier that is already
 *    green at pass start proves nothing about the fix, and that is exactly the
 *    shape of a test written to pass.
 *
 * `run` is injectable so the whole thing is testable without executing anything.
 * Commands are argv arrays, never shell strings: a file path with a space or a
 * `;` in it is data here, not syntax.
 */
import { spawnSync } from 'node:child_process';

const ENTRY_PLACEHOLDERS = ['key', 'rule', 'file', 'line'];

/** `{file}` and friends, substituted per argument. Unknown placeholders survive. */
export function expand(argv, entry, { configDir = null } = {}) {
  return argv.map((arg) => arg.replace(/\{(\w+)\}/g, (whole, name) => {
    if (name === 'configDir') return configDir ?? whole;
    if (!ENTRY_PLACEHOLDERS.includes(name)) return whole;
    return entry[name] == null ? whole : String(entry[name]);
  }));
}

const defaultRun = (argv, cwd) => spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' });
const lastLine = (text) => String(text || '').trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 200) || 'no output';

const identify = (entry) => ({ key: entry.key, rule: entry.rule, file: entry.file, line: entry.line });

export function applyPlan(plan, config, {
  run = defaultRun, dryRun = false, cwd = process.cwd(), configDir = null
} = {}) {
  const results = [];
  const context = { configDir };

  for (const entry of plan.entries || []) {
    if (entry.engine !== 'codemod') {
      results.push({ ...identify(entry), outcome: 'skipped', reason: `engine is \`${entry.engine}\`` });
      continue;
    }
    const rule = (config.codemods || {})[entry.rule];
    if (!rule || !rule.command) {
      results.push({ ...identify(entry), outcome: 'skipped', reason: 'no command is registered for this rule' });
      continue;
    }
    if (dryRun) {
      results.push({ ...identify(entry), outcome: 'planned', command: expand(rule.command, entry, context) });
      continue;
    }

    if (rule.verifyCommand) {
      const before = run(expand(rule.verifyCommand, entry, context), cwd);
      if (before.status === 0) {
        results.push({
          ...identify(entry),
          outcome: 'already-clean',
          reason: 'the verifier reports this finding gone before the fix ran — either a command '
            + 'earlier in this pass resolved it, or the check cannot discriminate it from its absence'
        });
        continue;
      }
    }

    const fix = run(expand(rule.command, entry, context), cwd);

    // The fix command's exit status is NOT the verdict. Real autofixers report
    // "errors remain in this file" rather than "I failed": `eslint --fix` exits 1
    // while unrelated rules still fire, and it exits 1 on a file it just fixed.
    // Measured on the first real run of this engine. So when a verifier exists,
    // the verifier decides; the status is recorded for the reader.
    if (rule.verifyCommand) {
      const after = run(expand(rule.verifyCommand, entry, context), cwd);
      if (after.status !== 0) {
        results.push({
          ...identify(entry),
          outcome: 'failed',
          fixStatus: fix.status,
          reason: `the verifier exited ${after.status} after the fix (the fix command exited `
            + `${fix.status}): ${lastLine(after.stderr)}`
        });
        continue;
      }
      results.push({ ...identify(entry), outcome: 'applied', verified: true, fixStatus: fix.status });
      continue;
    }

    if (fix.status !== 0) {
      results.push({
        ...identify(entry),
        outcome: 'failed',
        fixStatus: fix.status,
        reason: `the fix command exited ${fix.status}: ${lastLine(fix.stderr)}`
      });
      continue;
    }
    results.push({ ...identify(entry), outcome: 'applied', verified: false, fixStatus: fix.status });
  }

  const totals = {};
  for (const result of results) totals[result.outcome] = (totals[result.outcome] || 0) + 1;
  return { appliedAt: new Date().toISOString(), totals, results };
}
