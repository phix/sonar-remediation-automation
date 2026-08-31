/**
 * Prove the gates are not decoration.
 *
 * Every assertion in `agentic.test.mjs` runs against a fake workspace: no
 * process starts, no test runner runs, and `runTest` returns whatever the case
 * needed it to. That is the right shape for a unit test and it is exactly the
 * shape that hid three real bugs in this repo already — each one living in the
 * gap between a hand-written stub and a real file.
 *
 * So this builds a genuine little project on disk, hands it to the genuine
 * `createWorkspace`, and runs the genuine `fixOne` against a model that says
 * whatever this file tells it to. The only fake left is the model, which is
 * the point: everything downstream of it is real.
 *
 * Four scenarios, and the second is the one worth the effort:
 *
 *   1. a correct fix with a test that exercises it        -> ACCEPTED
 *   2. a correct fix with a test that never calls it      -> REJECTED  <-- the gate
 *   3. a fix that does not parse                          -> REJECTED
 *   4. an endpoint that is not there                      -> RED, classified, bounded
 *
 * If 2 passes, the discrimination gate asserts nothing and every "one test per
 * fix" claim this pipeline makes is decoration.
 *
 * Usage: node codemods/agentic/prove-gates.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from './workspace.mjs';
import { fixOne } from './agent.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A real `javascript:S3776` — deeply nested, and correct, which is what makes it a smell. */
const ORIGINAL = `export function grade(score, bonus, penalty) {
  if (score > 90) {
    if (bonus > 5) {
      if (penalty === 0) { return 'A+'; } else { return 'A'; }
    } else {
      if (penalty === 0) { return 'A'; } else { return 'B'; }
    }
  } else {
    if (bonus > 5) {
      if (penalty === 0) { return 'B'; } else { return 'C'; }
    } else {
      return 'D';
    }
  }
}
`;

const GOOD_FIX = `const TABLE = {
  'high:bonus:clean': 'A+', 'high:bonus:dirty': 'A',
  'high:plain:clean': 'A', 'high:plain:dirty': 'B',
  'low:bonus:clean': 'B', 'low:bonus:dirty': 'C'
};

export function grade(score, bonus, penalty) {
  if (score <= 90 && bonus <= 5) return 'D';
  const key = [score > 90 ? 'high' : 'low', bonus > 5 ? 'bonus' : 'plain', penalty === 0 ? 'clean' : 'dirty'].join(':');
  return TABLE[key];
}
`;

const REAL_TEST = `import { describe, it, expect } from 'vitest';
import { grade } from '../src/summary.js';

describe('grade', () => {
  it('preserves every branch of the original table', () => {
    expect(grade(95, 6, 0)).toBe('A+');
    expect(grade(95, 6, 1)).toBe('A');
    expect(grade(95, 1, 0)).toBe('A');
    expect(grade(95, 1, 1)).toBe('B');
    expect(grade(50, 6, 0)).toBe('B');
    expect(grade(50, 6, 1)).toBe('C');
    expect(grade(50, 1, 1)).toBe('D');
  });
});
`;

/**
 * The test a model writes when it wants the gate to go green: it imports the
 * module, it passes, and it never calls the function that was changed.
 */
const LAZY_TEST = `import { describe, it, expect } from 'vitest';
import * as mod from '../src/summary.js';

describe('summary', () => {
  it('exports what it should', () => {
    expect(typeof mod.grade).toBe('function');
    expect(mod.grade.length).toBe(3);
  });
});
`;

function scaffold() {
  const src = mkdtempSync(join(tmpdir(), 'prove-src-'));
  // The layout is the sandbox's, not a convenient one: `testPathFor` decides
  // where a generated test lives, and it only knows `api/` and `web/`. A
  // fixture shaped differently would be testing a path the pipeline never
  // takes -- which is how the first run of this prover reported three
  // scenarios failing and one passing for entirely the wrong reason.
  mkdirSync(join(src, 'api', 'src'), { recursive: true });
  mkdirSync(join(src, 'api', 'test'), { recursive: true });
  writeFileSync(join(src, 'api', 'src', 'summary.js'), ORIGINAL);
  writeFileSync(join(src, 'package.json'), JSON.stringify({
    name: 'prove-gates-fixture', private: true, type: 'module', version: '0.0.0',
    scripts: {
      // A real syntax gate: `node --check` fails on a file that does not parse.
      build: 'node --check api/src/summary.js',
      test: 'vitest run'
    }
  }, null, 2));
  return src;
}

