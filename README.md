# sonar-remediation-automation

Automated discovery, planning, remediation, and verification of SonarQube findings via GitHub Actions — with Jira as the human workflow surface and Microsoft Teams as the feedback channel.

A reference implementation built on a synthetic sandbox ([`phix/sonar-sandbox-app`](https://github.com/phix/sonar-sandbox-app)), designed to be abstracted and adopted internally.

## Where to start

- **[Implementation plan](docs/IMPLEMENTATION_PLAN.md)** — what is being built, what is decided, what is next.
- **[The map](https://github.com/phix/sonar-remediation-automation/issues/1)** — live work tracking. Child issues are tickets; GitHub-native dependencies show what blocks what.
- **[Source design docs](docs/source/)** — the architecture spec, plan JSON schema, Jira state model, and workflow design this is built from.

## The loop

```
SonarQube Cloud scan
    → recon    normalize findings, fingerprint them
    → plan     group them, create/dedupe Jira issues, emit plan JSON
    → execute  branch, codemod-or-Claude fix, build, test, re-scan
    → verify   PR opened, Jira transitioned, Teams notified
    → reset    one click back to the pristine baseline
```

Status: **charting complete, implementation starting.** No workflows exist yet.
