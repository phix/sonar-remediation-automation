/**
 * The optional merge half of the settle stage.
 *
 * ## Native auto-merge only — never a merge call
 *
 * This module enables GitHub's **native** auto-merge on the PR
 * (`enablePullRequestAutoMerge`); it never calls a merge mutation directly.
 * That is the property decision 9 of `docs/decisions/pr-remediation-flow.md`
 * depends on: branch protection stays the decision-maker, so if the required
 * check is red, nothing merges — and no function in this file is *capable* of
 * merging a red PR, because none of them can reach a merge mutation at all.
 * The guard against merging on red therefore lives in two independent places:
 * `runAutoMerge` refuses to even attempt the call when `classification.state`
 * is not `'ready'`, and — even if that check were bypassed by a caller error —
 * `enableAutoMerge` still could not merge anything, only flag intent that
 * GitHub's branch protection evaluates on its own.
 *
 * ## Tri-state, mirroring jira/run.mjs exactly
 *
 * Off (`enabled: false`, the default) is silent and green: nobody asked.
 * On-but-unconfigured is red: somebody asked and did not get it. Those are
 * opposite situations wearing similar clothes and must not collapse into one.
 *
 * ## The GitHub call is injected
 *
 * `call({ pullRequestId, mergeMethod })` is the only network seam, so tests
 * never touch a real repository. Its real-world failure modes are parsed by
 * message text because that is what GraphQL mutation errors are:
 *   - already enabled -> idempotent success, not an error;
 *   - "not allowed for this repository" -> a named, actionable failure;
 *   - PR not mergeable -> a different named, actionable failure.
 * Anything else is reported as `unknown` rather than silently swallowed.
 */

export function configFromEnv(env = process.env) {
  const cfg = {
    pullRequestId: env.PR_NODE_ID || '',
    mergeMethod: env.AUTO_MERGE_METHOD || 'SQUASH'
  };
  const missing = ['PR_NODE_ID'].filter((k) => !env[k]);
  return { ...cfg, configured: missing.length === 0, missing };
}

export class AutoMergeUnavailable extends Error {
  constructor(message, { reason, cause = null } = {}) {
    super(message);
    this.name = 'AutoMergeUnavailable';
    this.reason = reason; // 'not_allowed' | 'not_mergeable' | 'unknown'
    this.cause = cause;
  }
}

const ALREADY_ENABLED = /auto.?merge.*(already enabled|is already)/i;
const NOT_ALLOWED = /auto.?merge.*(not allowed|is not allowed|disabled for this repository)/i;
const NOT_MERGEABLE = /(not in the correct state|not mergeable|behind the target branch|has conflicts)/i;

function classifyGithubError(err) {
  const message = err?.message || String(err);
  if (ALREADY_ENABLED.test(message)) return 'already_enabled';
  if (NOT_ALLOWED.test(message)) return 'not_allowed';
  if (NOT_MERGEABLE.test(message)) return 'not_mergeable';
  return 'unknown';
}

/**
 * The one network call. Never resolves to anything that merges a PR — it only
 * flags GitHub's native auto-merge intent; GitHub's own branch protection
 * decides whether/when that intent turns into a merge.
 *
 * @param {{id: string, number?: number}} pr
 * @param {{call: Function, mergeMethod?: string}} deps
 */
export async function enableAutoMerge(pr, { call, mergeMethod = 'SQUASH' } = {}) {
  try {
    await call({ pullRequestId: pr.id, mergeMethod });
    return { enabled: true, alreadyEnabled: false };
  } catch (err) {
    const reason = classifyGithubError(err);
    if (reason === 'already_enabled') return { enabled: true, alreadyEnabled: true };
    if (reason === 'not_allowed') {
      throw new AutoMergeUnavailable(
        'Auto-merge could not be enabled: it is not allowed on this repository. '
        + 'Enable "Allow auto-merge" in the repository\'s settings.',
        { reason: 'not_allowed', cause: err }
      );
    }
    if (reason === 'not_mergeable') {
      throw new AutoMergeUnavailable(
        'Auto-merge could not be enabled: the pull request is not currently mergeable.',
        { reason: 'not_mergeable', cause: err }
      );
    }
    throw new AutoMergeUnavailable(
      `Auto-merge could not be enabled: ${err.message}`,
      { reason: 'unknown', cause: err }
    );
  }
}

/**
 * The settle-stage entry point. Acts on `classify()`'s verdict; never
 * overrides it.
 *
 * @param {{state: 'ready'|'red', reason: string}} classification
 * @param {{id: string, number?: number}|null} pr
 * @param {{enabled?: boolean, config?: object, call: Function, mergeMethod?:
 *   string, log?: Function}} deps
 */
export async function runAutoMerge(classification, pr, {
  enabled = false, config = configFromEnv(), call, mergeMethod, log = () => {}
} = {}) {
  // The non-negotiable guard: no path below this line can run when the
  // classification is not ready, regardless of what `enabled` says.
  //
  // The reason names the CLASSIFICATION, not the gate: a run can classify red
  // with the gate OK — sandbox PR #3's settle verdict rendered
  // "Quality gate | OK" beside "the quality gate is red" because this line
  // blamed the wrong input for an undetermined (missing-dispositions) red.
  if (!classification || classification.state !== 'ready') {
    return {
      ran: false, disabled: false,
      reason: 'the run classified red, and auto-merge only ever fires on a ready classification.'
    };
  }
  if (!enabled) {
    return {
      ran: false, disabled: true,
      reason: 'auto-merge is off (auto_merge: false), which is the default.'
    };
  }
  if (!config.configured) {
    return {
      ran: false, disabled: false,
      reason: `auto-merge was requested but is not configured: ${config.missing.join(', ')} unset.`
    };
  }
  if (!pr || !pr.id) {
    return {
      ran: false, disabled: false,
      reason: 'auto-merge was requested but the pull request identity (node id) is missing.'
    };
  }

  try {
    const result = await enableAutoMerge(pr, { call, mergeMethod: mergeMethod || config.mergeMethod });
    log(result.alreadyEnabled
      ? `auto-merge was already enabled on PR ${pr.number ?? pr.id}`
      : `auto-merge enabled on PR ${pr.number ?? pr.id}`);
    return { ran: true, ...result };
  } catch (err) {
    if (err instanceof AutoMergeUnavailable) {
      return { ran: true, enabled: false, failed: true, reason: err.message, classification: err.reason };
    }
    throw err;
  }
}
