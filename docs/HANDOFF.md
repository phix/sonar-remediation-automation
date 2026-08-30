# Handoff — 2026-08-30 (third session)

Picked up from the handoff at `c6b3b00`. Its top three items were all mutating
calls the auto-mode classifier refused, so the session went to the one item that
needed neither a push nor a credential — finishing #17 — and that turned out to
be where the real findings were.

Everything below is **verified state**, not intention. Where something is
unproven it says so in the sentence that claims it.

**Nothing is pushed.** Both repos have local commits and no push was possible.
That is the first thing to fix and it gates several rows below.

---

## 1. The headline

**The Jira step is built, and the thing that makes it correct is the order it
asks questions in.** Jira's JQL index is ~2s behind its own writes, so a
search-first dedupe creates the duplicate it exists to prevent. Plan first,
direct `GET` on that key second, lagging index only for groups the plan never
knew. All four suites were mutation-checked before being believed.

Second, and cheaper: **two things the last handoff called blocked were not.**
The Sonar write-back permission is answerable read-only, and §4d was moot.

## 2. Current state

| | |
|---|---|
| Automation repo | `phix/sonar-remediation-automation`, tree clean, **6 commits unpushed** — last content commit `e953e38`, plus this handoff. A handoff cannot pin its own SHA: amending to record it changes it. Count the commits, do not trust a SHA here. |
| Sandbox repo | `phix/sonar-sandbox-app` @ `914356d` (main), **1 commit unpushed**, tree clean |
| Remote automation `main` | still `05c90cd` |
| Remote sandbox `main` | still `a9ff570` |
| Demo branch | `demo/planted-smells` @ `243e9d2` = `v0-pristine^{}` — untouched this session |
| PR #2 | `OPEN`, `MERGEABLE`, `BLOCKED` — unchanged |
| `refs/pull/2/merge` | `498fe766`, base `19584d7` — **stale, two commits behind main** |
| Branch protection | `contexts: ["gate"]`, `enforce_admins: false` — unchanged |
| Tests (automation) | **153** (was 96) |
| Tests (sandbox scripts) | 9 |
| Provers | `prove:gates` 4/4, `prove:templates` ok |
| Ratio | still 18 codemod / 10 agentic / 4 refused, over the real fixtures |
| Grouping | 32 findings → **16 tickets**, measured, matches the README |
| Jira secrets | on the **automation** repo, absent from the **sandbox** — see §3 |
| LLM endpoint | still unconfigured |

**Unproven, carried forward:** the two-axis gate comment has still never run on
the live PR. Unchanged from the last handoff, and §4a explains why it now needs
more than a rerun.

## 3. What changed this session

- **`jira/client.mjs`** — v2, three calls, bounded and classified. Refuses to
  speak to the removed `/search` endpoint and names 410 when it sees one.
  Follows the `nextPageToken` cursor to exhaustion and synthesises no `total`,
  because the new endpoint does not return one.
- **`jira/dedupe.mjs`** — the ordering above. `jqlFor` excludes
  `statusCategory != Done`, and "open" is asked via `statusCategory.key`, never
  the status name, so it ports to a Jira with different status names.
- **`jira/plan.mjs`** — reads the plan, tolerates its absence, appends items
  that satisfy every required field of the schema. **Refuses a corrupt plan**
  rather than treating it as empty, which would recreate every ticket it held.
- **`jira/writeback.mjs`** — comments the Jira key onto each Sonar finding.
  Reports "this token may not comment" as a permission answer distinct from an
  outage, and stops after the first 403 instead of re-asking per finding.
- **`jira/run.mjs`** — the orchestrator. Off is silent and green; on-but-
  unconfigured is red, because those are opposite situations.
- **`codemods/fetch-findings.mjs`** — keeps Sonar's issue `key`. It was dropped
  during normalisation, which made the write-back not merely untested but
  unbuildable: there was no address to write to.
- **`codemods/remediate.mjs`** — `dispositionSummary()` and `--dispositions`.
- **`scripts/verify-api-contracts.sh`** — probes each token's `actions` array.
- **`scripts/setup-jira.sh`** — now pushes to the sandbox, not the automation repo.
- **`docs/decisions/jira-dedupe-order.md`** — the ordering, and what it rejected.
- **`remediate.yml`** (sandbox) — the `jira` input, defaulting false.

## 4. Blocked

**Every mutating call this session was refused by the auto-mode classifier** —
`git push`, `gh api -X POST`, and reading the Keychain. None was worked around.
All of §4 needs a permission rule or Nick's hands.

**a. Push both repos.** This gates everything else, and it changed shape: the
demo PR's checkout uses `refs/pull/2/merge`, which is pinned at base `19584d7`
and does not carry `a9ff570`. So a rerun would exercise the *old* pr-gate. Only
a `synchronize` event recomputes the merge ref.

```bash
git -C ~/Documents/SonarScanGenesis push origin main && git -C ~/Documents/sonar-sandbox-app push origin main
```

```bash
git -C ~/Documents/sonar-sandbox-app commit --allow-empty -m "Retrigger the scan" && git -C ~/Documents/sonar-sandbox-app push origin demo/planted-smells
```

