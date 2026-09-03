# sonar-remediation-automation

Automated discovery, remediation, and verification of SonarQube findings via
GitHub Actions — deterministic codemods first, a single tightly-policed LLM
call last, Jira as the optional human workflow surface, and Telegram as the
feedback channel.

Built and proven against a synthetic sandbox
([`phix/sonar-sandbox-app`](https://github.com/phix/sonar-sandbox-app)) whose
code smells are *planted on purpose* and recorded in a catalogue, so every
claim the pipeline makes can be checked against a known answer. This repo holds
the automation; the sandbox holds the code being fixed and the workflows that
run against it.

## The promise being demonstrated

> Pull down code. Create a branch. Push it. Open a PR.
> **Do nothing else.** Wait for one message saying the PR is ready — or that it
> is red and exactly why.

```
demo-reset            sandbox restored to its pristine, smelly baseline
    → PR opened       demo branch with 32 planted findings
    → scan            SonarQube Cloud analyses the PR branch; gate is a
                      required check, so red genuinely blocks the merge
    → (jira)          optional — one ticket per finding group
    → remediate       policy decides eligibility FIRST, codemods fix
                      everything they can, the LLM only gets what's left
    → push            bot commit lands on the PR branch → re-scan fires
                      (capped, so the loop cannot run away)
    → settle          reads the gate and classifies: ready or red-because-X;
                      on ready, merges the PR automatically
    → notify          ONE Telegram message at the terminal state
    → demo-reset      one click back to the baseline; the demo is repeatable
```

For the demo, the switches are on: `telegram_notify: true`, `auto_merge: true`
(`jira` stays off unless you want to show the ticket surface). All three
default to `false`, so the out-of-the-box pipeline is silent and never merges —
the defaults are safe, not complete.

## The demo, step by step

### 0. Reset — `demo-reset`

**What happens:** a one-click workflow on the sandbox repo restores the demo
branch to the pristine baseline: all 32 planted findings present, no bot
commits, attempt counter at zero.

**Why:** the demo has to be repeatable. Every run starts from the same known
state, so the numbers you see (32 findings, 16 groups) are the same numbers
every time, and nothing from a previous run can leak in. The reset workflow
pushes with a real repo token (`SANDBOX_REPO_TOKEN`), not the default
`GITHUB_TOKEN` — a default-token push leaves the re-triggered scan stuck at
`action_required` with zero jobs, which was found and fixed the hard way.

### 1. A PR is opened

**What happens:** the demo branch is opened as a PR against `main`
(same-repo only — fork PRs are skipped with a non-green status rather than
silently ignored).

**Why:** the PR is the unit of work for the entire system. Everything
downstream — scan, remediation, settle, notify — is scoped to *this* PR and
*this* branch. The human's job ended the moment the PR opened.

### 2. Scan

**What happens:** SonarQube Cloud analyses the PR branch and reports 32
findings in 16 groups. The quality gate result is posted as a **required
status check** (`gate`) on `main`.

**Why:** making the gate a required check means a red gate *actually blocks
the merge button* — the block is enforced by GitHub branch protection, not
merely reported in a comment. The gate goes red on **new-code coverage**, not
on the smells themselves, and that is deliberate: the ratings are all A because
the planted smells are individually minor; coverage is the honest reason this
code isn't mergeable
([why that is not a smell problem](docs/decisions/coverage-and-the-gate.md)).

### 3. Jira (optional, off by default)

**What happens:** when enabled, one Jira ticket is created per finding group
**before remediation touches anything**, labelled `needs-work`, deduplicated
so re-runs update rather than duplicate. A later call — after remediation, a
push and a re-scan — flips a ticket to `ready` and comments once Sonar stops
reporting that group at all, or back to `needs-work` with a "reopened" comment
if it regresses; it also drops a comment naming the remediation outcome
(`docs/decisions/jira-needs-work-and-outcome-comments.md`).

**Why:** Jira is the surface where a human team would track and audit the
work, so the ticket has to exist before there is anything to audit, and its
label has to track what Sonar actually still reports rather than freezing at
whatever it said when the ticket was filed. The demo usually skips Jira to
keep the arc tight, but it exists to show the pipeline can feed a real
workflow tool, not just a chat channel.

### 4. Remediate — the heart of the system

**What happens:** a CI container pulls the PR branch and runs one remediation
pass. The order inside that pass *is* the design:

1. **Policy first.** Every finding is checked against the eligibility policy
   *before any engine sees it*. On the sandbox catalogue, 4 findings are
   refused — files under `api/src/auth/` are off-limits no matter how easy the
   fix would be.
2. **Deterministic codemods next.** Every eligible finding whose Sonar rule has
   a registered codemod is fixed by pure code: 18 of the 32, with **zero LLM
   involvement**.
3. **The LLM last, and only for the leftovers.** Findings that are eligible
   but have no codemod go to the agentic engine — a self-hosted model reached
   from CI over a Tailscale tailnet whose ACL allows CI runners to reach
   *exactly one host and port* and nothing else. Throttled by
   `--max-findings` and `--max-attempts 2`; a fix that can't produce a
   discriminating test within two attempts is **refused and named**, not
   forced.
4. **Exactly one unit test per fix**, generated from the file *as it was
   before the edit*, so the test characterises the behaviour being preserved.
   Then the whole project is built and the full test suite runs.

**Why this order:** deciding eligibility before any fixer runs means a policy
refusal can never be argued away by an engine that happens to know how to make
the change. Running codemods before the LLM means the expensive, less
predictable path only ever handles the residue — the demo's headline is that
**most findings never touch an LLM at all**, and the ones that do are fenced by
policy, attempt caps, and a network ACL. A refusal is a first-class outcome:
the pipeline would rather tell you "I won't fix this, and here is why" than
ship an unverifiable change.

### 5. Push and re-scan

**What happens:** the workflow (not the remediation code — git is the
workflow's job) commits the fixes to the PR branch as a bot commit, e.g.
*"Remediate 18 findings deterministically, 1 agentically"*. The push
re-triggers the scan. Bot commits are **capped at 2** per PR.

**Why:** the re-scan is the verification — Sonar itself confirms the findings
are gone, rather than the pipeline grading its own homework. The cap exists
because an uncapped fix→scan→fix loop is a runaway machine; two attempts is
the point where anything still red needs a human.

### 6. Settle

**What happens:** once the re-scan finishes, the settle stage reads the PR's
quality gate and the remediation dispositions and classifies the terminal
state: **ready**, or **red with a deterministic reason** (for the sandbox:
`new_coverage 6.9 < 80`, plus the 4 policy refusals, each named). With
`auto_merge` on — as in this demo — a **ready** verdict merges the PR
automatically, no human click. A **red** verdict never merges, flag or no
flag: the required check has the merge blocked at the branch-protection layer.

**Why:** red is *not a failure of the pipeline* — on this sandbox it is the
correct, expected outcome, and settle exits 0 on it. The whole demonstration
is a gate that blocks for a stated reason. The only settle failure is
"auto-merge was asked for on a green PR and could not be delivered."
Auto-merge lives here, at the very end, because a merge is only trustworthy
after the gate has been re-read post-remediation — and the gate is fetched
*with* the PR parameter, because Sonar answers a wrongly-scoped gate query
with `{"status":"NONE"}` instead of an error, which settle classifies as
undetermined rather than green
([why](docs/decisions/scan-status-scoping.md)).

### 7. Notify

**What happens:** exactly **one** Telegram message
(`@SonarScannerFixBot`) at the terminal state: "ready" (and merged), or "red
because *coverage on new code is 6.9%, below the 80% gate; 4 findings refused
by policy*".

**Why:** one message is the entire human contract from the loop's promise. Not
a stream of per-step chatter — a single terminal verdict with a deterministic
reason. Off is silent, but *on-and-unconfigured is red*: a notifier that
silently skips the message it was asked to send is the exact failure mode this
whole system exists to prevent. Telegram replaced Teams purely on M365
licensing, one swapped step, same contract
([decision](docs/decisions/notify-telegram-not-teams.md)).

### 8. Reset again

**What happens:** one click on `demo-reset` and the sandbox is back at
step 0.

**Why:** a demo you can only run once is a recording. This one is a loop.

## The honest numbers

Measured against the live catalogue, not estimated:

| Count | Outcome | Engine |
|---|---|---|
| 32 | findings planted and detected | Sonar scan |
| 18 | fixed deterministically | codemods, zero LLM |
| 4 | refused by policy (`api/src/auth/`) | none — named in the verdict |
| rest | eligible for the agentic path | LLM, capped by `--max-findings` / `--max-attempts 2` |

One finding is a deliberate, accepted capability boundary: when the agentic
engine cannot produce a test that discriminates the fix, it refuses by name.
**The named refusal is the product behaviour** — the demo shows the machine
saying no, out loud, instead of merging something it cannot verify.

## Where to go deeper

- **[Implementation plan](docs/IMPLEMENTATION_PLAN.md)** — what is built, what
  is decided, what is next.
- **[Decision records](docs/decisions/)** — the flow
  ([pr-remediation-flow](docs/decisions/pr-remediation-flow.md)), the CI
  container shape, cross-repo auth, the LLM endpoint and transport saga, and
  more.
- **[Source design docs](docs/source/)** — architecture spec, plan JSON
  schema, Jira state model.

## Running the pieces locally

```
npm test                 # full unit suite (vitest)
npm run codemods:apply   # deterministic fixers against a findings file
npm run settle           # settle stage: node settle/run.mjs --project KEY --pr N [--auto-merge]
npm run jira             # jira step
npm run jira:resume      # where does one group already stand? --plan plan.json --fingerprint gf-x
npm run jira:queue       # bulk-onboarding batch selection: findings.json --plan plan.json --max-concurrent N
npm run jira:groups      # every group in a findings file, ticket key if one exists
npm run jira:filter      # cut a findings file down to named group fingerprints
npm run jira:record      # record a branch/PR/status onto the plan: branch|pr|status --plan plan.json --fingerprint gf-x
npm run preflight        # environment / secrets preflight
```

The multi-entry-point flow (bulk onboarding, tracking one finding before any
PR exists, auto-continue) is `docs/decisions/multi-entry-point-flow.md`; the
workflows that call these scripts live in the sandbox repo, not here.

The remediation core deliberately never touches git — the workflow owns
commits and pushes — which is exactly what makes the interesting half runnable
on a laptop.
