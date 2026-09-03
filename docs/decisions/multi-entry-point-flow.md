# Multiple entry points, one PR per group, and a durable state branch

**Status:** accepted, 2026-09-03. Reached by grilling (`/grilling` transcript
this session), not a Nick one-liner like most decisions here — recorded in
more procedural detail than usual because of that.

## The problem

`pr-remediation-flow.md` describes one entry point: a PR already exists (a
human opened it), and everything downstream reacts to that PR. That is fine
for the demo, where the PR IS the fixture. It does not cover:

1. A project adopting this pipeline with an existing backlog of findings —
   nothing ticketed, no PR, no branch, for any of them.
2. A single new finding surfacing on `main` with no PR involved at all.
3. A human seeing something on the Sonar dashboard and filing a Jira ticket
   for it before any GitHub-side artifact exists — which surfaced a real bug
   along the way: `jira/run.mjs`'s own top comment said it ran "after
   `remediate.mjs` and never before," and `remediate.yml` filed tickets only
   after code had already changed. The story was supposed to precede the
   work; it was running after even the GitHub-side work, not just after the
   code.

## The decisions, in the order they were made

**One PR per finding-group, not one big batch**, for anything the pipeline
itself creates (backlog onboarding, a single tracked finding). The existing
"batch everything into one PR" shape (`pr-remediation-flow.md` decision 4)
stays exactly as-is for the "PR already exists" entry point, because that PR
predates the pipeline and cannot be retroactively split — a human-opened PR
with 16 groups in it is still remediated as one batch. The two models coexist
because they answer different questions: who created the PR.

**Bulk onboarding is throttled, not run in one pass.** `jira/queue.mjs`
selects up to `max_concurrent` groups whose ticket/branch/PR are still
missing; a group counts as "in flight" once it has a PR and is not yet
`Verified`. Re-running the onboarding workflow picks up wherever the cap left
off last time — there is no separate resume step for the bulk case, running
it again IS the resume.

**Workflows stay separate per entry point; the STEPS overlap, not the
workflows.** Each entry point (`onboard-backlog`, `track-finding`,
`remediate-pr`, the always-on `scan, gate & settle`) is its own named,
purpose-described workflow — so a human matches their situation to a button
without reading YAML. What they share is factored into reusable workflows
(`_file-ticket.yml`, `_branch-pr.yml`, `_settle-notify.yml`) and composite
actions (`state-checkout`, `state-commit`, `upsert-pr-comment`), called by
`uses:`, not copy-pasted.

**A durable state branch, not a job-local file.** `plan.json` was always
called "the system of record" here, but nothing ever actually persisted it
between runs — `remediate.yml` passed `--plan plan.json` as a bare local
file, so every run started from an empty plan and the plan-first dedupe path
described in `jira-dedupe-order.md` never actually fired in production. That
was tolerable when the only entry point was "remediate a known PR." It is not
once bulk onboarding needs to know, across separately-triggered runs, how
many groups are in flight, and the auto-continue watcher needs to know,
possibly days later, whether a given PR was flagged for it. Both now read
`plan.json` off an orphan branch, `automation-state`, checked out and
committed by a pair of composite actions. Every job that touches it declares
`concurrency: { group: automation-state, cancel-in-progress: false }` —
GitHub's native queuing turns "several group-PRs finish around the same time"
from a lost-update race into a plain FIFO of small commits, rather than a
custom retry loop or lock service.

**"Optional auto-continue" is a plan field, not a label or a PR-body
convention.** `recordPR()` stores `auto_continue` on the group's plan item
when its branch/PR is created. A new `workflow_run` watcher
(`auto-continue-watch.yml`) fires whenever `02 - scan, gate & settle`
completes for any PR, looks up that PR's plan item, and dispatches
`remediate.yml` only if `auto_continue` is true. It fires on every scan
completion including PRs this pipeline never touched — safe by construction,
since a PR with no plan item has nothing to find and nothing gets dispatched.

**Ticketing stays optional and non-blocking — this did not change.**
`remediate.yml`'s Jira step moved (it now runs first, in its own job, before
codemods run — see `jira-needs-work-and-outcome-comments.md` for the
`jira/run.mjs` side of this), but it is still gated on `inputs.jira`
(default false), and the `remediate` job still runs whether `ticket` runs,
skips, or fails (`if: always() && !cancelled() && needs.resolve-pr.result ==
'success'`). The new outcome-recording pass in `_settle-notify.yml` is
gated the same way, per-group: it only touches groups the plan already has a
`jira_issue_key` for (via `jira/filter-findings.mjs`), so a PR that never
opted into ticketing gets no ticket filed on it just because a later scan
happened to run.

## Resuming from any step

`jira/resume.mjs` answers "what does this group still need" — `ticket`,
`branch`, `pr`, or `remediate` — from a fingerprint, a Jira key, or a PR
number, whichever a caller happens to be holding. `track-finding.yml` calls
it first and only runs the modules for whatever is still missing. This is
what makes "start at any step, auto-continue the rest" actually true for
every step, not just the ones a workflow author remembered to wire a
follow-on for.

## What is accepted, not solved

**A human filing a Jira ticket by hand has no way to generate the right
fingerprint without running this repo's tooling first.** `jira/run.mjs`'s
dedupe adopts a manually-created ticket exactly like one this pipeline made,
*if* it carries the group's `gf-<hash>` label — but that hash is a content
hash of module+rule+severity, not something a person can guess. The
practical path today is `npm run jira:groups` against a fetched
`findings.json` to read off the fingerprint before typing anything into
Jira. A friendlier version of this (a lookup workflow, or the fingerprint
surfaced directly on the Sonar dashboard some other way) is future work, not
built here.

**A PR closed without merging stays "in flight" until someone notices.**
`jira/queue.mjs`'s capacity accounting is plan-only, deliberately, to avoid a
GitHub API round-trip per group just to answer a throttle question. A merged
PR's group falls out of "in flight" on its own (the resolved-pass marks it
`Verified` once Sonar stops reporting it); a PR closed *without* merging does
not trigger that, and nothing here reconciles it. Same shape of accepted
residual as `jira-dedupe-order.md`'s note on overlapping first-ever runs.

**None of the new YAML has run in CI.** It was written against the real,
current `remediate.yml`/`sonar-pr-scan.yml` (fetched from `origin/main`, not
a stale local branch), checked with `actionlint` (clean except pre-existing
`SC2086`/`SC2015` info-level notes already present in the unmodified files),
and reasoned through for GitHub Actions mechanics (reusable-workflow
permission capping, matrix + `uses:`, `workflow_run` semantics) — but none of
that is a substitute for a real dispatch against a real Sonar project and a
real Jira site. Smoke-test `onboard-backlog` against a small `max_concurrent`
before trusting it against a real backlog.
