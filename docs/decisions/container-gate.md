# The container gate proves the app boots — it does not prove a finding is fixed

Status: decided 2026-09-24. Extends [`ci-container.md`](ci-container.md) (which
decided the shape of the *runner*) with the shape of the *app's own image*, and
amends the verification half of
[`pr-remediation-flow.md`](pr-remediation-flow.md).

## The question this answers

> "Queue up a Docker image of the app, let it build, and when the app is running
> run all your tests. If everything comes back green, did I successfully fix the
> issue?"

**No.** Green means the fix did not break the app. It cannot mean the smell is
gone, and treating it that way is the specific mistake this system was built to
avoid.

## Why green tests are not the proof

Three independent reasons, any one of which is sufficient:

1. **A test asserts behaviour, and a code smell is not behaviour.** An unused
   variable, a duplicated string literal or a nested ternary can all be removed
   or ignored without any observable behaviour changing — which is exactly why
   the smell was *classified* as a smell. A passing suite is evidence the
   behaviour survived the edit; it says nothing about whether the edit removed
   the defect.
2. **A green suite is green for the wrong reason when nothing covers the
   change.** The suite passes identically whether the fix is correct or the
   file is not exercised at all. This is the failure the coverage gate exists to
   make visible, and the reason the sandbox is deliberately red on new-code
   coverage while every maintainability rating is an A.
3. **The generated test is written not to assert the fix.** One
   characterization test per fix, generated from the file *as it was before the
   edit*, exists to pin the behaviour being preserved. That is a regression
   guard, and by construction it cannot be the thing that confirms the smell is
   gone.

## The decision

The container gate is a **gate on the push**, in the same category as the test
suite beside it, and the **re-scan remains the terminal proof**.

| Question | Who answers it | When |
|---|---|---|
| Does the code compile and the behaviour still hold? | `npm test` + `npm run build` | before the push |
| Does the **built app actually start and serve**? | the container gate | before the push |
| Are the findings gone? | Sonar's re-scan, through `settle` | after the push |
| Did the fix that landed do it? | `settle/outcome.mjs` | after the re-scan |

A red container gate pushes nothing, for the same reason a red suite pushes
nothing. It never merges, never marks anything fixed, and is not consulted by
`settle`.

## What the container gate is actually for

One thing that nothing else in the pipeline could see:

`npm test` drives the Express app **in-process through supertest**. It never
executes `api/src/server.js`, never reads `PORT`, and never binds a socket. The
web suite is component tests, and `npm run build` only compiles the Angular
bundle. So a change that leaves every test green while making the *real entry
point* fail — a bad top-level import, a missing env var, a route wired at
construction time — passed everything the pipeline had and merged.

`verify/container.mjs` builds the image, runs it, and requires `/health` and
`/api/orders` to answer. `/api/orders` and not just `/health`, because `/health`
is a stub that returns before the router, service and store are reachable from
the real process.

## The app image is not the CI image

[`ci-container.md`](ci-container.md) decided what the **job** runs in. This is a
different artifact: `Dockerfile` at the sandbox repo root builds the **app**.
The two must not be conflated — the CI container contract exists so a job can
bootstrap a toolchain, and has no opinion about whether the target app boots.

It stays a Dockerfile built on the runner rather than a published GHCR image, for
the reason `ci-container.md` already gives for the runner: a prebuilt artifact
moves the toolchain somewhere it has to be kept honest, and the thing being
demonstrated is a generic container that sets itself up.

## The outcome write-back, and the rule that keeps it honest

`settle/outcome.mjs` records the outcome on the Sonar finding itself: a comment
naming the ticket and the result, plus a `remediated` / `not-remediated` tag.
The tag is the coarse filter; the comment carries the reason.

A group counts as remediated only when **both** are true:

1. remediation actually changed a file in that group, **and**
2. Sonar's fresh scan no longer reports the group.

Either alone lies, and both lies were already found the hard way:

- **Absence alone is not proof.** A PR-scoped Sonar fetch omits a file the PR
  never touched for exactly the same reason it omits a fixed one. Confirmed live
  on 2026-09-03 — a freshly-opened, not-yet-remediated group PR had its group
  read as resolved on the first PR-scoped check. This is why `jira/run.mjs`
  refuses to resolve anything from a PR-scoped fetch, and why the outcome pass
  requires the disposition as well.
- **A change alone is not proof.** An edit that compiles, boots and passes every
  test can leave the smell exactly where it was.

So a group that is absent from the fresh scan **without** a recorded change is
reported `not_remediated` with a reason saying the absence cannot be attributed —
never as a success. The tag is one of two values on purpose: the honest third
state ("gone, but not by us") is expressed in the comment, which is where a
human reads the *why*, rather than smuggled into the success/failure axis.

### Where the finding's address comes from once it is fixed

A fixed finding is, by definition, absent from the fresh scan, so its Sonar issue
key has to come from somewhere else. Two sources, in order:

| Source | Covers |
|---|---|
| the pre-remediation `findings.json`, shipped in the remediation artifact | both paths, including the demo PR, whose groups no plan has ever heard of |
| `finding_ids` on the plan item | a group whose remediation predates the artifact carrying findings |

`finding_ids` is `key || hash || '<fingerprint>-<i>'`, so it is a deliberately
mixed bag and hash-shaped entries are filtered out rather than POSTed to an
endpoint expecting a key.

## Deliberately not done

- **No issue transitions.** Nothing is marked resolved, accepted or
  false-positive in Sonar. Those are irreversible and would hide the finding from
  the next scan's view — the exact evidence the re-scan depends on. The write-back
  is additive: a comment and a tag.
- **No CD.** The image is built and booted inside CI and never published, keeping
  `docs/IMPLEMENTATION_PLAN.md` §3 intact — there is still no deployed instance of
  the app, and the re-scan is still the proof.
- **The Angular bundle is not served by the API.** Building it into the runtime
  image would bake in an unused artifact and prove nothing extra, so web stays a
  job step and the image runs the API.

## The cost

Roughly a minute of CI per remediation run for the image build, plus the
pull of `node:24-bookworm`. That is the price of the one check that can see a
broken entry point, and it is visible in the run log rather than cached away —
the same trade-off `ci-container.md` made for the runner.
