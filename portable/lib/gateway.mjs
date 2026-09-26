/**
 * The model, last and bounded.
 *
 * Every line here exists to keep the unpredictable path small: only findings the
 * policy allowed and the codemods did not cover reach it, the payload's data
 * class must be approved, the call is bounded, and it is written to an
 * append-only egress log *before* it is made. That log — "here is everything that
 * left the boundary, and what it was for" — is the control an adopting
 * organisation asks for, and it is cheaper to build in than to retrofit.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

export class GatewayError extends Error {}

/**
 * Secrets are addressed by reference, never by value. `env:` is implemented
 * because it is universal; every other scheme (`vault:`, `keychain:`,
 * `secret:`) is a deliberate hole for the adopting environment to fill. An
 * unresolved reference fails loudly — it never falls back to anything.
 */
export function resolveSecret(ref, env = process.env) {
  if (typeof ref !== 'string' || ref === '') throw new GatewayError('no secret reference was configured');
  const index = ref.indexOf(':');
  const scheme = index === -1 ? ref : ref.slice(0, index);
  const name = index === -1 ? '' : ref.slice(index + 1);

  if (scheme === 'env') {
    const value = env[name];
    if (!value) throw new GatewayError(`secret reference \`${ref}\` did not resolve`);
    return value;
  }
  throw new GatewayError(
    `secret scheme \`${scheme}\` is not implemented here by design `
    + `(ref \`${ref}\`): wire this seam to the environment's own secret store.`
  );
}

/**
 * Open the egress log at boot, not at first use: an unwritable path has to stop
 * the run before anything is sent, not after.
 */
export function openEgressLog(path) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, '');
  return {
    write(record) {
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    }
  };
}

export function assertApprovedDataClass(gateway, dataClass) {
  const approved = gateway?.approvedDataClasses || [];
  if (!approved.includes(dataClass)) {
    throw new GatewayError(
      `data class \`${dataClass}\` is not approved for the model gateway `
      + `(approved: ${approved.join(', ') || 'none'})`
    );
  }
}

/**
 * One bounded request. No retries, no provider failover, no second attempt
 * inside this function: an attempt cap that lives in the caller is the only kind
 * that can be argued about, and "it failed over to a different vendor" is not a
 * sentence anyone wants to write in a data-flow review.
 */
export async function proposeFix({
  gateway, finding, source, prompt, egress, fetchImpl = globalThis.fetch
}) {
  assertApprovedDataClass(gateway, 'source-file');
  assertApprovedDataClass(gateway, 'finding-metadata');
  const token = resolveSecret(gateway.secretRef);

  const body = {
    model: gateway.model,
    max_tokens: gateway.maxOutputTokens,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user(source, finding) }
    ]
  };

  egress?.write({
    kind: 'model',
    endpoint: gateway.endpoint,
    model: gateway.model,
    findingKey: finding.key,
    rule: finding.rule,
    promptHash: createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16)
  });

  const res = await fetchImpl(gateway.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new GatewayError(`the model gateway answered HTTP ${res.status}`);
  const reply = await res.json();
  return { text: reply?.choices?.[0]?.message?.content ?? '', model: gateway.model };
}
