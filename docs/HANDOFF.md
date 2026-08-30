# Handoff — 2026-08-30 (second session)

Picked up from the handoff at `cc1017d`, found its top three items already done,
and spent the session on what they unblocked: the agentic path, the coverage
decision, and the half of Jira that needed no credential.

Everything below is **verified state**, not intention. Where something is
unproven it says so in the sentence that claims it.

---

## 1. The headline

**The only stage in this pipeline that is not deterministic now has gates that
are, and they are proven against a real build and a real vitest rather than a
stub.** `prove-gates.mjs` runs four scenarios; the one that matters is a correct
fix accompanied by a test that never calls the function it fixed. It is
rejected, by the runner, on disk, in 714ms.

Second, smaller: **the gate question is settled without touching the gate.**

## 2. Current state

| | |
|---|---|
| Automation repo | `phix/sonar-remediation-automation` @ `05c90cd`, pushed, tree clean |
| Sandbox repo | `phix/sonar-sandbox-app` @ `a9ff570` (main), pushed, tree clean |
| Demo branch | `demo/planted-smells` @ `243e9d2` = `v0-pristine^{}` — **clean, reset already ran** |
| PR #2 | `OPEN`, `MERGEABLE`, **`BLOCKED`** — the required `gate` check fails and now actually blocks |
| Branch protection | `contexts: ["gate"]`, `enforce_admins: false` |
| Findings | 32 reported on the pristine baseline, counted correctly |
| Ratio | 18 codemod / 10 agentic / 4 refused by policy |
| Agentic routing | `run.mjs` over the real fixtures reports exactly **10** with no deterministic fixer |
| Tests | **96** in the automation repo (was 50), **9** in the sandbox's script tests |
| Provers | `prove:gates` 4/4, `prove:templates` unchanged |
| Gate verdict | red on `new_coverage` **5.7 < 80**; all three ratings **A** |
| LLM endpoint | **not configured** — `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` all unset |

**Unproven:** the new two-axis gate comment has **never run on the live PR**.
The last `sonar-pr-scan` was 20:41 UTC; `a9ff570` was pushed at 21:07 UTC, and a
push to `main` does not retrigger a `pull_request` workflow. Its wording is
proven only by unit tests. See §9 item 1.

## 3. What changed this session

- **`codemods/agentic/`** — the whole path. `scope.mjs` refuses a finding a
  codemod could have fixed and raises a named alarm instead of serving it
  quietly. `client.mjs` cannot hang: connect and response deadlines are
  genuinely separate, retries are capped, and every exit carries a spec §14
  class. `validate.mjs` holds the gates. `agent.mjs` runs them in order and
  feeds a rejection back into the retry, per spec §15.
- **The discrimination gate** — the accompanying test is re-run against a copy
  of the model's own fix with the changed function stubbed to `return
  undefined`. If it still passes, it never exercised the fix, and the proposal
  is rejected.
- **`prove-gates.mjs`** — scaffolds a real project, real `npm run build`, real
  `vitest`, and drives real `fixOne` with only the model faked.
- **`codemods/sonar-rules.mjs`** — rule metadata, shared by the agentic prompt
  and the Jira body. Degrades to the finding's message plus the public rule link
  when unauthenticated.
- **`docs/decisions/coverage-and-the-gate.md`** — records the decision below and
  the option that was refused.
- **`pr-gate.mjs` two-axis reporting** (sandbox) — the comment now names which
  conditions remediation governs, and when only coverage fails it says outright
  that fixing every remaining finding would leave the gate exactly as it is.
- **`jira/group.mjs`, `jira/body.mjs`** — grouping, the label-safe fingerprint,
  and the `renderBody()` seam.
- **Two retry caps, deliberately separate.** `client.mjs` retries transport;
  `agent.mjs` retries proposals. Conflating them lets a flaky network burn the
  budget a bad model deserved, and reports the wrong failure class on exhaustion.

## 4. Blocked

**Two mutating calls were refused by the auto-mode classifier.** Neither was
worked around. Both need a permission rule or Nick's hands.

**a. `enforce_admins`, still #15's last open box.** Until this runs, "the merge
is gated even for Nick" is a claim. Run it, confirm the merge is refused, then
restore:

```bash
gh api -X POST repos/phix/sonar-sandbox-app/branches/main/protection/enforce_admins
```

```bash
gh api -X DELETE repos/phix/sonar-sandbox-app/branches/main/protection/enforce_admins
```

**b. Whether the Sonar token may comment on a finding** — #17's write-back step.
`api/issues/search` returns no `actions` field for this token, so this is
genuinely unknown rather than merely untested. One mutating call answers it:

```bash
curl -s -u "$SONAR_TOKEN:" -X POST "https://sonarcloud.io/api/issues/add_comment" -d "issue=AaBUHTIMZAs_M-b0fH6Z" -d "text=test"
```

**c. `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` are unset,** so #19's first
validation box — paste a successful `chat/completions` round trip — cannot be
ticked, and the library has never spoken to a real endpoint. Unconfigured it
exits **red with a stated reason**, which is the designed behaviour, not a
silent skip.

**d. The automation repo's `SANDBOX_REPO_TOKEN` may still be the bad value.**
Carried forward unverified from the last handoff and still unverified: the
sandbox copy was replaced at 18:31, the automation copy is untouched at 17:27.

## 5. Known open bugs

None found this session. One accidental inclusion worth knowing: **`git add -A`
swept `.claude/commands/{handoff,pickup}.md` into `cc914eb`.** Committing the
project's own slash commands is defensible and they are staying, but it was the
glob's decision rather than anyone's.

## 6. Verify before you push

```bash
# Does the whole pipeline still route 18/10/4 over the real sources? (~0.3s)
npm test
```

```bash
# Are the agentic gates still real, against a real build and a real vitest? (~2s)
npm run prove:gates
```

```bash
# Would this commit on main silently disable the demo PR's checks? (~2s)
node scripts/branch-contract.mjs --repo ~/Documents/sonar-sandbox-app --base main \
  --branch demo/planted-smells --gh-repo phix/sonar-sandbox-app --pr 2
