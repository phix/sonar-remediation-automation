# Jira Workflow and State Model for Sonar Remediation

## 1. Purpose

This document defines the Jira issue model, statuses, transitions, fields, and automation behavior for Sonar remediation work.

## 2. Jira Role in the System

Jira is the human-facing workflow surface for:
- triage
- visibility
- governance
- escalation
- audit-friendly status communication

The Plan JSON remains the canonical machine state, while Jira reflects the operational lifecycle for humans.

## 3. Recommended Jira Issue Strategy

## 3.1 Version 1 Recommendation
Create one Jira issue per remediation group.

A remediation group is defined by:
- repository
- Sonar rule key
- severity
- module prefix
- grouping strategy version

## 3.2 Future Option
Use an Epic for a remediation campaign and child issues for each remediation group.

This is useful when:
- many groups are created per scan
- reporting needs to roll up by campaign
- multiple teams own different modules

## 4. Recommended Issue Types

Primary issue type for version 1:
- Task or Story

Optional future issue types:
- Epic for campaign
- Sub-task for exact execution attempts
- Bug if your organization treats static-analysis findings as defects

## 5. Required Jira Fields

Recommended custom fields or labels:
- repository
- sonar_project_key
- plan_id
- group_id
- group_fingerprint
- sonar_rule_key
- sonar_severity
- automation_candidate
- module_prefix
- branch_name
- pull_request_url

## 6. Recommended Labels

Suggested labels:
- sonar
- sonar-remediation
- auto-remediation
- rule-<rule_key>
- severity-<severity>
- repo-<repository_slug>

## 7. Jira Status Model

Recommended statuses:

1. Open
2. Planned
3. In Progress
4. Auto Remediation Running
5. Fixed Pending Verification
6. Verified
7. Blocked
8. Escalated
9. Superseded
10. Won't Fix
11. False Positive
12. Closed

## 8. Status Definitions

### Open
Issue has been created but not yet committed into an active remediation plan.

### Planned
Issue is linked to an active Plan and is queued for execution.

### In Progress
Human or automation has started work.

### Auto Remediation Running
The automation workflow is actively attempting a fix.

### Fixed Pending Verification
A patch exists and preliminary validation passed, but final scan verification is pending.

### Verified
The issue has sufficient evidence of remediation:
- build passed
- tests passed
- scan passed
- issue no longer reproduces

### Blocked
Automation cannot continue without intervention.

### Escalated
The issue requires human review or manual remediation.

### Superseded
The issue has been replaced by a newer Plan or replacement issue.

### Won't Fix
The issue is intentionally not being remediated.

### False Positive
The finding is invalid or not actionable.

### Closed
The issue lifecycle is complete.

## 9. Transition Model

| From | To | Trigger |
|---|---|---|
| Open | Planned | Plan generation links issue to active plan |
| Planned | In Progress | Human starts work |
| Planned | Auto Remediation Running | Execution workflow starts |
| In Progress | Fixed Pending Verification | Patch prepared and validation started |
| Auto Remediation Running | Fixed Pending Verification | Build/tests/scan preliminarily pass |
| Auto Remediation Running | Blocked | Automation cannot proceed |
| Auto Remediation Running | Escalated | Human intervention required |
| Fixed Pending Verification | Verified | Final verification succeeds |
| Fixed Pending Verification | Blocked | Verification fails |
| Any active state | Superseded | Replacement plan/issue created |
| Any active state | Won't Fix | Governance decision |
| Any active state | False Positive | Triage decision |
| Verified | Closed | Administrative closure |
| Superseded | Closed | Administrative closure |
| Won't Fix | Closed | Administrative closure |
| False Positive | Closed | Administrative closure |

## 10. Jira Creation Rules

Create a Jira issue only when:
- the remediation group is eligible or triage-worthy
- no open matching issue exists for the same group fingerprint

Matching should consider:
- group_fingerprint
- repository
- sonar_rule_key
- severity
- module_prefix
- unresolved status

## 11. Jira Update Rules

Update Jira when:
- a Plan is created or refreshed
- execution begins
- branch is created
- PR is created
- verification succeeds
- failure classification changes
- retry is scheduled
- issue is escalated
- issue is superseded

## 12. Close and Create New Behavior

If the operator selects close_and_create_new:
- search for matching active Jira issues for the same group fingerprint
- transition them to Superseded
- add a comment linking the new issue or Plan
- do not use Cancelled unless your Jira workflow explicitly requires it

## 13. Recommended Jira Description Template

Suggested sections:
- Summary
- Repository
- Sonar project key
- Plan ID
- Group fingerprint
- Rule key and severity
- Affected module/path prefix
- Findings included
- Representative example
- Proposed remediation strategy
- Acceptance criteria
- Links to artifacts and workflow runs

## 14. Acceptance Criteria Template

Recommended acceptance criteria:
1. A remediation patch exists on a dedicated branch.
2. Build succeeds.
3. Relevant tests succeed.
4. No new critical regressions are introduced.
5. Targeted static scan succeeds.
6. The original finding or grouped findings no longer reproduce.

## 15. Commenting Model

Recommended automated comments:
- Plan linked
- Execution started
- Branch created
- PR created
- Verification passed
- Verification failed
- Retry scheduled
- Escalated to human
- Superseded by new issue/plan

## 16. Ownership and Assignment

Version 1 options:
- assign to a bot/service account
- assign to a default triage team
- leave unassigned but label clearly

Future options:
- assign by CODEOWNERS
- assign by module ownership map
- assign by service/team metadata

## 17. Reporting Recommendations

Track in Jira dashboards:
- issues created by repo
- issues by severity
- issues by Sonar rule
- automation success rate
- blocked/escalated rate
- verified rate
- mean time to verification
