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
| Automation repo | `phix/sonar-remediation-automation` |
| Sandbox repo | `phix/sonar-sandbox-app` (not yet created — issue #7) |

**Do not confuse the two Atlassian sites.** `phix.atlassian.net` also exists (cloud id `fed0936f-…`) and is *not* the one to use. Pointing at it returns an empty project list rather than an error.

## The secrets

| Name | Source | Used by |
|---|---|---|
| `JIRA_USER_EMAIL` | the Atlassian login for the 1337software site | Jira Basic auth (it is half the credential — treat it as secret) |
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

## Rotation and hygiene

- Rotating means reissuing at source, then updating **both** stores. `./scripts/secrets.sh list` and `gh secret list` show what exists in each; neither shows values.
- Workflows must never `echo` a secret. GitHub masks known secret values in logs, but only ones it knows — a token assembled or derived at runtime is not masked.
- Both repos are public. Nothing secret may be committed, printed in a workflow log, or included in an artifact. Artifacts on a public repo are downloadable by anyone.
