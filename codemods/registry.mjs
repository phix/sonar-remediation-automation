/**
 * Rule key -> deterministic fixer.
 *
 * This map IS the project's economic argument. A rule that is absent here is a
 * rule that costs an LLM call and its latency on every pull request that trips
 * it, so adding an entry is the highest-leverage change anyone can make.
 */
import * as removeUnusedImport from './fixers/remove-unused-import.mjs';
import * as removeUnusedVariable from './fixers/remove-unused-variable.mjs';
import * as removeDeadStore from './fixers/remove-dead-store.mjs';
import * as varToConst from './fixers/var-to-const.mjs';
import * as toOptionalChain from './fixers/to-optional-chain.mjs';
import * as someToIncludes from './fixers/some-to-includes.mjs';

export const FIXERS = [
  removeUnusedImport, removeUnusedVariable, removeDeadStore,
  varToConst, toOptionalChain, someToIncludes
];

const BY_RULE = new Map();
for (const f of FIXERS) for (const r of f.rules) BY_RULE.set(r, f);

export function fixerFor(ruleKey) {
  return BY_RULE.get(ruleKey) || null;
}

export function hasCodemod(ruleKey) {
  return BY_RULE.has(ruleKey);
}

export function supportedRules() {
  return [...BY_RULE.keys()].sort();
}
