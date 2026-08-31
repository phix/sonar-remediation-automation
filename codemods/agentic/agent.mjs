/**
 * The agentic path, end to end: scope -> ask -> validate -> accept or reject.
 *
 * There are two retry caps in this system and they are not the same cap.
 * `client.mjs` retries *transport* — the endpoint was unreachable, or answered
 * 503. This module retries *proposals* — the endpoint answered fine and the
 * answer was no good. Conflating them would let a flaky network burn the
 * budget a bad model deserved, and would report the wrong failure class when
 * it ran out. Both are finite, and running out of either is a red terminal
 * state carrying a reason.
 *
 * Nothing here decides a finding is fixed because a stage ran. Every accepted
 * proposal has cleared every gate in `validate.mjs`, in order, and a rejection
 * names the gate that refused it.
 */
import { partitionByScope } from './scope.mjs';
import { buildPrompt, parseProposal } from './proposal.mjs';
import { chat, LlmUnavailable, configFromEnv } from './client.mjs';
import { admissible, stubSymbol, reject, accept, tail } from './validate.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiFor } from '../core.mjs';
import { enclosingExport, testPathFor } from '../testgen.mjs';

export const DEFAULT_MAX_PROPOSAL_ATTEMPTS = 2;   // spec §15

/**
 * One round trip and every gate applied to what came back.
 * Returns a verdict; throws only for `LlmUnavailable`, which is infra and
 * belongs to the caller's terminal-state handling rather than the retry loop.
 */
export async function attemptFix(finding, ctx, priorRejections = []) {
  const { root, source, rule, config, workspace, llm = {}, log = () => {} } = ctx;

  const target = testPathFor(finding.file);
  if (!target) return reject('admissible', `no test location is defined for ${finding.file}`);

  const j = apiFor(finding.file);
  let enclosing = null;
  try { enclosing = enclosingExport(j, j(source), finding.line); } catch { /* prompt is weaker, not broken */ }

  const messages = buildPrompt({
    finding, source, rule,
    testPath: target.path,
    importPath: target.importPath,
    enclosing
  });
  if (priorRejections.length) {
    // Spec §15: retry context carries the prior failure so the second attempt
    // is informed rather than merely another sample. The gate's captured
    // output rides along, not just the verdict line: run 33349355864 proved
    // the line alone teaches nothing — "the test does not pass" hid a
    // ReferenceError, and the model repeated it verbatim on every retry.
    messages.push({
      role: 'user',
      content: 'A previous attempt was rejected by an automated gate. Do not repeat it.\n'
        + priorRejections.map((r, i) => {
          const head = `Attempt ${i + 1} rejected at gate "${r.gate}": ${r.reason}`;
          return typeof r.detail === 'string' && r.detail
            ? `${head}\nThe gate's output:\n${r.detail.slice(-1200)}`
            : head;
        }).join('\n')
        // The observed failure loop at temperature 0: a case asserting wrong
        // behaviour of an UNCHANGED function, repeated verbatim every retry
        // because the model cannot repair arithmetic it guessed. Deleting the
        // case is within its reach; say so, or the retry budget buys nothing.
        + '\nIf a failing case tests a function you did NOT change, DELETE that case '
        + 'rather than guessing that function\'s behaviour again. A smaller test that '
        + 'is right beats a broader one that is wrong.'
    });
  }

  const answer = await chat(config, messages, { ...llm, log });
  const parsed = parseProposal(answer.content);
  if (!parsed.ok) return { ...reject('admissible', parsed.reason), usage: answer.usage };

  // --- Gate 1: admissible -------------------------------------------------
  const adm = admissible({ original: source, proposed: parsed.fix, filePath: finding.file });
  if (!adm.ok) return { ...adm, usage: answer.usage };

  if (!enclosing) {
    // Without a symbol there is nothing to stub, so the discrimination gate
    // cannot run. Inconclusive is a rejection here, not a pass — an ungated
    // proposal is exactly what this module exists to prevent.
    return { ...reject('testDiscriminates',
      `no exported symbol encloses ${finding.file}:${finding.line}, so the test cannot be shown to exercise the fix`),
      usage: answer.usage };
  }

  // --- Gate 2: the test must fail against a broken copy of the same fix ----
  await workspace.reset();
  await workspace.write(finding.file, parsed.fix);
  await workspace.write(target.path, parsed.test);

  const passes = await workspace.runTest(target.path);
  if (!passes.ok) {
    return { ...reject('testDiscriminates',
      'the accompanying test does not pass against the proposed fix', tail(passes.stdout + passes.stderr)),
      usage: answer.usage };
  }

  const mutant = stubSymbol(parsed.fix, finding.file, enclosing);
  if (!mutant) {
    return { ...reject('testDiscriminates', `could not stub ${enclosing} to check the test discriminates`),
      usage: answer.usage };
  }
  await workspace.write(finding.file, mutant);
  const onMutant = await workspace.runTest(target.path);
  if (onMutant.ok) {
    return { ...reject('testDiscriminates',
      `the test still passes with ${enclosing}() stubbed to return undefined, so it never exercises the fix`),
      usage: answer.usage };
  }
  await workspace.write(finding.file, parsed.fix);   // put the real fix back

  // --- Gates 3 and 4: build, then the whole suite -------------------------
  const built = await workspace.runBuild();
  if (!built.ok) {
    return { ...reject('build', 'the proposed fix does not build', tail(built.stdout + built.stderr)),
      usage: answer.usage };
  }
  const suite = await workspace.runSuite();
  if (!suite.ok) {
    return { ...reject('suite', 'the full suite fails with the proposed fix', tail(suite.stdout + suite.stderr)),
      usage: answer.usage };
  }

  return {
    ...accept('suite', adm.detail),
    fix: parsed.fix,
    test: parsed.test,
    testPath: target.path,
    enclosing,
    usage: answer.usage,
    attempts: answer.attempts
  };
}

