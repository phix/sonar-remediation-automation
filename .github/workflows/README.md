# Workflows — demo in one glance

The demo's workflows live on the **sandbox repo**
([`phix/sonar-sandbox-app`](https://github.com/phix/sonar-sandbox-app/tree/main/.github/workflows));
this repo only carries [`sandbox-build.yml`](sandbox-build.yml) (re-proves the
CI container contract on demand). Full step-by-step with rationale:
[repo README](../../README.md).

## The demo, precisely

| # | Action | Workflow | Result |
|---|--------|----------|--------|
| 1 | Reset the sandbox | `demo-reset.yml` (manual) | Baseline restored: 32 planted findings, 0 bot commits |
| 2 | Open the demo PR | `demo-create-pr.yml` (manual) | PR opened against `main` |
| 3 | Scan | `sonar-pr-scan.yml` (auto, on PR) | 32 findings, 16 groups; required check `gate` goes **red** (new-code coverage) |
| 4 | Remediate | `remediate.yml` (auto) | Policy refuses 4 → codemods fix 18 → LLM fixes the eligible rest (≤2 attempts); 1 test per fix; bot commit pushed |
| 5 | Re-scan | `sonar-pr-scan.yml` (auto, on push; capped at 2 bot commits) | Gate re-read with fixes applied |
| 6 | Settle | `settle` job in `sonar-pr-scan.yml` | `ready` → **merges automatically**; `red` → merge stays blocked, reason named |
| 7 | Notify | "Tell Telegram" step, same job | ONE Telegram message: "ready" or "red because ⟨reason⟩" |
| 8 | Reset | `demo-reset.yml` | Back to step 1 — the demo is a loop |

Human input: two button clicks (1 and 2). Everything else is automatic.
