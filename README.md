# sonar-remediation-automation

Automated discovery, planning, remediation, and verification of SonarQube findings via GitHub Actions — with Jira as the human workflow surface and Microsoft Teams as the feedback channel.

A reference implementation built on a synthetic sandbox ([`phix/sonar-sandbox-app`](https://github.com/phix/sonar-sandbox-app)), designed to be abstracted and adopted internally.

## Where to start

- **[Implementation plan](docs/IMPLEMENTATION_PLAN.md)** — what is being built, what is decided, what is next.
- **[The map](https://github.com/phix/sonar-remediation-automation/issues/1)** — live work tracking. Child issues are tickets; GitHub-native dependencies show what blocks what.
- **[Source design docs](docs/source/)** — the architecture spec, plan JSON schema, Jira state model, and workflow design this is built from.

## The loop

```
PR opened or updated
    → scan       SonarQube Cloud analyses the PR branch
    → itrack     OPTIONAL — Jira ticket per group, rule suggestion attached,
                 Jira key written back onto the Sonar finding
    → remediate  container pulls the PR branch, fixes every eligible finding
                 in one pass, exactly one unit test per fix, builds, tests
    → push       commit lands on the PR branch → re-scan fires automatically
    → gate       all green → merge allowed
                 anything refused → escalate, merge stays blocked
    → reset      one click back to the pristine baseline
```

The loop closes on itself: the push is what re-triggers the scan. Jira is a
projection, not a dependency — `itrack` defaults to off and remediation never
waits for it. See [the flow decision](docs/decisions/pr-remediation-flow.md).

Status: **sandbox built and scanned-ready; the PR flow is being charted.**
