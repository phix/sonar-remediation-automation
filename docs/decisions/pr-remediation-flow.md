# The PR remediation flow

**Context:** Nick restated the flow 2026-08-29, after the sandbox and catalogue were built. This supersedes the campaign-style loop in the [architecture spec](../source/sonar_remediation_architecture_spec.md) §6 where the two disagree. **Superseding is deliberate and narrow** — the spec's data model, fingerprinting, eligibility policy, failure taxonomy and verification evidence rules all still hold. What changes is the *trigger*, the *unit of work*, and *where the fix lands*.

## The operator's experience

This is the whole product, stated from the only seat that matters:

> Pull down code. Create a branch. Push it. Open a PR.
> **Do nothing else.** Wait for one message saying the PR is ready, or that it
> is red and exactly why.

Everything below exists to make those four sentences true. Any design choice that adds a step for the person who opened the PR is wrong, regardless of how much it helps the pipeline.

## The flow

```
PR opened / updated  (same-repo branches only — forks are skipped, see §6)
   → scan        SonarQube Cloud analyses the PR branch
   → triage      any code smells?  ── no ──→ green
                        │ yes
   → jira        OPTIONAL, default OFF. Jira ticket per finding group:
                 labelled with the Sonar project key, carrying the rule's fix
                 suggestion, Jira key written back onto the Sonar finding.
                 Remediation never waits for it.
   → remediate   container pulls the PR branch and fixes every eligible finding
                 in one pass — DETERMINISTIC CODEMOD FIRST, always. An agentic
                 call happens only where no codemod exists for that rule.
                 Exactly one unit test per fix. Build. Test.
   → push        commit back onto the PR branch → PR updates → re-scan
                 (loop, capped — see "Guards")
   → settle      green  → OPTIONAL auto-merge, default OFF
                 red    → merge stays blocked
   → notify      OPTIONAL, default OFF. ONE Teams message at the terminal state:
                 "ready", or "red because <deterministic reason>".
```

The loop closes on itself: the push is what re-triggers the scan.

### The three switches, all default `false`

| Input | Default | What it adds |
|---|---|---|
| `jira` | `false` | Jira tickets |
| `teams_notify` | `false` | the terminal Teams message |
| `auto_merge` | `false` | merge the PR when the gate goes green |

**Off by default means the out-of-the-box pipeline is silent and does not merge.** It scans, fixes, pushes and stops. That is the right default — nothing surprising happens to a repository that has just adopted this — but it is worth saying plainly that *the experience described above is the switches-on configuration*. Hands-off-until-a-Teams-message requires `teams_notify: true`, and "ready to merge" becoming "merged" requires `auto_merge: true`. The defaults are safe, not complete.

## Decisions

### 1. Jira is optional, and off by default

Nick: *"I want the github action for creating the jira ticket to track the issue optional. i would like it to automatically try a self remediation without needing to go through the Jira step."*

`jira` becomes a workflow input, default `false`. When off, nothing about remediation changes — it reads findings straight from the Sonar API.

This is only affordable because spec §4.1 already made the **plan JSON the system of record and Jira merely the human workflow surface**. Turning off a projection costs nothing. Had Jira been the state store, this switch would have been a rewrite.

### 2. One unit test per Sonar fix, exactly

Nick, clarifying: *"1 test for each sonar fix."* One-to-one — not zero for the easy ones, and not a suite for the hard ones. A fix without a test does not ship; a fix with six tests is scope the pipeline did not ask for.

Including deletions. A removed unused variable gets a characterization test of the surrounding behaviour, not a test asserting the variable is gone.

The arithmetic is worth seeing before it is built. The sandbox's catalogue has 32 findings, 2 of them refused by policy, so a full run produces **30 fixes and therefore 30 new tests** on top of the existing 20. The suite more than doubles in one push. That is the intended cost — but it means test *quality* is now the pipeline's main output risk, not fix quality, and the review burden lands on whoever reads that PR.

**This collides with decision 7 (deterministic first), and decision 7 wins.** A codemod that deletes an unused import cannot *invent* a meaningful test for the module it edited — so the obvious move is to let Claude write the test even when the fix was mechanical. That is now forbidden: writing a test is not "analyzing how to fix a finding no codemod could handle."

