# Sonar Remediation Sandbox — Implementation Plan

**Status:** building · 7 of 19 tickets resolved, #15 and #18 substantially done · settle stage (`settle/`), Teams library (`teams/`) and the reset verifier (`scripts/verify-reset.mjs`) landed 2026-08-30, all unit-proven and none yet run in CI · #2 has its library half but still needs the Power Automate webhook proven by hand · **Map:** [phix/sonar-remediation-automation#1](https://github.com/phix/sonar-remediation-automation/issues/1)
**Owner:** Nick Ratliff (`phix`) · **Feedback channel:** Microsoft Teams

---

## 1. What this is

A personal, shareable mirror of a Sonar remediation pipeline Nick is building at work. Everything here runs on synthetic code and personal accounts, precisely so it can be handed to his employer as an internal reference implementation without exposing anything proprietary.

The design intent comes from four source documents, preserved verbatim in [`docs/source/`](source/): an architecture spec, a plan JSON schema, a Jira workflow/state model, and a GitHub Actions workflow design. This plan is how that intent becomes something that actually runs.

## 2. Destination

**Restated by Nick on 2026-08-29, after the sandbox was built.** The unit of work is a pull request, not a backlog campaign. A PR that introduces code smells gets them fixed on its own branch, and cannot merge until the scan is green.

The whole product, stated from the only seat that matters:

> Pull down code. Create a branch. Push it. Open a PR.
> **Do nothing else.** Wait for one message saying the PR is ready, or that it is red and exactly why.

```
PR opened or updated  (same-repo only — forks skipped with a non-green status)
    → scan: SonarQube Cloud analyses the PR branch
    → jira: OPTIONAL, default OFF — Jira ticket per group, rule suggestion
              attached, Jira key written back onto the Sonar finding
    → remediate: container pulls the PR branch, fixes every eligible finding in
                 one pass. DETERMINISTIC CODEMOD FIRST, ALWAYS — an agentic call
                 happens only where no codemod exists for that rule.
                 Exactly one unit test per fix. Build. Test.
    → push: commit lands on the PR branch → re-scan fires automatically (capped)
    → settle: green → OPTIONAL auto-merge, default OFF
              red   → merge stays blocked
    → notify: OPTIONAL, default OFF — ONE Teams message at the terminal state:
              "ready", or "red because <deterministic reason>"
    → reset: one click back to the pristine baseline
```

| Input | Default | What it adds |
|---|---|---|
| `jira` | `false` | Jira tickets |
| `teams_notify` | `false` | the terminal Teams message |
| `auto_merge` | `false` | merge the PR when the gate goes green |

**Off by default means the out-of-the-box pipeline is silent and does not merge** — it scans, fixes, pushes and stops. That is the right default, and it means the experience above is the *switches-on* configuration. The defaults are safe, not complete.

**An agentic call is permitted at exactly one point in the entire system**: generating a fix for a finding whose rule has no deterministic codemod. Grouping, fingerprinting, eligibility, test generation for codemod fixes, the red-because reason, Jira bodies and the merge decision are all deterministic. On the sandbox catalogue, with the eligibility policy enforced, that is **18 findings fixed with zero LLM involvement, 10 reaching Claude, 4 refused by policy** — measured on 2026-08-30, not estimated. The catalogue's `role` field says 19/11/2 because it records which engine *could* fix a finding rather than whether policy *allows* it; see §4.7. The pipeline reports this ratio per run, because it is the project's whole economic argument.

Every arrow is gated. No stage runs on the assumption the previous one worked. The loop closes on itself — the push is what re-triggers the scan — so the guards against self-triggering are load-bearing rather than defensive.

The full decision, what it supersedes in the source spec, and the risks it introduces are in [`docs/decisions/pr-remediation-flow.md`](decisions/pr-remediation-flow.md).

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

### 4.4 Five obvious rule choices would never have fired

