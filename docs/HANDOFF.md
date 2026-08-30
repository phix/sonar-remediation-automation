# Handoff — 2026-08-30 (fourth session)

Picked up from `6a0cdab`. Its §9 list was almost entirely permission-gated, so
this session did the one thing that list could not: **it wrote code.** Four
slices landed via parallel TDD engineers in isolated worktrees, and the most
valuable thing any of them produced was not a feature — it was an API probe that
falsified an assumption already merged into `settle/classify.mjs`.

Everything below is **verified state**, not intention. Where something is
unproven it says so in the sentence that claims it.

**Nothing is pushed since the mid-session push.** 10 commits are local.

---

## 1. The headline

**The settle half of the loop exists.** `settle/` decides the terminal state and
optionally enables native auto-merge; `teams/` renders and delivers the one
message; `scripts/verify-reset.mjs` asserts a reset actually restored what it
claims. All unit-proven, none run in CI.

**The thing worth reading twice:** `api/ce/component` — the endpoint that says
whether an analysis completed — **has no `pullRequest` parameter and silently
ignores one.** It returns the component's newest task whatever ref that belongs
to, so another branch's `SUCCESS` can stand in for this PR's. That would have
defeated the precondition which exists to stop a stale gate being trusted.
Found by probing, not by reading. See `docs/decisions/scan-status-scoping.md`.

## 2. Current state

| | |
|---|---|
| Automation repo | `phix/sonar-remediation-automation`, tree clean, **10 commits unpushed**, last `6e9ecea` |
| Remote automation `main` | `c81e0a8` (pushed mid-session by Nick) |
| Sandbox repo | `phix/sonar-sandbox-app` @ `914356d`, clean, **0 unpushed** |
| Remote sandbox `main` | `914356d` |
| Demo branch | `demo/planted-smells` @ `243e9d2` = `v0-pristine` — untouched |
| `v0-clean` | `1a3f005`. **Main is ahead of it** (`914356d`) — benign, see §5 |
| PR #2 | `OPEN`. Required context is `gate`; six `gate` check-runs on the head, all `failure`. Correctly blocking. |
| `refs/pull/2/merge` | base still `19584d7` — **stale**, unchanged |
| Branch protection | `contexts: ["gate"]`, `strict: false`, `enforce_admins: false` |
| Tests | **237** in 16 files (was 153 in 9) |
| Provers | `prove:gates` 4/4, `prove:templates` ok |
| Ratio | still 18 codemod / 10 agentic / 4 refused |
| Jira secrets | still on **automation**, still absent from the **sandbox** |
| Teams webhook | `TEAMS_WEBHOOK_URL` does not exist on either repo |
| LLM endpoint | still unconfigured |

**Unproven, carried forward:** nothing built this session has run in CI. The
two-axis gate comment still has never run on the live PR.

## 3. What changed this session

- **`settle/classify.mjs`** — two states, `ready` and `red`, and no third. An
  unanticipated input shape returns red-undetermined rather than throwing or
  falling through to green. Names the *failing condition* — the live gate is
  coverage-bound with all three ratings at A, so a reason saying "code smells"
  there would be actively wrong.
- **`settle/automerge.mjs`** — enables GitHub's **native** auto-merge only. No
  function in the file can reach a merge mutation, so branch protection stays
  the decision-maker even if a caller is wrong.
- **`settle/gate.mjs`** — bounded fetchers for the gate and the scan status,
  with the cross-check described in §1.
- **`teams/{card,client,notify}.mjs`** — Adaptive Card for Power Automate,
  bounded client that never retries a 4xx, and the off/unconfigured/on tri-state.
- **`scripts/verify-reset.mjs`** — the two boxes `demo-reset.yml` leaves unmet:
  PR #2's number unchanged and still open, and a second run from an already-clean
  state passing rather than erroring.
- **`vitest.config.mjs`** — new. Excludes `.claude/worktrees/**`. See §7.
- **`docs/decisions/scan-status-scoping.md`** — new.
- **`~/.claude/RTK.md` + rtk config** — defect 8 recorded, `vitest` excluded.

## 4. Blocked

Both were refused by the auto-mode classifier this session and need Nick's hands.

**a. `enforce_admins` — #15's last open box.**

```bash
gh api -X POST repos/phix/sonar-sandbox-app/branches/main/protection/enforce_admins
```

**b. Jira secrets are still on the wrong repo.** `remediate.yml` runs on the
sandbox and a workflow reads secrets only from its own repository. The script is
interactive (hidden token prompt) and the only other source is the Keychain,
which the classifier blocks.

```bash
./scripts/setup-jira.sh
```

**c. `TEAMS_WEBHOOK_URL` does not exist.** The library is built; #2's HITL steps
— create the Power Automate flow, confirm a personal Microsoft account can — have
never been done. The library half being finished changes nothing about that risk.