So **every codemod ships a test template alongside its transform.** `remove-unused-variable` emits a characterization test that imports the module and asserts its public behaviour is unchanged; it does not assert the variable is gone. The fixer and its template are written together and versioned together, and a codemod without a template is not finished.

Be honest about what that buys. A templated characterization test for "removed an unused variable in `store.js`" asserts the module still works. That is not nothing — it would catch a codemod that deleted the wrong line — but it is a regression guard, not a specification. **The valuable tests come from the agentic path**, where Claude is restructuring behaviour and can say what the behaviour is. The 17 templated tests are cheap insurance; the 10 written ones are the ones worth reading.

Accepted deliberately: a fix with no test is a fix nobody can prove didn't break something, and the whole point of the gate chain is that nothing is trusted because it ran.

### 3. Findings that cannot be fixed block the merge

Eligibility policy (spec §10) survives intact. When a finding sits in an excluded path — `api/src/auth/` in the sandbox — the pipeline refuses it, comments on the PR saying what it will not touch and why, and the merge stays blocked until a human deals with it.

The alternative, letting the bot waive its own gate, was rejected: a gate that the thing being gated can self-waive is decoration.

This is what the two `non_automatable` catalogue entries exist to prove, and it is the sharpest test in the whole system — `javascript:S1121` in `token-verifier.js` is trivially fixable and gets refused **purely because of where it lives**.

### 4. One remediation run fixes everything eligible

Not one finding per run. Each push triggers a fresh scan, so one-at-a-time would put the sandbox's 32 findings through 16+ scan cycles.

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

### 7. Deterministic first — an agentic call is a last resort, not a default

Nick: *"there should be no agentic calls except for when absolutely necessary to analyze how to fix the sonar findings because you couldn't find a deterministic resolution."*

This promotes what was a cost optimisation into an architectural constraint. Previously "codemod first, Claude as fallback" meant *prefer* the cheap path. Now it means: **an LLM call is permitted at exactly one point in the entire system** — generating a fix for a finding whose rule has no codemod. Everywhere else, deterministic code.

Concretely, none of these may be an agentic call:

| Step | Must be deterministic because |
|---|---|
| Grouping and fingerprinting | It is a pure function of the finding set. Spec §8 defines it exactly. |
| Eligibility / refusal | A policy decision that must be auditable and identical every run. |
| Test generation for codemod fixes | See decision 2 — templates, not prose. |
| The "red because XYZ" reason | Spec §14's failure taxonomy is a closed set of classifications. |
| Jira body, labels, dedupe | String assembly from known fields. |
| Auto-merge decision | The quality gate already decided; this just acts on it. |

On the sandbox catalogue this means **18 of 32 findings are fixed with zero LLM involvement**, and 10 reach Claude — the `S3776`, `S4144` and `S3358` groups, where a mechanical rewrite genuinely does not exist. The 4 findings refused by policy never reach either engine.

**Measured 2026-08-30, and it corrected the estimate.** The catalogue's `role` field says 19/11/2; enforcing the eligibility policy gives 18/10/4. The two findings that move are `javascript:S7765` and `javascript:S7737`, both in `api/src/auth/session.js` — the directory this document's own `S1121` example names as the protected path. `role` answers *which engine could fix this*; only the policy answers *are we allowed to*, and a finding can be codemod-fixable and refused. Where the two disagree, **the policy wins**, because the alternative is a pipeline that edits security-sensitive code whenever a fixer happens to exist for the rule.