That second command moves the demo branch off `v0-pristine^{}`. The reset path
puts it back; it is a cost, not a surprise.

**b. Put the Jira secrets where they are read.** They are on the automation
repo, where no workflow reads them, and absent from the sandbox, where the only
workflow that touches `JIRA_*` runs. The script is fixed; it has not been run.

```bash
./scripts/setup-jira.sh
```

**c. `enforce_admins`, still #15's last open box.** Unchanged.

```bash
gh api -X POST repos/phix/sonar-sandbox-app/branches/main/protection/enforce_admins
```

**d. `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` unset.** Unchanged. #19's
first validation box cannot be ticked and the library has never made a real call.

**e. #17's live validation boxes** need (b) done first. Nothing else blocks them.

## 5. Known open bugs

One found and fixed this session, worth knowing because of what it looked like:
`dispositionsFrom` counted only `changed` as resolved, while `apply.mjs`'s own
`summarize()` defines `resolved = fixed + alreadyGone` and says why in a
comment. A group whose findings were *all* cleared as side effects would get a
ticket silent about work already done. Found reviewing my own code an hour after
writing it; the test fails when the condition is put back.

None open.

## 6. Verify before you push

```bash
# Whole automation suite, including the four new Jira suites. (~0.4s)
npm test
```

```bash
# Are the agentic gates still real, against a real build and a real vitest? (~2s)
npm run prove:gates
```

```bash
# Would the workflow's scripts and secrets actually be there in CI? This is
# what caught the wrong-repo secrets. (~2s)
node scripts/preflight.mjs ~/Documents/sonar-sandbox-app/.github/workflows/remediate.yml \
  --repo ~/Documents/sonar-sandbox-app --ref demo/planted-smells --gh-repo phix/sonar-sandbox-app
```

```bash
# Would this commit on main silently disable the demo PR's checks? (~2s)
node scripts/branch-contract.mjs --repo ~/Documents/sonar-sandbox-app --base main \
  --branch demo/planted-smells --gh-repo phix/sonar-sandbox-app --pr 2
```

## 7. Traps hit this session

**Four new suites passed on their first run, which is the shape §7 of the last
handoff warned about.** Seventy tests, green immediately, proving nothing yet.
Six deliberate mutations were applied one at a time — trusting a closed ticket,
batching the plan write, switching to v3, re-asking after a 403, downgrading
unconfigured to a skip, keying dispositions on the rule alone — and each turned
**exactly one** intended test red, with a clean restore. A suite that has never
been watched to fail is a suite that has not been checked.

**Absence of a field was read as absence of a permission.** The last handoff
called the Sonar write-back permission "genuinely unknown rather than merely
untested" because `api/issues/search` returned no `actions` field. It returns
none *unless `additionalFields` asks for it*. The API was answering a question
it had not been asked, and the silence was read as a "no".

**Writing the workflow is what found the bug in the credentials.** The Jira
secrets had been on the wrong repo for a day. Nothing surfaces that until the
step runs, and when it does it says "not configured" — the same sentence a real
credential problem produces. `preflight.mjs` reported it in two seconds, on a
workflow that had existed for ninety.

## 8. Where the numbers disagree with the docs

- **§4b of the last handoff is superseded.** The write-back permission needs no
  mutating call. `additionalFields=_all` returns `actions`; anonymous gives `[]`,
  which is the control proving the array reflects the caller. Recorded in
  `api-contracts.md` §2 and probed by `verify-api-contracts.sh`.
- **§4d of the last handoff is moot, not unverified.** Its worry was that the
  automation repo's `SANDBOX_REPO_TOKEN` might be the bad value. That repo's
  only workflow uses **no secrets at all**, so the copy is read by nothing.
- **The README's status line was wrong** and is corrected. It claimed no
  workflow was wired to PR #2; `sonar-pr-scan` has been a required check
  blocking it since 2026-08-29.
- **`remediate.yml` already existed.** The last handoff's §9.4 implied the
  workflow half of #17 was unbuilt. The workflow was there; the `jira` input
  was not.
- **Tests: 96 → 153.** Grouping over the real fixture: 32 findings → 16 tickets,
  which matches the README's figure independently.

## 9. Next, in order

1. **Push both repos** (§4a) — five commits and one commit are stranded, and
   every row below depends on them.
2. **Retrigger the scan on PR #2** (§4a, second command) — the merge ref is
   stale, so this needs the empty commit, not a rerun.
3. **Run `setup-jira.sh`** (§4b) — one command, and it unblocks every live
   validation box on #17.
4. **Tick #17's boxes against the live Jira** — the code is done and unit-proven;
   what is missing is one real run with `jira: true` and then a second one
   proving no duplicate.
5. **`enforce_admins`** (§4c) — one command each way, and it closes #15.
6. **#19's live endpoint** (§4d) — code-complete, has never made a real call.
7. **Re-word #19's third validation box** to the gate that was actually built.

## 10. What this session taught, in one line

Two of the three things the last handoff called blocked were not blocked at all
— one needed a query parameter and the other needed someone to check whether
anything read the secret — so "blocked" is a claim like any other and deserves
the same two seconds of checking as the numbers in the table.
