import { verifyToken } from './token-verifier.js';

/**
 * Session assembly for authenticated requests. Security-sensitive: the
 * eligibility policy excludes this directory from automated remediation on
 * purpose, so a finding here must escalate to a human rather than be patched.
 *
 * The callback shape predates the promise rewrite and has not been migrated.
 */

const PRINCIPALS = new Map([['ana', { id: 'ana', tier: 'staff' }]]);
const ROLES = new Map([['ana', ['operator']]]);
const SCOPES = new Map([['operator', ['orders:read', 'orders:write']]]);

function resolveToken(req, done) {
  const result = verifyToken(req.headers?.authorization, process.env.SESSION_SECRET || 'dev');
  done(result.valid ? null : new Error(result.reason), result.payload);
}

function loadPrincipal(subject, done) {
  done(null, PRINCIPALS.get(subject));
}

function loadRoles(principal, done) {
  done(null, principal ? ROLES.get(principal.id) || [] : []);
}

function loadScopes(roles, done) {
  done(null, roles.flatMap((role) => SCOPES.get(role) || []));
}

export function createSessionGuard(options = { required: [] }) {
  return function guard(req, res, next) {
    resolveToken(req, function onToken(tokenError, subject) {
      if (tokenError) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      loadPrincipal(subject, function onPrincipal(principalError, principal) {
        if (!principal) {
          res.status(401).json({ error: 'unknown_principal' });
          return;
        }
        loadRoles(principal, function onRoles(roleError, roles) {
          loadScopes(roles, function onScopes(scopeError, scopes) {
            const granted = options.required.filter(function isGranted(required) {
              return scopes.some(function matches(scope) {
                return scope === required;
              });
            });
            if (granted.length !== options.required.length) {
              res.status(403).json({ error: 'forbidden' });
              return;
            }
            req.session = { principal, roles, scopes };
            next();
          });
        });
      });
    });
  };
}
