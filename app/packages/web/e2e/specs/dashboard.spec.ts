import type { Page, ElectronApplication } from 'playwright-core';
import {
  test,
  expect,
  launchElectron,
  applyGsdMocks,
  STOPPED_GAME,
  RUNNING_GAME,
  MULTI_GAME_STATUSES,
} from '../fixtures/index.js';
import { DashboardPage, AppLayout } from '../pages/index.js';

/**
 * Dashboard spec — driven via `_electron.launch()` and the
 * `window.gsd.__test.mock()` IPC seam instead of `vite preview` + `page.route()`.
 *
 * A single `ElectronApplication` is shared across all tests in the describe
 * block (launched in `beforeAll`, closed in `afterAll`). Each test calls
 * `applyGsdMocks()` to seed its own IPC responses, then resets the mock
 * registry in `afterEach` via `window.gsd.__test.clearMocks()` so stale
 * handlers do not bleed into later tests.
 */
test.describe('dashboard', () => {
  let app: ElectronApplication | undefined;
  let win: Page;
  let dashboard: DashboardPage;
  let layout: AppLayout;

  test.beforeAll(async () => {
    ({ app, win } = await launchElectron());
    dashboard = new DashboardPage(win);
    layout = new AppLayout(win);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test.afterEach(async () => {
    await win.evaluate(() => {
      const gsd = (window as Record<string, unknown>)['gsd'] as {
        __test: { clearMocks: () => void };
      };
      gsd.__test.clearMocks();
    });
  });

  test('should render a game card for a stopped game', async () => {
    await applyGsdMocks(win, { statuses: [STOPPED_GAME] });
    await dashboard.goto();

    await expect(dashboard.gameCardHeading('minecraft')).toBeVisible();
    await expect(dashboard.statusBadge('STOPPED')).toBeVisible();
  });

  test('should render a game card for a running game with IP', async () => {
    await applyGsdMocks(win, { statuses: [RUNNING_GAME] });
    await dashboard.goto();

    await expect(dashboard.statusBadge('RUNNING')).toBeVisible();
    await expect(dashboard.gameIpAddress('minecraft.example.com')).toBeVisible();
  });

  test('should render multiple game cards', async () => {
    await applyGsdMocks(win, { statuses: MULTI_GAME_STATUSES });
    await dashboard.goto();

    await expect(dashboard.gameCardHeading('minecraft')).toBeVisible();
    await expect(dashboard.gameCardHeading('valheim')).toBeVisible();
  });

  test('should show empty-state message when no games are configured', async () => {
    await applyGsdMocks(win, { statuses: [] });
    await dashboard.goto();

    await expect(dashboard.emptyConfiguredMessage()).toBeVisible();
  });

  test('should show setup guide and terraform.tfvars CTAs in the no-games card', async () => {
    await applyGsdMocks(win, { statuses: [] });
    await dashboard.goto();

    await expect(dashboard.setupGuideLink()).toBeVisible();
    await expect(dashboard.tfvarsLink()).toBeVisible();
  });

  test('should fire games.start IPC channel when Start is clicked', async () => {
    await applyGsdMocks(win, { statuses: [STOPPED_GAME] });

    // Override the games.start mock with one that records the call before
    // resolving, using window.__calledChannels as the in-browser flag store.
    await win.evaluate(() => {
      (window as Record<string, unknown>)['__calledChannels'] = {} as Record<string, boolean>;
      const gsd = (window as Record<string, unknown>)['gsd'] as {
        __test: { mock: (channel: string, handler: unknown) => void };
      };
      gsd.__test.mock('games.start', () => {
        ((window as Record<string, unknown>)['__calledChannels'] as Record<string, boolean>)[
          'games.start'
        ] = true;
        return Promise.resolve({ success: true, message: 'Started' });
      });
    });

    await dashboard.goto();
    await dashboard.startButton().click();

    await expect
      .poll(() =>
        win.evaluate(
          () =>
            (
              (window as Record<string, unknown>)['__calledChannels'] as Record<string, boolean>
            )['games.start'] === true,
        ),
      )
      .toBe(true);
  });

  test('should show only Stop as the primary action for a running game', async () => {
    await applyGsdMocks(win, { statuses: [RUNNING_GAME] });
    await dashboard.goto();

    // The redesigned card swaps the primary CTA based on state instead of
    // disabling the inactive button — Start should not exist while running.
    await expect(dashboard.stopButton()).toBeEnabled();
    await expect(dashboard.startButton()).toHaveCount(0);
  });

  test('should filter game cards by name in real time', async () => {
    await applyGsdMocks(win, { statuses: MULTI_GAME_STATUSES });
    await dashboard.goto();

    await expect(dashboard.gameCardHeading('minecraft')).toBeVisible();
    await expect(dashboard.gameCardHeading('valheim')).toBeVisible();

    await dashboard.filter('valheim');

    await expect(dashboard.gameCardHeading('minecraft')).toHaveCount(0);
    await expect(dashboard.gameCardHeading('valheim')).toBeVisible();
  });

  test('should show empty-state message when search has no matches', async () => {
    await applyGsdMocks(win, { statuses: MULTI_GAME_STATUSES });
    await dashboard.goto();

    await dashboard.filter('nonexistent');
    await expect(dashboard.emptySearchMessage()).toBeVisible();
  });

  test('should render the KPI strip with the four ops tiles', async () => {
    await applyGsdMocks(win, { statuses: MULTI_GAME_STATUSES });
    await dashboard.goto();

    await expect(dashboard.kpiTileLabel('Servers running')).toBeVisible();
    await expect(dashboard.kpiTileLabel('Spend today')).toBeVisible();
    await expect(dashboard.kpiTileLabel('Forecast MTD')).toBeVisible();
    await expect(dashboard.kpiTileLabel('Active alerts')).toBeVisible();
    // 1 of 2 games are running in MULTI_GAME_STATUSES (valheim).
    await expect(dashboard.serversRunningValue('1/2')).toBeVisible();
  });

  test('should navigate to the Logs page via sidebar', async () => {
    await applyGsdMocks(win, { statuses: [] });
    await dashboard.goto();

    await layout.navigateTo('Logs', '/logs');
    // The /logs route is no longer a placeholder — verify the redesigned
    // page actually renders so a regression to the placeholder breaks here.
    await expect(layout.logsPageHeading()).toBeVisible();
  });

  test('should navigate to the Discord page via sidebar', async () => {
    await applyGsdMocks(win, { statuses: [] });
    await dashboard.goto();

    await layout.navigateTo('Discord', '/discord');
  });

  test('should navigate to the Settings page via sidebar', async () => {
    await applyGsdMocks(win, { statuses: [] });
    await dashboard.goto();

    await layout.navigateTo('Settings', '/settings');
  });

  test('should show a success toast after starting a game', async () => {
    await applyGsdMocks(win, { statuses: [STOPPED_GAME] });
    await dashboard.goto();

    await dashboard.startButton().click();

    await expect(layout.toastMessage('minecraft is starting')).toBeVisible();
  });

  test('should show a stop toast with an Undo button after stopping a game', async () => {
    await applyGsdMocks(win, { statuses: [RUNNING_GAME] });

    // Override the games.stop mock with one that records the call before
    // resolving, using window.__calledChannels as the in-browser flag store.
    await win.evaluate(() => {
      (window as Record<string, unknown>)['__calledChannels'] = {} as Record<string, boolean>;
      const gsd = (window as Record<string, unknown>)['gsd'] as {
        __test: { mock: (channel: string, handler: unknown) => void };
      };
      gsd.__test.mock('games.stop', () => {
        ((window as Record<string, unknown>)['__calledChannels'] as Record<string, boolean>)[
          'games.stop'
        ] = true;
        return Promise.resolve({ success: true, message: 'Stopped' });
      });
    });

    await dashboard.goto();
    await dashboard.stopButton().click();

    // ConfirmDialog appears — confirm the stop.
    await dashboard.confirmStopButton().click();

    await expect(layout.toastMessage('minecraft stopped')).toBeVisible();
    await expect(layout.toastUndoButton()).toBeVisible();

    await expect
      .poll(() =>
        win.evaluate(
          () =>
            (
              (window as Record<string, unknown>)['__calledChannels'] as Record<string, boolean>
            )['games.stop'] === true,
        ),
      )
      .toBe(true);
  });
});
