# The agentic endpoint is tinman, and CI reaches it over Tailscale

Status: decided 2026-08-30. Supersedes the blank `LLM_BASE_URL` carried in
`.env.example` since #19 was written.

## The decision

The agentic fix path points at **Nick's Ollama deployment on `tinman`**, and
`remediate.yml` reaches it by joining the tailnet inside the job.

| | |
|---|---|
| `LLM_BASE_URL` | `http://tinman:11434/v1` |
| `LLM_MODEL` | `qwen2.5-coder:14b` |
| `LLM_API_KEY` | a placeholder, not a credential — see §"The key is not a key" |

## Why this needed a decision at all

`codemods/agentic/client.mjs` was built as a swappable seam precisely so the
endpoint would be configuration. It is — pointing it at Ollama needs **zero
code change**, because Ollama serves an OpenAI-compatible surface and the
client already does `POST {base}/chat/completions` with bearer auth.

The seam did its job. The problem was never the model call; it was the route.

`tinman` resolves to `192.168.1.217` — a private LAN address. `remediate.yml`
runs on the **sandbox** repository on GitHub-hosted runners, which have no
route to `192.168.1.0/24` and never will. The agentic path was therefore
unreachable from the only place it was ever meant to run, and no amount of
correct configuration would have changed that. This is a network topology
decision wearing the costume of a config value.

## Why Tailscale rather than the alternatives

- **A self-hosted runner on the LAN** removes the tunnel but makes us own
  runner uptime and its security posture, on a box that is a workstation
  rather than infrastructure. The demo would then have a second thing that
  can be off.
- **A public tunnel** (Cloudflare, ngrok) is the least work and the worst
  idea: it publishes an inference endpoint. Ollama has no authentication of
  its own, so the placeholder `LLM_API_KEY` would have to become a real
  enforced credential, and the auth layer in front of it becomes a thing we
  built and must defend.
- **Tailscale in the Action** keeps GitHub-hosted runners, exposes nothing
  publicly, and makes the tailnet name the address. The cost is one action
  step and one pair of repository secrets.

## The trap that shapes the workflow edit

`remediate.yml` currently pins `container: node:24-bookworm`, and that is
incompatible with this decision as written.

When a job declares `container:`, every step runs inside it. Tailscale in a
container generally cannot get `/dev/net/tun`, so it falls back to
**userspace networking** — which does not transparently route the container's
traffic. It exposes a SOCKS5/HTTP proxy instead, and reaching the tailnet then
requires the client to *use* that proxy.

`client.mjs:186` calls `globalThis.fetch`. Node's `fetch` does **not** honour
`HTTP_PROXY` / `ALL_PROXY` — undici requires an explicit `ProxyAgent`
dispatcher. So under `container:`, the tailnet would come up, the job would
report success, and the model call would still go out over the runner's normal
egress and fail to resolve `tinman`. Green step, dead route.

**Therefore the container is dropped from this job.** The comment that
introduced it says the job "needs node and nothing else" — that is satisfied by
`actions/setup-node` on `ubuntu-latest`, where Tailscale gets a real TUN device
and every process routes transparently, `globalThis.fetch` included. Pinning
the node version survives; the container does not.

The alternative — teaching `client.mjs` a `ProxyAgent` — was rejected because
it puts transport knowledge inside the vendor seam, which is the one thing the
seam exists to keep out.

## The key is not a key

`configFromEnv` refuses to run unless all three variables are non-empty, and
`config/secrets.md` lists `LLM_API_KEY` as a secret. Ollama ignores bearer
auth entirely. So the value is a placeholder that exists only to satisfy the
guard, and documenting it as a secret would send someone hunting for a
credential that was never issued.

It stays required rather than being made optional: the day this points at the
office's approved endpoint, that endpoint *will* need a real key, and a guard
that only appears when it is already too late is not a guard.

## What the live endpoint settled — and broke

tinman came up mid-session and all three unknowns resolved by probing it:

- **Node on the tailnet**: `tinman` = `100.102.1.50`, tailnet `tailc095b7.ts.net`, active, direct.
- **Model**: `qwen2.5-coder:14b`, the only one pulled.
- **Binds beyond loopback**: yes — reachable from another tailnet node.

A real `POST /v1/chat/completions` returned a correct OpenAI-shaped body. The
seam was right.

### The deadline defect the probe exposed

`DEFAULTS.connectTimeoutMs` was **10s**, applied to the `fetch` promise. Against
the live endpoint every single call failed — warm as well as cold — and was
reported as `infra_failure_transient`: a healthy server accused of being down.

| | time to headers |
|---|---|
| Cold, model unloaded | **74s** |
| Warm, realistic remediation prompt | **19.5s** |
| Old budget | 10s |

The premise was wrong, not the number. `fetch` resolves on *headers*, and the
original comment read that as connect-and-first-byte — true of a **streaming**
endpoint. A non-streaming completion generates the entire answer before sending
any header, so the header wait *is* the generation time. The two-deadline split
was a distinction without a difference here.

And the deadline was never what caught a dead host: a refused connection or DNS
failure rejects the fetch promise immediately, and the `catch` classifies it in
milliseconds. The header budget only bounded "accepted the socket then went
quiet" — which on a non-streaming endpoint is indistinguishable from "is
working".

Fixed by naming the deadline for what it measures and sizing it for a
self-hosted model: `headerTimeoutMs: 180_000`, plus a `bodyTimeoutMs` of its own
rather than whatever a slow generation left over. `stream: false` is now
explicit in the request, because the deadline model depends on it. The old
option names still resolve, because `prove-gates.mjs` and the suite drive tiny
budgets through them to force the bounded-wait path — dropping them would have
turned fast tests into three-minute ones.

Verified after the fix against live tinman: **54s cold, 19.5s warm, both OK.**
Four regression tests added, each proven to go red when the fix is reverted.

### The one thing still unproven

Nothing has run in CI. The tailnet join, the reachability probe, and the agentic
step have only ever been reasoned about — every measurement above was taken from
this laptop, which is already on the tailnet. That is a weaker proof than one
real workflow run, and this session's own lesson is that the gap between the two
is where the defects live.

### Budget note for whoever wires the workflow

~20s per finding warm. The current ratio is 10 findings on the agentic path, and
`maxProposalAttempts` defaults to 2, so a full run is minutes, not seconds.
