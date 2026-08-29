# Sonar Remediation Automation Architecture Specification

## 1. Purpose

This document defines a robust, auditable, and incrementally adoptable architecture for automating the discovery, planning, ticketing, remediation, verification, and escalation of Sonar findings across application repositories.

The design assumes:
- GitHub Actions is the orchestration layer.
- Sonar is the source for static analysis findings.
- Jira is the human-facing work management system.
- Git branches and pull requests are the delivery mechanism for proposed fixes.
- Initial implementation executes one remediation item at a time.
- Future implementation may chain phases and parallelize selected activities.

## 2. Goals

1. Discover Sonar findings in a repeatable and normalized way.
2. Group findings into actionable remediation units.
3. Prevent duplicate Jira issue creation.
4. Maintain a durable remediation plan as the system of record.
5. Attempt automated remediation only for eligible findings.
6. Verify fixes using build, test, and scan evidence.
7. Retry safely within policy.
8. Escalate non-automatable or ambiguous cases cleanly.
9. Preserve auditability through artifacts, logs, and state transitions.
10. Support future chaining and scale-out without redesigning core state.

## 3. Non-Goals for Version 1

1. Automatic merge to protected branches.
2. Unlimited retries.
3. Parallel remediation of multiple plan items.
4. Broad architectural refactors.
5. Automatic remediation of all Sonar rule types.
6. Blind closure or cancellation of Jira issues.
7. Fully autonomous end-to-end operation without human checkpoints.

## 4. Core Architectural Principles

### 4.1 Durable Plan as Source of Truth
A remediation Plan JSON document is the canonical state record for each remediation campaign. Jira is the human workflow surface, but not the sole source of truth.

### 4.2 Deterministic Identity
Each finding and each remediation group must have stable fingerprints to support deduplication, traceability, and idempotent reruns.

### 4.3 Separation of Concerns
The system is divided into distinct phases:
- Discovery
- Planning
- Execution
- Verification
- Retry / Escalation

### 4.4 Safety First
Only allowlisted findings are eligible for automated remediation. Branch protections, PR review, retry limits, and blast-radius controls must be enforced.

### 4.5 Auditability
Every phase produces artifacts and structured status updates. All meaningful state changes should be reconstructable from saved outputs.

## 5. High-Level System Components

### 5.1 GitHub Actions
GitHub Actions orchestrates the workflows. Initial workflows are manually triggered using workflow_dispatch. Later versions may chain workflows using workflow_run or repository_dispatch.

### 5.2 Sonar
Sonar provides the findings to be remediated. The system should retrieve findings using a read-only token where possible.

### 5.3 Jira
Jira stores work items for human visibility, triage, and governance. Jira issues are linked to Plan items using deterministic group fingerprints and metadata fields.

### 5.4 Repository and Branches
The target repository is the codebase being remediated. Each remediation attempt occurs on a dedicated branch.

### 5.5 Build and Test Infrastructure
The execution workflow must build the application, run tests, and optionally build a container if required by the application delivery model.

## 6. Workflow Overview

### 6.1 Workflow 1: Sonar Recon
Purpose:
- Pull findings from Sonar.
- Normalize findings into a stable schema.
- Compute finding fingerprints.
- Save findings artifact.

Inputs:
- repository (required)
- branch (optional)
- sonar_project_key (optional if derivable)
- severity_filter (optional)
- issue_type_filter (optional)
- new_code_only (optional)
- max_findings (optional)

Outputs:
- raw Sonar response artifact
- normalized findings JSON
- findings summary markdown
- sonar snapshot metadata

### 6.2 Workflow 2: Recon and Plan
Purpose:
- Filter ineligible findings.
- Group eligible findings.
- Compute group fingerprints.
- Search Jira for existing matching issues.
- Create or update Jira issues.
- Produce a durable Plan artifact.

Inputs:
- repository (required)
- findings_artifact (required)
- jira_project_key (required)
- grouping_strategy (optional)
- close_and_create_new (optional, default false)
- dry_run (optional)

Outputs:
- remediation plan JSON
- Jira mapping summary
- skipped findings report
- planning summary markdown

### 6.3 Workflow 3: Execute Remediation
Purpose:
- Select one eligible plan item.
- Lock it.
- Create branch.
- Attempt remediation.
- Build, test, and scan.
- Push branch and create PR if successful.
- Update Plan and Jira.

