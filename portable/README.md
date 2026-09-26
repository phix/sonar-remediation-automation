# portable/ — the remediation loop as a template

This directory is the part of the pipeline that has nothing to do with this
sandbox: **policy first, deterministic codemods second, a bounded model call
last, and the verdict on the pull request.** It has no network of its own, no
git, no CI and no sandbox in it, so it can be copied into another environment
and pointed at a different scanner, tracker and model gateway by editing one
JSON file.

It exists because the demo engine is welded to this repo — GitHub Actions, the
planted catalogue, `jscodeshift` fixers for its specific smells. The ordering and
the governance are the reusable part; this is that part on its own.

## Run it

Run `apply` from the repository being remediated; the engine may live anywhere.
Nothing here commits, branches or pushes — that is CI's job, and it is the half
that needs the approvals.

```bash
E=~/path/to/sonar-remediation-automation

node $E/portable/cli.mjs plan    --config $E/portable/config/example.json            # fixture, no credentials
node $E/portable/cli.mjs plan    --config $E/portable/config/example-eslint.json --findings issues.json --out plan.json
node $E/portable/cli.mjs plan    --config <cfg> --sonar-live --pull-request 42       # live, needs SONAR_TOKEN

cd <target repo>
node $E/portable/cli.mjs apply   --config $E/portable/config/example-eslint.json --plan plan.json --out applied.json
node $E/portable/cli.mjs apply   --config <cfg> --plan plan.json --dry-run           # show the commands, run none
node $E/portable/cli.mjs comment --plan plan.json --applied applied.json             # the PR comment
```

Two example configs ship with it, because the two environments differ in the one
way that matters — what a codemod *is*:

| Config | Codemod is | Verifier is |
|---|---|---|
| `example.json` | a Maven/OpenRewrite recipe | none registered |
| `example-eslint.json` | the repository's own linter in `--fix` mode | `tools/eslint-rule-absent.mjs` — the same analyzer, asked about one rule in one file |

## What the config controls

| Key | What an adopting environment changes |
|---|---|
| `policyVersion` | Bump it when you change the policy. A version this build does not implement is **refused at load**, so an edited-in-place policy cannot look enforced when it is not |
| `policy.protectedPaths` | Locations refused no matter how easy the fix is. Start with auth, crypto, payment, anything with a compliance boundary |
| `policy.refusedRules` | Rules never auto-fixed anywhere (command injection, CSRF, anything where a plausible-looking patch is a vulnerability) |
| `policy.editableExtensions` | The file types the pipeline may edit at all |
| `policy.maxFindingsPerPass` / `maxAttemptsPerFinding` | The pass budget (overflow is *named*, never dropped) and the per-finding attempt cap |
| `codemods` | **Rule key → `command` (+ optional `verifyCommand`).** This map is the economics: a rule with no entry costs a model call on every pass. Fill it from your own fixer of choice — OpenRewrite recipes for Java, the linters' autofixers for TS/Python |
| `sonar.host` / `sonar.projectKey` | Self-hosted SonarQube Server and the hosted service share `/api/issues/search`, so this is the only scanner change |
| `gateway.*` | The approved model endpoint, model name, `secretRef`, `approvedDataClasses` and output cap |

Secrets are addressed **by reference**, never by value. `env:NAME` is implemented;
`vault:`, `keychain:` and every other scheme throw a named error — that is the
seam to wire to the environment's own secret store, not an oversight.

## The apply half, and why a fix is only a fix when something says so

`apply` runs the plan's commands in the current directory. Three properties make
that safe to point at a real repository:

- **Only `codemod` entries execute.** Refused findings, model residue and findings
  over the cap are untouched *by construction* — the engine never decides to run
  a refused fix.
- **Commands are argv arrays, never shell strings.** A filename with a space or a
  `;` in it is data. `{file}`, `{rule}`, `{key}`, `{line}` and `{configDir}` are
  substituted per argument.
- **A fix is only counted when its verifier discriminates.** `verifyCommand` runs
  before the fix and again after it. Red-then-green is `applied`. Already green
  before is `already-clean` — either a command earlier in the pass resolved it
  (one linter run fixes every occurrence in a file), or the check cannot
  discriminate the finding from its absence, which is the shape of a test written
  to pass.

Outcomes are `applied`, `already-clean`, `failed`, `skipped` and (in a dry run)
`planned`. A non-zero `failed` sets the process exit code; a skip does not.

**The fix command's exit status is not the verdict.** Real autofixers report
"errors remain in this file", not "I failed": `eslint --fix` exits 1 while
unrelated rules still fire, on a file it just fixed. So the status is recorded as
`fixStatus` and the **verifier decides**. With no verifier registered, a non-zero
exit is the only signal there is, and it fails.

## What an adopting environment has to fill in

1. **The codemod map.** Start with the highest-volume rules; each entry moves work
   off the model path permanently.
2. **A verifier per rule** — the same analyzer asked about one rule, or the
   project's test run for that module. Without one, a fix is applied but reported
   `unverified`, and only the re-scan can speak for it.
3. **The secret scheme** in `portable/lib/gateway.mjs` (`resolveSecret`).
4. **The state store** ("which finding group already has a branch/PR/ticket"). A
   table beats a git branch for this in any environment with a real database.

## What is deliberately not here

- No branch, commit or push. The engine produces a plan, a diff in the working
  tree and a comment; CI owns git.
- **No generated unit test per fix.** The demo engine's version is `jscodeshift`
  templates anchored to the export enclosing the finding, read from the source
  before the edit — inherently language-specific. The portable seam is the
  per-rule verifier above; a *generator* would be a per-language command, and a
  stub that pretends to characterise behaviour would be worse than the hole.
- No notification channel. The verdict is a comment on the artifact it describes,
  which is the one surface that cannot drift from the change.
- No auto-merge, no retries and no provider failover in `proposeFix`.
- No `additionalFields` on the issue search: the hosted API answers HTTP 400 for
  `tags` there, and a rejected request degrades into "no findings" if nobody reads
  the status.

## Tests

`portable/__tests__/portable.test.mjs` runs under the repo's own `npm test`.
