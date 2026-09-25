# portable/ — the remediation loop as a template

This directory is the part of the pipeline that has nothing to do with this
sandbox: **policy first, deterministic codemods second, a bounded model call
last, and the verdict on the pull request.** It has no network, no git, no CI and
no sandbox in it, so it can be copied into another environment and pointed at a
different scanner, tracker and model gateway by editing one JSON file.

It exists because the demo engine is welded to this repo — GitHub Actions, the
planted catalogue, `jscodeshift` fixers for its specific smells. The ordering and
the governance are the reusable part; this is that part on its own.

## Run it

```bash
node portable/cli.mjs plan --config portable/config/example.json          # fixture, no credentials
node portable/cli.mjs plan --config <cfg> --out plan.json                 # machine-readable plan
node portable/cli.mjs comment --plan plan.json                            # the PR comment
node portable/cli.mjs plan --config <cfg> --sonar-live --pull-request 42  # live, needs SONAR_TOKEN
```

Nothing here fixes, commits or pushes. That is deliberate: `plan` is the artifact
an environment with no credentials, no egress approval and no change record can
still produce, and it is the same code that runs once those arrive.

## What the config controls

| Key | What an adopting environment changes |
|---|---|
| `policyVersion` | Bump it when you change the policy. A version this build does not implement is **refused at load**, so an edited-in-place policy cannot look enforced when it is not |
| `policy.protectedPaths` | The locations that are refused no matter how easy the fix is. Start with auth, crypto, payment, anything with a compliance boundary |
| `policy.refusedRules` | Rules never auto-fixed anywhere (command injection, CSRF, anything where a plausible-looking patch is a vulnerability) |
| `policy.editableExtensions` | The file types the pipeline is allowed to edit at all |
| `policy.maxFindingsPerPass` / `maxAttemptsPerFinding` | The pass cap (overflow is *named*, never dropped) and the per-finding attempt cap |
| `codemods` | **Rule key → command.** This map is the economics: a rule with no entry costs a model call on every pass. Fill it from your own fixer of choice — for Java, OpenRewrite recipes; for TS/Python, the linters' autofixers |
| `sonar.host` / `sonar.projectKey` | Self-hosted SonarQube Server and the hosted service share `/api/issues/search`, so this is the only scanner change |
| `gateway.*` | The approved model endpoint, model name, `secretRef`, `approvedDataClasses` and output cap |

Secrets are addressed **by reference**, never by value. `env:NAME` is implemented;
`vault:`, `keychain:` and every other scheme throw a named error — that is the
seam to wire to the environment's own secret store, not an oversight.

## What an adopting environment has to fill in

1. **The codemod map.** Start with the five highest-volume rules; each entry moves
   work off the model path permanently.
2. **The secret scheme** in `portable/lib/gateway.mjs` (`resolveSecret`).
3. **Applying the plan.** Running the chosen commands, generating one test per
   fixed finding, and opening the branch/PR is CI work and stays out of this
   directory on purpose — it is the part that needs the approvals.
4. **The state store** ("which finding group already has a branch/PR/ticket"). A
   table beats a git branch for this in any environment with a real database.

## What is deliberately not here

- No notification channel. The verdict is a comment on the artifact it describes,
  which is the one surface that cannot drift from the change.
- No auto-merge. Merge-on-green is a policy an organisation adopts after the loop
  has earned it, and it belongs in the CI config, not here.
- No retries or provider failover in `proposeFix`. "It failed over to another
  vendor" is not a sentence anyone wants to write in a data-flow review.
- No `comments`/`tags` on the issue search request: the hosted API answers HTTP
  400 for `additionalFields=tags`, and a rejected request degrades into "no
  findings" if nobody reads the status.

## Tests

`portable/__tests__/portable.test.mjs` runs under the repo's own `npm test`.
