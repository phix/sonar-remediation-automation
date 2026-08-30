---
description: Write the end-of-session handoff — verified state only, in the shape /pickup expects
argument-hint: [anything the session should record that commands cannot show]
---

Write the handoff for this session — asked for or not.

## Start it without being asked

When the session winds down: the work is done or parked, the user signals they
are finishing, or context is running short. Do not wait to be told. A session
that ends without a handoff leaves the next `/pickup` nothing to check, which is
the one failure this pair of commands exists to prevent.

## What it is

The next session starts by reading this file and re-checking every fact in it.
So it records **verified state, not intention**. Anything unproven says so, in
the sentence that makes the claim.

## 1. Gather before writing

Do not write a number you have not just watched a command produce. In parallel:

- `git log --oneline <previous handoff commit>..HEAD`, `git status --short` —
  what this session actually landed.
- The remote facts the state table pins: PR state, head SHAs, branch protection
  contexts, finding counts, test counts. Same commands `/pickup` uses.
- Read the previous handoff. Carry a fact forward **only** if you re-verified it
  this session; drop its "next" items that are now done.

If a claim cannot be checked in seconds, either check it properly or write it as
unproven. Do not launder an assumption into the table.

## 2. Where it goes

`docs/HANDOFF.md`, overwritten — git keeps the old ones and the README links
that path. If `docs/handoffs/` exists, write a new dated file there instead.

Title it `# Handoff — <today>`, then one paragraph on what the session was.

## 3. Sections

Keep the shape the previous handoff used. Drop any section with nothing real in
it rather than padding it.

1. **The headline** — the one thing that is true now and was not this morning.
2. **Current state** — a two-column table: repos and SHAs, branches, PR state,
   counts, versions. Every row a fact.
3. **What changed this session** — per item, what it does, not what it is.
4. **Blocked on Nick** — only what he alone can clear, each with the exact
   command or the decision, and what stays a claim until he does.
5. **Known open bugs** — the fix, why it survived, and what it makes look wrong.
6. **Verify before you push** — the runnable checks, with what each catches and
   how long it takes.
7. **Traps** — only ones actually hit this session, each with the tool that
   catches it next time.
8. **Where the numbers disagree with the docs** — every figure that moved, and
   which source wins.
9. **Next, in order** — ordered, each one line, top item startable immediately.
10. **What this session taught, in one line.**

## 4. Then

`$ARGUMENTS` records anything commands cannot show — a decision made aloud, a
dead end worth not re-walking.

Commit the handoff alone, message `Write the handoff`. Do not push, and do not
bundle other changes into it.
