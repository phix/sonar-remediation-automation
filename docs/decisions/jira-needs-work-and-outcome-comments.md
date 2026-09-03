# The Jira ticket exists before the GitHub-side work does, and its label tracks Sonar, not the pipeline

**Status:** accepted, 2026-09-03

## The bug

Nick noticed a Jira story was missing for a work item that already had a
GitHub-side artifact (a PR/branch), and said the story should exist *before*
that, carry a `Ready`/`Needs Work` label reflecting whether a Sonar finding is
actually open, and get a comment when remediation fails, when it succeeds,
and when a PR is created.

The flow docs ([`README.md`](../../README.md),
[`pr-remediation-flow.md`](./pr-remediation-flow.md) §"the flow") always said
`jira` runs between scan and remediate. But `jira/run.mjs`'s own top comment
said the opposite: *"a separate entry point from `remediate.mjs`, run after it
and never before."* The code itself didn't actually require remediation
output — `dispositionsFrom(null)` was already a documented no-op — so nothing
would have broken running it first. The comment was simply wrong, and wrong
in the direction that makes "file the ticket first" look unsupported when it
already was.

## What changed

**Nothing about *when* `jira/run.mjs` can be called changed** — it already
tolerated running before remediation. What changed is:

1. The misleading comment, corrected to state the actual, always-true
   contract: file first, optionally update again later, never blocking.
2. A real `Needs Work` / `Ready` label pair (`jira/group.mjs`'s
   `NEEDS_WORK_LABEL` / `READY_LABEL`), driven by **live presence in the
   findings passed to a given run**, not by pipeline stage:
   - Every group `groupFindings()` produces is labelled `needs-work` at
     creation, because a group only exists when Sonar just reported it.
   - A second `runJira()` call — after remediation, a push, and a re-scan —
     walks the plan for tickets whose group is no longer in that scan's
     `findings` at all, and flips those to `ready` with a comment
     (`resolvedComment()` in `jira/body.mjs`).
   - If a `ready` group's finding comes back on a later scan (a regression),
     the existing-ticket path flips it back to `needs-work` with an explicit
     "Reopened" comment, rather than leaving a stale `ready` label next to a
     live finding.
3. An explicit remediation-outcome comment (`verdictComment()`), posted onto
   a still-open ticket when the caller passes `ctx.verdict` — settle's
   `classify()` output — wired through as `--verdict ready|red --reason TEXT`
   on the CLI. **Deliberately per-group and not per-PR-gate**: the PR's gate
   can stay red on an unrelated axis (new-code coverage, say per
   [coverage-and-the-gate.md](./coverage-and-the-gate.md)) while every finding
   a specific ticket names is actually gone — gating a group's label on the
   whole gate would say `needs-work` for a reason that has nothing to do with
   that ticket.

## What did not change

Optional and non-blocking, per decision 1 in `pr-remediation-flow.md`, still
holds exactly as before: `jira` stays a switch defaulting to `false`,
remediation never reads `runJira()`'s result, and a Jira outage does not stop
a fix from shipping. Reordering when the ticket *can* be filed does not touch
whether anything downstream depends on it — nothing does.

## What is still a manual wiring step

This module supports being called twice — early, and again after settle —
but nothing in this repo yet calls it twice in one pipeline run. That wiring
(passing `--verdict`/`--reason` from `settle/run.mjs`'s output into a second
`jira/run.mjs` invocation, and threading `findings` from the post-remediation
re-scan rather than the pre-remediation one) lives in whatever workflow
orchestrates these scripts — the sandbox repo's Actions, not this one — and is
unbuilt.
