# The terminal notification goes to Telegram, and Teams is descoped

Status: decided 2026-08-31. Supersedes the Teams half of issue #2 and the
`teams/` library (removed the same day; its tests and structure carried over
into `telegram/`).

## The decision

The one terminal-state message ("the PR is ready", or "it is red and exactly
why") is delivered by a **Telegram bot** (`@SonarScannerFixBot`), not a Teams
Power Automate workflow.

| | |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from @BotFather; the credential, rides in the URL path |
| `TELEGRAM_CHAT_ID` | numeric id of the chat the bot posts into |
| transport | `POST https://api.telegram.org/bot<token>/sendMessage`, HTML parse mode |

## Why Teams died

Not code — licensing. Classic Teams incoming webhooks were retired in May
2026, and the only supported replacement (a Power Automate workflow with the
"Teams webhook request received" trigger) requires a **work/school M365
tenant**. This project runs on a personal account, and as of mid-2026 the free
routes to a tenant are closed or hollow:

- The **M365 Developer Program** sandbox has required a Visual Studio
  Pro/Enterprise subscription or a Microsoft partner-program enrollment since
  the January 2024 lockdown (FAQ re-checked 2026-08-31 — the July 2026 change
  added commerce features for enterprises, it did not reopen eligibility).
- The **Business Basic 30-day trial** works but auto-converts to paid and
  makes the demo depend on a countdown.

The notify stage was built behind a seam precisely so the transport could
swap: `card.mjs` was pure, `client.mjs` owned every deadline, `notify.mjs`
owned the tri-state. The swap touched no pipeline logic and kept the argv
contract, so the workflow change is one step's env and path.

## What deliberately did not change

- **The tri-state.** Off is silent and green; on-but-unconfigured is red;
  configured delivers or says exactly why not. Same as jira/run.mjs.
- **The product promise.** ONE message at the terminal state, reason carried
  verbatim, ratio when supplied, links to the run and PR.
- **Bounded waits and spec §14 classification.** Same constants, same
  TRANSIENT/PERSISTENT import from the agentic client.

## What is different, and matters

- **Two config values, not one.** The Teams URL was self-contained; Telegram
  splits credential (token) from destination (chat id). Both are required
  together — a token without a chat id authenticates and has nowhere to
  deliver — and `configFromEnv` names each missing half individually.
- **The token rides in the URL path.** So the request URL is a credential:
  error messages are status-based and never include it.
- **403 is not an auth failure.** A bot cannot open a DM; until the recipient
  presses Start, sends are 403 "bot was blocked" / "chat not found" shapes.
  The client's hint says so, because "check the token" is the wrong runbook
  for that status.
- **HTML parse mode, not MarkdownV2.** The red reason is arbitrary text from
  other stages; MarkdownV2 400s on unescaped punctuation that rule keys and
  file paths are full of. HTML needs three entities and `escapeHtml` covers
  them (plus quotes for hrefs).

## For the office handoff

The office has Teams. This decision does not bind them to Telegram: the seam
that made this swap one module is still there, and the deleted `teams/`
implementation is one `git log -- teams/` away — proven against the Power
Automate card shape, minus only the live webhook it never got.
