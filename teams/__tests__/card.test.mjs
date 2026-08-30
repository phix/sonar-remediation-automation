import { describe, it, expect } from 'vitest';
import { buildCard } from '../card.mjs';

describe('verdict is required and validated', () => {
  it('throws on a missing or unrecognised verdict', () => {
    expect(() => buildCard({})).toThrow(/verdict/i);
    expect(() => buildCard({ verdict: 'yellow' })).toThrow(/verdict/i);
  });

  it('throws when red has no reason — the reason is not optional decoration', () => {
    expect(() => buildCard({ verdict: 'red' })).toThrow(/reason/i);
  });
});

describe('the ready card', () => {
  it('states the verdict at a glance and carries no reason block', () => {
    const card = buildCard({ verdict: 'ready', repo: 'phix/sonar-sandbox-app', prNumber: '42' });
    expect(card.type).toBe('AdaptiveCard');
    const title = card.body[0];
    expect(title.text).toMatch(/ready/i);
    // No stray reason text anywhere in the body for a green verdict.
    expect(JSON.stringify(card.body)).not.toMatch(/reason/i);
  });
});

describe('the red card', () => {
  it('carries the caller-supplied reason VERBATIM — never invented, never summarised', () => {
    const weirdReason = 'S3776 in api/src/auth/session.js:88 — cyclomatic complexity 24 > 15, could not be fixed deterministically and the agent declined its own proposal twice.';
    const card = buildCard({ verdict: 'red', reason: weirdReason });
    const blocks = card.body.map((b) => b.text).filter(Boolean);
    expect(blocks).toContain(weirdReason);
  });

  it('marks the title distinctly from the ready title', () => {
    const readyTitle = buildCard({ verdict: 'ready' }).body[0].text;
    const redTitle = buildCard({ verdict: 'red', reason: 'x' }).body[0].text;
    expect(redTitle).not.toBe(readyTitle);
    expect(redTitle).toMatch(/red/i);
  });
});

describe('legible, not a wall of JSON — validation box 2 of #2', () => {
  it('renders a realistic multi-field payload as a facts block, not a dumped object', () => {
    const card = buildCard({
      verdict: 'red',
      reason: 'because reasons',
      repo: 'phix/sonar-sandbox-app',
      planId: 'plan-2026-08-30-01',
      ruleKey: 'javascript:S3776',
      prNumber: '17',
      runUrl: 'https://github.com/phix/sonar-remediation-automation/actions/runs/999'
    });
    const factSet = card.body.find((b) => b.type === 'FactSet');
    expect(factSet).toBeTruthy();
    const byTitle = Object.fromEntries(factSet.facts.map((f) => [f.title, f.value]));
    expect(byTitle.Repo).toBe('phix/sonar-sandbox-app');
    expect(byTitle.Plan).toBe('plan-2026-08-30-01');
    expect(byTitle.Rule).toBe('javascript:S3776');
    expect(byTitle.PR).toBe('#17');
    // Nothing in the card is a raw JSON dump of the input.
    expect(JSON.stringify(card)).not.toContain('planId');
  });

  it('omits facts for fields the caller did not supply, rather than inventing blanks', () => {
    const card = buildCard({ verdict: 'ready' });
    const factSet = card.body.find((b) => b.type === 'FactSet');
    const titles = factSet.facts.map((f) => f.title);
    expect(titles).not.toContain('Repo');
    expect(titles).not.toContain('Plan');
    expect(titles).not.toContain('Rule');
  });

  it('links to the run when a run URL is supplied, as an action rather than inline text', () => {
    const card = buildCard({ verdict: 'ready', runUrl: 'https://example.test/run/1' });
    expect(card.actions).toBeTruthy();
    const openRun = card.actions.find((a) => a.url === 'https://example.test/run/1');
    expect(openRun.type).toBe('Action.OpenUrl');
  });
});

describe('the deterministic ratio — "the project\'s whole economic argument"', () => {
  it('is included when the caller supplies it', () => {
    const card = buildCard({ verdict: 'ready', ratio: { codemod: 18, agent: 10, refused: 4 } });
    const text = JSON.stringify(card.body);
    expect(text).toMatch(/18/);
    expect(text).toMatch(/10/);
    expect(text).toMatch(/4/);
  });

  it('is absent when the caller supplies nothing, rather than showing zeroes', () => {
    const card = buildCard({ verdict: 'ready' });
    const text = JSON.stringify(card.body);
    expect(text).not.toMatch(/codemod/i);
  });
});

describe('purity', () => {
  it('does not mutate the input it was given', () => {
    const input = { verdict: 'ready', repo: 'a/b', ratio: { codemod: 1 } };
    const copy = JSON.parse(JSON.stringify(input));
    buildCard(input);
    expect(input).toEqual(copy);
  });
});
