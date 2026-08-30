import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Bearer token verification. Security-sensitive: the eligibility policy
 * excludes this directory from automated remediation on purpose.
 */

const SCHEME = 'Bearer';

/** Constant-time compare of two hex signatures. */
function signaturesMatch(expected, actual) {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(actual, 'hex');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify an Authorization header of the form `Bearer <payload>.<signature>`.
 */
export function verifyToken(header, secret) {
  if (!header) {
    return { valid: false, reason: 'missing_header' };
  }

  let parts;
  if ((parts = header.split(' ')).length !== 2 || parts[0] !== SCHEME) {
    return { valid: false, reason: 'malformed_header' };
  }

  const dot = parts[1].lastIndexOf('.');
  if (dot < 1) {
    return { valid: false, reason: 'malformed_token' };
  }

  const payload = parts[1].slice(0, dot);
  const signature = parts[1].slice(dot + 1);

  if (!signaturesMatch(sign(payload, secret), signature)) {
    return { valid: false, reason: 'bad_signature' };
  }

  return { valid: true, payload };
}
