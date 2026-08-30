# The scan status cannot be asked which ref it belongs to

**Status:** accepted, 2026-08-30
**Affects:** `settle/gate.mjs`, `settle/classify.mjs`

## The problem

`settle/classify.mjs` refuses to trust a quality gate unless the analysis that
produced it actually completed. That check is only worth having if the scan
status it reads belongs to the pull request being settled.

It does not, reliably. Probed live against `phix_sonar-sandbox-app`, anonymously,
2026-08-30:

| Endpoint | `pullRequest` parameter | Behaviour |
|---|---|---|
| `api/qualitygates/project_status` | **required in practice** | Without it: `{"status":"NONE","conditions":[]}`. With `pullRequest=2`: the real PR gate. |
| `api/ce/component` | **does not exist** | Confirmed against `api/webservices/list` — its only parameters are `component` and `componentId`. A supplied `pullRequest` is silently ignored, including a PR number that does not exist. |
| `api/ce/activity` | carries per-task `pullRequest` | Requires authentication. Not usable as an anonymous fallback. |

So `api/ce/component` returns *the component's current task*, whatever ref that
task belongs to. On this sandbox that happens to be PR #2's analysis, because it
is the only analysis ever run. Nothing guarantees it in general: a more recent
scan of `main`, or of another pull request, silently takes its place.

## Both halves of the trap

The gate call and the scan call fail in opposite directions, which is why only
one of them looks dangerous at first.

**The gate call fails loudly enough.** Forget `pullRequest` and you get
`status: "NONE"` with no conditions. That is not an error — it is a different
question answered politely — but it is at least *recognisably* not a verdict.
`classify()` treats an unrecognised gate status as red-undetermined, so a
forgotten parameter fails safe. Verified end to end: the unscoped response
classifies as red with "the quality gate reported an unrecognised status".

**The scan call fails silently.** It returns a well-formed `SUCCESS` for an
analysis of something else. Nothing in the response says which ref it describes
unless you go looking for the task's own `pullRequest` field. A borrowed
`SUCCESS` would satisfy the exact precondition that exists to stop a stale gate
being trusted — the guard would be defeated by the thing it was guarding.

## The decision

`fetchScanStatus` reads the task's own `pullRequest` field and **cross-checks it
against the one that was asked for. On a mismatch it refuses to report
`SUCCESS`.**

This is deliberately conservative, and the cost is real: a scan reads as
unreadable — and the PR therefore settles red — simply because someone re-scanned
a different branch after this PR's analysis completed. On a busy repository with
several analyses in flight that will happen.

We accept that cost. A red that says "I could not confirm this scan is yours" is
recoverable in one rerun. A green borrowed from another branch's analysis is not
recoverable at all, because nothing downstream ever questions it again.

## Why this is written down

This is the fifth time in this project an API has answered a question it was not
asked, and the fourth where the wrong answer was well-formed and plausible:

- five rule choices that were real rules but inactive in the default profile, so
  a scan would never have reported them;
- `api/issues/search` returning no `actions` field because `additionalFields`
  had not requested one — read as "no permission" for a day;
- Jira's JQL index lagging its own writes, so a search-first dedupe creates the
  duplicate it exists to prevent;
- `api/rules/show` returning empty descriptions anonymously rather than 401;
- and now a scan status that cannot be scoped to a ref.

The pattern is consistent enough to be a working rule: **on this project, an API
that returns 200 has answered *a* question, and it is worth one probe to confirm
it was yours.** Every one of the five was found by asking the live service rather
than reading its documentation.

## An adopting team should re-probe this

`api/ce/component`'s parameter list is a SonarQube Cloud fact checked on one
date. A self-hosted SonarQube, or a later version, may expose a properly scoped
task endpoint — in which case the cross-check becomes redundant rather than
wrong, and `fetchScanStatus` is the single function to change.