Inputs:
- repository (required)
- plan_id (required)
- single_plan_item_id (optional)
- retry_attempt (optional)
- new_sonar_scan_fix_only (optional)
- dry_run (optional)

Outputs:
- updated plan JSON
- branch name
- commit SHA
- PR URL if created
- build logs
- test logs
- scan verification logs
- execution summary markdown

### 6.4 Workflow 4: Assess Failure / Retry Decision
Purpose:
- Classify failure.
- Decide whether retry is allowed.
- Trigger another attempt or escalate.
- Update Plan and Jira.

Inputs:
- repository
- plan_id
- plan_item_id
- execution_artifacts

Outputs:
- updated plan JSON
- retry decision summary
- Jira update

## 7. Data Model

### 7.1 Finding
A normalized finding should include:
- finding_id
- finding_fingerprint
- repository
- sonar_project_key
- branch
- rule_key
- severity
- type
- status
- component
- file_path
- line
- message
- debt_minutes or effort estimate if available
- tags
- created_at
- raw_reference

### 7.2 Group
A remediation group should include:
- group_id
- group_fingerprint
- repository
- sonar_project_key
- grouping_strategy
- rule_key
- severity
- module_prefix
- finding_ids
- finding_count
- representative_finding_id
- eligibility
- proposed_fix_strategy
- jira_issue_key
- status

### 7.3 Plan
A Plan should include:
- plan_id
- repository
- sonar_project_key
- sonar_snapshot_id
- findings_artifact
- grouping_strategy
- policy
- status
- items
- jira_summary
- execution_history
- created_at
- updated_at

## 8. Fingerprinting Strategy

### 8.1 Finding Fingerprint
Recommended inputs:
- repository
- sonar_project_key
- rule_key
- normalized file path
- line number
- normalized message

Purpose:
- identify the exact issue instance
- support stale detection
- avoid duplicate issue-level processing

### 8.2 Group Fingerprint
Recommended inputs:
- repository
- sonar_project_key
- rule_key
- severity
- module_prefix
- grouping_strategy version

Purpose:
- identify the logical remediation unit
- support Jira deduplication
- support idempotent planning reruns

## 9. Grouping Strategy

Version 1 recommended grouping:
- repository
- rule_key
- severity
- top-level module or path prefix

Rationale:
- groups are coherent enough for remediation
- avoids one ticket per exact finding
- avoids giant cross-repo or cross-module tickets
- supports ownership routing later

Alternative future strategies:
- by fix pattern
- by team ownership
- by service boundary
- by security domain

## 10. Eligibility Policy

Only findings that satisfy policy should be auto-remediated.

Recommended policy dimensions:
- allowed rule keys
- allowed languages
- allowed directories
- maximum files touched
- maximum lines changed
- excluded sensitive paths
- excluded severity classes if too risky
- excluded issue types if non-deterministic

Version 1 recommendation:
- start with low-risk code smells and deterministic fixes
- exclude security-sensitive and architectural findings
- exclude auth, crypto, concurrency, and session management areas

## 11. Jira Integration Model

### 11.1 Jira as Human Workflow Surface
Jira should reflect:
- what was discovered
- what is planned
- what is being attempted
- what succeeded
- what failed
- what requires human intervention

### 11.2 Jira Issue Creation Rules
Create a Jira issue only when:
- the group is eligible or triage-worthy
- no open matching issue exists for the group fingerprint

### 11.3 Jira Update Rules
Update existing Jira issues when:
- a new plan references the same group fingerprint
- execution status changes
- verification succeeds
- failure classification changes
- a replacement or superseding issue is created

### 11.4 Close and Create New Behavior
If close_and_create_new is enabled:
- do not blindly cancel issues
- transition matching issues to Superseded or Replaced
- add a comment linking the replacement Plan or issue

## 12. Branch and Pull Request Model

### 12.1 Branch Naming
Recommended:
- sonarfix/<plan_id>/<group_id>

### 12.2 PR Creation
Create a PR when:
- remediation patch exists
- build passes
- tests pass
- targeted scan passes or issue no longer reproduces