const findingFor = (root) => ({
  rule: 'javascript:S3776',
  file: 'api/src/summary.js',
  line: 2,
  message: 'Refactor this function to reduce its Cognitive Complexity.'
});

function llmSaying(fix, test) {
  const content = `===FIX===\n${fix}\n===TEST===\n${test}\n===END===`;
  const enc = new TextEncoder();
  // An SSE body, because that is what the client reads now. A resolved JSON
  // document here would prove the gates against a transport that no longer
  // exists -- and a prover that passes on a path nothing uses is worse than
  // no prover. Built fresh per call: a stream can only be read once, and the
  // retry scenarios call this more than once.
  return {
    sleep: async () => {},
    fetchImpl: async () => ({
      ok: true, status: 200,
      text: async () => '',
      body: (async function* () {
        yield enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        yield enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 1 } })}\n\n`);
        yield enc.encode('data: [DONE]\n\n');
      })()
    })
  };
}

async function scenario(name, { fix, test, llm, expectAccepted, expectGate, expectReason }) {
  const src = scaffold();
  const ws = createWorkspace(src, {
    buildCmd: ['npm', ['run', '--silent', 'build']],
    suiteCmd: ['npx', ['vitest', 'run']],
    testCmd: (p) => ['npx', ['vitest', 'run', p]],
    timeoutMs: 120_000
  });
  // vitest comes from this repo rather than a fresh install per scenario.
  try { symlinkSync(join(REPO, 'node_modules'), join(ws.root, 'node_modules'), 'dir'); } catch { /* already there */ }

  const started = Date.now();
  const r = await fixOne(findingFor(ws.root), {
    root: ws.root,
    source: ORIGINAL,
    rule: { available: false, reason: 'not fetched in this prover' },
    config: { baseUrl: 'https://llm.invalid/v1', model: 'stub', apiKey: 'stub' },
    workspace: ws,
    llm: llm || llmSaying(fix, test),
    maxProposalAttempts: 1,
    log: () => {}
  });
  const elapsed = Date.now() - started;

  const gate = r.rejections?.[0]?.gate || (r.infra ? r.classification : null);
  const reason = r.rejections?.[0]?.reason || r.summary || '';
  // The reason is checked as well as the gate. Without it, scenario 3 once
  // reported PASS while every scenario was actually dying at the same
  // unrelated error -- the right verdict reached for the wrong cause, which is
  // the failure this whole file exists to argue against.
  const pass = r.accepted === expectAccepted
    && (!expectGate || gate === expectGate)
    && (!expectReason || expectReason.test(reason));
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        accepted=${r.accepted} gate=${gate ?? '-'} elapsed=${elapsed}ms`);
  if (r.rejections?.[0]) console.log(`        reason: ${r.rejections[0].reason}`);
  if (r.infra) console.log(`        summary: ${r.summary}`);
  if (!pass) {
    console.log(`        EXPECTED accepted=${expectAccepted} gate=${expectGate ?? 'any'}`
      + `${expectReason ? ` reason~${expectReason}` : ''}`);
  }

  ws.dispose();
  rmSync(src, { recursive: true, force: true });
  return pass;
}

const results = [];
console.log('Running the gates against a real project, a real build and a real vitest.\n');

results.push(await scenario('1. correct fix + a test that exercises it  -> ACCEPTED',
  { fix: GOOD_FIX, test: REAL_TEST, expectAccepted: true }));

results.push(await scenario('2. correct fix + a test that never calls it -> REJECTED',
  { fix: GOOD_FIX, test: LAZY_TEST, expectAccepted: false, expectGate: 'testDiscriminates',
    expectReason: /never exercises the fix/ }));

results.push(await scenario('3. a fix that does not parse                -> REJECTED',
  { fix: 'export function grade(score, bonus {{{', test: REAL_TEST,
    expectAccepted: false, expectGate: 'admissible', expectReason: /does not parse/ }));

results.push(await scenario('4. an endpoint that is not there            -> RED, bounded',
  { expectAccepted: false, expectGate: 'infra_failure_transient', expectReason: /Cannot reach/,
    llm: { sleep: async () => {}, maxRetries: 1, connectTimeoutMs: 500,
      fetchImpl: async () => { throw new Error('ENOTFOUND llm.invalid'); } } }));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} scenarios behaved as specified.`);
if (failed) {
  console.log('\nA failing scenario 2 means the discrimination gate asserts nothing:');
  console.log('every "one test per fix" claim downstream of it is decoration.');
}
process.exit(failed ? 1 : 0);
