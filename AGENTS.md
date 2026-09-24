# sonar-remediation-automation — project context

Inherits `~/Developer/AGENTS.md` (portfolio rules); in a DSH session also
`~/.dsh/AGENTS.md`. This file carries the *pair-level* context: what the two
sonar repos are, what an agent's job is inside each, and where the system
actually runs. Read it before touching either repo.

**Not a Sector.** Neither repo has a `sector.json`, so the Master Control daemon
never dispatches here and an issue filed here is not picked up by the factory —
work happens in-session, by hand. Two consequences worth stating plainly:

- The portfolio's **"no GitHub Actions, portfolio-wide"** rule is scoped to
  Sectors. This pair is *built on* Actions; the sandbox's workflows are the
  product, not dead configuration. Do not "clean them up".
- The "file it, don't build it" division of labour does not bind here. Building
  the engine and writing the decision records *is* the session's work.

## The pair, one line each

| Repo | Holds | Role |
|---|---|---|
| `phix/sonar-remediation-automation` — **this repo** | engine code, decision records | deterministic codemods first, one tightly-policed LLM call last; Jira, settle, telegram libraries. **Deliberately never touches git** — the workflow owns commits and pushes |
| `phix/sonar-sandbox-app` | target code **and every workflow** | intentionally defective Angular 22 + Express 5 app; 32 planted findings; the CI that drives the pipeline |

The pair exists because the same system is being built at Nick's work: this is a
personal-account, synthetic-code mirror of it, safe to hand over as an internal
reference implementation. Both repos are **public**. Never commit a secret to
either; see `config/secrets.md` (Keychain locally, Actions encrypted secrets in
CI).

## Where it runs — and what is *not* deployed

**There is no deployed instance of the app, on purpose.** CD is explicitly out of
scope (`docs/IMPLEMENTATION_PLAN.md` §3): a CI re-scan is the proof a fix worked.
`web/` and `api/` are only ever built and tested inside CI.

**The one public deployment** is the pipeline diagram:

