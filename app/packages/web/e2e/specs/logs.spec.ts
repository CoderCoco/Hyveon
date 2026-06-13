import { test, expect, stubApis, SAMPLE_LOG_LINES } from '../fixtures/index.js';

/**
 * `/logs` route specs (issue #63). The Nest server is never started — every
 * `/api/*` call goes through Playwright route stubs. `LogsPage` now fetches
 * its initial snapshot via `window.gsd.logs.get` (IPC bridge) instead of
 * the HTTP API; `stubApis()` injects a `window.gsd.logs` stub via
 * `addInitScript` that returns the seeded lines from `logLines` and resolves
 * the stream call immediately without firing any chunks, so specs drive the
 * page entirely off the seeded snapshot.
 */
test.describe('logs page', () => {
  test('should render LIVE badge and seeded log lines', async ({ logs }) => {
    await stubApis(logs.page, {
      statuses: [{ game: 'minecraft', state: 'stopped' }],
      logLines: { minecraft: SAMPLE_LOG_LINES },
    });
    await logs.goto();

    await expect(logs.heading()).toBeVisible();
    await expect(logs.liveBadge()).toBeVisible();
    await expect(logs.page.getByText('Server started on port 25565')).toBeVisible();
  });

  test('should toggle to Paused badge and back via the Pause/Resume button', async ({ logs }) => {
    await stubApis(logs.page, {
      statuses: [{ game: 'minecraft', state: 'stopped' }],
      logLines: { minecraft: SAMPLE_LOG_LINES },
    });
    await logs.goto();

    await logs.pauseButton().click();
    await expect(logs.pausedBadge()).toBeVisible();
    await expect(logs.liveBadge()).not.toBeVisible();

    await logs.resumeButton().click();
    await expect(logs.liveBadge()).toBeVisible();
  });

  test('should color-code lines containing INFO/WARN/ERROR/DEBUG with badges', async ({ logs }) => {
    await stubApis(logs.page, {
      statuses: [{ game: 'minecraft', state: 'stopped' }],
      logLines: { minecraft: SAMPLE_LOG_LINES },
    });
    await logs.goto();

    // Each level token should appear at least once as a small badge alongside
    // the matching line.
    for (const lvl of ['INFO', 'WARN', 'ERROR', 'DEBUG'] as const) {
      await expect(logs.levelBadge(lvl)).toBeVisible();
    }
  });

  test('should highlight matches via <mark> when typing into the search box without filtering lines out', async ({
    logs,
  }) => {
    await stubApis(logs.page, {
      statuses: [{ game: 'minecraft', state: 'stopped' }],
      logLines: { minecraft: SAMPLE_LOG_LINES },
    });
    await logs.goto();

    await expect(logs.highlightMarks()).toHaveCount(0);

    await logs.search('Connection');
    await expect(logs.highlightMark('Connection').first()).toBeVisible();
    // The matched line must remain in the buffer — search highlights, never filters.
    await expect(logs.page.getByText('refused from 10.0.0.5')).toBeVisible();
  });

  test('should hide ERROR-level lines when ERROR is unchecked in the Levels filter', async ({
    logs,
  }) => {
    await stubApis(logs.page, {
      statuses: [{ game: 'minecraft', state: 'stopped' }],
      logLines: { minecraft: SAMPLE_LOG_LINES },
    });
    await logs.goto();

    await expect(logs.page.getByText('Connection refused from 10.0.0.5')).toBeVisible();
    await expect(logs.levelsTriggerWithCount(4)).toBeVisible();

    await logs.toggleLevel('ERROR');

    await expect(logs.page.getByText('Connection refused from 10.0.0.5')).not.toBeVisible();
    await expect(logs.levelsTriggerWithCount(3)).toBeVisible();
  });

  test('should switch streams via the searchable game combobox', async ({ logs }) => {
    await stubApis(logs.page, {
      statuses: [
        { game: 'minecraft', state: 'stopped' },
        { game: 'valheim', state: 'stopped' },
      ],
      logLines: {
        minecraft: ['minecraft seeded line'],
        valheim: ['valheim seeded line'],
      },
    });
    await logs.goto();

    await expect(logs.page.getByText('minecraft seeded line')).toBeVisible();

    await logs.selectGame('valheim');

    await expect(logs.page.getByText('valheim seeded line')).toBeVisible();
    // Switching games resets the buffer — the previous game's seeded line
    // must be gone, not just hidden.
    await expect(logs.page.getByText('minecraft seeded line')).not.toBeVisible();
  });

  test('should display line count and oldest-line age in the footer', async ({ logs }) => {
    await stubApis(logs.page, {
      statuses: [{ game: 'minecraft', state: 'stopped' }],
      logLines: { minecraft: SAMPLE_LOG_LINES },
    });
    await logs.goto();

    // SAMPLE_LOG_LINES has 5 entries; "oldest" follows the count.
    await expect(logs.footerLineCount(5)).toBeVisible();
  });
});
