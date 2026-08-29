# Draft GitHub Actions Workflow Design for Sonar Remediation

## 1. Overview

This document provides a draft workflow design for implementing Sonar remediation automation in GitHub Actions.

Version 1 design assumptions:
- workflows are manually triggered
- one remediation item is executed at a time
- artifacts are persisted between phases
- PR review remains human-controlled
- no automatic merge

## 2. Workflow Inventory

1. sonar-recon.yml
2. plan-remediation.yml
3. execute-remediation.yml
4. assess-retry.yml

## 3. Common Design Standards

### 3.1 Trigger Model
Use workflow_dispatch for all version 1 workflows.

### 3.2 Artifact Naming
Use deterministic artifact names including repository and timestamp.

### 3.3 Concurrency
Use concurrency groups to prevent duplicate execution on the same plan item.

### 3.4 Permissions
Use least privilege permissions per workflow.

### 3.5 Environments
Use protected environments for workflows that can push branches or create PRs.

## 4. Workflow 1: sonar-recon.yml

### Purpose
Discover and normalize Sonar findings.

### Inputs
- repository
- branch
- sonar_project_key
- severity_filter
- issue_type_filter
- new_code_only
- max_findings

### Suggested Jobs

#### Job: validate-inputs
Responsibilities:
- validate required inputs
- derive defaults
- fail fast on invalid combinations

#### Job: fetch-sonar-findings
Responsibilities:
- authenticate to Sonar
- fetch findings
- save raw response artifact

#### Job: normalize-findings
Responsibilities:
- transform raw findings into normalized schema
- compute finding fingerprints
- generate summary counts by severity, rule, module

#### Job: publish-artifacts
Responsibilities:
- upload normalized findings JSON
- upload summary markdown
- emit artifact references as outputs

### Suggested Outputs
- findings_artifact_name
- normalized_findings_path
- sonar_snapshot_id
- findings_count

## 5. Workflow 2: plan-remediation.yml

### Purpose
Create a durable remediation plan and map groups to Jira.

### Inputs
- repository
- findings_artifact_name
- jira_project_key
- grouping_strategy
- close_and_create_new
- dry_run

### Suggested Jobs

#### Job: load-findings
Responsibilities:
- download findings artifact
- validate schema
- fail if artifact missing or malformed

#### Job: filter-findings
Responsibilities:
- remove resolved, false-positive, accepted-risk, or ineligible findings
- produce skipped findings report

#### Job: group-findings
Responsibilities:
- group by configured strategy
- compute group fingerprints
- choose representative findings
- generate proposed fix strategy summary

#### Job: jira-dedupe
Responsibilities:
- search Jira for existing active issues by group fingerprint
- map existing issues
- identify groups requiring new issues

#### Job: jira-create-or-update
Responsibilities:
- create new Jira issues where needed
- update existing issues where appropriate
- if close_and_create_new is true, supersede matching active issues

#### Job: build-plan
Responsibilities:
- create remediation plan JSON
- set plan status
- attach Jira mappings
- initialize execution history

#### Job: publish-plan
Responsibilities:
- upload plan JSON
- upload planning summary
- emit plan_id and artifact references

### Suggested Outputs
- plan_id
- plan_artifact_name
- created_issue_count
- linked_issue_count
- eligible_group_count

## 6. Workflow 3: execute-remediation.yml

### Purpose
Attempt remediation for one plan item.

### Inputs
- repository
- plan_artifact_name
- plan_id
- single_plan_item_id
- retry_attempt
- new_sonar_scan_fix_only
- dry_run

### Suggested Jobs

#### Job: load-plan
Responsibilities:
- download plan artifact
- validate schema
- select target plan item

#### Job: acquire-lock
Responsibilities:
- enforce concurrency for repository + plan_item_id
- prevent duplicate execution

#### Job: prepare-branch
Responsibilities:
- create deterministic branch name
- check out repository
- create branch
- update plan item status to In Progress

#### Job: generate-remediation
Responsibilities:
- inspect target findings
- generate patch
- optionally generate or update tests
- record patch summary

#### Job: static-validation
Responsibilities:
- run lint or local static checks if applicable
- fail fast on obvious issues

#### Job: build-application
Responsibilities:
- build application or container
- save build logs

#### Job: run-tests
Responsibilities:
- run relevant tests
- save test logs

#### Job: verify-scan
Responsibilities:
- run targeted scan or equivalent verification
- determine whether original issue still reproduces
- save scan logs

#### Job: push-branch
Responsibilities:
- commit changes
- push branch if policy allows and validation passed

#### Job: create-pr
Responsibilities:
- create PR when verification threshold is met
- include Jira and Plan references

