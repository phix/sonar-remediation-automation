# Which source decides whether a ticket already exists

**Status:** accepted, 2026-08-30
**Implements:** #17 step 5 · **Constrained by:** `api-contracts.md` §5.3b

## The problem

"Never create a second ticket for a group that already has an open one" reads
like a lookup. It is not, because the obvious place to look is the one place
that cannot be trusted to be current.

Jira's JQL index updates **asynchronously from the write** — measured at ~2
seconds on the live site, 2026-08-29. So the failing sequence is not exotic:

1. Run A creates `SONAR-12` for group `gf-2e80d8b85dce`.
2. Run B starts 1.2 seconds later — a re-push, a retried job, two PRs touching
   the same module.
3. Run B searches `labels = "gf-2e80d8b85dce"`. The index has not caught up.
   Zero results.
4. Run B creates `SONAR-13` for the same group.

That is the duplicate-issue problem spec §2.3 exists to prevent, arriving
**through the mechanism meant to prevent it**. No amount of care in the JQL
fixes it, because the query is correct and the index is late.

## What was rejected

**Sleep before searching.** 2s was one measurement on one day against one
Atlassian region. A constant tuned to it is a race that passes in testing.

**Bounded retry on the search.** Retrying only helps if you know an answer is
coming, and here "no results" is indistinguishable from "no results *yet*".
Retrying an empty result until it is non-empty means never creating a first
ticket at all.

**A `group_fingerprint` custom field instead of a label.** Correct in Jira
terms and rejected in §5.3 for portability — it needs site-admin configuration
and a per-site field id. Irrelevant here anyway: a custom field is indexed by
the same lagging index.

## The decision

Three sources can answer, and they differ in what they know and — the part that
decides this — in whether they are current:

| Source | Knows about | Current with the last write? |
|---|---|---|
| the plan JSON | tickets *this pipeline* created | **yes** — it is a file we wrote |
| `GET /rest/api/2/issue/{key}` | one named ticket | **yes** — direct, not indexed |
| `POST /rest/api/2/search/jql` | every ticket, by label | **no** — ~2s behind |

So: **ask the plan for the key, ask Jira directly whether that key is still
open, and fall through to the lagging index only for groups the plan has never
heard of.**

The failing sequence above is now answered entirely by the two current sources.
Run B reads `gf-2e80d8b85dce → SONAR-12` from a file run A already wrote, and
confirms it directly. The index is never consulted, so its lag cannot matter.

This is not a cache in front of a search. A cache would be about speed and
would be safe to skip. This is about *consistency*, and skipping it produces
duplicates.

## The part that is easy to get wrong

Plan-first alone is not enough, and the bug it causes is worse than the one it
fixes.

The plan remembers a ticket key **forever** and has no idea the ticket was
closed. So: a group is ticketed, fixed, verified, the ticket moves to Done. Six
weeks later the smell comes back. That is new work and deserves a new ticket —
but a blind plan hit returns the dead key and suppresses it. Permanently, and
on every subsequent run. From the outside it looks like the scanner having
quietly stopped reporting that rule, which is not a failure anybody goes
looking for.

That is why a plan hit costs one request. `GET /issue/{key}` is lag-free in
exactly the way the search is not, so the openness check can be trusted the
instant the ticket changes. One request is the entire difference between dedupe
and amnesia, and `jira/__tests__/dedupe.test.mjs` fails when it is removed.

"Open" is asked via `statusCategory.key !== 'done'`, never the status name:
§5.5 found four statuses on this site and the model specifies twelve, and an
office Jira will have different names again. The category is one of `new`,
`indeterminate`, `done` on every Jira there is.

## The consequence that shapes the code

The window in which a crash produces a duplicate is exactly the gap between
creating a ticket and recording it in the plan. So the plan is written **once
per ticket, immediately**, not batched at the end of the run — batching would
widen that window from one function call to the length of the whole run.

That ordering is invisible in the output and is therefore asserted directly:
the write-back's HTTP call reads the plan file off disk mid-run and fails if
the key is not already there.

## What is still true afterwards

Two runs that overlap *before either has created anything* can still both
create. Nothing here is a distributed lock, and adding one would be a much
larger decision than this ticket. What is bounded is the far commoner case —
sequential runs inside the index window — and the residual is stated rather
than hidden.
