import { describe, it, expect } from 'vitest';
import { chat, configFromEnv, LlmUnavailable, TRANSIENT, PERSISTENT, DEFAULTS } from '../agentic/client.mjs';
import { checkScope, partitionByScope, AGENTIC_RULES } from '../agentic/scope.mjs';
import { renderAgenticReport } from '../agentic/run.mjs';
import { parseProposal, buildPrompt } from '../agentic/proposal.mjs';
import { admissible, stubSymbol, tail } from '../agentic/validate.mjs';
import { fixOne, runAgentic, summarizeAgentic } from '../agentic/agent.mjs';
import { supportedRules } from '../registry.mjs';

/** A fetch that answers from a queue, and counts how often it was called. */
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (typeof next === 'function') return next();
    return next;
  };
  impl.calls = calls;
  return impl;
}
// Non-2xx answers never reach the stream reader -- the client throws on
// !res.ok after reading .text() -- so these stay plain objects.
const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

/**
 * A 200 whose body is a real SSE stream, because that is what the client now
 * reads. Faking a resolved JSON document here would test a code path that no
 * longer exists.
 */
const enc = new TextEncoder();
const sse = (frames, { trailing = true } = {}) => ({
  ok: true, status: 200,
  text: async () => frames.join(''),
  body: (async function* () {
    for (const f of frames) yield enc.encode(f);
    if (trailing) yield enc.encode('data: [DONE]\n\n');
  })()
});

