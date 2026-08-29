# Cross-repo auth and branch protection

**Context:** [Create the sonar-sandbox-app repo and cross-repo auth](https://github.com/phix/sonar-remediation-automation/issues/7) · decided 2026-08-29

Two repos: `phix/sonar-remediation-automation` holds the workflows, `phix/sonar-sandbox-app` is the scan target. This records how one reaches the other, and what branch protection actually enforces — measured, not assumed.

## Branch protection on the sandbox

Applied to `main`:

| Setting | Value | Why |
|---|---|---|
| PR required | yes | forces remediation through PRs, mirroring the office |
| Approvals required | **0** | Nick is the only human; requiring an approval he cannot give would deadlock the flow |
| `enforce_admins` | **false** | see below — this is the load-bearing choice |
| `allow_force_pushes` | **true** | the one-click reset force-pushes `main` back to `v0-pristine` |
| `allow_deletions` | false | nothing should be able to delete `main` |

### Protection does not bind the admin, and that is deliberate

**Measured, not assumed.** A direct push to `main` as repo admin succeeded, with GitHub printing:

```
remote: Bypassed rule violations for refs/heads/main:
remote: - Changes must be made through a pull request.
```

Warned, then allowed. With `enforce_admins: false`, protection is advisory for an admin.

That sounds like a hole. It is the correct configuration here, because of a genuine tension between two requirements:

- **Remediation must go through PRs** — the behaviour being mirrored.
- **The one-click reset must force `main` back to `v0-pristine`** — Nick's explicit requirement, which survives having merged fixes in an earlier run.

With `enforce_admins: true`, the second becomes impossible without the reset workflow lifting protection, resetting, and restoring it — three API calls with a window where `main` is unprotected, and a failure mode where a crash leaves it that way.

**What actually binds the automation is the token, not the setting.** The automation authenticates with a fine-grained PAT that is *not* an admin, so protection is fully enforced against it. The admin bypass exists only for Nick and for the reset — precisely the two actors who should have it.

**For the office version, invert this.** There, `enforce_admins: true` is right — many humans, real code, and the reset either does not exist or is a deliberate, audited operation. Flag it in the handoff: this repo's setting is a sandbox affordance, not a recommendation.

## Cross-repo auth

### The default token cannot do it

`GITHUB_TOKEN` in Actions is scoped to the repository running the workflow. A workflow in the automation repo cannot use it to push a branch or open a PR on the sandbox repo. Something else is required.

### Options

| | Fine-grained PAT | GitHub App |
|---|---|---|
| Setup | minutes | app registration, install, key handling |
| Scope | per-repo, per-permission | per-installation, per-permission |
| Identity in PRs | Nick | the app — clearer provenance |
| Expiry | fixed date, needs rotation | short-lived tokens minted per run |
| Rate limits | shared with Nick's user | its own budget |
| Org scale | breaks — tied to one person | correct answer |

### Decision: fine-grained PAT here, GitHub App noted for the office

A PAT limited to the two repos, with only the permissions the automation needs:

- **Contents: read & write** — create branches, push commits
- **Pull requests: read & write** — open PRs
- **Metadata: read** — mandatory for any fine-grained PAT

Nothing else. Not Actions, not Administration, not Secrets.

The PAT wins here on the thing that matters for a sandbox: it exists in five minutes and has no moving parts to debug while the *actual* subject under test is the remediation pipeline. Its weaknesses — tied to one person, expires, shares Nick's rate limit — are irrelevant at this scale and disqualifying at office scale.

**Say this plainly in the handoff.** An office deployment should use a GitHub App: PRs come from a bot identity rather than whoever created the PAT, tokens are minted per run rather than living for a year, and the credential survives that person leaving. A PAT that outlives its creator's employment is a real operational failure, not a hypothetical one.

### Not needed yet

Cross-repo auth is **not** on the critical path to the first scan. Scanning, and everything up to it, runs *inside* the sandbox repo using its own `GITHUB_TOKEN`. The credential is first required when `execute-remediation` starts creating branches and PRs on the sandbox from the automation repo.

Tracked separately so it does not block the sandbox chain.
