import { defineConfig } from 'vitest/config';

/**
 * The exclusion below is not tidiness — it is the difference between a test
 * count that means something and one that does not.
 *
 * The subagent harness materialises git worktrees at `.claude/worktrees/agent-*`
 * INSIDE this repository. Each is a full checkout carrying its own copy of every
 * `__tests__` directory, so vitest's default discovery walks straight into them
 * and counts the same suites two and three times over — at whatever commit that
 * worktree happens to sit on, which is routinely not this one.
 *
 * Observed 2026-08-30: the real suite was 177 tests in 11 files; discovery
 * reported 426 in 25, because two stale worktrees (one of them eight commits
 * behind) were contributing their own copies. Every number in that run — pass
 * count, file count, coverage — was describing a tree nobody was working on.
 *
 * That is the failure shape this project is built against: not a red that should
 * have been green, but a green that was never asked the right question. A stale
 * worktree whose tests pass says "426 passed" just as loudly as a correct one.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/worktrees/**']
  }
});
