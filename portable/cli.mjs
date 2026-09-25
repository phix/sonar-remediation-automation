#!/usr/bin/env node
/**
 * The entry point, in two halves.
 *
 *   node portable/cli.mjs plan  --config portable/config/example.json
 *   node portable/cli.mjs apply --config <cfg> --plan plan.json [--dry-run]
 *   node portable/cli.mjs comment --plan plan.json
 *
 * `plan` reads and decides; it needs no credentials and touches nothing. That is
 * what makes it runnable in an environment where network access and change
 * approval have not arrived yet. `apply` executes the plan's registered commands
 * in the current working directory — so run it *from the repository being
 * remediated*, with the config naming that repository's own fixers. It still
 * commits nothing and pushes nothing: branches, tests and pull requests are CI
 * work, and they are the part that needs the approvals.
 *
 *   cd <target repo> && node <engine>/portable/cli.mjs plan  --config <abs cfg> --out plan.json
 *   cd <target repo> && node <engine>/portable/cli.mjs apply --config <abs cfg> --plan plan.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readConfig, plan as buildPlan } from './lib/plan.mjs';
import { applyPlan } from './lib/apply.mjs';
import { fromFixture, fromSonar } from './lib/findings.mjs';
import { comment } from './lib/verdict.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    findings: { type: 'string' },
    'sonar-live': { type: 'boolean', default: false },
    'pull-request': { type: 'string' },
    branch: { type: 'string' },
    plan: { type: 'string' },
    applied: { type: 'string' },
    out: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }
  }
});

const verb = positionals[0];
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

if (verb === 'plan') {
  if (!values.config) fail('plan needs --config <file>');
  const config = readConfig(values.config);

  let findings;
  if (values['sonar-live']) {
    findings = await fromSonar({
      host: config.sonar?.host,
      projectKey: config.sonar?.projectKey,
      token: process.env.SONAR_TOKEN,
      pullRequest: values['pull-request'],
      branch: values.branch
    });
  } else {
    const path = values.findings || config.fixtures?.findings;
    if (!path) fail('no findings source: pass --findings <file>, or --sonar-live, or set fixtures.findings');
    findings = fromFixture(path);
  }

  const built = buildPlan(findings, config);
  const text = `${JSON.stringify(built, null, 2)}\n`;
  if (values.out) writeFileSync(values.out, text);
  process.stdout.write(text);
} else if (verb === 'apply') {
  if (!values.config) fail('apply needs --config <file>');
  if (!values.plan) fail('apply needs --plan <file>');
  const config = readConfig(values.config);
  const built = JSON.parse(readFileSync(values.plan, 'utf8'));
  const result = applyPlan(built, config, {
    dryRun: values['dry-run'],
    cwd: process.cwd(),
    configDir: dirname(resolve(values.config))
  });
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (values.out) writeFileSync(values.out, text);
  process.stdout.write(text);
  // A failed command is a red run; a skip or an already-clean finding is not.
  if (result.totals.failed) process.exitCode = 1;
} else if (verb === 'comment') {
  if (!values.plan) fail('comment needs --plan <file>');
  const built = JSON.parse(readFileSync(values.plan, 'utf8'));
  const applied = values.applied ? JSON.parse(readFileSync(values.applied, 'utf8')) : undefined;
  process.stdout.write(`${comment({ plan: built, applied })}\n`);
} else {
  fail('usage: cli.mjs plan --config <file> [--findings <file> | --sonar-live] [--out <file>]'
    + '\n       cli.mjs apply --config <file> --plan <file> [--dry-run] [--out <file>]'
    + '\n       cli.mjs comment --plan <file> [--applied <file>]');
}