/**
 * One finding, up to `maxProposalAttempts` proposals.
 *
 * Gate 5 — the finding is gone from a re-scan — is deliberately NOT here. It
 * cannot be answered until Sonar has seen the pushed branch, so it belongs to
 * the workflow after the push, not to a loop that has not committed anything.
 * Saying that out loud matters: a module that quietly skipped a gate it
 * advertised would be the same lie this pipeline exists to argue against.
 */
export async function fixOne(finding, ctx) {
  const max = ctx.maxProposalAttempts ?? DEFAULT_MAX_PROPOSAL_ATTEMPTS;
  const rejections = [];
  const log = ctx.log || (() => {});

  // Every attempt is paid for, accepted or not. A rejection that cost 2800
  // tokens and reports 0 makes the run's bill unfalsifiable — the summary said
  // "0 tokens" for a run that made four real model calls.
  const spent = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const pay = (u) => {
    if (!u) return;
    spent.prompt_tokens += u.prompt_tokens || 0;
    spent.completion_tokens += u.completion_tokens || 0;
    spent.total_tokens += u.total_tokens || 0;
  };

  for (let n = 1; n <= max; n++) {
    let verdict;
    try {
      verdict = await attemptFix(finding, ctx, rejections);
    } catch (e) {
      if (e instanceof LlmUnavailable) {
        log(`  ${finding.rule} ${finding.file}:${finding.line} — INFRA ${e.classification}: ${e.message}`);
        return {
          finding, accepted: false, infra: true,
          ...e.toTerminalState(),
          rejections,
          usage: spent
        };
      }
      throw e;
    }
    pay(verdict.usage);
    if (verdict.ok) {
      log(`  ${finding.rule} ${finding.file}:${finding.line} — ACCEPTED on attempt ${n}`);
      return { finding, accepted: true, attempt: n, rejections, ...verdict, usage: spent };
    }
    rejections.push({ gate: verdict.gate, reason: verdict.reason, detail: verdict.detail });
    log(`  ${finding.rule} ${finding.file}:${finding.line} — rejected at "${verdict.gate}": ${verdict.reason}`);
  }

  return {
    finding, accepted: false, infra: false,
    state: 'red',
    classification: rejections.some((r) => r.gate === 'build') ? 'build_failure_patch_induced'
      : rejections.some((r) => r.gate === 'suite') ? 'test_regression_patch_induced'
        : 'ambiguous_root_cause',
    summary: `${max} proposals were rejected; the last at "${rejections.at(-1).gate}".`,
    humanAction: 'Fix by hand, or add a deterministic codemod for this rule so it stops costing a call.',
    rejections,
    usage: spent
  };
}

/**
 * The whole batch. Scope alarms are raised before a single token is spent,
 * because a routing bug is cheaper to notice than to pay for.
 */
export async function runAgentic(findings, ctx) {
  const log = ctx.log || (() => {});
  const { inScope, outOfScope, alarms } = partitionByScope(findings);
  for (const a of alarms) log(`!! ${a}`);

  const cfg = ctx.config || configFromEnv();
  if (!cfg.configured) {
    // Not an infra failure — nobody said the endpoint was down, nobody said
    // where it is. Sending someone to check a healthy server is worse than
    // saying plainly that this path never ran.
    return {
      ran: false,
      reason: `the agentic path is not configured: ${cfg.missing.join(', ')} unset`,
      inScope, outOfScope, alarms, results: []
    };
  }

  // Source and rule guidance are per FINDING, not per run. Hoisting either one
  // onto the shared context would send every finding the first file's contents
  // — which reads as the model hallucinating wildly, when in fact it answered
  // the wrong question correctly.
  const readSource = ctx.readSource || ((file) => readFileSync(join(ctx.root || '.', file), 'utf8'));
  const rules = ctx.rules || new Map();

  const results = [];
  for (const f of inScope) {
    let source;
    try {
      source = readSource(f.file);
    } catch (e) {
      results.push({
        finding: f, accepted: false, infra: false, state: 'red',
        classification: 'ambiguous_root_cause',
        summary: `cannot read ${f.file}: ${e.message}`,
        humanAction: 'The finding names a file this checkout does not have. Check the ref being remediated.',
        rejections: []
      });
      continue;
    }
    results.push(await fixOne(f, {
      ...ctx,
      config: cfg,
      source,
      rule: rules.get(f.rule) || ctx.rule || { available: false, reason: 'no rule metadata fetched' }
    }));
  }
  return { ran: true, inScope, outOfScope, alarms, results };
}

export function summarizeAgentic(run) {
  const accepted = run.results.filter((r) => r.accepted);
  const infra = run.results.filter((r) => r.infra);
  return {
    ran: run.ran,
    reason: run.reason || null,
    considered: run.inScope.length,
    outOfScope: run.outOfScope.length,
    alarms: run.alarms.length,
    accepted: accepted.length,
    rejected: run.results.length - accepted.length - infra.length,
    infraFailures: infra.length,
    tokens: run.results.reduce((n, r) => n + (r.usage?.total_tokens || 0), 0)
  };
}
