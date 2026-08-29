# The PR remediation flow

**Context:** Nick restated the flow 2026-08-29, after the sandbox and catalogue were built. This supersedes the campaign-style loop in the [architecture spec](../source/sonar_remediation_architecture_spec.md) §6 where the two disagree. **Superseding is deliberate and narrow** — the spec's data model, fingerprinting, eligibility policy, failure taxonomy and verification evidence rules all still hold. What changes is the *trigger*, the *unit of work*, and *where the fix lands*.

## The flow

```
PR opened / updated
   → scan        SonarQube Cloud analyses the PR branch
   → triage      any code smells?  ── no ──→ quality gate green, merge allowed
                        │ yes
   → itrack      OPTIONAL. Create a Jira ticket per finding group:
                   · labelled with the Sonar project key
                   · carrying the rule's fix suggestion
                   · Jira key written back onto the Sonar finding
                 Default is OFF — remediation does not wait for it.
   → remediate   container pulls the PR branch, fixes every eligible finding
                 in one pass, writes exactly one unit test per fix, builds, tests
   → push        commit back onto the PR branch → PR updates → re-scan
   → gate        all scans green → merge allowed
                 anything refused → escalate, merge stays blocked
```

The loop closes on itself: the push in step 6 is what triggers step 1 again.

## Decisions

### 1. Jira is optional, and off by default

Nick: *"I want the github action for creating the jira ticket to track the issue optional. i would like it to automatically try a self remediation without needing to go through the itrack step."*

`itrack` becomes a workflow input, default `false`. When off, nothing about remediation changes — it reads findings straight from the Sonar API.

This is only affordable because spec §4.1 already made the **plan JSON the system of record and Jira merely the human workflow surface**. Turning off a projection costs nothing. Had Jira been the state store, this switch would have been a rewrite.

### 2. One unit test per Sonar fix, exactly

Nick, clarifying: *"1 test for each sonar fix."* One-to-one — not zero for the easy ones, and not a suite for the hard ones. A fix without a test does not ship; a fix with six tests is scope the pipeline did not ask for.

Including deletions. A removed unused variable gets a characterization test of the surrounding behaviour, not a test asserting the variable is gone.

The arithmetic is worth seeing before it is built. The sandbox's catalogue has 29 findings, 2 of them refused by policy, so a full run produces **27 fixes and therefore 27 new tests** on top of the existing 20. The suite roughly triples in one push. That is the intended cost — but it means test *quality* is now the pipeline's main output risk, not fix quality, and the review burden lands on whoever reads that PR.

**This has a consequence worth stating plainly: it makes the codemod path no longer purely mechanical.** A deterministic fixer that deletes an unused import cannot also invent a meaningful test for the module it edited. So either the codemod emits a templated characterization test, or test authorship routes through Claude even when the fix itself was mechanical. The design takes the first path and falls back to the second — but the "cheap deterministic path" is now cheap-*er*, not free, and the fix engine's two branches are no longer cleanly separated.

Accepted deliberately: a fix with no test is a fix nobody can prove didn't break something, and the whole point of the gate chain is that nothing is trusted because it ran.

### 3. Findings that cannot be fixed block the merge

Eligibility policy (spec §10) survives intact. When a finding sits in an excluded path — `api/src/auth/` in the sandbox — the pipeline refuses it, comments on the PR saying what it will not touch and why, and the merge stays blocked until a human deals with it.

The alternative, letting the bot waive its own gate, was rejected: a gate that the thing being gated can self-waive is decoration.

This is what the two `non_automatable` catalogue entries exist to prove, and it is the sharpest test in the whole system — `javascript:S1121` in `token-verifier.js` is trivially fixable and gets refused **purely because of where it lives**.

### 4. One remediation run fixes everything eligible

Not one finding per run. Each push triggers a fresh scan, so one-at-a-time would put the sandbox's 29 findings through 14+ scan cycles.

The cost is attribution: when a batched build fails, which of the eleven fixes broke it? Mitigated by committing one commit per rule group inside the single run, so `git bisect` and blame still answer the question, while the PR only sees one push.

### 5. Jira tickets are labelled with the Sonar project key

`phix_sonar-sandbox-app`. Stable across re-scans, groups every ticket from one codebase, and therefore usable for dedupe — which an analysis ID, unique per run, would not be.

### 6. Fork pull requests are out of scope

Nick: *"then don't make fork PRs."* Same-repo branches only.

This is not a limitation being tolerated, it is a boundary being drawn, and it settles a security question at the same time.

**Forks cannot work on the `pull_request` trigger.** GitHub does not pass repository secrets to a workflow run triggered by a PR from a fork, and `GITHUB_TOKEN` is read-only there. So a fork PR cannot even be *scanned* — `SONAR_TOKEN` is absent — let alone pushed to. The failure is not at step 6; it is at step 1.

