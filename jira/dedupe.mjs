/**
 * Never create a second ticket for a group that already has an open one.
 *
 * ## The order is the design, and it is not "cache then network"
 *
 * It looks like a cache in front of a search. It is not. The plan and the JQL
 * index answer *different* questions with *different* consistency, and the
 * order exists because of the second property, not the first:
 *
 * | source | knows about | consistent with the last write? |
 * |---|---|---|
 * | the plan | tickets *this pipeline* created | yes — it is a file we wrote |
 * | `GET /issue/{key}` | one named ticket | yes — direct, not indexed |
 * | `POST /search/jql` | every ticket, by label | **no** — ~2s behind (§5.3b) |
 *
 * So: ask the plan for the key, ask Jira directly whether that key is still
 * open, and only fall through to the lagging index for groups the plan has
 * never heard of. Two runs in quick succession — the case that produces
 * duplicates — are both answered entirely by the two consistent sources.
 *
 * ## The trap in trusting the plan alone
 *
 * A closed ticket must not dedupe. If a group was ticketed, fixed, and the
 * ticket moved to Done, and the smell later comes back, that is new work and
 * deserves a new ticket. The plan remembers the key forever and has no idea it
 * was closed — so plan-first *without* the openness check would silently
 * suppress every recurrence, permanently, and the failure would look like
 * "the scanner stopped finding it".
 *
 * That is why the plan hit costs a request. It is one direct GET, it is
 * lag-free, and it is the difference between dedupe and amnesia.
 */
import { searchJql, getIssue, isOpen } from './client.mjs';

/** JQL that asks the only question dedupe has: is there an unfinished ticket for this group? */
export function jqlFor(group, projectKey) {
  return `project = ${projectKey} AND labels = "${group.fingerprint}" AND statusCategory != Done`;
}

/**
 * @returns {Promise<{key: string|null, source: 'plan'|'jql'|null, note: string}>}
 */
export async function resolveExisting(group, { config, index, options = {} } = {}) {
  const known = index?.get(group.fingerprint);

  if (known) {
    const issue = await getIssue(config, known, ['key', 'status'], options);
    if (issue && isOpen(issue)) {
      return { key: known, source: 'plan', note: 'the plan already holds an open ticket for this group' };
    }
    if (!issue) {
      // The plan points at something that is not there any more. Falling
      // through to search is right: another ticket may exist, and if none
      // does, one should.
      return searchFallback(group, config, options,
        `the plan pointed at ${known}, which Jira no longer returns`);
    }
    return searchFallback(group, config, options,
      `the plan's ticket ${known} is closed, so this recurrence is new work`);
  }

  return searchFallback(group, config, options, 'the plan has never seen this group');
}

async function searchFallback(group, config, options, why) {
  const found = await searchJql(
    config, jqlFor(group, config.projectKey), ['key', 'status'], options
  );
  const open = found.find(isOpen);
  if (open) {
    return {
      key: open.key,
      source: 'jql',
      note: `${why}; the label search found open ticket ${open.key}`
    };
  }
  return { key: null, source: null, note: `${why}; the label search found none open` };
}