| | |
|---|---|
| URL | <https://phix.github.io/sonar-sandbox-app/> |
| Published by | sandbox workflow `98 - pipeline diagram`, on push to `main` touching `.github/workflows/**`, `.github/actions/**`, `tools/pipeline-diagram/**`, `docs/pipeline/**` |
| Pages config | `build_type: workflow`, source `main`, HTTPS enforced — verified 2026-09-24 |
| Renderer | [archify](https://github.com/tt-a1i/archify) checked out at pinned `ARCHIFY_SHA` (bump deliberately; its layout rules tighten between versions) |
| On a PR | does **not** deploy — comments the topology delta instead |

The automation repo has **no** Pages site (API returns 404) and **no** workflows.

**The real runtime is GitHub Actions on `phix/sonar-sandbox-app`.** Everything
that executes lives there: `01`–`06`, `98`, `99`, the `_`-prefixed reusable
modules, and `auto-continue watch`. This repo supplies the node code those jobs
check out with `AUTOMATION_REPO: phix/sonar-remediation-automation`.

Every external surface the pipeline touches:

| Surface | Detail |
|---|---|
| SonarQube Cloud | org `phix`, project `phix_sonar-sandbox-app`; analysis by `SonarSource/sonarqube-scan-action` |
| Jira | `https://1337software.atlassian.net`, project `SONAR` (not `phix.atlassian.net` — that site returns an empty project list instead of an error) |
| Telegram | bot `@SonarScannerFixBot` — **Teams is dead**, killed on M365 licensing; `docs/decisions/notify-telegram-not-teams.md` |
| tinman | Ollama, OpenAI-compatible, `http://tinman:11434/v1`, model `qwen2.5-coder:7b`; LAN `192.168.1.217`, tailnet `100.102.1.50`. GitHub runners reach it by joining the tailnet in-job (`TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET`, ACL tag `tag:ci`) |
| `automation-state` | orphan branch **in the sandbox repo** carrying `plan.json` between separately-triggered runs, so "which group already has a ticket/branch/PR" survives. Every job that reads or writes it needs `concurrency: group: automation-state` |

CI secrets present (verified 2026-09-24):

- automation repo — `JIRA_API_TOKEN`, `JIRA_USER_EMAIL`, `SANDBOX_REPO_TOKEN`, `SONAR_TOKEN_READ`
- sandbox repo — `JIRA_API_TOKEN`, `JIRA_USER_EMAIL`, `SANDBOX_REPO_TOKEN`, `SONAR_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`

## Derive state, never remember it

Nothing volatile belongs in this file — PR numbers, branch SHAs and open-branch
lists all rotate. Derive them, with `gh` at `/opt/homebrew/bin/gh` (not on the
default `PATH`):

```bash
export PATH="/opt/homebrew/bin:$PATH"
gh pr list   --repo phix/sonar-sandbox-app --state open
gh run list  --repo phix/sonar-sandbox-app --limit 10
gh api repos/phix/sonar-sandbox-app/branches --jq '.[].name'
gh api repos/phix/sonar-sandbox-app/branches/main/protection \
  --jq '.required_status_checks.contexts'          # a 404 means unprotected
```

## Shape of this repo

```
codemods/   policy.mjs (eligibility FIRST), registry.mjs, fixers/, agentic/ (LLM path), templates/
jira/       client, dedupe, group, plan, queue, record, resume, writeback, filter-findings
settle/     classify + gate + automerge — the terminal verdict, "red because <reason>"
telegram/   the one terminal message
scripts/    preflight, branch-contract, secrets.sh, sync-secrets.sh, verify-rule-keys.sh, verify-reset.mjs
docs/       decisions/ (10 records — read the relevant one before re-deciding anything), source/, research/
config/     secrets.md — names every credential, holds none
```

The order inside a remediation pass *is* the design: **policy → codemods → LLM →
one generated test per fix → build → full test suite.** On the sandbox catalogue
that is 18 findings fixed with zero LLM involvement, 4 refused by policy
(`api/src/auth/` is off-limits), the residue agentic. A refusal by name is
product behaviour, not a failure — do not "fix" it by loosening the policy or the
attempt cap.

## Commands

```bash
npm test                 # vitest, whole engine
npm run preflight        # environment / secrets check
npm run settle -- --project phix_sonar-sandbox-app --pr N [--auto-merge]
npm run jira:groups -- findings.json     # every group + ticket key, if any
npm run codemods:tracked-findings -- ...  # remediate from Sonar state, no live diff
```

Node ≥ 22. The interesting half runs on a laptop precisely because the engine
never touches git.

## Traps — stale docs in this repo

Facts drift; these three have already drifted. Trust the code and the sandbox
workflows over these lines:

- `docs/decisions/cross-repo-auth.md` still says **"the automation repo holds the
  workflows"**. It does not — they moved to the sandbox (see this repo's README).
  Its branch-protection half has drifted too: it documents `enforce_admins: false`
  and justifies that with "the one-click reset force-pushes `main` back to
  `v0-pristine`". **Measured 2026-09-24: `enforce_admins` is `true`** (protection
  binds admins), and `06 - reset the demo` force-pushes `demo/planted-smells` and
  explicitly never touches `main`. Do not read that doc's table as current; read
  the live protection API instead, as the sandbox `AGENTS.md` does.
- `config/secrets.md` still lists the sandbox repo and `SONAR_PROJECT_KEY` as
  "not yet created" (issues #7 / #10). Both landed; the secrets above exist
  today.
- `docs/IMPLEMENTATION_PLAN.md`'s header still names **Microsoft Teams** as the
  feedback channel and says 10 findings reach Claude. The channel is Telegram and
  the model is local (`qwen2.5-coder:7b` on tinman).

Two more that bite regardless of staleness:

- **The gate goes red on new-code coverage, not on the smells** — deliberate, and
  why a red settle verdict exits 0. Read `docs/decisions/coverage-and-the-gate.md`
  before touching gate logic.
- **One PR is the unit of work.** Everything downstream is scoped to *this* PR
  and *this* branch; a `settle` gate query without the PR parameter answers
  `{"status":"NONE"}` rather than erroring (`docs/decisions/scan-status-scoping.md`).

## Where to go deeper

- `README.md` — the promise, the demo walked step by step, the honest numbers.
- `docs/decisions/` — 10 records: flow, CI container, cross-repo auth, LLM
  endpoint transport, multi-entry-point flow, notify channel, dedupe order,
  coverage, scan scoping, Jira labels/comments.
- `docs/IMPLEMENTATION_PLAN.md` — what is built, what is decided, what is next.
- Sandbox side: `phix/sonar-sandbox-app` → `README.md`,
  `.github/workflows/README.md` ("which workflow do I run"), `AGENTS.md`.