The smell catalogue (#4) was built by looking every candidate rule up against the live SonarQube Cloud rules API rather than choosing rules that seemed apt. Five plausible picks turned out to be **real rules that are not activated in the default *Sonar way* profile**, so a scan would never have reported them:

| Rule | What it catches |
|---|---|
| `javascript:S1192` | String literals should not be duplicated |
| `javascript:S125` | Sections of code should not be commented out |
| `javascript:S1172` | Unused function parameters should be removed |
| `javascript:S138` | Functions should not have too many lines |
| `typescript:S1481` | Unused local variables — active for JavaScript, **not** for TypeScript |

Any of them would have failed the #10 scan gate for a bookkeeping reason rather than a real one, and the last is the nastiest: the same rule number behaves differently per language, so "it works in the API module" would not have transferred to the web module.

Severities held surprises too. `javascript:S3504` (*use let or const, not var*) is **CRITICAL**, not the MINOR that "modernise a keyword" suggests. [`scripts/verify-rule-keys.sh`](../scripts/verify-rule-keys.sh) now checks all three properties — existence, activation in the default profile, and the severity that profile actually assigns — reading the API anonymously, so it runs before `SONAR_TOKEN` exists.

### 4.5 One planted smell can produce two findings

An unused `const` raises **both** `S1481` (unused variable) and `S1854` (useless assignment) on the same line. Three of the catalogue's four `S1854` findings are co-located with an `S1481` in exactly this way, and a single codemod clears both.

This matters beyond bookkeeping. A catalogue built on the assumption of one-finding-per-planted-smell would show phantom "unexpected" findings at the #10 gate — which is designed to treat a mismatch as a real defect. The catalogue is therefore **generated from observed findings in a real Sonar scan**, never hand-written and never from the local ESLint stand-in, and carries 32 finding-shaped entries rather than 23 construct-shaped ones.

### 4.6 Scope narrowed to code smells

Bugs and vulnerabilities are not targets for now. Recon filters `types=CODE_SMELL` (verified working). This is a current scope rather than a permanent exclusion, and it matches source spec §10's own advice to begin with low-risk code smells. It changes the sandbox catalogue: the deliberately-non-automatable examples become code smells *sitting in sensitive paths*, which is the more faithful test anyway — eligibility policy refuses work by location and risk, not by whether something is technically a smell.

### 4.7 Two numbers the first real run corrected

Both were estimates that survived because nothing had executed yet.

**The quality gate was red on coverage, not on code smells.** The first CI scan reported `new_coverage 0.0 < 80` while `new_maintainability_rating`, `new_reliability_rating` and `new_security_rating` all passed — 32 code smells rate an **A**. So remediating every finding would not have turned the gate green, `auto_merge` would never have fired, and the loop would never have closed. The sandbox now reports lcov to Sonar, which moved `new_coverage` from `0.0` to `5.7`: still red, but red for something remediation can actually move.

The trap underneath it is worth keeping. vitest writes lcov `SF:` paths relative to each workspace (`src/store.js`); the scanner runs at the repo root, where that path does not exist. Sonar then resolves nothing and reports 0% — indistinguishable from having written no tests, and visible only in a scanner log line nobody reads. [`normalize-lcov.mjs`](https://github.com/phix/sonar-sandbox-app/blob/main/.github/scripts/normalize-lcov.mjs) rewrites the paths and **asserts each one exists on disk**, so a wrong prefix fails the build rather than becoming a silent zero.

**The 19/11/2 ratio is 18/10/4 once eligibility is enforced.** `javascript:S7765` (marked `codemod_fixable`) and `javascript:S7737` (marked `claude_fallback`) both sit in `api/src/auth/session.js` — the directory the catalogue's own `S1121` rationale names as the protected path. The catalogue's `role` field answers *which engine could fix this*; only the policy answers *are we allowed to*. Where they disagree the policy wins, or the pipeline edits security-sensitive code whenever a fixer happens to exist for the rule.

## 5. The map

Work is tracked as a [wayfinder map](https://github.com/phix/sonar-remediation-automation/issues/1) — one issue holding the destination and decisions, with child issues as tickets and GitHub-native dependencies expressing what blocks what.

**Resolved:**

| # | Ticket | Outcome |
|---|---|---|
| [3](https://github.com/phix/sonar-remediation-automation/issues/3) | Grant the workflow token scope | `workflow` and `read:project` granted; workflow files now push |
| [5](https://github.com/phix/sonar-remediation-automation/issues/5) | Map the SonarQube Cloud and Jira Cloud API contracts | [`docs/research/api-contracts.md`](research/api-contracts.md) — see §4.3 |
| [7](https://github.com/phix/sonar-remediation-automation/issues/7) | Create the sandbox repo and decide cross-repo auth | [`docs/decisions/cross-repo-auth.md`](decisions/cross-repo-auth.md) |
| [8](https://github.com/phix/sonar-remediation-automation/issues/8) | Build the clean Angular + Express sandbox app | `phix/sonar-sandbox-app`, 20 tests green |
| [9](https://github.com/phix/sonar-remediation-automation/issues/9) | Inject the smell catalogue and tag `v0-pristine` | catalogue planted, build and tests still green. Now 32 findings on `demo/planted-smells`, `v0-pristine` → `243e9d2` after #14 moved them off `main` |
| [11](https://github.com/phix/sonar-remediation-automation/issues/11) | Run the API contract verification against live accounts | 11/11 pass |
| [14](https://github.com/phix/sonar-remediation-automation/issues/14) | Restructure the sandbox so the smells arrive as a pull request | clean `main` at `v0-clean` (`1a3f005`), defective `demo/planted-smells` at `v0-pristine` (`243e9d2`), [PR #2](https://github.com/phix/sonar-sandbox-app/pull/2) open as the standing demo target |

**Awaiting Nick's yes or no** — the work and its evidence are done; these are decisions, not tasks:

| # | Ticket | What is waiting |
|---|---|---|
| [4](https://github.com/phix/sonar-remediation-automation/issues/4) | Choose the intentional code-smell catalogue | 32 findings proposed and proven to fire against a live scan — `16/16` planted rule keys reported, 0 unexpected. Is it representative of what you see at work? |
| [6](https://github.com/phix/sonar-remediation-automation/issues/6) | Decide the generic CI container contract | Bootstrap for execute, stock image for recon/plan — [decided and measured](decisions/ci-container.md). Agree or reject the split. |

**Need Nick's hands on a console:**

| # | Ticket | Why only he can do it |
|---|---|---|
| [2](https://github.com/phix/sonar-remediation-automation/issues/2) | Prove the Microsoft Teams feedback channel | Power Automate flow creation, personal account |
| [13](https://github.com/phix/sonar-remediation-automation/issues/13) | Create and prove `SANDBOX_REPO_TOKEN` | Fine-grained PAT creation |
| [10](https://github.com/phix/sonar-remediation-automation/issues/10) | Bind SonarQube Cloud and land a first real scan | **mostly done** — project imported as `phix_sonar-sandbox-app`, scan green locally. Remaining: issue `SONAR_TOKEN_READ`, and push `SONAR_TOKEN` into the **sandbox** repo's secrets so #15 can run it in CI |

**Blocked, in dependency order:**

| # | Ticket | Waits on |
|---|---|---|
| [15](https://github.com/phix/sonar-remediation-automation/issues/15) | `sonar-pr-scan.yml` and the quality gate as a required check | **the frontier** — needs only `SONAR_TOKEN` in the sandbox repo. PR #2 currently carries **zero status checks** |
| [16](https://github.com/phix/sonar-remediation-automation/issues/16) | The remediation run: fix, test, build, push to the PR branch | #13, #15 |
| [17](https://github.com/phix/sonar-remediation-automation/issues/17) | `jira` — the optional Jira ticketing step | #10 |
| [18](https://github.com/phix/sonar-remediation-automation/issues/18) | The deterministic codemod library and its test templates | — takeable now |
| [19](https://github.com/phix/sonar-remediation-automation/issues/19) | The agentic fix library, against a configurable LLM endpoint | — needs the endpoint |
| [12](https://github.com/phix/sonar-remediation-automation/issues/12) | Finding normalization (the workflow half is superseded by #15) | — |
| [20](https://github.com/phix/sonar-remediation-automation/issues/20) | `demo-reset.yml` — one click back to the defective baseline | **built and proven** in the sandbox repo, run twice clean. Two boxes left, both needing #16 and #17 to exist before there is anything to undo |

Everything buildable without a credential Nick has not yet issued is built.

## 5a. What the flow restatement changed

Nick restated the flow on 2026-08-29, after the sandbox and catalogue were built. The full decision is in [`docs/decisions/pr-remediation-flow.md`](decisions/pr-remediation-flow.md); the map consequences are:

### The sandbox now looks like this

```
main                1a3f005   clean · tagged v0-clean · catalogue empty by design
demo/planted-smells 243e9d2   32 findings · tagged v0-pristine
PR #2               demo/planted-smells -> main, standing demo target
```

`smells:verify` runs on both and means something different on each: on `main` it asserts nothing has crept in, on the branch it asserts the planted set is intact. The difference between the two catalogues is the demo's expectation.

**Reset restores two things**, and the branch is the harder one: force-push it rather than closing and reopening the PR, because PR #2's number is what Jira links, Sonar PR analysis and the required status check are all keyed to.

- **#14 is new and inverts #9.** Sonar analyses a PR against *new code*, so 32 findings sitting on `main` report nothing. `main` has to be clean and the smells have to arrive as a PR. Non-destructive to fix, and none of the catalogue work is lost — it moves to a branch.
- **#15, #16, #17 are new** and replace the not-yet-ticketed recon/plan/execute/verify chain from §6.
- **#12 is narrowed.** `sonar-recon.yml` is superseded by #15; the normalization half survives, and no longer needs #10, since a real findings payload is already on disk.
- **Teams has fallen out of the stated flow.** #2 is not cancelled — the PR comment may simply have replaced it, which would be the better answer. Needs an explicit yes or no.
- **PR creation disappears entirely.** The automation no longer opens a PR; it pushes to one that already exists. This narrows what `SANDBOX_REPO_TOKEN` (#13) is for without changing the permissions it needs.
- **The codemod library became the core deliverable** (#18). "Codemod first" was a cost optimisation; it is now an architectural constraint, so a rule without a fixer is a rule that costs money and latency on every PR that trips it.
- **The agentic path points at Nick's own OpenLLM** (#19), through a configurable OpenAI-compatible seam rather than a hardcoded vendor. This supersedes the `ANTHROPIC_API_KEY` the original spec assumed, and gives the office a swap point rather than a rewrite.
- **Fork pull requests are out of scope**, decided rather than tolerated. GitHub withholds repository secrets from a `pull_request` run on a fork, so the scan cannot run at all — the failure is at step 1, not the push. The usual workaround, `pull_request_target`, is refused: it runs in the base repo's context with secrets and a write token against contributor-controlled code. Workflows must skip forks **explicitly, with a non-green status**, because a workflow that silently does nothing is indistinguishable from one that ran and found nothing.

## 6. What is deliberately not yet ticketed

Most of what this section used to list is now ticketed — the flow restatement made shapes sharp that previously depended on answers the frontier had not reached. What remains:

- **Retry and escalation** is no longer a separate workflow. It collapsed into [#16](https://github.com/phix/sonar-remediation-automation/issues/16)'s guards: an attempt cap, and a hard failure into the red terminal state rather than a silent stop. Spec §14's taxonomy supplies the classifications; there is no orchestration left to design.
- **Abstraction and handoff pass** — parameterize everything site-specific and write the internal-sharing README. Deliberately last: it can only be written once the thing being abstracted actually runs, and writing it earlier would document intentions rather than behaviour.

Everything else graduated:

| Was | Now |
|---|---|
| Recon workflow | [#15](https://github.com/phix/sonar-remediation-automation/issues/15) (scan) + [#12](https://github.com/phix/sonar-remediation-automation/issues/12) (normalization) |
| Planning workflow | [#17](https://github.com/phix/sonar-remediation-automation/issues/17) — and optional, default off |
| Execute workflow | [#16](https://github.com/phix/sonar-remediation-automation/issues/16), split from [#18](https://github.com/phix/sonar-remediation-automation/issues/18) codemods and [#19](https://github.com/phix/sonar-remediation-automation/issues/19) agentic |
| Retry/escalation workflow | folded into #16's guards |
| Teams notification action | [#2](https://github.com/phix/sonar-remediation-automation/issues/2) — one terminal message, optional |
| `reset-sandbox.yml` | [#20](https://github.com/phix/sonar-remediation-automation/issues/20) |

That graduation is the method working, not scope growth: each became statable the moment the frontier reached it.

## 7. Validation discipline

Nick's requirement — *"each step of the way we need validation that the previous step passed"* — is enforced structurally, not by good intentions:

1. **Every ticket carries an explicit validation checklist** that must pass before it closes.
2. **Validation means pasted command output**, not assertion. "Should work" closes nothing.
3. **Blocking dependencies are GitHub-native**, so a ticket whose predecessor hasn't closed is visibly ungrabbable in the UI.
4. **Each stage re-proves the previous stage still works** rather than trusting it. Regressions surface at the next gate, not three tickets later.
5. **One terminal message, not one per gate.** Superseded by [decision 8](decisions/pr-remediation-flow.md): the operator asked to be left alone until the PR is ready or red, so a stream of per-gate pings would defeat the requirement it was meant to serve. Progress mid-run is visible on the PR itself, for anyone who chooses to look.

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
