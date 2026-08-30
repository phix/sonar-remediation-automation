---
description: Resume the last handoff session — read it, check what drifted, report where to start
argument-hint: [what to work on instead]
---

Pick up where the last session stopped.

## 1. Read the handoff

The newest of `docs/handoffs/*.md` if that directory exists, otherwise
`docs/HANDOFF.md`. Read the whole file — it is short and the traps section is
the part that saves the most time.

`git log --oneline -1 -- <that path>` gives the commit that wrote it. That
commit is the **as-of point** for everything the file claims.

## 2. Trust nothing in it that git or gh can check

The handoff records state that was verified when it was written, not now. In
parallel, check what may have moved:

- `git log --oneline <handoff-commit>..HEAD` and `git status --short` — what
  landed in this repo since, and what is uncommitted.
- The Current state table pins the repos, branches, SHAs, PR number and counts.
  Take those identifiers **from the table**, not from memory, then:
  - `gh pr view <pr> --repo <sandbox> --json state,mergeable,mergeStateStatus,headRefOid,statusCheckRollup`
  - `gh api repos/<sandbox>/branches/main/protection --jq '.required_status_checks.contexts'`
    — a 404 means still unprotected.
  - `gh api repos/<sandbox>/git/refs/heads/<demo branch> --jq .object.sha`
    against the pristine tag — is the demo branch still dirty.
- Anything the handoff calls blocked, open, or unproven: confirm it is still
  that before repeating the claim back.

Drift check only. No test suite, no CI run — seconds, not minutes.

## 3. Report, short

- **Where it stopped** — three lines.
- **Drift** — every fact that no longer holds, and what it is now. If nothing
  moved, say "no drift" and move on.
- **Blocked on Nick** — only the items still blocked. These are his to clear;
  do not work around them silently.
- **Next** — the handoff's ordered list, minus anything now done.
- **Traps** — only the ones that bite the top item.

## 4. Then

`$ARGUMENTS` outranks the handoff's list — if given, work that instead.
Otherwise propose the top item and wait. Do not start it unprompted.

Never rewrite the handoff during pickup. It is the last session's record; a new
one gets written at the end of this session, not the start.

Write that one yourself. When this session winds down — the work done or parked,
or context running short — start the handoff unprompted rather than waiting to
be asked for it.
