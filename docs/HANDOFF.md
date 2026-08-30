# Handoff — 2026-08-30 (fifth session)

Picked up from `ecfc9a3`. Its §9 list had three items already done by the time
pickup checked them — the push had landed, `enforce_admins` was on, the Jira
secrets had moved to the sandbox — so the real work started at item 4.

Then Nick said the LLM should run against **tinman**, and that turned a config
task into a defect hunt. The seam was fine. Everything around it was not.

**Everything below is verified state.** Where something is unproven it says so in
the sentence that claims it.

**Nothing is merged.** All work sits on two pushed branches; both `main`s are
untouched.

---

## 1. The headline

**The agentic path could never have worked against tinman, and the test suite
had no way to know.** `DEFAULTS.connectTimeoutMs` was 10s, applied to the `fetch`
promise on the premise that fetch resolving on headers means
connect-and-first-byte. That is true of a *streaming* endpoint. Ollama generates
the entire completion before sending a single header, so the header wait **is**
the generation time:

| | time to headers |
|---|---|
| cold, model unloaded | **74s** |
| warm, realistic remediation prompt | **19.5s** |
| old budget | **10s** |

Every call died on the deadline — warm as well as cold — and reported
`infra_failure_transient`: a healthy server accused of being down. That is the
exact confusion `client.mjs`'s own header comment says the module exists to
prevent.

The deadline was never what caught a dead host anyway. A refused connection or a
DNS failure rejects the fetch promise immediately; `prove:gates` scenario 4 still
fails instantly on `ENOTFOUND` after the fix.

## 2. Current state

| | |
|---|---|
| Automation `main` | `ecfc9a3` — **untouched** |
| Automation branch | `llm/tinman-endpoint`, 3 commits, **pushed**, tree clean |
| Sandbox `main` | `914356d` — **untouched** |
| Sandbox branch | `llm/tinman-transport`, 4 commits, **pushed**, tree clean |
| Tests | **253** in 17 files (was 237 in 16) |
| Provers | `prove:gates` 4/4, `prove:templates` ok |
| PR #2 | `OPEN`, `BLOCKED`, head `243e9d2`, no auto-merge request |
| Required context | `gate`, `strict:false`, `enforce_admins` **true** |
| `refs/pull/2/merge` | parents `19584d7` + `243e9d2` — **still stale** |
| Live gate | `ERROR`, `new_coverage 5.7` vs 80, all three ratings `OK` |
| tinman | `100.102.1.50` on tailnet `tailc095b7.ts.net`, active, Windows |
| Model | `qwen2.5-coder:14b` — the only one pulled |
| `LLM_API_KEY` | **not a secret**. Ollama ignores bearer auth; it is a placeholder |
| Jira secrets | on **both** repos now |
| `TEAMS_WEBHOOK_URL` | absent — and now *declared* optional, so preflight says note, not failure |
| `TS_OAUTH_*` | absent — the only real preflight failures left |

**Unproven, and it is the important caveat:** *nothing in either branch has run
in CI.* Every measurement above was taken from this laptop, which is already on
the tailnet. This project's own repeated lesson is that the gap between "proven
locally" and "proven in CI" is where the defects live.

## 3. What changed this session

**Automation (`llm/tinman-endpoint`)**

- **`codemods/agentic/client.mjs`** — the deadline fix. `headerTimeoutMs: 180_000`
  named for what it measures, `bodyTimeoutMs` its own number rather than whatever
  a slow generation left over, explicit `stream: false`. Old option names still
  resolve, because `prove-gates.mjs` and the suite drive tiny budgets through them
  to force the bounded-wait path.
- **`settle/run.mjs`** — new. `classify/gate/automerge` were libraries with **no
  entry point and no npm script**; the terminal-state decision existed only inside
  its own tests. Plus `npm run settle`.
- **`scripts/preflight.mjs`** — optional secrets, declared via a
  `# preflight: optional-secret NAME` comment.
- **`.env.example`, `config/secrets.md`, `docs/decisions/llm-endpoint-transport.md`**.

**Sandbox (`llm/tinman-transport`)**

- **`remediate.yml`** — tailnet join, a reachability probe *before* the model
  call, the agentic step actually invoked, honest commit provenance, the
  remediation record uploaded as an artifact. **`container:` removed** — see §7.
- **`sonar-pr-scan.yml`** — a new `settle` job and the Teams notification.

## 4. Blocked

**a. `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` on the sandbox repo.** A tailnet
OAuth client with `auth_keys` scope, and an ACL letting `tag:ci` reach
`tinman:11434`. This is the only thing standing between the branches and a real
CI run. preflight names both.

