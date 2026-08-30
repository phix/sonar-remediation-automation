/**
 * The settle stage's terminal-state decision.
 *
 * "Wait for one message saying the PR is ready, or that it is red and exactly
 * why." Everything this function does serves that one sentence, and it must
 * be fully deterministic — spec §14's failure taxonomy is a closed set and the
 * "red because" reason is explicitly not something an LLM is ever allowed to
 * generate (docs/decisions/pr-remediation-flow.md, decision 7).
 *
 * ## No third state
 *
 * `ready` and `red` are the only two states. An input shape this function did
 * not anticipate must produce `red` with a reason saying the state could not
 * be determined — never a throw, and never a silent `ready`. A throw stops the
 * pipeline where nobody is watching it; a silent `ready` reports success for
 * work that never happened. Both are worse than a red nobody asked for.
 *
 * ## Three inputs, three independent ways to be red
 *
 * - `gate` — Sonar's `api/qualitygates/project_status` shape:
 *   `{ status: 'OK'|'ERROR'|..., conditions: [{ metricKey, status, actualValue,
 *   errorThreshold, comparator }] }`. This is the shape
 *   `docs/decisions/coverage-and-the-gate.md`'s table is drawn from. A failing
 *   condition is named by its operator-facing label, never by an unrelated
 *   axis — the sandbox's live case is coverage-bound while every rating is A,
 *   and a reason blaming "code smells" there would be actively wrong.
 * - `scan` — the analysis run itself, `{ status: 'SUCCESS'|'FAILED'|... }`
 *   (Sonar's background-task shape). A `gate` result is only trustworthy if
 *   the scan that produced it actually completed; a stale or absent gate
 *   behind a failed scan must not read as green.
 * - `dispositions` — `codemods/remediate.mjs`'s `dispositionSummary()` shape,
 *   `{ refused, needsAgent, results }`. Findings in `refused` are blocked by
 *   eligibility policy (decision 3) independently of what the Sonar gate says
 *   about ratings — refusals are never waived, so they are checked and named
 *   regardless of whether the gate itself is green.
 */

const CONDITION_LABELS = {
  new_coverage: 'new-code coverage',
  new_reliability_rating: 'new reliability rating',
  new_security_rating: 'new security rating',
  new_maintainability_rating: 'new maintainability rating (code smells)',
  new_duplicated_lines_density: 'new duplicated lines density',
  new_security_hotspots_reviewed: 'new security hotspots reviewed'
};

function labelFor(metricKey) {
  return CONDITION_LABELS[metricKey] || metricKey;
}

const UNDETERMINED = 'the terminal state could not be determined: ';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** @returns {string|null} a red reason, or null if the scan is trustworthy. */
function scanIssue(scan) {
  if (!isPlainObject(scan) || typeof scan.status !== 'string') {
    return `${UNDETERMINED}the scan result is missing or malformed.`;
  }
  if (scan.status !== 'SUCCESS') {
    return `the scan did not complete (status: ${scan.status}), so no quality gate result can be trusted.`;
  }
  return null;
}

/** @returns {string|null} a red reason, or null if nothing is refused. */
function dispositionsIssue(dispositions) {
  if (!isPlainObject(dispositions) || !Array.isArray(dispositions.refused)) {
    return `${UNDETERMINED}the remediation dispositions are missing or malformed.`;
  }
  if (!dispositions.refused.length) return null;
  const named = dispositions.refused
    .map((f) => `\`${f?.rule}\` at \`${f?.file}:${f?.line}\``)
    .join(', ');
  return `${dispositions.refused.length} finding(s) refused by eligibility policy — ${named}. `
    + 'Refusals are never waived, so the merge stays blocked.';
}

/** @returns {string|null} a red reason, or null if the gate passed cleanly. */
function gateIssue(gate) {
  if (!isPlainObject(gate) || !Array.isArray(gate.conditions) || typeof gate.status !== 'string') {
    return `${UNDETERMINED}the quality gate result is missing or malformed.`;
  }
  if (gate.status === 'OK') return null;
  if (gate.status !== 'ERROR') {
    return `${UNDETERMINED}the quality gate reported an unrecognised status ("${gate.status}").`;
  }

  const failing = gate.conditions.filter((c) => isPlainObject(c) && c.status === 'ERROR');
  if (!failing.length) {
    return `${UNDETERMINED}the quality gate reported ERROR but named no failing condition.`;
  }
  const parts = failing.map((c) => `${labelFor(c.metricKey)} is ${c.actualValue} against a threshold of ${c.errorThreshold}`);
  return `quality gate failed: ${parts.join('; ')}.`;
}

/**
 * @param {object} gate - Sonar quality-gate project status.
 * @param {object} scan - the analysis/scan run status.
 * @param {object} dispositions - `dispositionSummary()` from remediate.mjs.
 * @returns {{state: 'ready'|'red', reason: string}}
 */
export function classify(gate, scan, dispositions) {
  // Checked in this order so that a malformed/incomplete input is reported on
  // its own terms rather than folded into a generic "gate failed" — each
  // `${UNDETERMINED}` reason names exactly which input could not be read.
  const scanReason = scanIssue(scan);
  if (scanReason) return { state: 'red', reason: scanReason };

  const dispReason = dispositionsIssue(dispositions);
  if (dispReason && dispReason.startsWith(UNDETERMINED)) return { state: 'red', reason: dispReason };

  const gateReason = gateIssue(gate);
  if (gateReason && gateReason.startsWith(UNDETERMINED)) return { state: 'red', reason: gateReason };

  const reasons = [gateReason, dispReason].filter(Boolean);
  if (!reasons.length) return { state: 'ready', reason: 'the quality gate passed and nothing is outstanding.' };
  return { state: 'red', reason: reasons.join(' ') };
}