```

```bash
# Does the reporting path still say the right thing? (sandbox repo, ~0.1s)
npm run test:scripts
```

## 7. Traps hit this session

**A prover can pass for the wrong reason.** `prove-gates.mjs`'s first run
reported 3 failures and 1 PASS — and the PASS was worthless, because all four
scenarios were dying at the same unrelated error (`testPathFor` returns null
outside `api/` and `web/`, and the fixture used neither). The right verdict
reached by the wrong cause. It now asserts the *reason* as well as the gate,
which is the check that catches this next time.

**A per-run value hoisted onto a shared context is invisible.** `runAgentic`
briefly took `source` off the shared ctx, so every finding after the first was
sent a different file's contents. The symptom is the worst kind: the model
answers coherently about the wrong file, so it reads as the model being bad
rather than the caller being wrong. There is now a test that asserts each
finding's own source reaches its own prompt.

## 8. Where the numbers disagree with the docs

- **#17 is not blocked on rule text, and never was after `SONAR_TOKEN_READ`.**
  The issue records `descriptionSections` as empty and flags `requiredEntitlements`
  as a hint it may be plan-gated. Measured 2026-08-30 with the analysis token:
  `javascript:S3776` returns **9376 chars** of `htmlDesc` and four sections
  (`how_to_fix` 6517). It is not plan-gated, only **not anonymous**. Where the
  issue and this disagree, this wins — it was measured against the live API.
- **#19's "the test must fail against the unfixed code" is unachievable as
  written,** for all three rules in its own scope table. S3776, S4144 and S3358
  are behaviour-preserving refactorings; the unfixed code is correct, which is
  what makes it a smell. A test failing against it would be asserting the smell
  and would have to be deleted by the fix it was written to guard.
  `prove-templates.mjs` reached this wall first, so the house answer is reused
  and the box should be re-worded rather than ticked.
- **The gate was never smell-bound** — carried forward and re-confirmed. All
  three ratings are A at 32 findings.

## 9. Next, in order

1. **Retrigger the scan on PR #2** so the two-axis comment is observed rather
   than assumed — `git commit --allow-empty` on the demo branch, or re-run the
   workflow. This is the only unproven claim in §2.
2. **`enforce_admins`** (§4a) — one command each way, and it closes #15.
3. **Answer the write-back question** (§4b) — one command, and it unblocks the
   last unbuilt part of #17.
4. **Finish #17** — the v2 client, dedupe (plan JSON first, JQL as backstop; the
   index lags a write by ~2s), and the write-back.
5. **#19's live endpoint** — the library is code-complete and has never made a
   real call.
6. **Re-word #19's third validation box** to the gate that was actually built.

## 10. What this session taught, in one line

The prover written to stop a gate being decoration was itself decoration on its
first run — it reported a PASS while every scenario was dying of the same
unrelated cause — so a check that only asserts the verdict, and not the reason
for it, is not yet a check.