**The obvious workaround is `pull_request_target`, and it is refused.** That trigger runs in the base repository's context *with* secrets and a write token, against code the contributor controls. Reaching for it to "support forks" hands an untrusted PR author the credentials for the repository it is scanning, which is a well-known escalation path and precisely the wrong trade for a convenience. Not supporting forks is therefore the safe answer as well as the simple one.

**What the workflows must do instead of failing oddly.** A fork PR must be detected and skipped *explicitly*, with a comment saying the pipeline does not run on forks and why. A workflow that silently does nothing on a fork is indistinguishable from a workflow that ran and found nothing — the exact failure mode this system is built against.

```
head.repo.full_name != base.repo.full_name  →  skip, comment, neutral status
```

The status must be **neutral or failing, never green**. A fork PR that reports a passing Sonar gate because the scan never ran is worse than no gate.

## What this changes against the charted design

| | Charted | Now |
|---|---|---|
| Trigger | `workflow_dispatch`, scan `main` | `pull_request` opened/synchronize |
| Unit of work | a remediation campaign over a backlog | one PR |
| Fix lands on | a new `sonarfix/<plan>/<group>` branch | **the PR author's own branch** |
| PR creation | the automation opens one | **none — the PR already exists** |
| Jira | always, before execution | optional, default off |
| Concurrency | one plan item at a time (spec §3) | all eligible findings in one run |
| Merge | out of scope | **the point** — Sonar gate as a required check |

### The consequence that needs action

**The sandbox is currently built the wrong way round for this flow.**

SonarQube Cloud analyses a PR against *new code*. The 29 planted findings are on `main` at `v0-pristine`, so a PR that does not touch those lines reports **nothing**, the gate goes green, and the pipeline demonstrates precisely nothing.

For the flow to be demonstrable, `main` must be **clean** and the smells must arrive **as a PR**:

| | now | needs to be |
|---|---|---|
| `main` | 29 planted findings | clean |
| the smells | on `main` | on a branch that opens a PR into `main` |
| `v0-pristine` | the defective `main` | the tip of the defective PR branch |
| reset | force-push `main` back to the tag | restore clean `main` **and** recreate the defective PR |

This inverts work completed earlier today under [#9](https://github.com/phix/sonar-remediation-automation/issues/9). Nothing is lost — the catalogue, the oracle and the injected code are all reusable verbatim; they simply live on a branch instead of on `main`. The restructure is non-destructive: branch the current `main`, then revert the smells on `main` with a new commit rather than rewriting history.

## Open risks

**Self-triggering.** The bot's own push fires `synchronize`, which re-runs remediation. Guarded three ways: skip when the head commit is the bot's *and* no eligible finding remains; a per-PR attempt counter capped per spec §15; and hard failure rather than silent stop when the cap is hit.

**The rule suggestion needs authentication.** Verified 2026-08-29: `api/rules/show` returns rule metadata anonymously — name, severity, effort, clean-code attribute — but `descriptionSections` and `htmlDesc` come back **empty** without a token. So *"add the sonar suggestion to the jira ticket"* cannot be built or tested until `SONAR_TOKEN_READ` exists. Whether the full text is available even with a token is unconfirmed; the `requiredEntitlements` field on the rule payload suggests it may be plan-gated. If it is, the fallback is the finding's own `message` plus a link to the public rule documentation.

**The merge gate depends on branch protection that currently does not bind.** [`cross-repo-auth.md`](cross-repo-auth.md) sets `enforce_admins: false` deliberately, so Nick bypasses every rule including this one. Fine for a demo he drives himself; it means the sandbox cannot *prove* the gate blocks a merge without temporarily enforcing it. Worth one deliberate test.

## For the office handoff

Two properties of this flow travel better than the campaign model did:

- It needs **no backlog triage**. Findings are bounded by the PR diff, so adoption is per-team and incremental rather than a sweep of an existing codebase.
- The merge gate is the natural enforcement point teams already understand, so nothing new has to be socialised.

The thing that travels worst is step 6, and the office needs to hear the constraint early rather than discover it: **this flow only works on same-repo pull requests.** That is fine, and usually invisible, for internal teams working on branches of the repository itself. It breaks completely for any repository that takes contributions from forks — open source, cross-org, or contractors without write access.

Do not let anyone "solve" that with `pull_request_target`. The reasoning is in decision 6, and it is the single most likely place for a well-meaning adopter to introduce a credential-disclosure bug while believing they are extending coverage. If a repository genuinely needs fork support, the answer is a separate, deliberately designed flow with no secrets in the untrusted context — not a trigger swap.