**b. `TEAMS_WEBHOOK_URL` — #2's HITL half.** The library is wired now; creating
the Power Automate flow and confirming a personal Microsoft account can is still
untouched, and has been across three sessions.

**c. Retriggering PR #2.** Needs an empty commit on `demo/planted-smells`. Not
done because it mutates the demo branch and nobody asked.

## 5. Known open bugs

None open. Four found and fixed, three of them in code written *this* session:

- The 10s header budget (§1).
- **My own artifact lookup filtered `gh run list --branch <head>`.** `remediate.yml`
  is `workflow_dispatch`, so its run is attributed to whatever ref it was
  dispatched from — usually `main`, never the PR head. It would have silently
  found nothing and reported "no remediation has run" for a PR that had just been
  remediated. Caught before commit, by asking where the run actually lives.
- **My own workflow comment claimed `run.mjs` exits 0 when unconfigured.** It
  returns **1**, deliberately. The step is fatal, not soft.
- **The optional-secret marker matched nothing at first.** `allText` is
  `JSON.stringify(parse(yaml))`, which contains no comments, so a comment marker
  could never be seen. It looked exactly like a feature that worked.

## 6. Verify before you push

```bash
npm test && npm run prove:gates && npm run prove:templates
```

```bash
node settle/run.mjs --project phix_sonar-sandbox-app --pr 2
```

That second one is the cheapest proof the settle stage reads reality. With a
clean dispositions file it must say `red — quality gate failed: new-code coverage
is 5.7 against a threshold of 80`. Ask it about `--pr 999` and it must say
red-undetermined rather than borrowing PR 2's `SUCCESS` — that is the previous
session's headline defect, and both directions were checked live.

## 7. Traps hit this session

**A green suite cannot see a wrong deadline.** All 237 tests passed against a
client that could not complete a single real call. The tests mock `fetch`, so the
one thing that mattered — how long a real endpoint takes to send headers — was
the one thing never exercised.

**`container:` silently defeats Tailscale.** Inside a container Tailscale cannot
get `/dev/net/tun`, falls back to userspace networking, and offers a SOCKS5 proxy
instead of routing — while `client.mjs` calls `globalThis.fetch`, which ignores
`HTTP_PROXY`/`ALL_PROXY` entirely. The tailnet comes up, the step goes green, and
the call still leaves over normal egress. **Green step, dead route.**

**preflight against the wrong ref invents problems.** `sonar-pr-scan.yml` checked
against `demo/planted-smells` reports four missing scripts; against `main` — the
merge ref it actually runs on — it is clean. Pass the ref the workflow really uses.

**Twelve tests passed on their first run**, the shape §7 has now warned about
four times. Five deliberate mutations were applied to `settle/run.mjs` and each
shown to turn them red; four more to `client.mjs`. Zero holes, but the first-run
pass is still the signal to go looking.

**A false red is a real cost.** Wiring Teams made preflight report a failure the
workflow would not actually have. Left alone, that is how the *true* red line
underneath it stops being read.

## 8. Where the numbers disagree with the docs

- **`LLM_API_KEY` was documented as a secret.** It is a placeholder — Ollama
  ignores bearer auth. Corrected in `config/secrets.md`. It stays *required*
  because the office endpoint that replaces tinman will need a real one.
- **Tests: 237 → 253.** Files 16 → 17.
- **README's required-check wording was already fixed** — it says `(context gate)`.
  §8 of the previous handoff is stale on that point.
- **Handoff item 4 said "wire settle into remediate.yml".** Settle does not belong
  there: remediation pushes, the push re-triggers the scan, and only then is the
  gate the fixed code's gate. It went into `sonar-pr-scan.yml` as a second,
  non-required job instead.

## 9. Next, in order

1. **Issue the Tailscale OAuth client and set `TS_OAUTH_*`** (§4a). Everything
   else is downstream of this.
2. **Run `remediate.yml` once, dry-run first.** Nothing in either branch has ever
   executed. Expect ~20s per agentic finding, 10 of them, up to 2 proposal
   attempts — minutes, not seconds.
3. **Merge the two branches** once a real run has proven them. Not before.
4. **#2's HITL half** (§4b) — the Power Automate flow, or pick the fallback.
5. **Retrigger PR #2** (§4c) — empty commit, not a rerun; the merge ref is stale.
6. **Rotate the GitHub token in `~/.zshrc:13`.** A live `ghp_` value sits there in
   plaintext; it surfaced in a grep this session. Unrelated to this repo, still real.

## 10. What this session taught, in one line

The seam that was designed to be swapped swapped perfectly, and every defect was
in the things nobody thought were decisions — a timeout constant, a container
image, a `--branch` filter, and a comment the parser had already thrown away.
