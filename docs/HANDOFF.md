# Handoff — 2026-08-30

Written at the end of the session that built the scan gate, the codemod library
and the remediation run, and drove the loop end to end for the first time.

Everything below is **verified state**, not intention. Where something is
unproven it says so.

---

## 1. The loop closes

This is the headline: on 2026-08-30 a pull request went through the whole cycle
without a human touching it.

```
sonar-pr-scan  →  32 findings, gate ERROR
remediate      →  18 resolved deterministically, 15 tests generated
push           →  bot commit 5d5a9c6 on demo/planted-smells
re-scan        →  fired automatically, 14 findings remain
```

The automatic re-scan is the part that was uncertain. A push made with
`GITHUB_TOKEN` deliberately does **not** trigger workflow runs, so the
remediation push has to use `SANDBOX_REPO_TOKEN`. It does, and the scan fired.

## 2. Current state

| | |
|---|---|
| Automation repo | `phix/sonar-remediation-automation` @ `7d21f35` |
| Sandbox repo | `phix/sonar-sandbox-app` @ `1290d3e` (main) |
| Demo branch | `demo/planted-smells` @ `5d5a9c6` — **carries a bot commit, no longer at `v0-pristine`** |
| PR #2 | open, `MERGEABLE`, `UNSTABLE` (failing but not blocked) |
| Findings | 32 reported, **14 open** after remediation |
| Ratio | **18 codemod / 10 agentic / 4 refused by policy** |
| Tests | 50 in the automation repo, 43 in the sandbox after remediation (was 20) |
| Version | Claude Code 2.1.251 |

**The demo branch is dirty.** Run `demo-reset` before demoing anything. Doing so
also closes #20's last open box — remediate fully, reset, confirm the findings
come back — which is now takeable for the first time.

## 3. What changed this session

- **`sonar-pr-scan.yml`** — scans every PR, waits for the compute-engine task,
  posts a findings comment, and fails the job when the gate is red. The job's own
  conclusion is the status check; nothing posts a second one.
- **Coverage reporting** — the gate was red on `new_coverage`, *not* on the code
  smells. All three ratings passed; 32 smells rate an **A**. Without coverage,
  fixing every finding would never have turned the gate green. Now `0.0 → 5.3`.
- **The codemod library** — six fixers over twelve rule keys, plus an eligibility
  policy that refuses by location before any engine sees a finding.
- **Per-fix test generation** — one characterization case per applied fix,
  anchored to the exported symbol enclosing the finding.
- **`remediate.yml`** — the full run: fetch findings, fix, generate tests, build,
  test, commit, push.
- **Three verification tools** (§6), each proven by replaying the failure it
  exists to catch.

## 4. Blocked on Nick

**Branch protection is still unset.** `required_status_checks.contexts` is
`none`, so PR #2 shows `UNSTABLE` — failing checks that do not block the merge.
Until this lands, "the merge is gated" is a claim, not a fact.

```bash
gh api -X PUT repos/phix/sonar-sandbox-app/branches/main/protection --input - <<'JSON'
{"required_status_checks":{"strict":false,"contexts":["gate"]},"enforce_admins":false,"required_pull_request_reviews":{"dismiss_stale_reviews":true,"require_code_owner_reviews":false,"require_last_push_approval":false,"required_approving_review_count":0},"restrictions":null,"required_linear_history":false,"allow_force_pushes":true,"allow_deletions":false,"block_creations":false,"required_conversation_resolution":false,"lock_branch":false,"allow_fork_syncing":false}
JSON
```

`allow_force_pushes: true` is preserved deliberately — `demo-reset` needs it.

**A decision only Nick can make: can the gate ever go green?** New-code coverage
is **5.3% against an 80% threshold**. Thirty generated characterization tests
will not close that gap — they assert module shape, not behaviour, so they add
few covered lines. Three options:

1. Lower the threshold, or use a custom quality gate without `new_coverage`.
2. Accept that green is unreachable and make "red because new_coverage 5.3% <
   80%" the deterministic reason the flow already promises.
