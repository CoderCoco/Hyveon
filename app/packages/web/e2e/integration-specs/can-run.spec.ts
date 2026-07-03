import { test } from './index.js';

/**
 * Placeholder for canRun() permission enforcement tests.
 *
 * TODO(#75): Add integration specs once the Discord module is wired into the
 * `ipc` test harness. Each spec should verify that a guild not in
 * `allowedGuilds`, a non-admin user, or a user without the required per-game
 * action permission is rejected with the appropriate error.
 */
test.skip('canRun() permission enforcement — pending Discord integration', () => {
  // placeholder
});
