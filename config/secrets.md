# Secrets and configuration

Where every credential lives, and why it lives there. **No secret values appear in this repo — this file names them, it does not hold them.**

## The rule

| | |
|---|---|
| **Non-secret config** | committed here and in `docs/` — site URLs, project keys, org ids, repo names |
| **Secrets** | macOS Keychain locally, GitHub Actions encrypted secrets in CI. Never in a file, never in chat, never in a commit |

`.env` is gitignored and supported as a fallback, but the Keychain is preferred — a plaintext token on disk is one careless `cat` or screen-share away from being disclosed.

## Known config (safe, no secret content)

| Key | Value |
|---|---|
| `JIRA_BASE_URL` | `https://1337software.atlassian.net` |
| `JIRA_PROJECT_KEY` | `SONAR` |
| Jira cloud id | `8cda2610-e1e4-4253-ab1f-066e94b3ae51` |
| Jira project statuses | To Do · In Progress · In Review · Done |
| `SONAR_ORG` | `phix` (SonarQube Cloud, Nick is Admin, single org) |
| Atlassian login | `1337.geek@gmail.com` — **not** the hotmail address; confirmed 2026-08-29 |
| `SONAR_PROJECT_KEY` | expected `phix_sonar-sandbox-app` — **not yet real**, created when the sandbox repo is imported (issue #10) |
| Automation repo | `phix/sonar-remediation-automation` |
| Sandbox repo | `phix/sonar-sandbox-app` (not yet created — issue #7) |

**Do not confuse the two Atlassian sites.** `phix.atlassian.net` also exists (cloud id `fed0936f-…`) and is *not* the one to use. Pointing at it returns an empty project list rather than an error.

## The secrets

| Name | Source | Used by |
|---|---|---|
| `JIRA_USER_EMAIL` | `1337.geek@gmail.com` | Jira Basic auth. Half the credential, so it lives in secrets — though it is already public in this repo's commit authorship, so the token is what actually protects the account |
| `JIRA_API_TOKEN` | [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) — **classic, unscoped** | plan + retry workflows |
| `SONAR_TOKEN` | SonarQube Cloud → My Account → Security | the scan action |
| `SONAR_TOKEN_READ` | as above, separate token | recon (least privilege, spec §18.2) |
| `TEAMS_WEBHOOK_URL` | Power Automate Workflows (issue #2) | every workflow's status gate |
| `SANDBOX_REPO_TOKEN` | fine-grained PAT or GitHub App (issue #7) | cross-repo branch + PR |

**Two Sonar tokens, deliberately.** The scanner must submit analysis; recon only reads issues. One token doing both is a privilege the recon job never needs, and the verification script probes whether the read token is genuinely read-only.

## Local use

```bash
./scripts/secrets.sh set jira-api-token     # prompts silently, stores in Keychain
./scripts/secrets.sh list                   # shows which are set — never values
```

Scripts load them automatically: Keychain first, then `.env`, with anything already exported winning over both. So this just works:

```bash
./scripts/verify-api-contracts.sh
```

To load them into a shell manually — note this puts secrets in your environment, so don't do it in a recorded terminal:

```bash
eval "$(./scripts/secrets.sh export)"
```

## CI use

GitHub Actions encrypted secrets on `phix/sonar-remediation-automation`:

Bulk-sync everything already exported in your shell:

```bash
./scripts/sync-secrets.sh                # add --keychain to mirror locally too
./scripts/sync-secrets.sh --dry-run      # see what would happen first
```

Values are piped to `gh` on **stdin** — never in argv (which `ps` can read), never in shell history, never echoed. Only names and character counts print. Anything unset is skipped rather than blanked, so a partial run is safe and re-runnable.

Or one at a time — `gh` prompts and reads the value itself:

```bash
gh secret set JIRA_API_TOKEN --repo phix/sonar-remediation-automation
```

Verified 2026-08-29 that the current `gh` token can set and delete both secrets and variables on this repo.

`gh secret set` reads from stdin or prompts, so the value never enters your shell history. Set them once; they are write-only afterwards — GitHub will not show them back, which is why the Keychain copy matters for local runs.

## What is not obtainable yet

Three of these cannot exist until earlier tickets land. They are gated, not forgotten — `sync-secrets.sh` skips anything unset, so re-run it as each becomes available.

| Secret | Blocked on |
|---|---|
| `TEAMS_WEBHOOK_URL` | issue #2 — the Power Automate flow does not exist yet |
| `SONAR_PROJECT_KEY` | issue #10 — no SonarCloud project until the sandbox repo is imported |
| `SANDBOX_REPO_TOKEN` | issue #7 — the sandbox repo does not exist yet |

The **agentic fix endpoint** is only needed once the fix engine reaches a finding no codemod can handle. It is **Ollama on `tinman`**, reached through a single swappable seam — nothing here is bound to a model vendor, which matters for the handoff because the office will have its own approved endpoint. Confirmed OpenAI-compatible (`POST {base}/chat/completions`), so the client needs no change; see `docs/decisions/llm-endpoint-transport.md`.

| Name | Secret? | Purpose |
|---|---|---|
| `LLM_BASE_URL` | no — config | `http://tinman:11434/v1` |
| `LLM_API_KEY` | no — **placeholder** | Ollama ignores bearer auth. Any non-empty string. See below. |
| `LLM_MODEL` | no — config | `qwen2.5-coder:7b` — 14b is too slow on tinman (~5 tok/s); see the decision record |

`LLM_API_KEY` was previously listed here as a secret. It is not one, and leaving it that way sends whoever picks this up hunting for a credential that was never issued. It is required only because `configFromEnv` refuses to run with any of the three unset — a guard kept deliberately, because the office endpoint that replaces tinman **will** need a real key, and a guard that first appears then is too late.

`tinman` is LAN/tailnet-only (`192.168.1.217`), so GitHub-hosted runners cannot reach it by default. `remediate.yml` joins the tailnet in-job, which needs two secrets **on the sandbox repository**:

| Name | Secret? | Purpose |
|---|---|---|
| `TS_OAUTH_CLIENT_ID` | yes | tailnet OAuth client, `auth_keys` scope |
| `TS_OAUTH_SECRET` | yes | its secret |

Both are issued from the Tailscale admin console and must carry an ACL tag (e.g. `tag:ci`) that is permitted to reach tinman:11434.

This supersedes the `ANTHROPIC_API_KEY` the original spec assumed.

## Rotation and hygiene

- Rotating means reissuing at source, then updating **both** stores. `./scripts/secrets.sh list` and `gh secret list` show what exists in each; neither shows values.
- Workflows must never `echo` a secret. GitHub masks known secret values in logs, but only ones it knows — a token assembled or derived at runtime is not masked.
- Both repos are public. Nothing secret may be committed, printed in a workflow log, or included in an artifact. Artifacts on a public repo are downloadable by anyone.
