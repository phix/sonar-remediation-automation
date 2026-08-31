# Handoff — 2026-08-31 (sixth session)

Picked up from `ecfc9a3`; three of its blockers were already done. The session
became one directive — *"the LLM should be against the openllm hosted through
tinman"* — and everything that fell out of trying to make it true.

**The loop now runs end to end in CI.** Six dispatched runs, each failing
further along than the last. The final one made four real model calls over the
tailnet and reported `infraFailures: 0`.

**Everything below is verified state.** Where something is unproven it says so.

---

## 1. The headline

**`infraFailures: 0`, `rejected: 2`.** The agentic path reaches tinman from a
GitHub-hosted runner, generates, and is refused by its own quality gate:

```
javascript:S4144 api/src/reports/summary.js:20 — rejected at "testDiscriminates":
the accompanying test does not pass against the proposed fix
```

That is the gate working. The model wrote a fix and a test, the test did not
verify the fix, and nothing was committed. **The remaining problem is model
output quality, not infrastructure.**

## 2. Current state

| | |
|---|---|
| Automation `main` | streaming client + settle entrypoint + preflight, all merged & pushed |
| Sandbox branch | `llm/tinman-transport`, 7 commits, pushed, **not merged** |
| Sandbox `main` | `914356d` — untouched |
| Tests | **257** in 17 files (was 237/16) |
| Provers | `prove:gates` 4/4, `prove:templates` ok |
| preflight | clean on both workflows (`sonar-pr-scan.yml` against `main`, the merge ref it runs on) |
| Model | **`qwen2.5-coder:7b`** — pulled onto tinman this session |
| tinman | `100.102.1.50`, tailnet `tailc095b7.ts.net`, ~**5 tok/s**, fully GPU-offloaded |
| Tailscale | OAuth client + `tag:ci` in `tagOwners` — **working, proven in CI** |
| PR #2 | `OPEN`, `BLOCKED`, merge ref still stale at base `19584d7` |
| Live gate | `ERROR`, `new_coverage 5.7`, all three ratings `OK` |

## 3. The measurements that drove every decision

| | |
|---|---|
| tinman generation rate | ~5 tok/s |
| one real fix | ~1750 output tokens |
| `qwen2.5-coder:7b` | **343.6s** end to end |
| `qwen2.5-coder:14b` | did not finish inside 10 minutes |
| **undici's headers ceiling** | **300s, not configurable from this codebase** |

343 > 300 is the whole story: a **non-streaming request cannot complete at this
endpoint at any budget**. Two earlier "fixes" raised a number that does not
control the outcome.

## 4. Blocked

Nothing is blocked on Nick. Everything left is code or judgement.

## 5. Known open bugs

- **The 7b cannot write a discriminating test for `javascript:S4144`.** Both
  findings rejected at the same gate, twice each. Unknown whether this is the
  model, the prompt, or S4144 being a poor fit for the agentic path — it asks
  the model to differentiate two identical function bodies, which is a design
  question as much as a generation one.
- **`summary.tokens` reports 0** even though the client captures usage
  correctly (verified live: `prompt_tokens 1053, completion_tokens 1743`).
  Rejected results apparently do not carry usage into the summary. Cosmetic.

## 6. Verify before you push

```bash
npm test && npm run prove:gates && npm run prove:templates
```

```bash
node settle/run.mjs --project phix_sonar-sandbox-app --pr 2
```

## 7. Traps hit this session

**A step that fails can report success.** `tailscale/github-action` exhausted
five `tailscale up` attempts with `invalid key`, then reported
`outcome=success`. Two full diagnoses were built on that green — MagicDNS, then
a tailnet IP — both wrong, both shipped. `Assert the tailnet actually came up`
now exists because of it. **When a downstream step fails inexplicably, read the
upstream step's log rather than its conclusion.**

**`--branch` on a `workflow_dispatch` run.** The run is attributed to the ref it
was dispatched *from*, usually `main`, never the PR head. Look artifacts up by
name.

**CI reads `main`, not your branch.** `remediate.yml` checks the automation repo
out with no `ref:`. The deadline fix passed locally on the branch and CI ran the
old code for two runs.

**bash-isms in a zsh shell.** `read -rp` does not prompt in zsh, so a one-liner
uploaded two *empty* secrets and produced a completely different error. Cost two
rounds.

**A stream body is read once.** Test fakes returning one shared stream made the
second proposal attempt see an exhausted body and report a false persistent
failure. Fakes must hand out a fresh stream per call.

**`prove:gates` silently fell to 1/4** on the streaming change because its fake
still returned the old shape. A prover that passes on a dead path is worse than
no prover.

## 8. Next, in order

1. **Fix the rejections.** Either improve the prompt for `S4144`, try a larger
   model when time is not the constraint, or drop `S4144` from `AGENTIC_RULES`
   as a poor fit and let the deterministic path own it.
2. **Merge `llm/tinman-transport`** once a run gets to `accepted > 0`.
3. **A real (non-dry-run) run**, so the push-and-rescan half is exercised.
4. **The settle job has never run** — it triggers on `pull_request`, and nothing
   has pushed to the PR branch yet.
5. **#2's HITL half** — the Power Automate flow.
6. **Retrigger PR #2** — empty commit; the merge ref is stale.
7. Narrow the tailnet ACL: it is currently `*` -> `*`, and a GitHub runner is
   the one node on that tailnet Nick does not control.

## 9. What this session taught, in one line

Every wrong turn came from trusting a green that was not earned — a step that
reported success after failing, a budget that was never the binding constraint,
a local pass against code CI would never load — and every correction came from
measuring the thing itself.
