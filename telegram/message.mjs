/**
 * The Telegram message for the terminal-state notification.
 *
 * The product promise is unchanged from the Teams shape it replaces (see
 * docs/decisions/notify-telegram-not-teams.md): ONE message at the terminal
 * state — "the PR is ready", or "it is red and exactly why". Everything here
 * exists to make that verdict readable at a glance: a title that states the
 * verdict, the reason (red only, carried verbatim), the structured fields,
 * the deterministic ratio when supplied, and links to the run and PR rather
 * than URLs buried in text.
 *
 * HTML parse mode, not MarkdownV2: the red reason is arbitrary text written
 * by other stages, and MarkdownV2 requires escaping seventeen punctuation
 * characters that appear constantly in rule keys and file paths — one missed
 * underscore and the API 400s the whole message. HTML needs three entities.
 *
 * Pure function. No I/O — nothing here can hang or need a fetchImpl, and
 * that is deliberate: transport bounding belongs in client.mjs alone.
 */

/** The three characters HTML parse mode reserves, plus quotes for hrefs. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function factLine(title, value) {
  return `<b>${title}:</b> ${escapeHtml(value)}`;
}

/**
 * @param {object} input
 * @param {'ready'|'red'} input.verdict
 * @param {string} [input.reason]   required when verdict is 'red'; carried
 *                                  verbatim (HTML-escaped, never reworded)
 *                                  into the message — this function never
 *                                  invents or summarises it
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
 * @returns {object} the sendMessage payload fields (text + parse settings),
 *   ready for client.mjs to add chat_id and POST as-is
 */
export function buildMessage(input = {}) {
  const { verdict, reason, repo, planId, ruleKey, prNumber, prUrl, runUrl, ratio } = input;

  if (verdict !== 'ready' && verdict !== 'red') {
    throw new Error(`buildMessage: verdict must be "ready" or "red", got ${JSON.stringify(verdict)}`);
  }
  if (verdict === 'red' && !reason) {
    throw new Error('buildMessage: a red verdict requires a reason — the whole point of this '
      + 'message is saying exactly why');
  }

  const lines = [verdict === 'ready' ? '✅ <b>PR is ready</b>' : '🔴 <b>PR is red</b>'];

  if (verdict === 'red') {
    // Verbatim (escaped, never reworded): this module is not the place that
    // decides what the reason means, only the place that displays it.
    lines.push('', escapeHtml(reason));
  }

  lines.push('');
  if (repo) lines.push(factLine('Repo', repo));
  if (prNumber !== undefined && prNumber !== null && prNumber !== '') {
    lines.push(prUrl
      ? `<b>PR:</b> <a href="${escapeHtml(prUrl)}">#${escapeHtml(prNumber)}</a>`
      : factLine('PR', `#${prNumber}`));
  }
  if (planId) lines.push(factLine('Plan', planId));
  if (ruleKey) lines.push(factLine('Rule', ruleKey));
  lines.push(factLine('Verdict', verdict === 'ready' ? 'Ready to merge' : 'Red'));

  if (ratio && (ratio.codemod != null || ratio.agent != null || ratio.refused != null)) {
    const parts = [];
    if (ratio.codemod != null) parts.push(`${ratio.codemod} fixed by codemod`);
    if (ratio.agent != null) parts.push(`${ratio.agent} fixed by agent`);
    if (ratio.refused != null) parts.push(`${ratio.refused} refused by policy`);
    lines.push('', `<i>${escapeHtml(parts.join(', '))}</i>`);
  }

  const links = [];
  if (runUrl) links.push(`<a href="${escapeHtml(runUrl)}">View run</a>`);
  if (prUrl && (prNumber === undefined || prNumber === null || prNumber === '')) {
    // The PR link normally rides on the PR fact above; without a number it
    // still deserves a way in.
    links.push(`<a href="${escapeHtml(prUrl)}">View pull request</a>`);
  }
  if (links.length) lines.push('', links.join(' · '));

  return {
    text: lines.join('\n'),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true }
  };
}
