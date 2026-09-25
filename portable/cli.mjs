#!/usr/bin/env node
/**
 * The credential-free entry point.
 *
 *   node portable/cli.mjs plan --config portable/config/example.json
 *   node portable/cli.mjs plan --config <cfg> --sonar-live --pull-request 42   # needs SONAR_TOKEN
 *   node portable/cli.mjs comment --plan plan.json
 *
 * `plan` reads, decides and prints. It fixes nothing and pushes nothing — which
 * is the whole reason it can run in an environment where credentials, network
 * access and change approval have not arrived yet. Applying a plan is the CI's
 * job, and the branches/PR half is the part that needs the approvals.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readConfig, plan as buildPlan } from './lib/plan.mjs';
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
    out: { type: 'string' }
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
} else if (verb === 'comment') {
  if (!values.plan) fail('comment needs --plan <file>');
  const built = JSON.parse(readFileSync(values.plan, 'utf8'));
  process.stdout.write(`${comment({ plan: built })}\n`);
} else {
  fail('usage: cli.mjs plan --config <file> [--findings <file> | --sonar-live] [--out <file>]'
    + '\n       cli.mjs comment --plan <file>');
}