### 12.3 PR Content
Include:
- Jira issue link
- Plan ID
- Sonar rule
- findings count
- files touched
- verification evidence
- retry history
- known limitations

## 13. Verification Model

A finding is not considered verified fixed solely because code changed.

Required evidence:
1. patch applied cleanly
2. build passed
3. relevant tests passed
4. no new critical regressions introduced
5. targeted static scan passed
6. original issue no longer reproduces in scan evidence

If server-side Sonar verification is delayed:
- use Fixed Pending Verification first
- transition to Verified after confirmation

## 14. Failure Classification

Recommended failure classes:
- build_failure_patch_induced
- test_regression_patch_induced
- scan_unresolved
- infra_failure_transient
- infra_failure_persistent
- non_automatable
- ambiguous_root_cause

Each failure should include:
- short summary
- evidence links
- retry recommendation
- human action recommendation

## 15. Retry Policy

Version 1 recommendation:
- maximum automatic retries per item: 1 or 2
- retry only when failure is likely patch-correctable
- do not retry indefinitely
- do not retry if blast radius grows beyond policy
- do not retry if root cause is ambiguous or architectural

Retry context should include:
- original finding details
- attempted patch summary
- files changed
- build/test/scan logs excerpt
- prior failure classification

## 16. State Machine

### 16.1 Plan States
- Draft
- Planned
- In Progress
- Partially Verified
- Completed
- Blocked
- Closed

### 16.2 Plan Item States
- Discovered
- Grouped
- Ticketed
- Eligible
- In Progress
- Patch Generated
- Build Passed
- Tests Passed
- Scan Passed
- Fixed Pending Verification
- Verified
- Retry Pending
- Blocked
- Escalated
- Closed

## 17. Concurrency and Locking

Use one lock per:
- repository + plan_item_id

Goals:
- prevent duplicate remediation attempts
- prevent duplicate branch creation
- prevent conflicting Jira updates
- support future parallelism safely

## 18. Security Model

### 18.1 Secrets
Recommended secrets:
- SONAR_TOKEN_READ
- JIRA_TOKEN_AUTOMATION
- GITHUB_BOT_TOKEN
- registry/build secrets if needed

### 18.2 Least Privilege
- Sonar token should be read-only where possible.
- Jira token should be scoped to the relevant project.
- GitHub token should not bypass branch protections.
- Execution workflows should use environment protections if available.

### 18.3 Logging Hygiene
- never print secrets
- avoid dumping raw API payloads if sensitive
- redact tokens and confidential metadata

## 19. Artifacts and Auditability

Each workflow should save artifacts.

### 19.1 Recon Artifacts
- raw_sonar_response.json
- normalized_findings.json
- findings_summary.md

### 19.2 Planning Artifacts
- remediation_plan.json
- jira_mapping.json
- skipped_findings.json
- planning_summary.md

### 19.3 Execution Artifacts
- updated_plan.json
- patch_summary.md
- build.log
- test.log
- scan_verification.log
- execution_summary.md

### 19.4 Failure Assessment Artifacts
- failure_classification.json
- retry_decision.json
- escalation_summary.md

## 20. Operational Recommendations

### 20.1 Start Manual
Use workflow_dispatch for all workflows in version 1.

### 20.2 Start Narrow
Use a small allowlist of rules and one repository first.

### 20.3 Require PR Review
Do not auto-merge in version 1.

### 20.4 Measure Outcomes
Track:
- findings discovered
- groups created
- Jira issues created
- remediation attempts
- success rate
- retry rate
- escalation rate
- mean time to verified fix

## 21. Future Enhancements

1. Chain workflows automatically.
2. Parallelize independent plan items.
3. Add richer fix-pattern grouping.
4. Add ownership routing.
5. Add dashboards.
6. Add policy-as-code for eligibility and retry.
7. Add confidence scoring for remediation attempts.
8. Add automatic stale finding detection against fresh scans.

## 22. Recommended Version 1 Defaults

- trigger model: workflow_dispatch
- grouping: repository + rule_key + severity + module_prefix
- Jira dedupe: group_fingerprint
- Jira replacement behavior: Superseded, not Cancelled
- retry count: 1
- branch naming: sonarfix/<plan_id>/<group_id>
- success action: create PR
- verification: build + tests + targeted scan
- branch deletion: only if no diagnostic value remains
