# sonar-remediation-automation

Automated discovery, planning, remediation, and verification of SonarQube findings via GitHub Actions — with Jira as the human workflow surface and Microsoft Teams as the feedback channel.

A reference implementation built on a synthetic sandbox ([`phix/sonar-sandbox-app`](https://github.com/phix/sonar-sandbox-app)), designed to be abstracted and adopted internally.

## Where to start

- **[Handoff](docs/HANDOFF.md)** — verified state, what is blocked, and the traps. Start here.
- **[Implementation plan](docs/IMPLEMENTATION_PLAN.md)** — what is being built, what is decided, what is next.
- **[The map](https://github.com/phix/sonar-remediation-automation/issues/1)** — live work tracking. Child issues are tickets; GitHub-native dependencies show what blocks what.
- **[Source design docs](docs/source/)** — the architecture spec, plan JSON schema, Jira state model, and workflow design this is built from.

## The loop

> Pull down code. Create a branch. Push it. Open a PR.
> **Do nothing else.** Wait for one message saying the PR is ready, or that it
> is red and exactly why.

```
PR opened or updated  (same-repo only — forks skipped with a non-green status)
    → scan       SonarQube Cloud analyses the PR branch
    → jira       OPTIONAL, default OFF — Jira ticket per group
    → remediate  container pulls the PR branch, fixes every eligible finding in
                 one pass. DETERMINISTIC CODEMOD FIRST, ALWAYS — an agentic call
                 happens only where no codemod exists for that rule.
                 Exactly one unit test per fix. Build. Test.
    → push       commit lands on the PR branch → re-scan fires (capped)
    → settle     green → OPTIONAL auto-merge, default OFF
                 red   → merge stays blocked
    → notify     OPTIONAL, default OFF — ONE Teams message at the terminal
                 state: "ready", or "red because <deterministic reason>"
    → reset      one click back to the pristine baseline
```

`jira`, `teams_notify` and `auto_merge` all default to `false`, so the
out-of-the-box pipeline is silent and does not merge. The experience above is
the switches-on configuration; the defaults are safe, not complete.

**An agentic call is permitted at exactly one point in the system** — fixing a
finding whose rule has no deterministic codemod. Everything else is code. On the
sandbox catalogue, with the eligibility policy actually enforced, that is
**18 findings fixed with zero LLM involvement, 10 reaching Claude, and 4 refused
by policy** — measured, not estimated. The catalogue's own `role` field says
19/11/2, because it records which engine *could* fix a finding rather than
whether policy *allows* it; two findings in `api/src/auth/` are both.

See [the flow decision](docs/decisions/pr-remediation-flow.md).

Status: **the scan half of the loop is live.** `sonar-pr-scan` is wired to PR #2 and
is a required check on `main`, so the merge is genuinely blocked rather than
merely reported — red on new-code coverage, with all three ratings at A
([why that is not a smell problem](docs/decisions/coverage-and-the-gate.md)).
`remediate` and the Jira step are built and unit-proven but have not yet run in
CI. Catalogue proven against a live Sonar scan: 32 findings, 16 groups.
