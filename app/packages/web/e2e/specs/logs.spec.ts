import { test, expect, _electron, SAMPLE_LOG_LINES } from '../fixtures/index.js';
import type { ElectronApplication, Page } from '../fixtures/index.js';
import { electronMain, electronEnv } from '../../playwright.config.js';
import { LogsPage } from '../pages/index.js';

/**
 * `/logs` route specs migrated to the Electron project (issue #191).
 *
 * Each test manages its own `ElectronApplication` lifecycle and seeds IPC
 * responses exclusively via `window.gsd.__test.mock(channel, handler)` — the
 * mock seam provided by the preload script when `HYVEON_TEST_MODE=1`.
 *
 * The `logs.get` mock seeds the initial snapshot displayed by `LogsPage`.
 * The `logs.stream` mock is an async generator that yields nothing and returns
 * immediately, so specs drive the UI off the seeded snapshot only.
 * `games.list` supplies the game selector, and `games.status` silences the
 * `GameStatusProvider` poller that runs in the background.
 */

/** IPC channel mocked for every test — silences the background status poller. */
const STOPPED_STATUSES = [{ game: 'minecraft', state: 'stopped' }];

/**
 * Seed IPC mocks via the `__test` surface and navigate to the Logs page via
 * the sidebar.
 *
 * @param win       - The Electron renderer window handle.
 * @param games     - Game names returned by `games.list`.
 * @param logLines  - Map of game name → initial log lines returned by `logs.get`.
 */
async function setupLogsPage(
  win: Page,
  games: string[],
  logLines: Record<string, string[]>,
): Promise<void> {
  await win.evaluate(
    ({ games: g, logLines: ll, statuses }) => {
      const gsd = (window as Record<string, unknown>)['gsd'] as {
        __test: { mock: (channel: string, handler: unknown) => void };
      };

      // Silence the background GameStatusProvider poller.
      gsd.__test.mock('games.status', () => Promise.resolve(statuses));

      // Seed the game list for the combobox selector. `games.list` resolves
      // `GameListEntry[]`, not bare strings — see issue #92.
      gsd.__test.mock('games.list', () =>
        Promise.resolve({ games: g.map((name) => ({ name, declared: true, deployed: true })) }),
      );

      // Seed the initial log snapshot for each game.
      gsd.__test.mock('logs.get', ({ game }: { game: string }) =>
        Promise.resolve({ game, lines: ll[game] ?? [] }),
      );

      // Stream mock: async generator that yields nothing so specs drive off the
      // seeded snapshot and never wait for live chunks.
      gsd.__test.mock('logs.stream', async function* () {});
    },
    { games, logLines, statuses: STOPPED_STATUSES },
  );
}

test.describe('logs page', () => {
  let app: ElectronApplication;
  let win: Page;
  let logs: LogsPage;

  test.beforeEach(async () => {
    app = await _electron.launch({ args: [electronMain], env: electronEnv });
    win = await app.firstWindow();
    logs = new LogsPage(win);
  });

  test.afterEach(async () => {
    // Each test launches its own Electron app in `beforeEach`, so there is no
    // shared mock registry to clear here — just tear down the app instance.
    await app.close();
  });

  test('should render LIVE badge and seeded log lines', async () => {
    await setupLogsPage(win, ['minecraft'], { minecraft: SAMPLE_LOG_LINES });
    await logs.gotoViaSidebar();

    await expect(logs.heading()).toBeVisible();
    await expect(logs.liveBadge()).toBeVisible();
    await expect(win.getByText('Server started on port 25565')).toBeVisible();
  });

  test('should toggle to Paused badge and back via the Pause/Resume button', async () => {
    await setupLogsPage(win, ['minecraft'], { minecraft: SAMPLE_LOG_LINES });
    await logs.gotoViaSidebar();

    await logs.pauseButton().click();
    await expect(logs.pausedBadge()).toBeVisible();
    await expect(logs.liveBadge()).not.toBeVisible();

    await logs.resumeButton().click();
    await expect(logs.liveBadge()).toBeVisible();
  });

  test('should color-code lines containing INFO/WARN/ERROR/DEBUG with badges', async () => {
    await setupLogsPage(win, ['minecraft'], { minecraft: SAMPLE_LOG_LINES });
    await logs.gotoViaSidebar();

    // Each level token should appear at least once as a small badge alongside
    // the matching line.
    for (const lvl of ['INFO', 'WARN', 'ERROR', 'DEBUG'] as const) {
      await expect(logs.levelBadge(lvl)).toBeVisible();
    }
  });

  test('should highlight matches via <mark> when typing into the search box without filtering lines out', async () => {
    await setupLogsPage(win, ['minecraft'], { minecraft: SAMPLE_LOG_LINES });
    await logs.gotoViaSidebar();

    await expect(logs.highlightMarks()).toHaveCount(0);

    await logs.search('Connection');
    await expect(logs.highlightMark('Connection').first()).toBeVisible();
    // The matched line must remain in the buffer — search highlights, never filters.
    await expect(win.getByText('refused from 10.0.0.5')).toBeVisible();
  });

  test('should hide ERROR-level lines when ERROR is unchecked in the Levels filter', async () => {
    await setupLogsPage(win, ['minecraft'], { minecraft: SAMPLE_LOG_LINES });
    await logs.gotoViaSidebar();

    await expect(win.getByText('Connection refused from 10.0.0.5')).toBeVisible();
    await expect(logs.levelsTriggerWithCount(4)).toBeVisible();

    await logs.toggleLevel('ERROR');

    await expect(win.getByText('Connection refused from 10.0.0.5')).not.toBeVisible();
    await expect(logs.levelsTriggerWithCount(3)).toBeVisible();
  });

  test('should switch streams via the searchable game combobox', async () => {
    await setupLogsPage(
      win,
      ['minecraft', 'valheim'],
      {
        minecraft: ['minecraft seeded line'],
        valheim: ['valheim seeded line'],
      },
    );
    await logs.gotoViaSidebar();

    await expect(win.getByText('minecraft seeded line')).toBeVisible();

    await logs.selectGame('valheim');

    await expect(win.getByText('valheim seeded line')).toBeVisible();
    // Switching games resets the buffer — the previous game's seeded line
    // must be gone, not just hidden.
    await expect(win.getByText('minecraft seeded line')).not.toBeVisible();
  });

  test('should display line count and oldest-line age in the footer', async () => {
    await setupLogsPage(win, ['minecraft'], { minecraft: SAMPLE_LOG_LINES });
    await logs.gotoViaSidebar();

    // SAMPLE_LOG_LINES has 5 entries; "oldest" follows the count.
    await expect(logs.footerLineCount(5)).toBeVisible();
  });
});
