# The terminal verdict is a comment on the PR — there is no notification channel

Status: decided 2026-09-24. Supersedes
[`notify-telegram-not-teams.md`](notify-telegram-not-teams.md) (deleted the same
day, with the `telegram/` library it described) and, through it, the Teams half
of issue #2.

## The decision

The one terminal-state message — "the PR is ready", or "it is red and exactly
why" — is the **`<!-- sonar-settle -->` comment that `settle` posts on the pull
request**. There is no bot, no webhook, and no chat channel, and adding one is a
decision to be made on purpose rather than a step to be re-added.

| | |
|---|---|
| transport | `gh`'s issue-comment API, via `.github/actions/upsert-pr-comment` |
| credential | the workflow's own token — nothing extra to configure |
| scope | the PR the loop was already scoped to |

## Why the channel went away entirely

**Telegram is not part of this** (Nick, 2026-09-24). But the argument for
removal is not only preference — there was a concrete failure:

A docs-only PR (#39) sent a message reading *red — the terminal state could not
be determined*, because no remediation had run on it and `settle` is honest about
a missing input. The pipeline was reporting to a chat about a PR it had no
business reporting on. Every fix for that is a special case — skip non-code PRs,
skip this label, skip that path — and each one is a rule about *when not to
send*, which is the shape of machinery that eventually goes quiet in the case
that matters.

Three more properties fall out of moving the verdict onto the PR:

- **It cannot drift from the change it describes.** A chat message is read out of
  context days later; the comment sits on the diff and the gate it is about.
- **There is nothing to configure**, so there is no "on but unconfigured" state —
  the exact failure the previous tri-state existed to make loud. That property is
  worth keeping in mind if a channel is ever added back: *on-and-unconfigured
  must be red*, never a silent skip.
- **One fewer transport.** Teams died on M365 licensing, Telegram replaced it,
  and the chain stops here rather than acquiring a fourth.

## What was removed

| Where | What |
|---|---|
| `telegram/` | `client`, `message`, `notify` and their three test files — 451 lines |
| sandbox `_settle-notify.yml` | the `Tell Telegram` step and its two `preflight: optional-secret` annotations |
| both repos | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` as repo secrets; both keys out of `scripts/secrets.sh` and `sync-secrets.sh` |
| pipeline diagram | the `telegram` node, its layout entry, and the `TELEGRAM_BOT_TOKEN` mapping |
| docs | the Telegram rows in `config/secrets.md`, the flow's notify arrow, and the switch narrative that described `telegram_notify` as an input (it never was — it was secret-driven) |

The `preflight: optional-secret` *mechanism* stayed; Telegram's annotation was
its last user, and whether a secret is optional is a fact only a step's author
can declare.

`tools/pipeline-diagram/generate-ir.test.mjs` now asserts that the
`settle-notify → telegram` edge is **absent**, so re-introducing a channel fails
the diagram suite instead of passing silently.

## What deliberately did not change

- **ONE terminal message.** Not a stream of per-step chatter — a single verdict
  with a deterministic reason, carried verbatim.
- **The reason string.** Red is still reported as a stated cause (coverage,
  policy refusals, undetermined dispositions), not as a status colour.
- **`settle` still exits 0 on red.** Red is a product outcome here, not a
  pipeline failure.

## The cost, named

Someone not watching GitHub gets no signal. That is accepted: the unit of work is
a PR, the human's part ends when it opens, and the answer is where the work is.
If that ever stops being true — a genuinely hands-off flow that pages someone —
it gets a decision record first, not a re-added step.
