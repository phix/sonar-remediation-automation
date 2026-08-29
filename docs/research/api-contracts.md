# API contracts: SonarQube Cloud + Jira Cloud

**Resolves:** [Map the SonarQube Cloud and Jira Cloud API contracts](https://github.com/phix/sonar-remediation-automation/issues/5)
**Researched:** 2026-08-29 · **Verify with:** [`scripts/verify-api-contracts.sh`](../../scripts/verify-api-contracts.sh)

Every claim below cites current vendor documentation. Anything not verifiable from docs is marked **UNVERIFIED** and left for the verification script to settle against the live services — this document does not guess.

---

## Headline findings

Four things here change the design. Three of them would have broken code written from the source spec.

1. **Jira's old search endpoint is gone, not deprecated.** `GET/POST /rest/api/{2,3}/search` returns **410 Gone** — sunset completed 1 August 2025. Dedupe must use `POST /rest/api/{2,3}/search/jql`, which paginates by opaque **`nextPageToken` cursor**, not `startAt`, and **returns no `total`**.
2. **Sonar returns *both* severity vocabularies on every issue** — legacy and Clean Code/MQR, always, verified on 100 real issues. For code smells they map 1:1, so the source spec's `MAJOR` vocabulary is safe to keep. See [§3](#3-severity--settled-empirically).
3. **Sonar issue search is v1-only.** The v2 API (`api.sonarcloud.io`) does not cover Issues. Recon stays on v1 `/api/issues/search`.
4. **Jira v3 forces ADF for all rich text**; v2 accepts plain strings. Recommendation in [§5.6](#56-which-api-version-to-use) is to use **v2** and keep the body format behind one function.

---

## 1. SonarQube Cloud — connection

| Property | Value | Source |
|---|---|---|
| v1 base (EU) | `https://sonarcloud.io/api` | [Web API docs](https://docs.sonarsource.com/sonarqube-cloud/appendices/web-api) |
| v1 base (US) | `https://sonarqube.us/api` | same |
| v2 base (EU) | `https://api.sonarcloud.io` | same |
| Auth header | `Authorization: Bearer <token>` | same |
| Interactive v1 docs | `https://sonarcloud.io/web_api` | same |
| Interactive v2 docs | [api-docs.sonarsource.com](https://api-docs.sonarsource.com/sonarqube-cloud/default/landing) | same |

**Least privilege (spec §18.2).** Sonar tokens come in several types; the analysis job and the recon job want *different* ones. The scan needs a token that can submit analysis; recon only needs to read issues. Generate two, store as separate secrets (`SONAR_TOKEN` for the scan action, `SONAR_TOKEN_READ` for recon), and do not reuse one for both. **UNVERIFIED:** whether SonarQube Cloud's current token types allow a genuinely read-only token — the verification script probes this by attempting a write with the read token and expecting a 403.

**v2 does not cover Issues.** The v2 domains are Analysis, Authentication, Audit logs, AICA, Enterprises/Reports/Portfolios, Organizations, Projects, Quality Gates, SCA, Software Quality Reports, Users/roles. No Issues domain. Recon therefore targets **v1 `/api/issues/search`** and should expect to migrate eventually — the docs state v2 "will gradually replace" v1 as endpoints are deprecated.

## 2. SonarQube Cloud — `GET /api/issues/search`

### Scope: code smells only (current)

Nick has scoped this effort to **code smells** for now — bugs and vulnerabilities are not targets yet. That fixes the recon filter, and the filter is *mode-dependent*:

**Use `types=CODE_SMELL`.** Verified live: both `types=CODE_SMELL` (5619 hits) and `impactSoftwareQualities=MAINTAINABILITY` (5615) work on the same project — they are not mode-gated, and either is available regardless of configuration. `types` is the better choice because it aligns with the single-valued `severity` used for grouping ([§3](#3-severity--settled-empirically)).

Practical upside: code smells are also the safest class to auto-remediate, which is exactly what the source spec's eligibility policy (§10) recommends starting with — *"start with low-risk code smells and deterministic fixes; exclude security-sensitive and architectural findings."* The scoping decision and the spec's own advice agree.

### Request parameters

| Param | Purpose | Notes |
|---|---|---|
| `componentKeys` | project key | the primary filter |
| `organization` | Sonar org | **required on SonarQube Cloud**, unlike self-hosted Server |
| `branch` | branch name | omit for main |
| `severities` | legacy severity filter | Standard mode only — see §3 |
| `impactSeverities` | MQR severity filter | MQR mode — see §3 |
| `types` | `BUG`,`VULNERABILITY`,`CODE_SMELL` | legacy taxonomy |
| `impactSoftwareQualities` | `SECURITY`,`RELIABILITY`,`MAINTAINABILITY` | MQR taxonomy |
| `resolved` | `false` to get open issues | **always set this** — default includes resolved |
| `inNewCodePeriod` | new-code-only | maps to the spec's `new_code_only` input |
| `rules` | filter to specific rule keys | useful for targeted re-scan verification |
| `ps` | page size | **max 500** |
| `p` | page number | 1-indexed |

### Pagination — a hard ceiling that matters

`ps` caps at 500, and the endpoint **will not return beyond 10,000 total results** regardless of paging ([Sonar community, confirmed repeatedly](https://community.sonarsource.com/t/sonarcloud-web-api-issues-search-endpoint-record-limit/41337)).

For the sandbox this is irrelevant — we will have dozens of findings. **For the office version it is a design constraint**, and the recon workflow must handle it honestly:

- Set `max_findings` (spec §6.1) with 10,000 as the absolute ceiling.
- When `paging.total` exceeds what was fetched, **say so loudly** in the summary and the Teams message. A recon run that silently analysed the first 10,000 of 40,000 findings, and reported success, is exactly the failure mode the map's validation discipline exists to prevent.
- The escape hatch is partitioning the query — by `rules`, by severity, or by directory — so each slice stays under the cap. Worth building the seam for now even if unused.

### Response fields → spec §7.1 Finding

| Spec §7.1 field | Sonar source | Notes |
|---|---|---|
| `finding_id` | `key` | Sonar's own issue key; stable per issue |
| `finding_fingerprint` | **derived** | see below |
| `repository` | **derived** | workflow input, not in the payload |
| `sonar_project_key` | `project` | |
| `branch` | **derived** | echo the request param |
| `rule_key` | `rule` | e.g. `javascript:S1481` |
| `severity` | `severity` | single-valued; **also** carry `impacts[]` — see §3 |
| `type` | `type` | `CODE_SMELL` under current scope; also carry `cleanCodeAttribute` |
| `status` | `status` | `OPEN`,`CONFIRMED`,`RESOLVED`,`CLOSED`… |
| `component` | `component` | `projectKey:path/to/file.ts` |
| `file_path` | **derived** | strip the `projectKey:` prefix from `component` |
| `line` | `line` | **absent for file-level issues** — must be optional |
| `message` | `message` | |
| `debt_minutes` | `effort` / `debt` | string like `"5min"`; needs parsing to an integer |
| `tags` | `tags` | |
| `created_at` | `creationDate` | |
| `raw_reference` | the whole issue object | keep verbatim for audit (spec §19.1) |

### Fields the spec does not mention but the API returns

Observed on every sampled issue and worth carrying into `raw_reference` at minimum:

`textRange` (start/end line and offset — more precise than `line` for patching), `cleanCodeAttribute` / `cleanCodeAttributeCategory`, `issueStatus`, `flows` (empty for smells; populated for dataflow findings), `projectName`, `internalTags`, `updateDate`.

`textRange` is the one with real downstream value: a deterministic codemod that must edit exactly one expression benefits from column offsets, which `line` alone does not give.

### Fingerprinting — use Sonar's `hash`, not the line number

Spec §8.1 proposes fingerprinting on `repository + project + rule_key + file_path + line + message`. **Line number is the weak link**: every edit above a finding shifts it, so the same defect fingerprints differently after any unrelated change, and stale-detection produces false churn.

Sonar returns a **`hash`** field — a hash of the *line's content* — precisely for tracking issues across edits. Recommendation:

```
finding_fingerprint = sha256(repository | sonar_project_key | rule_key | file_path | hash)
```

falling back to `line` only when `hash` is absent (file-level issues). This is a deliberate, documented deviation from spec §8.1 and should be recorded as such.

**Verified 2026-08-29:** `hash` was present on **100/100** real issues sampled from a public project, and `line` on 100/100. Java rather than JS/TS, so the verification script still re-checks coverage against the actual sandbox once it is scanned — but the field is clearly populated as standard, not occasional.

### Quality gate

`GET /api/qualitygates/project_status?projectKey=<key>` (add `branch` for a branch). Returns `projectStatus.status` of `OK` / `ERROR`. This is the coarse pass/fail for the Teams notification; the issue-level diff is what actually proves a fix.

## 3. Severity — settled empirically

**This section was rewritten after live verification. My documentation-only reading of it was wrong, and the error mattered.**

### What the docs imply, and what is actually true

SonarQube documents two taxonomies — legacy **Standard mode** (`severity`: BLOCKER/CRITICAL/MAJOR/MINOR/INFO, `type`: BUG/VULNERABILITY/CODE_SMELL) and modern **MQR mode** (`impacts[]` of `softwareQuality` × `severity`, with severity BLOCKER/HIGH/MEDIUM/LOW/INFO). Reading only the docs, the natural conclusion is that a project is in *one* mode and the other vocabulary is absent or deprecated — which would make the source spec's `"severity": "MAJOR"` potentially unrepresentable.

That conclusion is wrong. Verified 2026-08-29 by anonymous query against the public `apache_dubbo` project (100 real issues, [fixture saved](fixtures/sonar-issues-sample.json)):

```
legacy `severity`     present on 100/100
legacy `type`         present on 100/100
MQR `impacts[]`       present on 100/100
`cleanCodeAttribute`  present on 100/100
```

**The API returns both vocabularies on every issue, always.** Mode is a presentation and quality-gate concern, not a payload concern. There is no "which fields will I get" risk.

### For code smells the two are isomorphic

Cross-tabulating all 100 issues gives a clean 1:1 mapping with no exceptions:

| legacy `type`/`severity` | MQR `impacts[]` | count |
|---|---|---|
| CODE_SMELL / BLOCKER | MAINTAINABILITY:BLOCKER | 5 |
| CODE_SMELL / CRITICAL | MAINTAINABILITY:HIGH | 16 |
| CODE_SMELL / MAJOR | MAINTAINABILITY:MEDIUM | 46 |
| CODE_SMELL / MINOR | MAINTAINABILITY:LOW | 27 |
| CODE_SMELL / INFO | MAINTAINABILITY:INFO | 6 |

Both filters also work and agree closely: `types=CODE_SMELL` → 5619, `impactSoftwareQualities=MAINTAINABILITY` → 5615. The 4-issue gap is issues carrying a maintainability impact without being classed a code smell — irrelevant at sandbox scale, worth remembering at office scale.

### Decision: use legacy `severity`, carry MQR alongside

Given the evidence this is not a genuine fork, so it is decided here rather than turned into a ticket:

1. **Group and label on legacy `severity`.** It is **single-valued**, so it needs no reduction rule — whereas `impacts` is an array and "the severity" of an issue would need a defined pick (highest? maintainability's?). It also matches spec §9 and [`sample_remediation_plan.json`](../source/sample_remediation_plan.json) exactly, so no schema change is needed.
2. **Query with `types=CODE_SMELL`** for the current code-smell-only scope.
3. **Normalize `impacts` and `cleanCodeAttribute` into the Finding anyway.** They cost nothing to carry, and they are what the office version will need when it widens beyond code smells or when Sonar eventually retires the legacy fields.
4. **Keep the mapping table above in code** as an explicit converter, so switching the plan's vocabulary later is a one-function change.

The one thing worth Nick's attention: if his office SonarQube is configured MQR-first and its dashboards speak HIGH/MEDIUM/LOW, plan tickets saying `MAJOR` will read as foreign to that audience. That is a presentation concern, resolved by the converter above — flagging it rather than deciding it.

## 4. Jira Cloud — connection

| Property | Value |
|---|---|
| Base | `https://<site>.atlassian.net/rest/api/{2,3}` |
| Auth | HTTP Basic: `base64(email:api_token)` |
| Header | `Authorization: Basic <b64>` |
| Token source | [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) |

Store `JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN` as GitHub secrets. Note the email is itself a credential half here — keep it in secrets, not in workflow YAML.

## 5. Jira Cloud — endpoints

### 5.1 Search / dedupe — the one that changed

**`POST /rest/api/{2,3}/search/jql`**

`GET`/`POST /rest/api/{2,3}/search` was deprecated in October 2024 and **removed**; it now returns **410 Gone** ([Atlassian CHANGE-2046](https://developer.atlassian.com/changelog/#CHANGE-2046), [migration guide](https://documentation.codefortynine.com/external-data-for-jira-fields/jql-search-migration-guide)). Anything still pointing at it is already broken.

```json
{
  "jql": "project = APP AND labels = \"gf-9f6f4f0f0f\" AND statusCategory != Done",
  "maxResults": 50,
  "fields": ["key", "status", "summary", "labels"]
}
```

Three behavioural changes that bite:

1. **Pagination is a cursor.** Response carries `nextPageToken`; pass it back to get the next page. `startAt` is gone. Loop until `nextPageToken` is absent.
2. **No `total`.** The new endpoint does not return a result count. Code that logged "found N matching issues" must count what it actually fetched, or use the separate approximate-count endpoint. For dedupe this is fine — we care whether *any* match exists.
3. **`fields` is not optional in practice.** Omitting it returns a minimal representation. Always ask for what you need; `["*all"]` works but is wasteful.

### 5.2 Create — `POST /rest/api/{2,3}/issue`

```json
{
  "fields": {
    "project":   { "key": "APP" },
    "issuetype": { "name": "Task" },
    "summary":   "[Sonar] javascript:S1481 unused variables in api/src/routes",
    "labels":    ["sonar-remediation", "gf-9f6f4f0f0f", "rule-javascript-S1481"],
    "description": "..."
  }
}
```

`description` is **plain string on v2, ADF object on v3**. See §5.6.

### 5.3 Dedupe key — labels, with a caveat

Spec §8.2 wants Jira lookup by `group_fingerprint`. A custom field is the "correct" answer but requires admin configuration and a per-site field id. **Labels are the pragmatic choice** for a personal site and for portability.

The constraint that shapes the fingerprint format: **Jira labels cannot contain spaces**, and are best kept to `[A-Za-z0-9_-]`. So a fingerprint must be emitted label-safe — `gf-<hex>` — not as raw base64 or anything containing `+`, `/`, or `=`.

The JQL `labels = "gf-<hex>"` is an exact match, which is what dedupe wants.

**UNVERIFIED:** whether the free plan restricts label length. The verification script creates an issue carrying a realistic-length fingerprint label and reads it back.

### 5.4 Transitions — never hardcode ids

- `GET /rest/api/{2,3}/issue/{key}/transitions` → available transitions **from the issue's current status**
- `POST` the same path with `{"transition": {"id": "<id>"}}`

**Transition ids are per-workflow and differ between sites and even projects.** The automation must fetch transitions and match on `to.name`, never carry a hardcoded id. A hardcoded id is the classic thing that works in the sandbox and fails on the office Jira.

Two consequences worth planning for: only transitions *valid from the current status* are returned, so a "move to Verified" that assumes a direct edge may find none; and the target name must match exactly.

### 5.5 The status model gap — plan for compression

[`jira_workflow_state_model.md`](../source/jira_workflow_state_model.md) §7 specifies **twelve** statuses including `Auto Remediation Running`, `Fixed Pending Verification`, and `Superseded`.

A default Jira Cloud project ships roughly **three**: To Do, In Progress, Done.

**UNVERIFIED, and worth checking early:** team-managed projects generally allow adding statuses from board settings without site-admin rights, which would make the fuller model reachable on a free site; company-managed projects need workflow administration. The verification script reports the project style and the actual available statuses.

The realistic strategy either way — and the one to recommend to the office — is **compress status, preserve detail in labels**:

| Model status | Jira status | Carried by |
|---|---|---|
| Open, Planned | To Do | label `sonar-planned` |
| In Progress, Auto Remediation Running | In Progress | label `sonar-auto-running` |
| Fixed Pending Verification | In Progress | label `sonar-pending-verification` |
| Verified | Done | label `sonar-verified` |
| Blocked, Escalated | In Progress | label `sonar-escalated` + comment |
| Superseded | Done | label `sonar-superseded` + link comment |

This keeps the *machine* state where it belongs — the plan JSON, which spec §4.1 already names as the source of truth — and asks Jira only for what a human needs to see. It also means the automation works on **any** Jira configuration, which matters more for the office handoff than fidelity to a twelve-status ideal.

Worth stating plainly for Nick's Jira admin: the full model needs a custom workflow with those statuses and the transitions in Jira doc §9. That is a Jira configuration project in its own right, not something the automation can create for itself.

### 5.6 Which API version to use

| | v2 | v3 |
|---|---|---|
| `description` / comment body | plain string | **ADF object required** |
| `search/jql` | available | available |
| Status | supported, older | current |

v2 does not accept ADF; v3 does not accept `{"body": "plain text"}` — they are not interchangeable ([Atlassian developer community](https://community.developer.atlassian.com/t/post-html-issue-description-with-jira-rest-api-v3/38482)).

**Recommendation: use v2.** The Jira integration is a CI script whose job is to write structured status text. ADF turns every description and comment into a nested document tree — real code, real bugs, for zero benefit at this fidelity. v2 takes a string.

The hedge that makes this safe: put body construction behind **one function** (`renderBody(sections) -> string | ADFDocument`). Switching to v3 later then means rewriting that function, not every call site. Recorded as a deliberate trade-off: v2 is older and Atlassian will eventually retire it, and the seam is the mitigation.

## 6. Open items for the verification script

These cannot be settled from documentation and are exactly why [`scripts/verify-api-contracts.sh`](../../scripts/verify-api-contracts.sh) exists:

- [x] ~~Which severity fields come back~~ — **both, always**; settled in §3 against 100 real issues
- [ ] Whether `hash` coverage holds for **JS/TS** specifically (100% on Java; re-check on the sandbox)
- [ ] Whether a genuinely read-only Sonar token is achievable
- [ ] The Jira project style (team-managed vs company-managed) and its real status list
- [ ] Available transition names from each status
- [ ] Label length tolerance for fingerprints
- [ ] That `POST /search/jql` behaves as documented, and that old `/search` really is 410 on this site
