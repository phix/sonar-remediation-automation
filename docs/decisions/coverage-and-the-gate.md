# Coverage, and what the gate is actually measuring

**Status:** accepted, 2026-08-30
**Supersedes:** the open question left in `docs/HANDOFF.md` §4

## The problem

The quality gate on the demo pull request has been red since the first run, and
not for the reason everyone assumed. Every rating condition passes:

| Condition | Status | Actual | Threshold |
|---|---|---|---|
| `new_reliability_rating` | ok | 1 | GT 1 |
| `new_security_rating` | ok | 1 | GT 1 |
| `new_maintainability_rating` | ok | 1 | GT 1 |
| `new_coverage` | **ERROR** | 5.7 | LT 80 |
| `new_duplicated_lines_density` | ok | 0.0 | GT 3 |
| `new_security_hotspots_reviewed` | ok | 100.0 | LT 100 |

Thirty-two code smells rate an **A**. The gate has never once been smell-bound.
It is coverage-bound, and it was coverage-bound before a single finding was
fixed.

This matters because it makes a claim the demo wants to make untrue as stated.
"Fix the findings and the gate goes green" is false here: fixing all 32 leaves
the gate exactly as red as it was.

## Three options, and why the obvious one is wrong

**Lower the threshold, or bind the project to a gate without `new_coverage`.**
Rejected. It is available — the project uses the built-in `Sonar way`, and
copying it into an editable gate is two API calls — and that is precisely the
problem. The pipeline's entire argument is that a check you can edit when it
fails is not a check. Editing the gate the first time it says something
inconvenient would be the same move as deleting a failing test, performed at
the level of the thing that grades the tests. Whatever is written in the office
write-up afterwards, the reviewable record would show the threshold moving to
meet the result.

**Have the agentic path write tests that genuinely cover the code.** Correct,
and it is the only route to 80% that is honest. It is also not available yet:
it needs `#19` running against a real endpoint, which needs credentials this
repo does not have. It stays the target rather than the answer.

**Report the two axes separately and let the gate stay red for a stated
reason.** Accepted.

## The decision

The gate is left exactly as SonarSource ships it. Nothing is lowered, copied,
or unbound.

What changes is what the pipeline *claims*. It stops implying it governs the
gate as a whole, because it does not. It governs one axis of it:

- **Maintainability** — the findings. This is what remediation acts on, and it
  is reported as its own result: how many were resolved, how many refused, and
  by what.
- **Coverage** — not what this pipeline produces. Characterization tests assert
  module shape, so thirty of them moved `new_coverage` from 0.0 to 5.7. That is
  the honest ceiling of a generated-test strategy, and quoting the number is
  better than implying the gap is nearly closed.

So the red gate is not a failure of the loop; it is the loop reporting a
condition it never claimed to satisfy. The PR comment says which axis is which,
which is the difference between "the gate is red" and "the gate is red because
new-code coverage is 5.7% against a threshold of 80%, and nothing in this
pipeline was ever going to change that".

## What this costs, said plainly

`auto_merge` cannot fire on this sandbox, and `#16`'s green terminal state is
unreachable until coverage is addressed by something other than this pipeline —
either real tests written by the agentic path, or a deliberate, recorded
decision by the repository's owner to grade new code differently.

That cost is the point. A demo that reached green by moving the threshold would
prove that the threshold moves.