The measurable consequence: **the codemod library is now the core deliverable of this project**, not a cost saving on the side. A rule with no codemod is a rule that costs money and latency on every PR that trips it. That reframing is why it gets [its own ticket](https://github.com/phix/sonar-remediation-automation/issues/18).

### 8. One Teams message, at the terminal state only

Nick: *"everything should be hands off until i get a teams message that the pr is ready, that the pr is red because xyz."*

**This supersedes §7.5 of the implementation plan**, which had Teams notified at *every* gate. A remediation loop that may run several scan cycles would produce a stream of messages, and "hands off" means not being pinged through the middle of it. One message, when the PR reaches a terminal state:

- **ready** — gate green, nothing refused
- **red because `<reason>`** — with the reason drawn from spec §14's failure taxonomy plus the specific findings, e.g. *"2 findings in `api/src/auth/` refused by eligibility policy (excluded path)"*

The reason is assembled deterministically from the plan state. It is a report, not a summary — nothing writes prose about what went wrong.

`teams_notify`, default `false`.

### 9. Auto-merge when green, default off

`auto_merge: true` enables GitHub's native auto-merge on the PR, so it merges the moment the required checks pass. Native rather than a bot-issued merge, because it keeps branch protection as the decision-maker: if the gate is red, nothing merges, and no code path exists that could merge it anyway.

Default `false` — a pipeline that silently merges code on first adoption is exactly the surprise that gets a tool banned. Turning it on is a deliberate act by someone who has watched it run.

Note the interaction with decision 3: findings the policy refuses keep the gate red, so **auto-merge and the refusal path cannot conflict**. There is no state where the bot merges something it refused to fix.

### 10. The agentic path calls a configurable endpoint, not a vendor

Nick: *"if you come across a sonar fix you cannot determine the fix through a coding tool you may need to include a library with have the github action use my openllm to make agentic decisions."*

The one permitted agentic call goes to **Nick's own OpenLLM deployment**, reached through a single seam so the provider is configuration rather than code.

| Variable | Purpose |
|---|---|
| `LLM_BASE_URL` | endpoint root, e.g. `https://…/v1` |
| `LLM_API_KEY` | bearer credential |
| `LLM_MODEL` | model identifier |

**Assumed OpenAI-compatible** — `POST {base}/chat/completions` with a bearer token. OpenLLM serves an OpenAI-compatible API, and so does essentially every self-hosted server worth using, so this is the safe default. If Nick's deployment is not, only the client function changes, which is the entire point of putting it behind a seam. Stated as an assumption rather than a fact because it has not been reached yet.

This also replaces the `ANTHROPIC_API_KEY` entry that `config/secrets.md` carried from the original spec. Nothing in this system is bound to a particular model vendor, which matters more for the handoff than it does here — the office will have its own approved endpoint and its own opinions about which models may see source code.

#### The model is never trusted, only used

Every output is validated deterministically before it can reach the branch:

1. the patch **applies**, or it is rejected;
2. the build **passes**, or it is rejected;
3. the full suite **passes**, or it is rejected;
4. the re-scan shows the finding **gone**, or it is rejected;
5. exactly **one** new test accompanies the fix, or it is rejected.

A model claiming it fixed something is evidence of nothing. This is the same principle the rest of the pipeline runs on — no stage is believed because it ran — applied at the point where it matters most, because it is the only stage whose output is not deterministic.

#### It must fail into red, never hang

A self-hosted endpoint can be down, slow, or rate-limited, and the operator is sitting in a hands-off wait for a single message. So the client is bounded — connect timeout, request timeout, a retry cap — and **exhausting them is a terminal red state with a reason**, not a stall. `infra_failure_transient` and `infra_failure_persistent` already exist in spec §14's taxonomy for exactly this.

A pipeline that hangs is worse than one that fails, because the person waiting cannot tell the difference between "still working" and "never coming back".

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

**The sandbox is currently built the wrong way round for this flow.** *(Resolved 2026-08-29 by [#14](https://github.com/phix/sonar-remediation-automation/issues/14) — the restructure below has landed. Counts are the post-scan figures, not the local-proxy estimates this was written from.)*

SonarQube Cloud analyses a PR against *new code*. The 32 planted findings are on `main` at `v0-pristine`, so a PR that does not touch those lines reports **nothing**, the gate goes green, and the pipeline demonstrates precisely nothing.

For the flow to be demonstrable, `main` must be **clean** and the smells must arrive **as a PR**:

| | now | needs to be |
|---|---|---|
| `main` | 32 planted findings | clean |
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

---

**Correction, 2026-08-31: the notification channel is Telegram, not Teams.**
Everywhere this document says `teams_notify` or "Teams message", read
`telegram_notify` / "Telegram message" — the flag's tri-state semantics and
default are unchanged. Teams was descoped on the M365 licensing wall, not on
any property of this flow; the reasoning and the swap's mechanics are in
[`notify-telegram-not-teams.md`](notify-telegram-not-teams.md). The office
handoff can swap it back through the same seam.
