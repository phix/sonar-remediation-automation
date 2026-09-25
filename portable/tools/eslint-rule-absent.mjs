#!/usr/bin/env node
/**
 * The reference verifier for a JavaScript/TypeScript repository.
 *
 * Exit 0 when the analyzer no longer reports the finding's rule in the given
 * file; non-zero when it still does; 2 when the question cannot be asked at all
 * (no local rule is mapped to that Sonar key). That third code matters: a
 * verifier that answers "fine" to a question it could not ask is the failure
 * this whole file exists to prevent.
 *
 *   node tools/eslint-rule-absent.mjs --config eslint.config.mjs \
 *     --sonar-rule javascript:S3504 --file api/src/reports/summary.js
 *
 * The rule id is read from the target project's own config, so a mapping change
 * there cannot silently leave this check pointing at a rule nobody runs.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    'sonar-rule': { type: 'string' },
    rule: { type: 'string' },
    file: { type: 'string' },
    cwd: { type: 'string' }
  }
});

const cwd = resolve(values.cwd || process.cwd());
if (!values.config || !values.file || !(values.rule || values['sonar-rule'])) {
  process.stderr.write('need --config <file> --file <file> and --rule <id> or --sonar-rule <key>\n');
  process.exit(2);
}

const configPath = resolve(cwd, values.config);
const project = await import(pathToFileURL(configPath).href);
const ruleId = values.rule || (project.RULE_MAP || {})[values['sonar-rule']];
if (!ruleId) {
  process.stderr.write(`no local rule is mapped to \`${values['sonar-rule']}\` in ${values.config}\n`);
  process.exit(2);
}

// ESLint comes from the *target* project, not from whoever invoked this file.
const require = createRequire(resolve(cwd, 'package.json'));
const { ESLint } = require('eslint');
const eslint = new ESLint({ cwd, overrideConfigFile: configPath });

const results = await eslint.lintFiles([values.file]);
const hits = results.flatMap((result) => result.messages).filter((message) => message.ruleId === ruleId);
if (hits.length) {
  process.stderr.write(`${ruleId} is still reported ${hits.length} time(s) in ${values.file} `
    + `(first at line ${hits[0].line})\n`);
  process.exit(1);
}
process.exit(0);