/** Content split across two deltas, so the accumulator is actually exercised. */
const ok = (content) => {
  const half = Math.ceil(content.length / 2);
  return sse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, half) } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(half) } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 42 } })}\n\n`
  ]);
};

const CONFIG = { baseUrl: 'https://llm.example/v1', model: 'm', apiKey: 'k' };
const NO_WAIT = { sleep: async () => {}, backoffMs: 0 };

describe('the client cannot hang and always classifies', () => {
  it('retries a transient failure up to the cap, then gives up with elapsed time', async () => {
    const f = fakeFetch([() => { throw new Error('ECONNREFUSED'); }]);
    let t = 0;
    await expect(chat(CONFIG, [], { ...NO_WAIT, fetchImpl: f, maxRetries: 2, now: () => (t += 500) }))
      .rejects.toMatchObject({ classification: TRANSIENT, attempts: 3 });
    expect(f.calls.length).toBe(3);   // 1 initial + 2 retries, never more
  });

  it('does NOT retry a credential failure — a 401 is still 401 next time', async () => {
    const f = fakeFetch([json({ error: 'bad key' }, 401)]);
    const err = await chat(CONFIG, [], { ...NO_WAIT, fetchImpl: f, maxRetries: 2 }).catch((e) => e);
    expect(err.classification).toBe(PERSISTENT);
    expect(f.calls.length).toBe(1);
  });

  it('recovers when a transient failure clears within the cap', async () => {
    let n = 0;
    const f = fakeFetch([() => (++n === 1 ? json({}, 503) : ok('hello'))]);
    const r = await chat(CONFIG, [], { ...NO_WAIT, fetchImpl: f, maxRetries: 2 });
    expect(r.content).toBe('hello');
    expect(r.attempts).toBe(2);
  });

  it('bounds the wait when the endpoint accepts the connection and never answers', async () => {
    const f = fakeFetch([() => new Promise(() => {})]);   // never resolves
    const started = Date.now();
    const err = await chat(CONFIG, [], { ...NO_WAIT, fetchImpl: f, maxRetries: 0, connectTimeoutMs: 40 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmUnavailable);
    expect(err.classification).toBe(TRANSIENT);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // Regression, 2026-08-30. The default header budget was 10s, read as
  // connect-and-first-byte. That is a STREAMING endpoint's timing. Against the
  // real non-streaming endpoint (Ollama on tinman) the whole answer is
  // generated before any header is sent: 19.5s measured warm, 54s cold. Every
  // call died on the deadline and was reported as `infra_failure_transient` --
  // a healthy server accused of being down. These pin the corrected model.
  it('does not time out a non-streaming endpoint that generates before sending headers', async () => {
    // Slower than the old 10s default; the fix must let it through.
    const slow = () => new Promise((r) => setTimeout(() => r(ok('fixed source')), 30));
    const f = fakeFetch([slow]);
    const r = await chat(CONFIG, [], { ...NO_WAIT, fetchImpl: f, maxRetries: 0 });
    expect(r.content).toBe('fixed source');
    expect(f.calls.length).toBe(1);
  });

  it('budgets a cold model load for headers, and generation separately', () => {
    // A cold 14B took 74s to produce its first token. A header budget at or
    // below that turns a model loading into a false "endpoint unavailable".
    expect(DEFAULTS.headerTimeoutMs).toBeGreaterThan(60_000);
    // Silence between chunks is "wedged", not "slow" -- at ~5 tok/s a healthy
    // stream never goes a minute without a token. It must be far below the
    // total, or it stops being a distinct signal.
    expect(DEFAULTS.stallTimeoutMs).toBeGreaterThan(0);
    expect(DEFAULTS.stallTimeoutMs).toBeLessThan(DEFAULTS.totalTimeoutMs);
    // One real fix measured 339.6s at 7b. A total at or under that would fail
    // every genuine call.
    expect(DEFAULTS.totalTimeoutMs).toBeGreaterThan(340_000);
  });

  it('sends stream:true, because non-streaming is unfixable at this endpoint', async () => {
    // Not a preference. A real fix takes 339.6s and undici enforces its own
    // 300s headers ceiling that no option here can raise, so a non-streaming
    // request cannot complete at any budget this module could choose.
    const f = fakeFetch([() => ok('x')]);
    await chat(CONFIG, [], { ...NO_WAIT, fetchImpl: f, maxRetries: 0 });
    expect(JSON.parse(f.calls[0].init.body).stream).toBe(true);
  });

  it('accumulates content across deltas rather than reading one final message', async () => {
    const f = fakeFetch([() => ok('corrected source here')]);
    const r = await chat(CONFIG, [], { ...NO_WAIT, fetchImpl: f, maxRetries: 0 });
    expect(r.content).toBe('corrected source here');
    expect(r.usage).toEqual({ total_tokens: 42 });
  });

  it('calls a stream that goes silent mid-generation wedged, not slow', async () => {
    const enc2 = new TextEncoder();
    const stalled = () => ({
      ok: true, status: 200, text: async () => '',
      body: (async function* () {
        yield enc2.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
        await new Promise(() => {});   // tokens started, then nothing, ever
      })()
    });
    const err = await chat(CONFIG, [], { ...NO_WAIT, fetchImpl: fakeFetch([stalled]), maxRetries: 0, stallTimeoutMs: 40 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmUnavailable);
    expect(err.classification).toBe(TRANSIENT);
    expect(err.message).toMatch(/wedged rather than slow/);
  });

  it('still honours the old option names, so the provers keep failing fast', async () => {
    const f = fakeFetch([() => new Promise(() => {})]);
    const err = await chat(CONFIG, [], { ...NO_WAIT, fetchImpl: f, maxRetries: 0, connectTimeoutMs: 40 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmUnavailable);
  });

  it('calls a 200 with the wrong shape persistent, because retrying will not make it OpenAI-compatible', async () => {
    const f = fakeFetch([sse([`data: ${JSON.stringify({ result: 'not openai shaped' })}\n\n`])]);
    const err = await chat(CONFIG, [], { ...NO_WAIT, fetchImpl: f, maxRetries: 2 }).catch((e) => e);
    expect(err.classification).toBe(PERSISTENT);
    expect(err.message).toMatch(/OpenAI-compatible/);
    expect(f.calls.length).toBe(1);
  });

  // --max-findings is a demo budget. The danger is that a capped run and an
  // exhaustive run look identical, which would turn the cap into a way to
  // claim coverage nobody had.
  it('names every deferred finding in the report instead of dropping it', () => {
    const run = { ran: true, inScope: [], outOfScope: [], alarms: [], results: [] };
    const deferred = [
      { rule: 'typescript:S3776', file: 'web/src/a.ts', line: 12 },
      { rule: 'typescript:S3358', file: 'web/src/b.ts', line: 40 }
    ];
    const md = renderAgenticReport(run, summarizeAgentic(run), deferred);
    expect(md).toMatch(/2 finding\(s\) were deferred/);
    expect(md).toMatch(/web\/src\/a\.ts:12/);
    expect(md).toMatch(/web\/src\/b\.ts:40/);
    expect(md).toMatch(/remain unresolved/);
  });

  it('says nothing about deferrals when nothing was deferred', () => {
    const run = { ran: true, inScope: [], outOfScope: [], alarms: [], results: [] };
    expect(renderAgenticReport(run, summarizeAgentic(run), [])).not.toMatch(/deferred/);
    expect(renderAgenticReport(run, summarizeAgentic(run))).not.toMatch(/deferred/);
  });

  it('separates missing configuration from a down endpoint', () => {
    expect(configFromEnv({}).configured).toBe(false);
    expect(configFromEnv({}).missing).toEqual(['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY']);
    expect(configFromEnv({ LLM_BASE_URL: 'x/', LLM_MODEL: 'm', LLM_API_KEY: 'k' }))
      .toMatchObject({ configured: true, baseUrl: 'x' });
  });

  it('turns a terminal failure into a state with a human action', async () => {
    const err = await chat(CONFIG, [], { ...NO_WAIT, fetchImpl: fakeFetch([json({}, 403)]) }).catch((e) => e);
    expect(err.toTerminalState()).toMatchObject({ state: 'red', classification: PERSISTENT });
    expect(err.toTerminalState().humanAction).toMatch(/retrying will not help/);
  });
});

describe('scope is a guard, not a router', () => {
  it('raises a routing alarm rather than paying for a fix that is already free', () => {
    const v = checkScope({ rule: supportedRules()[0], file: 'a.js', line: 1 });
    expect(v.inScope).toBe(false);
    expect(v.alarm).toMatch(/ROUTING BUG/);
  });

  it('raises a scope-creep alarm for a rule nobody decided about', () => {
    const v = checkScope({ rule: 'javascript:S9999', file: 'a.js', line: 1 });
    expect(v.inScope).toBe(false);
    expect(v.alarm).toMatch(/SCOPE CREEP/);
  });

  it('admits exactly the ten findings #19 exists for', () => {
    for (const rule of AGENTIC_RULES) {
      expect(checkScope({ rule, file: 'a.ts', line: 1 }).inScope).toBe(true);
    }
  });

  it('never lets a codemod-fixable rule through — zero tokens for those groups', async () => {
    const findings = supportedRules().map((rule, i) => ({ rule, file: `f${i}.js`, line: 1 }));
    let called = 0;
    const run = await runAgentic(findings, {
      config: { ...CONFIG, configured: true },
      llm: { fetchImpl: () => { called++; return ok(''); } }
    });
    expect(called).toBe(0);
    expect(run.results).toEqual([]);
    expect(run.alarms.length).toBe(findings.length);
  });
});

describe('reading the answer back', () => {
  it('accepts the contract, with or without the fences it was told not to use', () => {
    expect(parseProposal('===FIX===\nconst a=1\n===TEST===\nconst t=1\n===END===')).toMatchObject({ ok: true });
    expect(parseProposal('===FIX===\n```ts\nconst a=1\n```\n===TEST===\nconst t=1\n===END==='))
      .toMatchObject({ ok: true, fix: 'const a=1' });
  });

  it('treats a malformed reply as a rejected attempt with a reason, not a crash', () => {
    expect(parseProposal('sure, here you go!')).toMatchObject({ ok: false });
    expect(parseProposal('===FIX===\n\n===TEST===\nx\n===END===').reason).toMatch(/fix section is empty/);
    expect(parseProposal('===TEST===\nx\n===FIX===\ny').reason).toMatch(/before/);
  });

  it('puts the rule guidance and the numbered source in front of the model', () => {
    const msgs = buildPrompt({
      finding: { rule: 'typescript:S3358', file: 'web/src/a.ts', line: 2, message: 'nested ternary' },
      source: 'const a = 1;\nconst b = c ? d ? 1 : 2 : 3;\n',
      rule: { available: true, howToFix: 'Extract the inner ternary.' },
      testPath: 'web/src/a.spec.ts', importPath: './a', enclosing: 'b'
    });
    expect(msgs[1].content).toMatch(/Extract the inner ternary/);
    expect(msgs[1].content).toMatch(/2\| const b/);
    expect(msgs[0].content).toMatch(/Behaviour is preserved exactly/);
  });

  // Regression, run 33349355864: all four proposals died on
  // "ReferenceError: describe is not defined". The sandbox runs bare vitest
  // with no globals, the prompt never said so, and a jest-shaped test never
  // loads there. The contract belongs in the prompt, not in folklore.
  it('tells the model the test framework contract, not just where the file goes', () => {
    const msgs = buildPrompt({
      finding: { rule: 'javascript:S4144', file: 'api/src/a.js', line: 2 },
      source: 'export const a = 1;\n',
      rule: { available: false },
      testPath: 'api/test/a.generated.test.js', importPath: '../src/a.js', enclosing: 'a'
    });
    expect(msgs[0].content).toMatch(/import \{ describe, it, expect \} from/);
    expect(msgs[0].content).toMatch(/vitest/);
  });

  // Telling it was not enough: with the contract in the prompt the 7b still
  // opened with a bare `describe` in 3 of 4 attempts. Same class of tic as
  // the fences unfence() strips, so it gets the same treatment — a mechanical
  // repair at the parse seam, and the gates judge substance instead of idiom.
  it('prepends the vitest import a jest-shaped test forgot', () => {
    const p = parseProposal('===FIX===\nconst a=1\n===TEST===\n'
      + 'import { f } from "./f.js";\ndescribe("f", () => {\n  it("works", () => {\n'
      + '    expect(f()).toBe(1);\n  });\n});\n===END===');
    expect(p.ok).toBe(true);
    expect(p.test).toMatch(/^import \{ describe, it, expect \} from 'vitest';\n/);
  });

  it('leaves a test that already imports from vitest alone', () => {
    const body = "import { describe, it, expect } from 'vitest';\ndescribe('x', () => {});\n";
    const p = parseProposal(`===FIX===\nconst a=1\n===TEST===\n${body}===END===`);
    expect(p.test).toBe(body.trim());
  });

  it('imports only the helpers the test actually uses, vi included', () => {
    const p = parseProposal('===FIX===\nconst a=1\n===TEST===\n'
      + 'test("t", () => {\n  vi.useFakeTimers();\n  expect(1).toBe(1);\n});\n===END===');
    expect(p.test.split('\n')[0]).toBe("import { test, expect, vi } from 'vitest';");
  });

  it('does not touch a test that uses no test helpers at all', () => {
    const p = parseProposal('===FIX===\nconst a=1\n===TEST===\nconsole.log("not a test")\n===END===');
    expect(p.test).toBe('console.log("not a test")');
  });
});

// A workspace that answers however the test needs, without touching a disk or
// starting a process. The real one is exercised by prove-gates.mjs.
function fakeWorkspace({ testOnFix = true, testOnMutant = false, build = true, suite = true } = {}) {
  const seen = [];
  let current = 'fix';
  return {
    seen,
    async reset() { seen.push('reset'); },
    async write(p, c) { seen.push(`write ${p}`); current = c.includes('return undefined') ? 'mutant' : 'fix'; },
    async runTest() {
      const pass = current === 'mutant' ? testOnMutant : testOnFix;
      return { ok: pass, stdout: pass ? 'ok' : 'FAIL', stderr: '' };
    },
    async runBuild() { return { ok: build, stdout: build ? '' : 'build broke', stderr: '' }; },
    async runSuite() { return { ok: suite, stdout: suite ? '' : 'suite broke', stderr: '' }; }
  };
}

const SOURCE = `export function pick(a, b, c) {
  return a ? (b ? 1 : 2) : 3;
}
`;
const GOOD_FIX = `export function pick(a, b, c) {
  if (!a) return 3;
  return b ? 1 : 2;
}
`;
const FINDING = { rule: 'typescript:S3358', file: 'web/src/app/orders/order-stats.ts', line: 2, message: 'nested ternary' };

function llmReturning(fix, test = 'import { pick } from "./order-stats";\ntest("t", () => {});\n') {
  // A thunk, not a value: a stream body can only be read once, and real HTTP
  // hands out a fresh one per request. Sharing one across proposal attempts
  // made the second attempt read an exhausted stream.
  return { fetchImpl: fakeFetch([() => ok(`===FIX===\n${fix}\n===TEST===\n${test}\n===END===`)]) };
}

describe('the model is never trusted, only used', () => {
  const base = { root: '.', source: SOURCE, rule: { available: false }, config: CONFIG };

  it('accepts a proposal that clears every gate', async () => {
    const r = await fixOne(FINDING, {
      ...base, workspace: fakeWorkspace(), llm: { ...NO_WAIT, ...llmReturning(GOOD_FIX) }
    });
    expect(r.accepted).toBe(true);
    expect(r.enclosing).toBe('pick');
    expect(r.test).toBeTruthy();
    // Its own file, not the deterministic path's: the model returns a WHOLE
    // test file, so sharing the name would replace the committed
    // characterization tests for every deterministic fix in that source file.
    expect(r.testPath).toBe('web/src/app/orders/order-stats.agentic.spec.ts');
  });

  it('rejects a test that still passes with the fixed function stubbed out', async () => {
    const r = await fixOne(FINDING, {
      ...base,
      workspace: fakeWorkspace({ testOnMutant: true }),
      llm: { ...NO_WAIT, ...llmReturning(GOOD_FIX) },
      maxProposalAttempts: 1
    });
    expect(r.accepted).toBe(false);
    expect(r.rejections[0].gate).toBe('testDiscriminates');
    expect(r.rejections[0].reason).toMatch(/never exercises the fix/);
  });

  it('rejects a proposal that changes the public surface', async () => {
    const r = await fixOne(FINDING, {
      ...base,
      workspace: fakeWorkspace(),
      llm: { ...NO_WAIT, ...llmReturning('export function choose(a, b) { return a ? b : 0; }\n') },
      maxProposalAttempts: 1
    });
    expect(r.rejections[0].gate).toBe('admissible');
    expect(r.rejections[0].reason).toMatch(/public surface changed/);
  });

  it('rejects a proposal that does not build, and classifies the terminal state', async () => {
    const r = await fixOne(FINDING, {
      ...base,
      workspace: fakeWorkspace({ build: false }),
      llm: { ...NO_WAIT, ...llmReturning(GOOD_FIX) },
      maxProposalAttempts: 2
    });
    expect(r.accepted).toBe(false);
    expect(r.rejections.length).toBe(2);            // the cap, and not one more
    expect(r.classification).toBe('build_failure_patch_induced');
    expect(r.state).toBe('red');
  });

  it('feeds the prior rejection back into the retry, per spec §15', async () => {
    const f = fakeFetch([() => ok(`===FIX===\n${GOOD_FIX}\n===TEST===\nx\n===END===`)]);
    await fixOne(FINDING, {
      ...base, workspace: fakeWorkspace({ build: false }),
      llm: { ...NO_WAIT, fetchImpl: f }, maxProposalAttempts: 2
    });
    const second = JSON.parse(f.calls[1].init.body);
    expect(second.messages.at(-1).content).toMatch(/rejected at gate "build"/);
    // The gate's captured output, not only its verdict. Run 33349355864:
    // "the test does not pass" hid a ReferenceError, so every retry repeated it.
    expect(second.messages.at(-1).content).toMatch(/The gate's output:\nbuild broke/);
  });

  it('feeds the failing test output back, so a loading crash is learnable', async () => {
    const f = fakeFetch([() => ok(`===FIX===\n${GOOD_FIX}\n===TEST===\nx\n===END===`)]);
    await fixOne(FINDING, {
      ...base, workspace: fakeWorkspace({ testOnFix: false }),
      llm: { ...NO_WAIT, fetchImpl: f }, maxProposalAttempts: 2
    });
    const second = JSON.parse(f.calls[1].init.body);
    expect(second.messages.at(-1).content).toMatch(/rejected at gate "testDiscriminates"/);
    expect(second.messages.at(-1).content).toMatch(/The gate's output:\nFAIL/);
    // At temperature 0 the only lever a retry has is its instruction, and the
    // observed loop was a wrong guess about an unchanged function repeated
    // verbatim. The escape hatch must be stated, or the budget buys nothing.
    expect(second.messages.at(-1).content).toMatch(/DELETE that case/);
  });

  // The summary said "0 tokens" for a run that made four real model calls:
  // rejected attempts carried usage that fixOne dropped on the floor. Every
  // attempt is paid for, accepted or not, and the bill must say so.
  it('accounts tokens for rejected attempts, not only accepted ones', async () => {
    const r = await fixOne(FINDING, {
      ...base, workspace: fakeWorkspace({ testOnFix: false }),
      llm: { ...NO_WAIT, ...llmReturning(GOOD_FIX) }, maxProposalAttempts: 2
    });
    expect(r.accepted).toBe(false);
    expect(r.usage.total_tokens).toBe(84);   // 42 per attempt, twice
    const run = { ran: true, inScope: [FINDING], outOfScope: [], alarms: [], results: [r] };
    expect(summarizeAgentic(run).tokens).toBe(84);
  });

  it('accounts every attempt behind an acceptance, not just the last', async () => {
    let n = 0;
    const f = fakeFetch([() => (++n === 1
      ? ok('malformed on purpose')
      : ok(`===FIX===\n${GOOD_FIX}\n===TEST===\nimport { pick } from "./order-stats";\ntest("t", () => {});\n===END===`))]);
    const r = await fixOne(FINDING, {
      ...base, workspace: fakeWorkspace(), llm: { ...NO_WAIT, fetchImpl: f }, maxProposalAttempts: 2
    });
    expect(r.accepted).toBe(true);
    expect(r.usage.total_tokens).toBe(84);   // the rejected first attempt still cost 42
  });

  it('reaches a red terminal state with an infra class when the endpoint is unreachable', async () => {
    const r = await fixOne(FINDING, {
      ...base,
      workspace: fakeWorkspace(),
      llm: { ...NO_WAIT, fetchImpl: fakeFetch([() => { throw new Error('ENOTFOUND'); }]), maxRetries: 1 }
    });
    expect(r.accepted).toBe(false);
    expect(r.infra).toBe(true);
    expect(r.classification).toBe(TRANSIENT);
    expect(r.state).toBe('red');
  });

  it('says plainly that it never ran rather than implying a healthy endpoint failed', async () => {
    const run = await runAgentic([FINDING], { config: configFromEnv({}) });
    expect(run.ran).toBe(false);
    expect(run.reason).toMatch(/not configured: LLM_BASE_URL/);
    expect(summarizeAgentic(run)).toMatchObject({ ran: false, accepted: 0, tokens: 0 });
  });
});

describe('the mutant the discrimination gate depends on', () => {
  it('empties a declared function, an arrow, and every method of a class', () => {
    const src = 'export function f(a) { return a + 1; }\n'
      + 'export const g = (a) => a * 2;\n'
      + 'export class C { m() { return 1; } }\n';
    expect(stubSymbol(src, 'a.js', 'f')).toMatch(/function f\(a\) \{\s*return undefined;/);
    expect(stubSymbol(src, 'a.js', 'g')).toMatch(/g = a => \{\s*return undefined;/);
    expect(stubSymbol(src, 'a.js', 'C')).toMatch(/m\(\) \{\s*return undefined;/);
  });

  it('returns null rather than a false pass when the symbol is not there', () => {
    expect(stubSymbol('export const a = 1;', 'a.js', 'missing')).toBeNull();
  });

  it('refuses a proposal whose finding sits outside any exported symbol', async () => {
    const r = await fixOne({ ...FINDING, line: 99 }, {
      root: '.', source: SOURCE, rule: { available: false }, config: CONFIG,
      workspace: fakeWorkspace(), llm: { ...NO_WAIT, ...llmReturning(GOOD_FIX) },
      maxProposalAttempts: 1
    });
    expect(r.rejections[0].gate).toBe('testDiscriminates');
    expect(r.rejections[0].reason).toMatch(/no exported symbol encloses/);
  });
});

describe('admissibility', () => {
  it('refuses a reply that changed nothing', () => {
    expect(admissible({ original: SOURCE, proposed: SOURCE, filePath: 'a.ts' }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/byte-identical/) });
  });
  it('refuses a reply that does not parse', () => {
    expect(admissible({ original: SOURCE, proposed: 'export function ( {{{', filePath: 'a.ts' }).ok).toBe(false);
  });
  it('records a gained export rather than silently allowing a bigger change than asked for', () => {
    const v = admissible({
      original: SOURCE,
      proposed: `${GOOD_FIX}export function inner(b) { return b ? 1 : 2; }\n`,
      filePath: 'a.ts'
    });
    expect(v.ok).toBe(true);
    expect(v.detail.gained).toContain('inner/function/1');
  });
});

describe('what a gate captures is text, not a terminal', () => {
  it('strips colour codes, so artifacts, comments and retry prompts stay readable', () => {
    expect(tail('\u001b[31m\u001b[1mFAIL\u001b[22m\u001b[39m api/test/x.test.js')).toBe('FAIL api/test/x.test.js');
  });

  it('keeps only the last n lines', () => {
    expect(tail('a\nb\nc\nd', 2)).toBe('c\nd');
  });
});

describe('each finding gets its own file, not the first one', () => {
  /**
   * Replays a bug that shipped for exactly one commit: `runAgentic` took
   * `source` off the shared context, so every finding after the first was sent
   * a different file's contents. The symptom is the worst kind — the model
   * answers coherently about the wrong file, and the rejection reads as the
   * model being bad rather than the caller being wrong.
   */
  it('reads the source for each finding it is asked about', async () => {
    const asked = [];
    const seen = new Map();
    const findings = [
      { rule: 'javascript:S3776', file: 'api/src/a.js', line: 1 },
      { rule: 'javascript:S4144', file: 'api/src/b.js', line: 1 }
    ];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      asked.push(body.messages[1].content);
      return ok('nope, malformed on purpose');
    };
    const run = await runAgentic(findings, {
      config: { ...CONFIG, configured: true },
      readSource: (f) => { seen.set(f, true); return `export function only_in_${f.split('/').pop().split('.')[0]}() {}\n`; },
      workspace: fakeWorkspace(),
      llm: { ...NO_WAIT, fetchImpl },
      maxProposalAttempts: 1,
      rules: new Map()
    });
    expect(run.ran).toBe(true);
    expect([...seen.keys()]).toEqual(['api/src/a.js', 'api/src/b.js']);
    expect(asked[0]).toMatch(/only_in_a/);
    expect(asked[0]).not.toMatch(/only_in_b/);
    expect(asked[1]).toMatch(/only_in_b/);
  });

  it('turns a file the checkout does not have into a red state, not a crash', async () => {
    const run = await runAgentic([{ rule: 'javascript:S3776', file: 'api/src/gone.js', line: 1 }], {
      config: { ...CONFIG, configured: true },
      readSource: () => { throw new Error('ENOENT'); }
    });
    expect(run.results[0]).toMatchObject({ accepted: false, state: 'red', classification: 'ambiguous_root_cause' });
    expect(run.results[0].summary).toMatch(/cannot read api\/src\/gone\.js/);
  });
});
