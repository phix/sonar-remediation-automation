import { describe, it, expect } from 'vitest';
import { buildMessage, escapeHtml } from '../message.mjs';

describe('the verdict contract — same as the card it replaced', () => {
  it('refuses any verdict that is not ready or red', () => {
    expect(() => buildMessage({ verdict: 'maybe' })).toThrow(/ready.*red/);
    expect(() => buildMessage({})).toThrow(/ready.*red/);
  });

  it('refuses a red verdict without a reason — the whole point is saying exactly why', () => {
    expect(() => buildMessage({ verdict: 'red' })).toThrow(/requires a reason/);
  });

  it('a ready verdict carries no reason line even if one is passed', () => {
    const m = buildMessage({ verdict: 'ready', reason: 'should not appear' });
    expect(m.text).not.toContain('should not appear');
  });
});

describe('HTML safety — the reason is arbitrary text from other stages', () => {
  it('escapes markup in the reason instead of letting it break the message', () => {
    const m = buildMessage({ verdict: 'red', reason: 'coverage < 80 & rules <b>unfixed</b>' });
    expect(m.text).toContain('coverage &lt; 80 &amp; rules &lt;b&gt;unfixed&lt;/b&gt;');
    expect(m.text).not.toContain('<b>unfixed</b>');
  });

  it('escapeHtml covers the four characters that matter in text and hrefs', () => {
    expect(escapeHtml('&<>"')).toBe('&amp;&lt;&gt;&quot;');
  });
});

describe('the facts', () => {
  it('renders repo, plan, rule and a linked PR number', () => {
    const m = buildMessage({
      verdict: 'ready', repo: 'phix/sonar-sandbox-app', planId: 'plan-7',
      ruleKey: 'javascript:S4144', prNumber: 2, prUrl: 'https://github.com/phix/sonar-sandbox-app/pull/2'
    });
    expect(m.text).toContain('<b>Repo:</b> phix/sonar-sandbox-app');
    expect(m.text).toContain('<b>Plan:</b> plan-7');
    expect(m.text).toContain('<b>Rule:</b> javascript:S4144');
    expect(m.text).toContain('<a href="https://github.com/phix/sonar-sandbox-app/pull/2">#2</a>');
    expect(m.text).toContain('<b>Verdict:</b> Ready to merge');
  });

  it('states the ratio when supplied — the economic argument travels with the verdict', () => {
    const m = buildMessage({ verdict: 'ready', ratio: { codemod: 3, agent: 1, refused: 2 } });
    expect(m.text).toContain('3 fixed by codemod, 1 fixed by agent, 2 refused by policy');
  });

  it('omits the ratio line entirely when none is supplied', () => {
    const m = buildMessage({ verdict: 'ready' });
    expect(m.text).not.toMatch(/fixed by/);
  });

  it('links the run when a run URL is supplied', () => {
    const m = buildMessage({ verdict: 'ready', runUrl: 'https://github.com/x/y/actions/runs/1' });
    expect(m.text).toContain('<a href="https://github.com/x/y/actions/runs/1">View run</a>');
  });
});

describe('the payload shape', () => {
  it('is HTML parse mode with link previews off, ready for chat_id to be attached', () => {
    const m = buildMessage({ verdict: 'ready' });
    expect(m.parse_mode).toBe('HTML');
    expect(m.link_preview_options).toEqual({ is_disabled: true });
    expect(m.chat_id).toBeUndefined(); // routing belongs to client.mjs, not the builder
  });
});