**d. `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` unset.** Unchanged.

**e. Reading `node scripts/verify-reset.mjs` was itself blocked.** A read-only
script, refused twice. Its logic was verified by importing it in-process with the
live SHAs injected, which is weaker than one real run. If one permission is worth
adding, it is this one.

## 5. Known open bugs

None open. One found and fixed, worth knowing because of how it was found:

`verify-reset.mjs` asserted `main === v0-clean`. Live, `main` is `914356d` and
`v0-clean` is `1a3f005` — main advanced with ordinary tooling commits, which
`demo-reset.yml` explicitly calls normal and quietly advances the tag for. So the
verifier failed a healthy repository, and its message could not distinguish that
from "main contains `v0-pristine`, PR #2 was merged, the baseline is dead". It
now reproduces the workflow's three-way split. **The unit tests were green
throughout; only running it against the real repository found this.**

## 6. Verify before you push

```bash
npm test
```

```bash
npm run prove:gates && npm run prove:templates
```

```bash
curl -s "https://sonarcloud.io/api/qualitygates/project_status?projectKey=phix_sonar-sandbox-app&pullRequest=2"
```

That last one is the cheapest proof the settle stage is reading reality: it must
report `ERROR` with `new_coverage 5.7` and all three ratings `OK`. Drop
`&pullRequest=2` and it answers `{"status":"NONE","conditions":[]}` — not an
error, a different question answered politely.

## 7. Traps hit this session

**A green suite counted 426 tests when the true number was 177.** The subagent
harness materialises worktrees at `.claude/worktrees/agent-*` *inside* the repo,
and vitest walked into them, counting stale copies of every suite — one from a
checkout eight commits behind. Nothing was red. The number was wrong in the
direction nobody checks.

**rtk hid it.** `npx vitest run` was rewritten to `rtk vitest`, which collapses
the report to `PASS (n) FAIL (n)` — dropping the *file* count, which is the one
number that would have shown 25 files where 11 were expected. Worse, `npx vitest
list --filesOnly` — which lists files and runs nothing — returned `PASS (0) FAIL
(0)`. Recorded as RTK defect 8; both spellings excluded and verified across eight
invocations. **The lesson is about what a wrapper drops, not what it corrupts: a
summariser that discards the denominator turns a wrong number into an
unfalsifiable one.**

**Four suites passed on their first run again**, the same shape §7 has warned
about twice. Every engineer was required to apply five deliberate mutations and
show each turned tests red. Nineteen mutations across four slices, zero holes.
Two engineers reported a mutation catching *more* tests than intended and
correctly declined to narrow the fixture to make the table look tidier.

**Two agents ignored the worktree path they were given** and worked in their own
harness worktree instead, one landing on a branch nobody asked for
(`slice/teams-lib`). Both said so plainly, which is the only reason it cost
nothing. Check `git worktree list` and the branch a slice actually landed on
before merging it.

## 8. Where the numbers disagree with the docs

- **The README claimed `sonar-pr-scan` is the required check.** The required
  *context* is `gate` — the job's name, not the workflow's. Six `gate` check-runs
  sit on the head commit, all failing, so the block is real. Wording only.
- **`classify.mjs`'s documented input contract was half wrong.** The gate shape
  was right; the scan shape assumed a per-ref scoping that does not exist. The
  fetcher was built to compensate rather than the contract loosened.
- **Tests: 153 → 237.** Files 9 → 16.
- **`v0-clean` is not `main`.** It was `03c5384` in an older ticket and is now
  `1a3f005`, because `demo-reset.yml` advances it. Do not treat the SHAs written
  into issue #20 as current.

## 9. Next, in order

1. **Push** — 10 commits stranded.
2. **`enforce_admins`** (§4a) — one command, closes #15.
3. **`setup-jira.sh`** (§4b) — unblocks every live box on #17.
4. **Wire `settle/` and `teams/` into `remediate.yml`.** They are libraries with
   npm scripts and nothing calls them. Run `scripts/preflight.mjs` against the
   edited workflow *before* trusting it — that is what caught the wrong-repo
   secrets last session, in two seconds, on a workflow that had existed for ninety.
5. **#2's HITL half** — prove a personal Microsoft account can create the Power
   Automate flow, or pick the fallback. Deliberately ticket one; still undone.
6. **Retrigger PR #2** — the merge ref is still stale at base `19584d7`, so this
   needs an empty commit on the branch, not a rerun.
7. **#19's live endpoint** — code-complete, has never made a real call.

## 10. What this session taught, in one line

Every real defect this session was found by running something against reality —
the live Sonar API, the live repository, the actual file count — and every one of
them sat underneath a green test suite that had no way to know it was wrong.
