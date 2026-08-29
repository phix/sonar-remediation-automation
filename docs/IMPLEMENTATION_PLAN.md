# Sonar Remediation Sandbox — Implementation Plan

**Status:** charted 2026-08-29 · 1 of 11 tickets resolved · **Map:** [phix/sonar-remediation-automation#1](https://github.com/phix/sonar-remediation-automation/issues/1)
**Owner:** Nick Ratliff (`phix`) · **Feedback channel:** Microsoft Teams

---

## 1. What this is

A personal, shareable mirror of a Sonar remediation pipeline Nick is building at work. Everything here runs on synthetic code and personal accounts, precisely so it can be handed to his employer as an internal reference implementation without exposing anything proprietary.

The design intent comes from four source documents, preserved verbatim in [`docs/source/`](source/): an architecture spec, a plan JSON schema, a Jira workflow/state model, and a GitHub Actions workflow design. This plan is how that intent becomes something that actually runs.

## 2. Destination

A single operator run takes a planted code smell from *"SonarQube Cloud found it"* to *"PR open, re-scan clean, Jira transitioned, Teams notified"* — and one click puts it all back.

Concretely, the loop is:

```
SonarQube Cloud scan
    → recon: normalize findings, fingerprint them
    → plan: group them, create/dedupe Jira issues, emit plan JSON
    → execute: branch, codemod-or-Claude fix, build, test, re-scan
    → verify: PR opened, Jira transitioned, Teams notified
    → reset: one click back to v0-pristine
```

Every arrow is gated. No stage runs on the assumption the previous one worked.

## 3. Decisions locked during charting

| Decision | Choice | Why |
|---|---|---|
| Repo layout | Two repos — `sonar-remediation-automation` + `sonar-sandbox-app` | Mirrors the office model where automation is central and repos are targets. The automation repo is what gets shared internally. |
| Visibility | Both public | Unlimited Actions minutes; SonarQube Cloud free tier. The sandbox code is deliberately bad and holds no secrets. |
| Sonar | SonarQube Cloud via `SonarSource/sonarqube-scan-action@v7` | Hosted, free for public repos, real Web API for recon. The older `sonarcloud-github-action` is deprecated. |
| Fix engine | Deterministic codemod first, Claude as fallback | Cheap and auditable where a mechanical fixer exists; general where one doesn't. Mirrors a mature office system. |
| Revert | Reset `main` to the `v0-pristine` tag, plus branch/PR/Jira cleanup | Genuinely one click, genuinely total — survives having merged fixes in earlier runs. |
| Sandbox app | Angular frontend + Express API in one repo | Two modules means `module_prefix` grouping is actually exercised rather than degenerate. |
| Secrets | GitHub Actions encrypted secrets | Nothing in plaintext, nothing committed. |
| CD | Out of scope | Nick ruled it out: a CI re-scan is sufficient proof a fix worked. |

## 4. Two findings that change the plan

Both were verified during charting, and both would have bitten later.

### 4.1 The GitHub blocker is a token scope, not a plan

Nick asked to "upgrade my GitHub account so I have capability to run GitHub Actions." **That upgrade is almost certainly unnecessary** — Actions is included on GitHub Free, with unlimited minutes on public repositories, and both repos here are public.

The actual blocker is different. As of 2026-08-29:

```
gh auth status → Token scopes: 'gist', 'read:org', 'repo'
```

There is no `workflow` scope, so **any push touching `.github/workflows/` will be rejected**. Fixed by `gh auth refresh -h github.com -s workflow -s read:project`. This is [#3](https://github.com/phix/sonar-remediation-automation/issues/3), and it gates every workflow file in the effort.

### 4.2 Classic Teams webhooks are dead

Office 365 connectors — the traditional Teams incoming webhook — were **disabled May 18–22, 2026**. The only supported path is now Power Automate Workflows ("When a Teams webhook request is received" → "Post card in a chat or channel").

The residual risk: Power Automate's Teams connectors are built around work/school (Entra ID) accounts, and Nick's is a personal hotmail account. He believes it works. [#2](https://github.com/phix/sonar-remediation-automation/issues/2) proves it or picks a fallback — and it is deliberately **ticket one**, because every subsequent validation gate reports through that channel. Discovering it's impossible after nine tickets depend on it would be expensive.

### 4.3 The API contracts held three surprises

Researched and largely verified against live services ([full write-up](research/api-contracts.md)):

- **Jira's old search endpoint returns 410 Gone**, not a deprecation warning — sunset completed August 2025. Dedupe uses `POST /rest/api/{2,3}/search/jql`, which paginates by opaque cursor and returns no result count.
- **Sonar returns both severity vocabularies on every issue.** Documentation implies a project is in one mode or the other; 100 real issues showed legacy `severity`, `type`, `impacts[]` and `cleanCodeAttribute` all present at 100%. For code smells they map 1:1, so the source spec's `MAJOR` vocabulary is safe to keep — and the concern that it might be unrepresentable was unfounded.
- **Jira v3 forces ADF** (a nested document tree) for every description and comment; v2 takes plain strings. Using v2, behind a single `renderBody()` seam so a later migration touches one function.

Also decided: fingerprint findings on Sonar's content `hash` rather than the line number, a deliberate deviation from spec §8.1 — line numbers shift on every unrelated edit above a finding, which would make the same defect re-fingerprint constantly.

### 4.4 Scope narrowed to code smells

Bugs and vulnerabilities are not targets for now. Recon filters `types=CODE_SMELL` (verified working). This is a current scope rather than a permanent exclusion, and it matches source spec §10's own advice to begin with low-risk code smells. It changes the sandbox catalogue: the deliberately-non-automatable examples become code smells *sitting in sensitive paths*, which is the more faithful test anyway — eligibility policy refuses work by location and risk, not by whether something is technically a smell.

## 5. The map

Work is tracked as a [wayfinder map](https://github.com/phix/sonar-remediation-automation/issues/1) — one issue holding the destination and decisions, with child issues as tickets and GitHub-native dependencies expressing what blocks what.

**Resolved:**

| # | Ticket | Outcome |
|---|---|---|
| [5](https://github.com/phix/sonar-remediation-automation/issues/5) | Map the SonarQube Cloud and Jira Cloud API contracts | [`docs/research/api-contracts.md`](research/api-contracts.md) — see §4.3 below |

**Takeable now (no blockers):**

| # | Ticket | Type |
|---|---|---|
| [2](https://github.com/phix/sonar-remediation-automation/issues/2) | Prove the Microsoft Teams feedback channel works end to end | task |
| [3](https://github.com/phix/sonar-remediation-automation/issues/3) | Grant the workflow token scope and confirm Actions entitlement | task |
| [4](https://github.com/phix/sonar-remediation-automation/issues/4) | Choose the intentional code-smell catalogue | grilling |
| [6](https://github.com/phix/sonar-remediation-automation/issues/6) | Decide the generic CI container contract | grilling |
| [11](https://github.com/phix/sonar-remediation-automation/issues/11) | Run the API contract verification against live accounts | task |

**Blocked, in dependency order:**

| # | Ticket | Waits on |
|---|---|---|
| [7](https://github.com/phix/sonar-remediation-automation/issues/7) | Create the sonar-sandbox-app repo and cross-repo auth | #3 |
| [8](https://github.com/phix/sonar-remediation-automation/issues/8) | Build the clean Angular + Express sandbox app | #7 |
| [9](https://github.com/phix/sonar-remediation-automation/issues/9) | Inject the smell catalogue and tag `v0-pristine` | #4, #8 |
| [10](https://github.com/phix/sonar-remediation-automation/issues/10) | Bind SonarQube Cloud and land a first real scan | #6, #9 |
| [12](https://github.com/phix/sonar-remediation-automation/issues/12) | Implement `sonar-recon.yml` and finding normalization | #6, #10 |

All five open frontier tickets need Nick — four need his hands on a console, one is a live conversation.

## 6. What is deliberately not yet ticketed

The map charts what can be stated sharply *now*. These are in scope and coming, but their shape depends on answers the frontier hasn't reached — writing them as tickets today would mean inventing detail:

- **Recon workflow** and finding normalization — depends on what the Sonar Web API actually returns (#5) and the container contract (#6).
- **Planning workflow** — grouping, fingerprints, Jira create/dedupe/supersede, plan JSON validating against the provided schema. Needs the Jira contract and real findings to group.
- **Execute workflow** — the codemod fixers, the Claude fallback, build/test/re-scan verification, PR creation. Can't be specified before the catalogue (#4) names which rules need which treatment.
- **Retry/escalation workflow** — failure taxonomy and retry policy. Needs real failures to classify.
- **Reusable Teams notification action** — called at every gate. Shape depends on what the Power Automate webhook accepts (#2).
- **`reset-sandbox.yml`** — the one-click revert.
- **Abstraction and handoff pass** — parameterize everything site-specific, write the internal-sharing README.

Each graduates into real tickets as the frontier advances. That is the method, not a gap.

## 7. Validation discipline

Nick's requirement — *"each step of the way we need validation that the previous step passed"* — is enforced structurally, not by good intentions:

1. **Every ticket carries an explicit validation checklist** that must pass before it closes.
2. **Validation means pasted command output**, not assertion. "Should work" closes nothing.
3. **Blocking dependencies are GitHub-native**, so a ticket whose predecessor hasn't closed is visibly ungrabbable in the UI.
4. **Each stage re-proves the previous stage still works** rather than trusting it. Regressions surface at the next gate, not three tickets later.
5. **Teams gets notified at each gate** once #2 lands, so progress is visible without opening GitHub.

The recurring anti-pattern this is built against: a pipeline stage that reports success because it *ran*, rather than because it *achieved something*. Hence the sharpest gate in the map — #10 does not accept "the scan completed" as success. It diffs actual reported rule keys against the planted catalogue, and a planted smell that never fires is treated as a real defect in the oracle.

## 8. Handoff to the office

The abstraction pass is a ticket, not an afterthought. What has to become parameters before this can be shared internally:

- Sonar host, organisation, project key — Cloud here, likely self-hosted Server there.
- Jira base URL, project key, and the **status model gap**. The source state model (§7 of [the Jira doc](source/jira_workflow_state_model.md)) assumes twelve statuses including `Auto Remediation Running` and `Superseded`. A default free Jira Cloud project has roughly three. #5 records what's realistically available and what a real Jira workflow config would need — that difference is exactly what Nick's Jira admin will need to hear.
- Notification transport — Power Automate here, possibly a corporate connector there.
- Cross-repo auth — a fine-grained PAT here, plausibly a GitHub App at organisation scale (#7 records the trade-off).
- Eligibility policy — the allowlist of auto-fixable rules will differ per codebase and per risk appetite.

## 9. Working the map

```bash
/mattpocock-skills:wayfinder https://github.com/phix/sonar-remediation-automation/issues/1
```

Resolves the next frontier ticket. One ticket per session — that constraint is what keeps each one properly finished instead of half-done across four. Name a specific issue to work that one instead.
