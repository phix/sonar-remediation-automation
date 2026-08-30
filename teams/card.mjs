/**
 * The Adaptive Card for the terminal-state Teams message.
 *
 * Power Automate's "Post card in a chat or channel" action posts a raw
 * Adaptive Card — not the classic MessageCard envelope the old incoming
 * webhooks used, which is dead along with the webhooks that spoke it (see
 * IMPLEMENTATION_PLAN.md §4.2).
 *
 * The product promise is ONE message at the terminal state: "the PR is
 * ready", or "it is red and exactly why". Everything here exists to make
 * that verdict readable at a glance rather than a wall of raw JSON —
 * validation box 2 of #2 — so the shape is: a title that states the
 * verdict, the reason (red only, carried verbatim), a facts block for the
 * structured fields, the deterministic ratio when supplied, and a link
 * action to the run rather than a URL buried in text.
 *
 * Pure function. No I/O — nothing here can hang or need a fetchImpl, and
 * that is deliberate: transport bounding belongs in client.mjs alone.
 */

const SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';
const VERSION = '1.4';

function fact(title, value) {
  return { title, value: String(value) };
}

/**
 * @param {object} input
 * @param {'ready'|'red'} input.verdict
 * @param {string} [input.reason]   required when verdict is 'red'; carried
 *                                  verbatim into the card — this function
 *                                  never invents or summarises it
 * @param {string} [input.repo]
 * @param {string} [input.planId]
 * @param {string} [input.ruleKey]
 * @param {string|number} [input.prNumber]
 * @param {string} [input.prUrl]
 * @param {string} [input.runUrl]
 * @param {{codemod?: number, agent?: number, refused?: number}} [input.ratio]
 *   The fixed-by-codemod vs fixed-by-agent split. Reported when the caller
 *   supplies it — the plan calls this "the project's whole economic
 *   argument" and asks for it per run, not as an aggregate elsewhere.
 * @returns {object} an Adaptive Card, ready to POST as-is
 */
export function buildCard(input = {}) {
  const { verdict, reason, repo, planId, ruleKey, prNumber, prUrl, runUrl, ratio } = input;

  if (verdict !== 'ready' && verdict !== 'red') {
    throw new Error(`buildCard: verdict must be "ready" or "red", got ${JSON.stringify(verdict)}`);
  }
  if (verdict === 'red' && !reason) {
    throw new Error('buildCard: a red verdict requires a reason — the whole point of this message '
      + 'is saying exactly why');
  }

  const title = verdict === 'ready' ? 'PR is ready' : 'PR is red';
  const body = [
    {
      type: 'TextBlock',
      text: title,
      weight: 'Bolder',
      size: 'Large',
      wrap: true,
      color: verdict === 'ready' ? 'Good' : 'Attention'
    }
  ];

  if (verdict === 'red') {
    // Verbatim: this module is not the place that decides what the reason
    // means, only the place that displays it.
    body.push({ type: 'TextBlock', text: reason, wrap: true });
  }

  const facts = [];
  if (repo) facts.push(fact('Repo', repo));
  if (prNumber !== undefined && prNumber !== null && prNumber !== '') facts.push(fact('PR', `#${prNumber}`));
  if (planId) facts.push(fact('Plan', planId));
  if (ruleKey) facts.push(fact('Rule', ruleKey));
  facts.push(fact('Verdict', verdict === 'ready' ? 'Ready to merge' : 'Red'));
  body.push({ type: 'FactSet', facts });

  if (ratio && (ratio.codemod != null || ratio.agent != null || ratio.refused != null)) {
    const parts = [];
    if (ratio.codemod != null) parts.push(`${ratio.codemod} fixed by codemod`);
    if (ratio.agent != null) parts.push(`${ratio.agent} fixed by agent`);
    if (ratio.refused != null) parts.push(`${ratio.refused} refused by policy`);
    body.push({ type: 'TextBlock', text: parts.join(', '), wrap: true, isSubtle: true });
  }

  const actions = [];
  if (runUrl) actions.push({ type: 'Action.OpenUrl', title: 'View run', url: runUrl });
  if (prUrl) actions.push({ type: 'Action.OpenUrl', title: 'View pull request', url: prUrl });

  return {
    type: 'AdaptiveCard',
    $schema: SCHEMA,
    version: VERSION,
    body,
    ...(actions.length ? { actions } : {})
  };
}