3. Have the agentic path write behaviour-level tests that actually cover code —
   the only route that reaches 80% honestly, and it needs #19.

**Also worth checking:** the automation repo's copy of `SANDBOX_REPO_TOKEN` may
still hold the bad value that the sandbox copy had (192 chars, HTTP 401). Only
the sandbox copy was replaced.

## 5. Known open bug

**`pr-gate.mjs` counts resolved findings.** It queries `api/issues/search`
without a status filter, so the PR comment says *"32 code smells"* when 14 are
open. `fetch-findings.mjs` filters correctly, which is why remediation itself
was right.

Cosmetic in effect, but it makes a working remediation look like it did nothing —
precisely the failure mode this project exists to argue against. One-line fix:
add `&statuses=OPEN,CONFIRMED,REOPENED` to the query in `fetchAllIssues`.
Nothing tests the reporting path, which is why it survived.

## 6. Verify before you push

Three tools, each written after the failure it prevents, and each verified by
replaying that failure.

```bash
# Will this workflow fail in CI? (~1s, vs a 2-4 min round trip)
node scripts/preflight.mjs <workflow.yml> --repo <sandbox> --ref origin/demo/planted-smells \
     --gh-repo phix/sonar-sandbox-app

# Would this commit on main silently disable the demo PR's checks?
node scripts/branch-contract.mjs --repo <sandbox> --base main \
     --branch demo/planted-smells --gh-repo phix/sonar-sandbox-app --pr 2

# Does the whole pipeline still produce 18/10/4 over the real sources?
npm test
```

## 7. Three traps that will bite you

**Remediation and the scan see different filesystems.** `sonar-pr-scan` runs on
the merge ref (base merged with head); `remediate` checks out the **raw PR head**,
which is pinned at `v0-pristine` and predates everything `main` has gained. Three
separate CI failures came from this. Anything remediation needs must live on the
branch or in the `.automation` checkout. `preflight.mjs` catches it.

**A conflicting PR silently disables CI.** Edit a file on `main` that the demo
branch also owns, without making it byte-identical, and the PR goes
`CONFLICTING` → no merge ref → `pull_request` workflows do not run **at all**.
The PR shows zero checks, which is indistinguishable from no workflow being
configured. `branch-contract.mjs` catches it.

**The merge ref lags a push.** Push a workflow change to `main` and retrigger
immediately and GitHub may run the **previous** version from a cached merge ref.
Confirm the merge ref caught up before concluding anything:

```bash
git fetch origin '+refs/pull/2/merge:refs/remotes/origin/pr2merge' && \
  git show origin/pr2merge:.github/workflows/sonar-pr-scan.yml | grep -c "<your new step>"
```

## 8. Where the numbers disagree with the docs

Two headline figures moved once things actually ran, and the corrections are in
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) §4.7:

- **19/11/2 → 18/10/4.** The catalogue's `role` field records which engine
  *could* fix a finding; only the policy records whether we are *allowed* to.
  `javascript:S7765` and `javascript:S7737` sit in `api/src/auth/session.js` —
  the directory the catalogue's own `S1121` rationale names as protected. Where
  the two disagree the policy wins, or the pipeline edits security-sensitive code
  whenever a fixer happens to exist for the rule.
- **The gate was never smell-bound.** It was coverage-bound from the first run.

## 9. Next, in order

1. **`demo-reset`** — the branch is dirty; this also closes #20.
2. **Branch protection** — turns the gate from claim into fact (#15).
3. **The `pr-gate.mjs` status filter** — one line, plus the first test of the
   reporting path.
4. **The coverage decision** — until it is made, #16's green terminal state is
   unreachable and `auto_merge` can never fire.
5. **#19, the agentic path** — 10 findings wait on it, and it is the only route
   to honest coverage. Needs `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`.
6. **#17 Jira** — unblocked; `SONAR_TOKEN_READ` is in place.

## 10. What this session taught, in one line

Four of nine CI runs failed on questions that were answerable locally in under
two seconds, and 35 passing unit tests caught none of the three real bugs —
because every one of those tests used a hand-written snippet, and every bug lived
in the gap between a snippet and a real file.
