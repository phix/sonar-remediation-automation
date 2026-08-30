/**
 * Rule metadata from Sonar, including the text that says how to fix the rule.
 *
 * Two callers need this and they need the same thing: the agentic path puts
 * `how_to_fix` in the prompt so the model is told the rule's own remedy rather
 * than guessing at it, and the Jira step puts it in the ticket body so the
 * ticket says what to actually do.
 *
 * ## The plan-gating question, settled
 *
 * `docs/research/api-contracts.md` recorded that `api/rules/show` returns
 * `htmlDesc: None` and `descriptionSections: None` anonymously, and flagged
 * that `requiredEntitlements` on the payload hinted the text might be
 * plan-gated even *with* a token. Checked 2026-08-30 against
 * `javascript:S3776` with the analysis token:
 *
 *     htmlDesc            9376 chars
 *     descriptionSections introduction 111 | root_cause 2282 | how_to_fix 6517 | resources 368
 *
 * It is not plan-gated. It is simply not anonymous. So the fallback below —
 * the finding's own message plus a link to the public rule docs — is a
 * genuine degradation path for a missing token, not the expected case.
 */

const DEFAULT_HOST = 'https://sonarcloud.io';

/** Public documentation URL for a rule, which needs no credential at all. */
export function ruleDocsUrl(ruleKey) {
  const [lang, id] = String(ruleKey).split(':');
  return `https://rules.sonarsource.com/${lang}/RSPEC-${String(id).replace(/^S/, '')}/`;
}

function section(rule, key) {
  const s = (rule.descriptionSections || []).find((x) => x.key === key);
  return s?.content || '';
}

/** Strip the HTML Sonar returns down to something worth putting in a prompt. */
export function toPlainText(html) {
  return String(html || '')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\n${code}\n\n`)
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetch one rule. Never throws: a rule we cannot describe is a weaker prompt
 * and a thinner ticket, not a failed run. `available` says which happened, so
 * a caller that cares can say so out loud instead of silently shipping the
 * degraded version.
 */
export async function fetchRule(ruleKey, {
  org, token, host = DEFAULT_HOST, fetchImpl = globalThis.fetch
} = {}) {
  const docs = ruleDocsUrl(ruleKey);
  const url = `${host}/api/rules/show?organization=${encodeURIComponent(org)}&key=${encodeURIComponent(ruleKey)}`;
  const auth = token ? { authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` } : {};

  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json', ...auth } });
    if (!res.ok) {
      return { key: ruleKey, available: false, reason: `HTTP ${res.status}`, docs };
    }
    const rule = (await res.json())?.rule || {};
    const howToFix = toPlainText(section(rule, 'how_to_fix'));
    const rootCause = toPlainText(section(rule, 'root_cause'));
    const fallbackDesc = toPlainText(rule.htmlDesc);
    const text = howToFix || rootCause || fallbackDesc;
    return {
      key: ruleKey,
      name: rule.name || ruleKey,
      severity: rule.severity || null,
      type: rule.type || null,
      cleanCodeAttribute: rule.cleanCodeAttribute || null,
      rootCause,
      howToFix,
      // Anonymous access returns 200 with empty sections, so emptiness is the
      // real signal here, not the status code.
      available: Boolean(text),
      reason: text ? 'ok' : 'description empty — is the request authenticated?',
      docs
    };
  } catch (e) {
    return { key: ruleKey, available: false, reason: e.message, docs };
  }
}

/** One request per distinct rule, however many findings trip it. */
export async function fetchRules(ruleKeys, options = {}) {
  const unique = [...new Set(ruleKeys)];
  const rules = await Promise.all(unique.map((k) => fetchRule(k, options)));
  return new Map(rules.map((r) => [r.key, r]));
}

/**
 * What a ticket or a prompt says when the description was not available.
 * Deliberately still useful: the finding's own message and a public link beat
 * an empty section and a shrug.
 */
export function describeRule(rule, finding) {
  if (rule?.available) {
    return `${rule.name}\n\n${rule.howToFix || rule.rootCause}\n\nRule reference: ${rule.docs}`;
  }
  return `${finding?.message || rule?.key || 'Sonar finding'}\n\n`
    + `The rule's own guidance was not retrievable (${rule?.reason || 'no rule metadata'}). `
    + `See ${rule?.docs || ruleDocsUrl(finding?.rule)}.`;
}