#### Job: update-plan-and-jira
Responsibilities:
- update plan item status
- append execution history
- update Jira issue with branch, PR, and verification outcome

#### Job: publish-execution-artifacts
Responsibilities:
- upload updated plan
- upload patch summary
- upload build/test/scan logs
- upload execution summary

### Suggested Outputs
- branch_name
- pull_request_url
- execution_result
- updated_plan_artifact_name
- verification_status

## 7. Workflow 4: assess-retry.yml

### Purpose
Classify failure and decide retry vs escalation.

### Inputs
- repository
- plan_artifact_name
- plan_id
- plan_item_id
- execution_artifact_name

### Suggested Jobs

#### Job: load-execution-context
Responsibilities:
- download updated plan
- download execution logs
- identify target item and latest attempt

#### Job: classify-failure
Responsibilities:
- classify failure into structured category
- summarize evidence
- determine whether retry is policy-eligible

#### Job: decide-next-step
Responsibilities:
- if retry allowed and retry count below max, set Retry Pending
- otherwise set Blocked or Escalated

#### Job: update-jira
Responsibilities:
- add structured comment
- transition issue to Blocked, Escalated, or keep active for retry

#### Job: publish-decision
Responsibilities:
- upload failure classification
- upload retry decision
- upload updated plan

### Suggested Outputs
- retry_allowed
- next_status
- updated_plan_artifact_name

## 8. Recommended Permissions by Workflow

### sonar-recon.yml
- contents: read

### plan-remediation.yml
- contents: read
- actions: read
- optional id-token if needed by internal auth
- no repo write required unless storing plan in repo

### execute-remediation.yml
- contents: write
- pull-requests: write
- actions: read
- packages: write only if container build/push is required

### assess-retry.yml
- contents: read
- pull-requests: read
- actions: read

## 9. Recommended Secrets

- SONAR_TOKEN_READ
- JIRA_BASE_URL
- JIRA_USER or service identity
- JIRA_TOKEN_AUTOMATION
- GITHUB_BOT_TOKEN
- registry credentials if container build/push is needed

## 10. Recommended Environments

Use a protected environment for:
- branch push
- PR creation
- registry publishing
- any workflow with elevated write permissions

## 11. Artifact Contract

### Recon Artifacts
- raw_sonar_response.json
- normalized_findings.json
- findings_summary.md

### Planning Artifacts
- remediation_plan.json
- jira_mapping.json
- skipped_findings.json
- planning_summary.md

### Execution Artifacts
- updated_plan.json
- patch_summary.md
- build.log
- test.log
- scan_verification.log
- execution_summary.md

### Retry Artifacts
- failure_classification.json
- retry_decision.json
- escalation_summary.md

## 12. Suggested Failure Gates

Fail the workflow immediately when:
- required inputs are missing
- findings artifact is malformed
- plan schema validation fails
- target plan item is not eligible
- branch already exists in conflicting state
- retry count exceeds policy

## 13. Suggested Success Gates

Mark a remediation item as Verified only when:
- patch exists
- build passed
- tests passed
- targeted scan passed
- issue no longer reproduces

If scan confirmation is delayed:
- use Fixed Pending Verification
- follow with later verification update

## 14. Suggested GitHub Summary Content

Each workflow should write a concise summary including:
- repository
- plan ID if applicable
- counts processed
- target item
- Jira issue key
- branch and PR links
- final status
- artifact references

## 15. Suggested Rollout Plan

Phase 1:
- implement sonar-recon.yml
- implement plan-remediation.yml
- validate Jira dedupe and Plan generation

Phase 2:
- implement execute-remediation.yml for one allowlisted rule family

Phase 3:
- implement assess-retry.yml
- add retry policy enforcement

Phase 4:
- add workflow chaining and broader rule coverage

## 16. Draft YAML Skeleton Notes

When you implement the YAML:
- keep jobs modular
- pass artifact names and IDs as outputs
- centralize policy values in workflow inputs or config files
- avoid embedding business logic directly in YAML where possible
- prefer scripts or reusable actions for normalization, grouping, and Jira interaction

## 17. Recommended Repository Layout

.github/workflows/
- sonar-recon.yml
- plan-remediation.yml
- execute-remediation.yml
- assess-retry.yml

automation/
- sonar/
- jira/
- plan/
- remediation/
- verification/
- policy/

artifacts/
- optional local test fixtures

docs/
- architecture spec
- schemas
- workflow docs

## 18. Final Recommendation

Implement version 1 as a controlled, manual, artifact-driven system. Once the Plan schema, Jira transitions, and verification logic are stable, chaining and scale-out can be added with much lower risk.
