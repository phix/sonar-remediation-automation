/**
 * The Telegram notification step, as the workflow calls it.
 *
 * README.md's loop: "→ notify OPTIONAL, default OFF — ONE message at the
 * terminal state: 'ready', or 'red because <deterministic reason>'." This
 * module is that step. It replaced the Teams implementation when Teams was
 * descoped (docs/decisions/notify-telegram-not-teams.md); the argv contract
 * is unchanged so the workflow swap stayed one step's env and path.
 *
 * ## Off is silent; on-but-unconfigured is red
 *
 * The same distinction jira/run.mjs draws, mirrored exactly: `--enabled
 * false` means nobody asked for a message, so exit clean. Enabled with no
 * token or chat id means somebody DID ask and did not get one, and reporting
 * that as a skip is a pipeline claiming success for work it never did —
 * which is precisely the failure mode this whole automation exists to
 * prevent. The two paths return visibly different shapes (`disabled: true`
 * vs `disabled: false`) so a caller cannot collapse them into the same
 * message by accident.
 *
 * ## Unlike jira/run.mjs: a delivery failure is caught HERE
 *
 * `runJira` lets `JiraUnavailable` propagate to its `main()`, because
 * remediation does not wait on Jira and something downstream may still want
 * to know a real exception happened. This notification runs at the very end
 * of the pipeline, reporting the terminal state itself — a notifier that
 * throws while trying to report "done" is the exact failure it exists to
 * prevent from happening silently. So `notifyTelegram` never throws for an
 * expected condition (disabled, unconfigured, or a classified delivery
 * failure); only a genuine bug propagates.
 *
 * ## Exactly one message
 *
 * There is exactly one call to `sendMessage()` in the success path below,
 * and no retry of the call to `notifyTelegram` itself. Retries of the
 * underlying HTTP request happen inside `client.mjs`, bounded by its own
 * cap, and are retries of delivering the SAME message, not additional
 * messages.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildMessage } from './message.mjs';
import { configFromEnv, sendMessage, TelegramUnavailable } from './client.mjs';

/**
 * @param {object} input          see buildMessage() for the accepted fields
 * @returns {Promise<{ran: boolean, sent: boolean, disabled?: boolean,
 *                    reason?: string, classification?: string, verdict?: string}>}
 */
export async function notifyTelegram(input, {
  enabled = false,
  config = configFromEnv(),
  options = {},
  log = () => {}
} = {}) {
  if (!enabled) {
    return {
      ran: false, sent: false, disabled: true,
      reason: 'Telegram notification is off (telegram_notify: false), which is the default'
    };
  }
  if (!config.configured) {
    return {
      ran: false, sent: false, disabled: false,
      reason: `Telegram notification was requested but is not configured: ${config.missing.join(', ')} unset`
    };
  }

  const message = buildMessage(input);
  try {
    const outcome = await sendMessage(config, message, options);
    log(`Telegram notified: ${input.verdict}`);
    return { ran: true, sent: true, verdict: input.verdict, attempts: outcome.attempts };
  } catch (e) {
    if (e instanceof TelegramUnavailable) {
      return {
        ran: true, sent: false, disabled: false,
        reason: `Telegram is unusable [${e.classification}]: ${e.message}`,
        classification: e.classification, verdict: input.verdict
      };
    }
    throw e;
  }
}

/** The PR comment, in the same shape the other stages report in. */
export function renderTelegramReport(result) {
  const l = ['<!-- sonar-telegram -->', '### Telegram notification', ''];
  if (result.disabled) {
    l.push(`**Not sent.** ${result.reason}.`);
    return l.join('\n');
  }
  if (!result.sent) {
    l.push(`**Requested but not sent.** ${result.reason}. This is reported red rather than `
      + 'skipped, because somebody asked for a Telegram message and did not get one.');
    return l.join('\n');
  }
  l.push(`Sent — verdict: **${result.verdict}**.`);
  return l.join('\n');
}

export async function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const val = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

  const verdict = val('verdict');
  if (verdict !== 'ready' && verdict !== 'red') {
    console.error('usage: telegram/notify.mjs --verdict ready|red [--enabled] [--reason "..."] '
      + '[--repo owner/name] [--pr N] [--pr-url URL] [--run-url URL] [--plan ID] [--rule KEY] '
      + '[--ratio-codemod N] [--ratio-agent N] [--ratio-refused N] [--json out.json]');
    return 2;
  }

  const numOrUndefined = (s) => (s === undefined ? undefined : Number(s));
  const ratio = {
    codemod: numOrUndefined(val('ratio-codemod')),
    agent: numOrUndefined(val('ratio-agent')),
    refused: numOrUndefined(val('ratio-refused'))
  };

  const input = {
    verdict,
    reason: val('reason'),
    repo: val('repo'),
    planId: val('plan'),
    ruleKey: val('rule'),
    prNumber: val('pr'),
    prUrl: val('pr-url'),
    runUrl: val('run-url'),
    ratio
  };

  const result = await notifyTelegram(input, { enabled: flag('enabled'), log: (m) => console.log(m) });

  const out = val('json');
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(renderTelegramReport(result));

  // Disabled is success. Requested-and-unconfigured, or a delivery failure, is not.
  if (result.disabled) return 0;
  return result.sent ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv).then((c) => { process.exitCode = c; });
}
